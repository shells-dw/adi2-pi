'use strict';
/**
 * Shut the Pi down when the ADI-2 goes to standby (settings.trigger).
 *
 * - source 'usb': the ADI-2's MIDI port disappears or the unit stops answering.
 * - source 'gpio': Trigger Out → optocoupler → GPIO (README "12 V trigger"); low = ADI-2 on.
 *   GPIO3 also wakes a halted Pi 4/3. While the ADI-2 answers over USB it counts as on.
 * - Shuts down after the ADI-2 was seen on and then off for delaySec; with atStartSec also when
 *   it isn't switched on after the Pi started. Waits for running package updates.
 * - GPIO3 is probed while it isn't the trigger input; low while USB answers = trigger wired.
 * Read with gpioget (libgpiod 1.x/2.x) once a second. Events: 'status'.
 */
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');

const PIN = 3;
const POLL_MS = 1000;
const START_WINDOW_S = 600;
const PROBE_MS = 10000;
const NO_SIGNAL_MS = 10000;  // the ADI-2 answers over USB this long while the trigger GPIO stays high
const MAX_PACKAGE_WAIT_MS = 30 * 60 * 1000;
const CHIP_LABELS = /pinctrl-(bcm2711|bcm2835|bcm2837|rp1)/;

/** True while dpkg, apt, apt-get, aptitude or unattended-upgrade runs (from /proc, readable by
 *  any user). unattended-upgrade-shutdown runs permanently and doesn't count. */
function packagesBusy() {
  let pids;
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return false; }
  for (const pid of pids) {
    let comm;
    try { comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { continue; }
    if (comm === 'dpkg' || comm === 'apt' || comm === 'apt-get' || comm === 'aptitude') return true;
    if (comm.startsWith('unattended-upg')) {
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (cmd.split('\0').some((a) => /(^|\/)unattended-upgrade$/.test(a))) return true;
    }
  }
  return false;
}

function uptimeSec() {
  try { return Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]); } catch { return Infinity; }
}

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
  });
}

