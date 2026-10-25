'use strict';
/** UPS HAT: detection, readings (HAT (E) registers, INA219), shutdown on battery. */
const test = require('node:test');
const assert = require('node:assert');
const { Ups } = require('../lib/ups');
const { Settings } = require('../lib/settings');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(5); } throw new Error('timed out'); }

/** fake i2ctransfer: devices = { addr: Uint8Array of registers } */
function fakeI2c(devices) {
  return async (cmd, a) => {
    if (cmd !== 'i2ctransfer') return { code: 1, out: '', err: '' };
    if (a[0] === '-V') return { code: 0, out: 'i2ctransfer version 4.3\n', err: '' };
    const addr = parseInt(a[2].split('@')[1], 16), reg = parseInt(a[3], 16), n = Number(a[4].slice(1));
    const d = devices[addr];
    if (!d) return { code: 1, out: '', err: 'Error: Sending messages failed: Remote I/O error' };
    const bytes = typeof d === 'function' ? d(reg, n) : [...d.slice(reg, reg + n)];
    return { code: 0, out: bytes.map((x) => `0x${x.toString(16).padStart(2, '0')}`).join(' ') + '\n', err: '' };
  };
}
const le = (r, i, v) => { r[i] = v & 0xff; r[i + 1] = (v >> 8) & 0xff; };
const be = (r, i, v) => { r[i] = (v >> 8) & 0xff; r[i + 1] = v & 0xff; };

test('UPS HAT (E): registers, power loss → shutdown after the delay; power back cancels', async () => {
  const regs = new Uint8Array(0x60);
  regs[0] = 0x0a; regs[2] = 0xa2;           // charging, input powered
  le(regs, 0x10, 5100); le(regs, 0x14, 6000);
  le(regs, 0x20, 15900); le(regs, 0x22, 450); le(regs, 0x24, 87); le(regs, 0x26, 4200); le(regs, 0x2a, 35);
  const settings = new Settings(null, quiet);
  settings.update({ ups: { delaySec: 10 } });
  let off = 0;
  const u = new Ups({ getSettings: () => settings.get(), log: quiet, run: fakeI2c({ 0x2d: regs }), devPath: __filename, powerOff: async () => { off++; }, pollMs: 15 });
  u.start();
  try {
    await until(() => u.status().available);
    let s = u.status();
    assert.strictEqual(s.model, 'Waveshare UPS HAT (E)');
    assert.deepStrictEqual([s.mains, s.charging, s.percent, s.batteryV, s.batteryA, s.inputV, s.remainingMah, s.minutesToFull, s.percentFromVoltage], [true, true, 87, 15.9, 0.45, 5.1, 4200, 35, false]);
    // pull the plug
    regs[2] = 0x00; le(regs, 0x22, 0x10000 - 600); le(regs, 0x28, 200);
    await until(() => u.status().shutdownAt);
    s = u.status();
    assert.strictEqual(s.mains, false);
    assert.strictEqual(s.batteryA, -0.6);
    assert.strictEqual(s.minutesToEmpty, 200);
    assert.strictEqual(off, 0);
    regs[2] = 0x20;                               // power back
    await until(() => !u.status().shutdownAt);
    regs[2] = 0x00;
    await until(() => u.status().shutdownAt);
    u.batterySince -= 11000;                      // time passes
    await until(() => off === 1);
    assert.strictEqual(u.status().shuttingDown, true);
  } finally { u.stop(); }
});

test('UPS HAT (B) via INA219 at 0x42: voltage, current from the shunt, low battery shuts down', async () => {
  // INA219: 16-bit registers, big-endian; 0x01 shunt voltage, 0x02 bus voltage
  const regs16 = { 1: 3000, 2: Math.round(8.0 / 0.004) << 3 };   // +30 mV over 0.1 Ω = +0.3 A, 8.0 V
  const ina = (reg) => { const b = []; be(b, 0, regs16[reg] || 0); return b; };
  const settings = new Settings(null, quiet);
  settings.update({ ups: { delaySec: 600, lowPct: 20 } });
  let off = 0;
  const u = new Ups({ getSettings: () => settings.get(), log: quiet, run: fakeI2c({ 0x42: ina }), devPath: __filename, powerOff: async () => { off++; }, pollMs: 15 });
  u.start();
  try {
    await until(() => u.status().available);
    let s = u.status();
    assert.strictEqual(s.model, 'Waveshare UPS HAT / UPS HAT (B)');
    assert.deepStrictEqual([s.batteryV, s.batteryA, s.percent, s.mains, s.charging, s.percentFromVoltage], [8, 0.3, 83, true, true, true]);
    regs16[1] = 0x10000 - 7000;                   // −70 mV: −0.7 A, on battery
    regs16[2] = Math.round(6.4 / 0.004) << 3;     // 6.4 V = 17 %
    await until(() => off === 1, 3000);
    s = u.status();
    assert.strictEqual(s.mains, false);
    assert.strictEqual(s.percent, 17);
  } finally { u.stop(); }
});

test('UPS: shutdown off, cancel, nothing found, settings', async () => {
  const regs = new Uint8Array(0x60);
  regs[0] = 0x0a; regs[2] = 0x00; le(regs, 0x24, 5);
  const settings = new Settings(null, quiet);
  settings.update({ ups: { shutdown: false } });
  let off = 0;
  const u = new Ups({ getSettings: () => settings.get(), log: quiet, run: fakeI2c({ 0x2d: regs }), devPath: __filename, powerOff: async () => { off++; }, pollMs: 15 });
  u.start();
  try {
    await until(() => u.status().available);
    await sleep(80);
    assert.strictEqual(off, 0, 'shutdown switched off: stays on, also at 5 %');
    assert.strictEqual(u.status().shutdownAt, null);
    settings.update({ ups: { shutdown: true, lowPct: 5, delaySec: 600 } });
    await until(() => off === 1, 2000);
  } finally { u.stop(); }
  const none = new Ups({ getSettings: () => settings.get(), log: quiet, run: fakeI2c({}), devPath: __filename, pollMs: 15 });
  none.start();
  await until(() => none.status().reason);
  assert.match(none.status().reason, /no UPS HAT found/);
  assert.strictEqual(none.status().present, false);
  none.stop();
  const noI2c = new Ups({ getSettings: () => settings.get(), log: quiet, run: fakeI2c({}), devPath: '/nonexistent/i2c-1', pollMs: 15 });
  noI2c.start();
  await until(() => noI2c.status().reason);
  assert.match(noI2c.status().reason, /I2C is off/);
  noI2c.stop();
  assert.throws(() => settings.update({ ups: { delaySec: 7 } }), /UPS delay/);
  assert.throws(() => settings.update({ ups: { lowPct: 2 } }), /5…50/);
});
