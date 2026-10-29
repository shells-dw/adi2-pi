'use strict';
/**
 * Waveshare UPS HATs on I2C bus 1, read with i2c-tools (i2ctransfer, i2cget): battery, power
 * source, and a clean shutdown when the HAT runs on battery.
 *
 * Detected models:
 *   - UPS HAT (E): MCU at 0x2D, ID register 0x00 = 0x0A. Registers (little-endian 16 bit): 0x02
 *     charge status (bit 5 = USB-C input powered, bit 7 charging), 0x10/0x12 input mV/mA,
 *     0x20/0x22 battery mV/mA (signed, + = charging), 0x24 %, 0x26 mAh left, 0x28/0x2A minutes
 *     to empty / to full.
 *   - UPS HAT, UPS HAT (B): INA219 at 0x42, two cells in series (6.0 … 8.4 V).
 *   - UPS HAT (C), UPS HAT (D): INA219 at 0x43, one cell (3.0 … 4.2 V).
 *   INA219 (registers big-endian): bus voltage 0x02 (bits 15–3 × 4 mV), shunt voltage 0x01 (signed
 *   × 10 µV). Current = shunt voltage / shunt resistance, with the resistance that Waveshare's
 *   calibration implies (0x42: 0.1 Ω, 0x43: 0.01 Ω); negative = the battery supplies the Pi.
 *   Battery % from the voltage, linear as in Waveshare's scripts. Nothing is written to an INA219.
 *
 * On battery: after `delaySec` (power not back) or when the battery is at or below `lowPct`, the
 * Pi shuts down (settings.ups.shutdown). Events: 'status'.
 */
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');

const BUS = 1;
const POLL_MS = 5000;
const ON_BATTERY_MA = -80;      // INA219 models: below this the battery supplies the Pi
const INA = {
  0x42: { label: 'Waveshare UPS HAT / UPS HAT (B)', cells: 2, shuntOhm: 0.1, vMin: 6.0, vMax: 8.4 },
  0x43: { label: 'Waveshare UPS HAT (C) / (D)', cells: 1, shuntOhm: 0.01, vMin: 3.0, vMax: 4.2 },
};

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
  });
}

const hexBytes = (s) => (s.match(/0x[0-9a-f]{2}/gi) || []).map((x) => parseInt(x, 16));
const le16 = (b, i) => b[i] | (b[i + 1] << 8);
const s16 = (v) => (v & 0x8000 ? v - 0x10000 : v);

class Ups extends EventEmitter {
  constructor({ getSettings, log, run: runFn = run, powerOff, pollMs = POLL_MS, devPath = `/dev/i2c-${BUS}` } = {}) {
    super();
    this.getSettings = getSettings;
    this.log = log || console;
    this.run = runFn;
    this.pollMs = pollMs;
    this.devPath = devPath;
    this.powerOff = powerOff || (async () => {
      const r = await this.run('systemctl', ['poweroff']);
      if (r.code !== 0) throw new Error((r.err || r.out).trim() || `systemctl poweroff failed (${r.code})`);
    });
    this.model = null;      // { kind: 'e' | 'ina219', addr, label, … }
    this.reason = null;
    this.data = null;       // last reading
    this.batterySince = null;
    this.shutdownAt = null;
    this.shuttingDown = false;
    this.lowCount = 0;
    this.lastJson = '';
  }

  cfg() {
    const u = this.getSettings().ups || {};
    return { shutdown: u.shutdown !== false, delaySec: Number(u.delaySec) || 60, lowPct: Number(u.lowPct) || 10 };
  }

  start() { this._tick(); }
  stop() { clearTimeout(this.timer); this.timer = null; }

  async _i2c(addr, reg, n) {
    const r = await this.run('i2ctransfer', ['-y', String(BUS), `w1@0x${addr.toString(16)}`, `0x${reg.toString(16)}`, `r${n}`]);
    if (r.code !== 0) throw new Error((r.err || r.out).trim() || 'i2ctransfer failed');
    const b = hexBytes(r.out);
    if (b.length !== n) throw new Error(`i2ctransfer: unexpected answer "${r.out.trim()}"`);
    return b;
  }

  async _detect() {
    if (!fs.existsSync(this.devPath)) { this.reason = 'I2C is off (run the installer with --with-ups to look for a UPS HAT)'; return false; }
    const v = await this.run('i2ctransfer', ['-V']);
    if (v.code !== 0 && !/i2ctransfer/i.test(v.out + v.err)) { this.reason = 'i2c-tools are missing – run the installer again'; return false; }
    try {
      const id = await this._i2c(0x2d, 0x00, 1);
      if (id[0] === 0x0a) { this.model = { kind: 'e', addr: 0x2d, label: 'Waveshare UPS HAT (E)', cells: 4 }; return true; }
    } catch { /* not there */ }
    for (const addr of [0x42, 0x43]) {
      try {
        await this._i2c(addr, 0x02, 2);
        this.model = { kind: 'ina219', addr, ...INA[addr] };
        return true;
      } catch { /* not there */ }
    }
    this.reason = 'no UPS HAT found on I2C (0x2D, 0x42, 0x43)';
    return false;
  }

