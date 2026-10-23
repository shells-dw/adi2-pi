'use strict';
/**
 * Shut the Pi down when the ADI-2 goes to standby, using the unit's 12 V Trigger Out.
 *
 * Wiring (README "Trigger: shut down with the ADI-2"): Trigger Out → optocoupler → GPIO3 (pin 5)
 * and GND. ADI-2 on = optocoupler conducts = GPIO3 low (0); standby = GPIO3 high (board pull-up).
 * GPIO3 is also the pin that wakes a halted Pi 4 (and 3) when pulled low: switching the ADI-2 on
 * starts the Pi again. Nothing here is needed for that – it's the Pi's boot ROM/bootloader.
 *
 * Read with libgpiod's gpioget (package gpiod, v1 or v2 syntax), once a second. Shuts down only
 * after the trigger was seen ON and then stays OFF for `delaySec` – a Pi started while the ADI-2 is
 * in standby stays on (it never saw the ADI-2 switch off).
 */
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');

const PIN = 3;
const POLL_MS = 1000;
const CHIP_LABELS = /pinctrl-(bcm2711|bcm2835|bcm2837|rp1)/;

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
   */
  constructor({ getSettings, log, run: runFn = run, powerOff, model, pollMs = POLL_MS } = {}) {
    super();
    this.getSettings = getSettings;
    this.log = log || console;
    this.run = runFn;
    this.pollMs = pollMs;
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
    this.timer = null;
  }

  cfg() { const t = this.getSettings().trigger || {}; return { enabled: !!t.enabled, delaySec: Number(t.delaySec) || 10 }; }

  /** Pi 4 and 3 wake from halt on GPIO3; the Pi 5 doesn't (it has a power button). */
  get canWake() { return !/Raspberry Pi 5/i.test(this.model) && /Raspberry Pi/i.test(this.model); }

  start() { this.apply(); }
  stop() { clearTimeout(this.timer); this.timer = null; }

  /** Settings changed: start or stop watching. */
  apply() {
    const { enabled } = this.cfg();
    if (!enabled) {
      this.stop();
      this.adiOn = null; this.offSince = null; this.shutdownAt = null; this.seenOn = false;
      this.reason = null;
      this._emit();
      return;
    }
    if (!this.timer) this._tick();
  }

  async _detect() {
    if (this.chip) return true;
    const v = await this.run('gpioget', ['--version']);
    if (v.code !== 0 && !/gpioget/.test(v.out + v.err)) { this.reason = 'gpioget is missing – run the installer again (package gpiod)'; return false; }
    this.v2 = /v2\./.test(v.out + v.err);
    const d = await this.run('gpiodetect', []);
    const line = d.out.split('\n').find((l) => CHIP_LABELS.test(l));
    if (!line) { this.reason = 'no Raspberry Pi GPIO header found'; return false; }
    this.chip = line.split(/\s+/)[0];
    return true;
  }

  /** GPIO3: 0 = low (ADI-2 on), 1 = high (standby), or throws. */
  async _read() {
    const args = this.v2 ? ['--numeric', '-c', this.chip, String(PIN)] : [this.chip, String(PIN)];
    const r = await this.run('gpioget', args);
    if (r.code !== 0) {
      const msg = (r.err || r.out).trim();
      if (/busy/i.test(msg)) throw new Error('GPIO3 is in use by something else – usually I²C (a HAT, or I²C switched on in raspi-config). The trigger needs GPIO3.');
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
    if (!this.cfg().enabled) return;
    try {
      if (!(await this._detect())) { this._emit(); return; }
      const level = await this._read();
      this.reason = null;
      this._update(level === 0);
    } catch (e) {
      this.reason = e.message;
      this.adiOn = null;
      this._emit();
    }
  }

  _update(on) {
    const now = Date.now();
    const { delaySec } = this.cfg();
    this.adiOn = on;
    if (on) {
      this.seenOn = true;
      this.offSince = null;
      this.shutdownAt = null;
    } else if (this.seenOn) {
      if (this.offSince === null) {
        this.offSince = now;
        this.log.info(`trigger: ADI-2 in standby – shutting the Pi down in ${delaySec} s unless it comes back`);
      }
      this.shutdownAt = this.offSince + delaySec * 1000;
      if (now >= this.shutdownAt && !this.shuttingDown) {
        this.shuttingDown = true;
        this.log.info('trigger: ADI-2 stayed in standby – shutting the Pi down');
        this._emit();
        this.powerOff().catch((e) => {
          this.shuttingDown = false;
          this.reason = `could not shut down: ${e.message}`;
          this.log.warn(`trigger: ${this.reason}`);
          this._emit();
        });
      }
    }
    this._emit();
  }

  /** Stop a running countdown; it starts again only after the ADI-2 has been on once more. */
  cancel() {
    if (this.shutdownAt) this.log.info('trigger: shutdown cancelled');
    this.seenOn = false;
    this.offSince = null;
    this.shutdownAt = null;
    this._emit();
  }

  status() {
    const { enabled, delaySec } = this.cfg();
    return {
      enabled, delaySec, pin: PIN, model: this.model || null, canWake: this.canWake,
      available: !this.reason, reason: this.reason,
      adiOn: enabled ? this.adiOn : null,
      armed: enabled && this.seenOn,            // a standby will shut the Pi down
      shutdownAt: this.shutdownAt, shuttingDown: !!this.shuttingDown,
    };
  }

  _emit() {
    const s = JSON.stringify(this.status());
    if (s === this._last) return;
    this._last = s;
    this.emit('status', this.status());
  }
}

module.exports = { Trigger, PIN };