class Trigger extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.getSettings
   * @param {(cmd: string, args: string[]) => Promise<{code, out, err}>} [o.run] for tests
   * @param {() => Promise<void>} [o.powerOff]
   * @param {string} [o.model] Pi model string (default: /proc/device-tree/model)
   * @param {number} [o.uptime] seconds since boot when the bridge starts (default: /proc/uptime)
   * @param {() => boolean} [o.packagesBusy] a package update runs (default: dpkg/apt processes)
   * @param {() => boolean} [o.updatesPending] the system update after the start is still to come
   */
  constructor({ getSettings, getDevice = () => null, log, run: runFn = run, powerOff, model, pollMs = POLL_MS, probeMs = PROBE_MS, uptime, packagesBusy: busyFn = packagesBusy, updatesPending = () => false } = {}) {
    super();
    this.getSettings = getSettings;
    this.getDevice = getDevice;
    this.log = log || console;
    this.run = runFn;
    this.pollMs = pollMs;
    this.probeMs = probeMs;
    this.packagesBusy = busyFn;
    this.updatesPending = updatesPending;
    // started together with the Pi (not a restart of the service later on)
    this.bootStart = (uptime ?? uptimeSec()) < START_WINDOW_S;
    this.powerOff = powerOff || (async () => {
      const r = await this.run('systemctl', ['poweroff']);
      if (r.code !== 0) throw new Error((r.err || r.out).trim() || `systemctl poweroff failed (${r.code})`);
    });
    try { this.model = model ?? fs.readFileSync('/proc/device-tree/model', 'utf8').replace(/\0/g, '').trim(); } catch { this.model = model || ''; }
    this.chip = null;          // gpiochipN of the 40-pin header
    this.v2 = null;            // libgpiod 2.x command syntax
    this.reason = null;        // why it can't work, in plain words
    this.adiOn = null;         // true / false / null (not read)
    this.seenOn = false;       // the trigger was on since the bridge started
    this.offSince = null;
    this.shutdownAt = null;
    this.atStart = false;      // the running countdown is the one after the start
    this.startCancelled = false;
    this.watchFrom = Date.now();
    this.waitingSince = null;  // a package update postpones the shutdown
    this.detected = false;     // GPIO3 seen low while the ADI-2 answered over USB: a trigger is wired there
    this.usbOnSince = null;
    this.noSignal = false;     // trigger GPIO high although the ADI-2 answers over USB
    this.timer = null;
    this.probeTimer = null;
  }

  cfg() {
    const t = this.getSettings().trigger || {};
    return { enabled: !!t.enabled, delaySec: Number(t.delaySec) || 10, source: t.source === 'gpio' ? 'gpio' : 'usb', pin: Number(t.pin) || PIN, atStartSec: Number(t.atStartSec) || 0 };
  }

  /** Pi 4 and 3 wake from halt on GPIO3; the Pi 5 doesn't (it has a power button). Only with the trigger wiring. */
  get canWake() { const c = this.cfg(); return c.source === 'gpio' && c.pin === PIN && !/Raspberry Pi 5/i.test(this.model) && /Raspberry Pi/i.test(this.model); }

  start() { this.apply(); this._probe(); }
  stop() { clearTimeout(this.timer); this.timer = null; clearTimeout(this.probeTimer); this.probeTimer = null; }

  /** The ADI-2 answers over USB (so it is on). */
  _usbOn() {
    const d = this.getDevice() || {};
    return !!(d.connected && d.answering === true);
  }

  /** While the trigger isn't read on GPIO3: look at GPIO3 now and then for a wired trigger. */
  async _probe() {
    this.probeTimer = setTimeout(() => this._probe(), this.probeMs);
    this.probeTimer.unref?.();
    const { enabled, source, pin } = this.cfg();
    if (this.detected || (enabled && source === 'gpio' && pin === PIN) || !this._usbOn()) return;
    try {
      if (!(await this._detect(true))) { clearTimeout(this.probeTimer); this.probeTimer = null; return; } // not a Pi
      if ((await this._read(PIN)) === 0 && this._usbOn()) {
        this.detected = true;
        this.log.info('trigger: the ADI-2\'s trigger is wired to GPIO3');
        this._emit();
      }
    } catch { /* GPIO3 in use (I²C) or not readable: nothing to find */ }
  }

  /** Settings changed: start or stop watching. */
  apply() {
    const { enabled, source, pin, atStartSec } = this.cfg();
    if (`${source}:${pin}` !== this.source) {
      // another signal: start over (armed again only after the ADI-2 was seen on)
      this.source = `${source}:${pin}`;
      this.adiOn = null; this.offSince = null; this.shutdownAt = null; this.seenOn = false; this.reason = null; this.atStart = false;
    }
    // the time after the start counts from when it was switched on or changed
    const key = `${enabled}:${source}:${pin}:${atStartSec}`;
    if (key !== this.watchKey) {
      if (this.watchKey !== undefined) { this.watchFrom = Date.now(); this.startCancelled = false; }
      this.watchKey = key;
      if (this.atStart) { this.atStart = false; this.offSince = null; this.shutdownAt = null; }
    }
    if (!enabled) {
      clearTimeout(this.timer); this.timer = null; // the GPIO3 probe goes on
      this.adiOn = null; this.offSince = null; this.shutdownAt = null; this.seenOn = false; this.atStart = false;
      this.reason = null;
      this._emit();
      return;
    }
    if (!this.timer) this._tick();
  }

  async _detect(quiet = false) {
    if (this.chip) return true;
    const v = await this.run('gpioget', ['--version']);
    if (v.code !== 0 && !/gpioget/.test(v.out + v.err)) { if (!quiet) this.reason = 'gpioget is missing – run the installer again (package gpiod)'; return false; }
    this.v2 = /v2\./.test(v.out + v.err);
    const d = await this.run('gpiodetect', []);
    const line = d.out.split('\n').find((l) => CHIP_LABELS.test(l));
    if (!line) { if (!quiet) this.reason = 'no Raspberry Pi GPIO header found'; return false; }
    this.chip = line.split(/\s+/)[0];
    return true;
  }

  /** The trigger GPIO: 0 = low (ADI-2 on), 1 = high (standby), or throws. GPIO3 has a pull-up on
   *  the board; other pins get the internal pull-up. */
  async _read(pin = this.cfg().pin) {
    const bias = pin === PIN ? [] : this.v2 ? ['--bias=pull-up'] : ['-B', 'pull-up'];
    const args = this.v2 ? ['--numeric', ...bias, '-c', this.chip, String(pin)] : [...bias, this.chip, String(pin)];
    const r = await this.run('gpioget', args);
    if (r.code !== 0) {
      const msg = (r.err || r.out).trim();
      if (/busy/i.test(msg)) throw new Error(pin === PIN ? 'GPIO3 is in use by something else – usually I²C (a UPS HAT, another HAT, or I²C switched on in raspi-config). Choose another GPIO for the trigger.' : `GPIO${pin} is in use by something else – choose another GPIO for the trigger.`);
      if (/permission|denied/i.test(msg)) throw new Error('no access to the GPIO pins – run the installer again (it adds ADI-2-Pi to the gpio group)');
      throw new Error(msg || `gpioget failed (${r.code})`);
    }
    const m = r.out.trim().match(/([01])\s*$/) || r.out.match(/=(active|inactive)/);
    if (!m) throw new Error(`gpioget: unexpected answer "${r.out.trim()}"`);
    return m[1] === '1' || m[1] === 'active' ? 1 : 0;
  }

  async _tick() {
    this.timer = setTimeout(() => this._tick(), this.pollMs);
    this.timer.unref?.();
    const { enabled, source } = this.cfg();
    if (!enabled) return;
    if (source === 'usb') {
      const d = this.getDevice() || {};
      this.reason = null;
      this._update(!!d.connected && d.answering !== false);
      return;
    }
    try {
      if (!(await this._detect())) { this._emit(); return; }
      const { pin } = this.cfg();
      const level = await this._read();
      this.reason = null;
      // second opinion from USB: answering means on, whatever the GPIO says
      const usb = this._usbOn();
      this.usbOnSince = usb ? (this.usbOnSince ?? Date.now()) : null;
      if (level === 0 && usb && pin === PIN && !this.detected) { this.detected = true; }
      const noSignal = level === 1 && usb && Date.now() - this.usbOnSince >= NO_SIGNAL_MS;
      if (noSignal && !this.noSignal) this.log.warn(`trigger: the ADI-2 answers over USB, but GPIO${pin} gets no trigger signal – check the wiring`);
      this.noSignal = noSignal;
      this._update(level === 0 || usb);
    } catch (e) {
      this.reason = e.message;
      this.adiOn = null;
      this._emit();
    }
  }

  _update(on) {
    const now = Date.now();
    const { delaySec, atStartSec, source } = this.cfg();
    this.adiOn = on;
    if (on) {
      if (this.offSince !== null && !this.shuttingDown) this.log.info('trigger: ADI-2 on again – no shutdown');
      this.seenOn = true;
      this.offSince = null;
      this.shutdownAt = null;
      this.atStart = false;
      this.waitingSince = null;
    } else if (this.seenOn) {
      if (this.offSince === null) {
        this.offSince = now;
        this.log.info(`trigger: ADI-2 off (${source === 'usb' ? 'USB' : 'trigger'}) – shutting the Pi down in ${delaySec} s unless it comes back`);
      }
      this.shutdownAt = this.offSince + delaySec * 1000;
    } else if (atStartSec > 0 && this.bootStart && !this.startCancelled) {
      // started with the ADI-2 off: shut down after atStartSec, and at least delaySec after the first off reading
      if (this.offSince === null) {
        this.offSince = now;
        this.atStart = true;
        const at = Math.max(this.watchFrom + atStartSec * 1000, now + delaySec * 1000);
        this.log.info(`trigger: ADI-2 off since the Pi started – shutting the Pi down in ${Math.round((at - now) / 1000)} s unless it is switched on`);
      }
      this.shutdownAt = Math.max(this.watchFrom + atStartSec * 1000, this.offSince + delaySec * 1000);
    }
    if (this.shutdownAt !== null && now >= this.shutdownAt && !this.shuttingDown) this._shutdown(now);
    this._emit();
  }

  _shutdown(now) {
    // a package update in progress: wait for it (dpkg interrupted halfway can leave packages broken);
    // after the start, also for the system update that is due then
    if (this.packagesBusy() || (this.atStart && this.updatesPending())) {
      if (this.waitingSince === null) {
        this.waitingSince = now;
        this.log.info('trigger: a package update is running – shutting down when it has finished');
      }
      if (now - this.waitingSince < MAX_PACKAGE_WAIT_MS) return;
      this.log.warn('trigger: the package update is still running after 30 min – shutting down anyway');
    }
    this.waitingSince = null;
    this.shuttingDown = true;
    this.log.info(this.atStart ? 'trigger: the ADI-2 was not switched on after the start – shutting the Pi down' : 'trigger: ADI-2 stayed off – shutting the Pi down');
    this._emit();
    this.powerOff().catch((e) => {
      this.shuttingDown = false;
      this.reason = `could not shut down: ${e.message}`;
      this.log.warn(`trigger: ${this.reason}`);
      this._emit();
    });
  }

  /** Stop a running countdown; it starts again only after the ADI-2 has been on once more. */
  cancel() {
    if (this.shutdownAt) this.log.info('trigger: shutdown cancelled');
    this.seenOn = false;
    this.startCancelled = true;
    this.atStart = false;
    this.offSince = null;
    this.shutdownAt = null;
    this.waitingSince = null;
    this._emit();
  }

  status() {
    const { enabled, delaySec, source, pin, atStartSec } = this.cfg();
    return {
      enabled, delaySec, source, pin, atStartSec, model: this.model || null, canWake: this.canWake,
      available: !this.reason, reason: this.reason,
      adiOn: enabled ? this.adiOn : null,
      armed: enabled && this.seenOn,            // a standby will shut the Pi down
      shutdownAt: this.shutdownAt, atStart: enabled && this.atStart, shuttingDown: !!this.shuttingDown,
      waitingForUpdates: this.waitingSince !== null,
      detected: this.detected,                  // a trigger is wired to GPIO3 (seen low while the ADI-2 answered over USB)
      noSignal: enabled && source === 'gpio' && this.noSignal, // ADI-2 on (USB) but the trigger GPIO stays high
    };
  }

  _emit() {
    const s = JSON.stringify(this.status());
    if (s === this._last) return;
    this._last = s;
    this.emit('status', this.status());
  }
}

module.exports = { Trigger, PIN, packagesBusy };