  async _read() {
    const m = this.model;
    if (m.kind === 'e') {
      const st = (await this._i2c(0x2d, 0x02, 1))[0];
      const vin = await this._i2c(0x2d, 0x10, 6);
      const bat = await this._i2c(0x2d, 0x20, 12);
      const batteryMa = s16(le16(bat, 2));
      return {
        mains: !!(st & 0x20),
        charging: !!(st & 0x80),
        inputV: le16(vin, 0) / 1000, inputW: le16(vin, 4) / 1000,
        batteryV: le16(bat, 0) / 1000,
        batteryA: batteryMa / 1000,
        percent: Math.max(0, Math.min(100, le16(bat, 4))),
        percentFromVoltage: false,
        remainingMah: le16(bat, 6),
        minutesToEmpty: !(st & 0x20) ? le16(bat, 8) : null,
        minutesToFull: st & 0x80 ? le16(bat, 10) : null,
      };
    }
    const sh = await this._i2c(m.addr, 0x01, 2);
    const bus = await this._i2c(m.addr, 0x02, 2);
    const v = ((bus[0] << 8 | bus[1]) >> 3) * 0.004;
    const shuntV = s16(sh[0] << 8 | sh[1]) * 0.00001;
    const a = shuntV / m.shuntOhm;
    return {
      mains: a * 1000 > ON_BATTERY_MA,
      charging: a > 0.02,
      inputV: null, inputW: null,
      batteryV: Math.round(v * 1000) / 1000,
      batteryA: Math.round(a * 1000) / 1000,
      percent: Math.round(Math.max(0, Math.min(100, ((v - m.vMin) / (m.vMax - m.vMin)) * 100))),
      percentFromVoltage: true,
      remainingMah: null, minutesToEmpty: null, minutesToFull: null,
    };
  }

  async _tick() {
    this.timer = setTimeout(() => this._tick(), this.pollMs);
    this.timer.unref?.();
    try {
      if (!this.model && !(await this._detect())) { this._emit(); return; }
      this.data = { ...(await this._read()), at: Date.now() };
      this.reason = null;
      this._check();
    } catch (e) {
      this.reason = e.message;
      this.data = null;
    }
    this._emit();
  }

  _check() {
    const d = this.data;
    const c = this.cfg();
    const now = Date.now();
    if (d.mains) {
      if (this.batterySince) this.log.info('ups: power is back');
      this.batterySince = null;
      this.shutdownAt = null;
      this.lowCount = 0;
      return;
    }
    if (!this.batterySince) {
      this.batterySince = now;
      this.log.info(`ups: on battery (${d.percent} %)`);
    }
    this.shutdownAt = c.shutdown ? this.batterySince + c.delaySec * 1000 : null;
    // low battery: three readings in a row, so a load peak doesn't count
    this.lowCount = d.percent <= c.lowPct ? this.lowCount + 1 : 0;
    const low = c.shutdown && this.lowCount >= 3;
    if (c.shutdown && !this.shuttingDown && (now >= this.shutdownAt || low)) {
      this.shuttingDown = true;
      this.log.info(`ups: ${low ? `battery at ${d.percent} %` : `no power for ${c.delaySec} s`} – shutting the Pi down`);
      this.powerOff().catch((e) => {
        this.shuttingDown = false;
        this.reason = `could not shut down: ${e.message}`;
        this.log.warn(`ups: ${this.reason}`);
        this._emit();
      });
    }
  }

  /** Stop a running countdown until power returns and fails again. */
  cancel() {
    if (this.shutdownAt) this.log.info('ups: shutdown cancelled');
    this.shutdownAt = null;
    this.batterySince = Infinity; // stays "on battery" without a countdown until mains is back
  }

  status() {
    const c = this.cfg();
    const d = this.data;
    return {
      present: !!this.model,
      model: this.model ? this.model.label : null,
      available: !!(this.model && d),
      reason: this.reason,
      ...c,
      mains: d ? d.mains : null,
      charging: d ? d.charging : null,
      batteryV: d ? d.batteryV : null,
      batteryA: d ? d.batteryA : null,
      percent: d ? d.percent : null,
      percentFromVoltage: d ? d.percentFromVoltage : null,
      inputV: d ? d.inputV : null,
      remainingMah: d ? d.remainingMah : null,
      minutesToEmpty: d ? d.minutesToEmpty : null,
      minutesToFull: d ? d.minutesToFull : null,
      onBatterySince: Number.isFinite(this.batterySince) ? this.batterySince : null,
      shutdownAt: Number.isFinite(this.shutdownAt) ? this.shutdownAt : null,
      shuttingDown: this.shuttingDown,
    };
  }

  _emit() {
    const s = this.status();
    // readings change all the time: broadcast at most when something visible changes
    const key = JSON.stringify({ ...s, batteryV: s.batteryV && Math.round(s.batteryV * 20) / 20, batteryA: s.batteryA && Math.round(s.batteryA * 20) / 20, inputV: s.inputV && Math.round(s.inputV * 10) / 10 });
    if (key === this.lastJson) return;
    this.lastJson = key;
    this.emit('status', s);
  }
}

module.exports = { Ups, INA };
