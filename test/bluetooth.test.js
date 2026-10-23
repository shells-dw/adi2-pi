'use strict';
/** Bluetooth helper against a fake BlueZ on a private D-Bus (no hardware needed). */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Bluetooth } = require('../lib/bluetooth');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(25); }
  throw new Error('timed out');
}

// the Python that has dbus + gi (on the Pi: python3; build machines may need a specific version)
const PY = ['python3', 'python3.12', 'python3.11'].find((p) => spawnSync(p, ['-c', 'import dbus, gi'], { stdio: 'ignore' }).status === 0);
const canRun = !!PY && spawnSync('dbus-daemon', ['--version'], { stdio: 'ignore' }).status === 0;

function startBus() {
  return new Promise((resolve, reject) => {
    const d = spawn('dbus-daemon', ['--session', '--nofork', '--print-address=1'], { stdio: ['ignore', 'pipe', 'inherit'] });
    d.stdout.setEncoding('utf8');
    d.stdout.once('data', (a) => resolve({ proc: d, address: a.trim().split('\n')[0] }));
    d.on('error', reject);
  });
}

function ctl(address, method, ...args) {
  const r = spawnSync('dbus-send', ['--print-reply=literal', `--bus=${address}`, '--dest=org.bluez', '/test', `net.adi2pi.Test.${method}`, ...args], { encoding: 'utf8' });
  return r.stdout.trim();
}

test('Bluetooth helper: pairing window, scan, pair, connect, forget, refusals', { skip: !canRun && 'python3-dbus or dbus-daemon missing' }, async () => {
  const bus = await startBus();
  const env = { DBUS_SESSION_BUS_ADDRESS: bus.address, DBUS_SYSTEM_BUS_ADDRESS: bus.address };
  const fake = spawn(PY, [path.join(__dirname, 'fake-bluez.py')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => fake.stdout.once('data', r));
  const bt = new Bluetooth({ log: quiet, env, alias: 'ADI-2-Pi Test', python: PY });
  try {
    bt.start();
    await until(() => bt.state.available && bt.state.adapter && bt.state.adapter.powered);
    // prepared: our name, powered, not visible, agent registered as NoInputNoOutput
    assert.strictEqual(bt.state.adapter.name, 'ADI-2-Pi Test');
    assert.strictEqual(bt.state.adapter.discoverable, false);
    assert.strictEqual(bt.state.adapter.pairable, false);
    assert.match(ctl(bus.address, 'Agent'), /adi2pi/);
    assert.strictEqual(ctl(bus.address, 'Caps'), 'NoInputNoOutput');

    // a phone can't pair outside the pairing window
    assert.match(ctl(bus.address, 'IncomingPair', 'string:AA:AA:AA:AA:AA:01'), /false/);
    // pairing window: visible, and the phone can pair
    const st = await bt.cmd('pairing', { seconds: 60 });
    assert.ok(st.pairingUntil > Date.now());
    await until(() => bt.state.adapter.discoverable && bt.state.adapter.pairable);
    assert.match(ctl(bus.address, 'IncomingPair', 'string:AA:AA:AA:AA:AA:02'), /true/);
    await until(() => (bt.device('AA:AA:AA:AA:AA:02') || {}).trusted === true);
    const phone = bt.device('AA:AA:AA:AA:AA:02');
    assert.strictEqual(phone.canSend, true);
    assert.strictEqual(phone.canReceive, false);
    // only audio services
    assert.match(ctl(bus.address, 'Authorize', 'string:AA:AA:AA:AA:AA:02', 'string:00001105-0000-1000-8000-00805f9b34fb'), /false/, 'file transfer refused');
    assert.match(ctl(bus.address, 'Authorize', 'string:AA:AA:AA:AA:AA:02', 'string:0000110e-0000-1000-8000-00805f9b34fb'), /true/, 'AVRCP allowed');
    await bt.cmd('pairing', { seconds: 0 });
    await until(() => !bt.state.adapter.discoverable && !bt.state.pairingUntil);

    // search and pair headphones (outside the window: we start it, so the agent accepts)
    await bt.cmd('scan', { seconds: 20 });
    await until(() => bt.device('00:11:22:33:44:55'));
    const hp = bt.device('00:11:22:33:44:55');
    assert.strictEqual(hp.canReceive, true);
    assert.strictEqual(hp.rssi, -50);
    await bt.cmd('pair', { address: '00:11:22:33:44:55' });
    await until(() => { const d = bt.device('00:11:22:33:44:55'); return d.paired && d.trusted && d.connected; });
    assert.strictEqual(bt.device('00:11:22:33:44:55').bonded, true, 'the key is stored although the pairing window is closed');
    await until(() => !bt.state.adapter.pairable, 3000);
    // switched off: still known, connects again without pairing
    await bt.cmd('disconnect', { address: '00:11:22:33:44:55' });
    await until(() => !bt.device('00:11:22:33:44:55').connected);
    await sleep(300);
    assert.ok(bt.device('00:11:22:33:44:55'), 'still paired after disconnecting');
    await bt.cmd('connect', { address: '00:11:22:33:44:55' });
    await until(() => bt.device('00:11:22:33:44:55').connected);
    await bt.cmd('scan', { seconds: 0 });
    await until(() => !bt.state.adapter.discovering);

    // errors come back in plain words
    await assert.rejects(bt.cmd('connect', { address: '66:66:66:66:66:66' }), /Could not reach the device/);
    await assert.rejects(bt.cmd('connect', { address: '12:34:56:78:9A:BC' }), /no longer known|unknown device/);

    await bt.cmd('forget', { address: '00:11:22:33:44:55' });
    await until(() => !bt.device('00:11:22:33:44:55'));
  } finally {
    bt.stop();
    fake.kill();
    bus.proc.kill();
  }
});
