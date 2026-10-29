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

test('started with the ADI-2 off: shuts down after atStartSec, only when started with the Pi', async () => {
  const settings = new Settings(null, quiet);
  assert.strictEqual(settings.get().trigger.atStartSec, 0, 'default: stays on');
  const g = fakeGpio({ level: 1 }); // ADI-2 in standby
  let off = 0;
  const make = (uptime) => new Trigger({ getSettings: () => settings.get(), log: quiet, run: g.run, powerOff: async () => { off++; }, model: 'Raspberry Pi 4 Model B Rev 1.5', pollMs: 20, uptime, packagesBusy: () => false });
  settings.update({ trigger: { enabled: true, source: 'gpio', delaySec: 10, atStartSec: 900 } });
  const t = make(40);
  t.start();
  try {
    await until(() => t.status().shutdownAt);
    const s = t.status();
    assert.strictEqual(s.atStart, true);
    assert.strictEqual(s.armed, false);
    assert.ok(Math.abs(s.shutdownAt - (t.watchFrom + 900000)) < 50, 'counts from the start');
    // switched on in time: normal behaviour from then on
    g.level = 0;
    await until(() => t.status().armed && !t.status().shutdownAt);
    assert.strictEqual(t.status().atStart, false);
    g.level = 1;
    await until(() => t.status().shutdownAt);
    assert.strictEqual(t.status().atStart, false, 'normal countdown after the ADI-2 was on');
    t.cancel();
    await sleep(80);
    assert.strictEqual(t.status().shutdownAt, null, 'a cancel isn\'t followed by the start countdown');

    // a new start that runs out
    t.stop();
    const t2 = make(40);
    t2.start();
    await until(() => t2.status().shutdownAt);
    t2.watchFrom -= 901000; t2.offSince -= 11000; t2.shutdownAt = null; // time passes
    await until(() => off === 1);
    t2.stop();

    // the service restarted long after boot: stays on
    const t3 = make(5000);
    t3.start();
    await until(() => t3.status().adiOn === false);
    await sleep(80);
    assert.strictEqual(t3.status().shutdownAt, null);
    t3.stop();
    assert.throws(() => settings.update({ trigger: { atStartSec: 60 } }), /atStartSec/);
  } finally { t.stop(); }
});

test('a running package update postpones the shutdown', async () => {
  const settings = new Settings(null, quiet);
  const g = fakeGpio({ level: 0 });
  let off = 0; let busy = true;
  const t = new Trigger({ getSettings: () => settings.get(), log: quiet, run: g.run, powerOff: async () => { off++; }, model: 'Raspberry Pi 4 Model B Rev 1.5', pollMs: 20, uptime: 9999, packagesBusy: () => busy });
  settings.update({ trigger: { enabled: true, source: 'gpio', delaySec: 10 } });
  t.start();
  try {
    await until(() => t.status().armed);
    g.level = 1;
    await until(() => t.status().shutdownAt);
    t.offSince -= 11000;
    await until(() => t.status().waitingForUpdates);
    await sleep(80);
    assert.strictEqual(off, 0, 'waits while dpkg/apt runs');
    busy = false;
    await until(() => off === 1);
    assert.strictEqual(t.status().waitingForUpdates, false);
  } finally { t.stop(); }
});

test('the start shutdown waits for the system update due after the start', async () => {
  const settings = new Settings(null, quiet);
  const g = fakeGpio({ level: 1 });
  let off = 0; let pending = true;
  const t = new Trigger({ getSettings: () => settings.get(), log: quiet, run: g.run, powerOff: async () => { off++; }, model: 'Raspberry Pi 4 Model B Rev 1.5', pollMs: 20, uptime: 30, packagesBusy: () => false, updatesPending: () => pending });
  settings.update({ trigger: { enabled: true, source: 'gpio', delaySec: 10, atStartSec: 300 } });
  t.start();
  try {
    await until(() => t.status().shutdownAt);
    t.watchFrom -= 301000; t.offSince -= 11000;
    await until(() => t.status().waitingForUpdates);
    await sleep(80);
    assert.strictEqual(off, 0);
    pending = false;
    await until(() => off === 1);
  } finally { t.stop(); }
});

test('wiring: GPIO3 low while the ADI-2 answers over USB = trigger found; USB on overrides a silent GPIO', async () => {
  const settings = new Settings(null, quiet);
  const g = fakeGpio({ level: 0 });
  const dev = { connected: true, answering: false };
  let off = 0;
  const t = new Trigger({ getSettings: () => settings.get(), getDevice: () => dev, log: quiet, run: g.run, powerOff: async () => { off++; }, model: 'Raspberry Pi 4 Model B Rev 1.5', pollMs: 20, probeMs: 20, uptime: 9999, packagesBusy: () => false });
  // trigger switched off: GPIO3 is looked at anyway, once the ADI-2 answers over USB
  t.start();
  try {
    await sleep(60);
    assert.strictEqual(t.status().detected, false, 'not while the ADI-2 is silent');
    settings.update({ trigger: { delaySec: 30 } }); t.apply(); // other settings changes don't stop it
    dev.answering = true;
    await until(() => t.status().detected);
    assert.ok(g.calls.includes('gpioget gpiochip0 3'));

    // on GPIO3, wire comes off while the ADI-2 stays on: no shutdown, noSignal after a while
    settings.update({ trigger: { enabled: true, source: 'gpio', delaySec: 10 } }); t.apply();
    await until(() => t.status().armed);
    g.level = 1;
    t.usbOnSince = Date.now() - 11000;
    await until(() => t.status().noSignal);
    assert.strictEqual(t.status().adiOn, true, 'USB says on');
    assert.strictEqual(t.status().shutdownAt, null);
    // the ADI-2 goes to standby: USB silent too → countdown
    dev.answering = false;
    await until(() => t.status().shutdownAt);
    assert.strictEqual(t.status().noSignal, false);
    assert.strictEqual(off, 0);
  } finally { t.stop(); }

  // not a Pi: no probing, no errors shown
  const none = new Trigger({ getSettings: () => new Settings(null, quiet).get(), getDevice: () => dev, log: quiet, run: async () => ({ code: 1, out: '', err: 'not found' }), powerOff: async () => {}, model: '', pollMs: 20 });
  dev.answering = true;
  none.start();
  await sleep(60);
  assert.strictEqual(none.status().detected, false);
  assert.strictEqual(none.status().reason, null);
  none.stop();
});
