'use strict';
/** Shut down with the ADI-2: GPIO3 read through a fake gpioget (libgpiod v1 and v2 syntax), or the USB connection. */
const test = require('node:test');
const assert = require('node:assert');
const { Trigger } = require('../lib/trigger');
const { Settings } = require('../lib/settings');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(5); } throw new Error('timed out'); }

function fakeGpio({ v2 = false, level = 0, busy = false } = {}) {
  const g = { level, calls: [] };
  g.run = async (cmd, args) => {
    g.calls.push([cmd, ...args].join(' '));
    if (cmd === 'gpiodetect') return { code: 0, out: 'gpiochip0 [pinctrl-bcm2711] (58 lines)\ngpiochip1 [raspberrypi-exp-gpio] (8 lines)\n' };
    if (cmd !== 'gpioget') return { code: 1, out: '', err: 'nope' };
    if (args[0] === '--version') return { code: 0, out: v2 ? 'gpioget (libgpiod) v2.1.3\n' : 'gpioget (libgpiod) v1.6.3\n' };
    if (busy) return { code: 1, out: '', err: 'gpioget: error reading GPIO values: Device or resource busy' };
    return { code: 0, out: v2 ? `${g.level}\n` : `${g.level}\n` };
  };
  return g;
}

for (const v2 of [false, true]) {
  test(`shuts down after the ADI-2 was on and stays in standby (libgpiod ${v2 ? 2 : 1})`, async () => {
    const settings = new Settings(null, quiet);
    const g = fakeGpio({ v2, level: 1 }); // ADI-2 in standby when the Pi starts
    let off = 0;
    const t = new Trigger({ getSettings: () => settings.get(), log: quiet, run: g.run, powerOff: async () => { off++; }, model: 'Raspberry Pi 4 Model B Rev 1.5', pollMs: 20 });
    settings.update({ trigger: { enabled: true, delaySec: 10, source: 'gpio' } });
    t.start();
    try {
      await until(() => t.status().adiOn === false);
      assert.strictEqual(t.status().armed, false, 'started in standby: not armed');
      await sleep(100);
      assert.strictEqual(off, 0, 'a Pi started while the ADI-2 is in standby stays on');
      assert.ok(g.calls.includes(v2 ? 'gpioget --numeric -c gpiochip0 3' : 'gpioget gpiochip0 3'));

      g.level = 0; // ADI-2 switched on
      await until(() => t.status().adiOn === true && t.status().armed);
      g.level = 1; // standby
      await until(() => t.status().shutdownAt);
      // the countdown: still on before delaySec – shorten it by moving the start back
      assert.strictEqual(off, 0);
      g.level = 0; // back on within the delay: no shutdown
      await until(() => !t.status().shutdownAt);
      g.level = 1;
      await until(() => t.status().shutdownAt);
      t.offSince -= 11000; // time passes
      await until(() => off === 1);
      assert.strictEqual(t.status().shuttingDown, true);
      assert.strictEqual(t.status().canWake, true);
    } finally { t.stop(); }
  });
}

test('cancel, GPIO3 busy (I²C), switched off, Pi 5', async () => {
  const settings = new Settings(null, quiet);
  const g = fakeGpio({ level: 0 });
  let off = 0;
  const t = new Trigger({ getSettings: () => settings.get(), log: quiet, run: g.run, powerOff: async () => { off++; }, model: 'Raspberry Pi 5 Model B Rev 1.0', pollMs: 20 });
  settings.update({ trigger: { enabled: true, source: 'gpio' } });
  t.start();
  try {
    await until(() => t.status().armed);
    assert.strictEqual(t.status().canWake, false);
    g.level = 1;
    await until(() => t.status().shutdownAt);
    t.cancel();
    t.offSince = null;
    await sleep(80);
    assert.strictEqual(t.status().shutdownAt, null, 'cancelled; needs the ADI-2 on again to arm');
    assert.strictEqual(off, 0);

    settings.update({ trigger: { enabled: false } }); t.apply();
    assert.strictEqual(t.status().adiOn, null);
    const calls = g.calls.length;
    await sleep(80);
    assert.strictEqual(g.calls.length, calls, 'not polling while off');

    const busy = new Trigger({ getSettings: () => ({ trigger: { enabled: true, delaySec: 10, source: 'gpio' } }), log: quiet, run: fakeGpio({ busy: true }).run, powerOff: async () => {}, model: 'Raspberry Pi 4', pollMs: 20 });
    busy.start();
    await until(() => busy.status().reason);
    assert.match(busy.status().reason, /I²C/);
    assert.strictEqual(busy.status().available, false);
    busy.stop();
    assert.throws(() => settings.update({ trigger: { delaySec: 7 } }), /delay/);
  } finally { t.stop(); }
});

test('USB source: shuts down when the ADI-2 disappears or stops answering, no GPIO access', async () => {
  const settings = new Settings(null, quiet);
  assert.strictEqual(settings.get().trigger.source, 'usb', 'default');
  const g = fakeGpio();
  const dev = { connected: false, ready: false, answering: null };
  let off = 0;
  const t = new Trigger({ getSettings: () => settings.get(), getDevice: () => dev, log: quiet, run: g.run, powerOff: async () => { off++; }, model: 'Raspberry Pi 5 Model B Rev 1.0', pollMs: 20 });
  settings.update({ trigger: { enabled: true } });
  t.start();
  try {
    await until(() => t.status().adiOn === false);
    assert.strictEqual(t.status().armed, false, 'not seen yet: not armed');
    assert.strictEqual(t.status().canWake, false, 'USB can\'t start the Pi');
    Object.assign(dev, { connected: true, ready: true, answering: true });
    await until(() => t.status().adiOn === true && t.status().armed);
    dev.answering = false; // MIDI Control off / unit silent
    await until(() => t.status().shutdownAt);
    dev.answering = true;
    await until(() => !t.status().shutdownAt);
    dev.connected = false; // USB gone
    await until(() => t.status().shutdownAt);
    t.offSince -= 11000;
    await until(() => off === 1);
    assert.strictEqual(g.calls.length, 0, 'GPIO not touched');

    settings.update({ trigger: { source: 'gpio' } }); t.apply();
    assert.strictEqual(t.status().armed, false, 'new source starts unarmed');
    assert.throws(() => settings.update({ trigger: { source: 'serial' } }), /source/);
  } finally { t.stop(); }
});

test('trigger on another GPIO: internal pull-up, no wake', async () => {
  for (const v2 of [false, true]) {
    const settings = new Settings(null, quiet);
    const g = fakeGpio({ v2, level: 0 });
    const t = new Trigger({ getSettings: () => settings.get(), log: quiet, run: g.run, powerOff: async () => {}, model: 'Raspberry Pi 4 Model B Rev 1.5', pollMs: 20 });
    settings.update({ trigger: { enabled: true, source: 'gpio', pin: 17 } });
    t.start();
    try {
      await until(() => t.status().armed);
      assert.ok(g.calls.includes(v2 ? 'gpioget --numeric --bias=pull-up -c gpiochip0 17' : 'gpioget -B pull-up gpiochip0 17'), g.calls.join('\n'));
      assert.strictEqual(t.status().pin, 17);
      assert.strictEqual(t.status().canWake, false, 'only GPIO3 wakes the Pi');
    } finally { t.stop(); }
  }
  assert.throws(() => new Settings(null, quiet).update({ trigger: { pin: 2 } }), /GPIO must be/);
});
