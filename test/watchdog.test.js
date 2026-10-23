'use strict';
/** The unit stops answering (MIDI Control switched off) and comes back; USB sample rate. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/protocol');
const { MockAdi } = require('../lib/mock-adi');
const { Adi2 } = require('../lib/device');
const { UsbAudio } = require('../lib/usb-audio');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(20); }
  throw new Error('timed out');
}

test('notices when the unit stops answering, says why, and picks up again', async () => {
  const mock = new MockAdi({ model: 'pro' });
  const dev = new Adi2({ transport: mock, settings: { limits: {} }, log: quiet, silentMs: 1500 });
  const events = [];
  dev.on('device', (d) => events.push(d));
  try {
    dev.start();
    await until(() => dev.ready);
    assert.strictEqual(dev.info().answering, true);
    // something is sent, then MIDI Control goes off on the unit
    dev.storeEqPreset(5, { L: { 4: 6 } }, 'Test');
    await sleep(100);
    mock.setMidiControl(false);
    await until(() => dev.info().answering === false, 4000);
    const info = dev.info();
    assert.strictEqual(info.problem.code, 'silent');
    assert.match(info.problem.text, /MIDI Control/);
    const s = dev.silences[0];
    assert.ok(s.sent.some((m) => m.what === 'store EQ preset 5 (flags word)'), JSON.stringify(s.sent));
    assert.ok(s.sent.some((m) => m.what === 'name EQ preset 5 "Test"'));
    // sets are refused instead of silently going nowhere
    const r = dev.set([{ ch: 'line', id: 'vol', value: -30 }]);
    assert.match(r.errors[0], /not answering/);
    assert.throws(() => dev.loadSetup(1), /not answering/);
    // MIDI Control back on: the bridge's next request wakes the unit up
    mock.setMidiControl(true);
    await until(() => dev.info().answering === true, 5000);
    assert.strictEqual(dev.info().problem, null);
    assert.ok(dev.silences[0].back);
    assert.strictEqual(dev.set([{ ch: 'line', id: 'vol', value: -30 }]).errors.length, 0);
  } finally { dev.stop(); }
});

test('describes messages in plain words', () => {
  assert.strictEqual(P.describe(P.requestAll(0x72)), 'read all settings');
  assert.strictEqual(P.describe(P.loadSetup(0x72, 2)), 'load setup 2');
  assert.strictEqual(P.describe(P.loadFactory(0x72)), 'load factory defaults');
  assert.strictEqual(P.describe(P.paramsToDevice(0x72, [{ addr: 3, idx: 12, value: -200 }])[0]), 'set 3.12=-200');
});

function fakeProc({ open }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2pi-proc-'));
  const sub = path.join(root, 'proc', 'asound', 'card2', 'pcm0p', 'sub0');
  fs.mkdirSync(sub, { recursive: true });
  if (open) {
    fs.writeFileSync(path.join(sub, 'hw_params'), 'access: MMAP_INTERLEAVED\nformat: S32_LE\nsubformat: STD\nchannels: 2\nrate: 96000 (96000/1)\n');
    fs.writeFileSync(path.join(sub, 'status'), 'state: RUNNING\nowner_pid   : 4321\n');
    fs.mkdirSync(path.join(root, 'proc', '4321'));
    fs.writeFileSync(path.join(root, 'proc', '4321', 'comm'), 'squeezelite\n');
  } else {
    fs.writeFileSync(path.join(sub, 'hw_params'), 'closed\n');
    fs.writeFileSync(path.join(sub, 'status'), 'closed\n');
  }
  return root;
}

test('USB sample rate: set by opening the playback device, refused while a player has it', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    // the unit takes 2 channels, but not 16 bit only… first format works
    return { ok: true, out: '' };
  };
  const usb = new UsbAudio({ getCard: () => 2, log: quiet, procRoot: fakeProc({ open: false }), run });
  assert.deepStrictEqual(usb.status().open, false);
  await usb.setRate(48000);
  assert.deepStrictEqual(calls[0].slice(0, 9), ['-q', '-D', 'hw:2,0', '-t', 'raw', '-c', '2', '-r', '48000']);
  assert.strictEqual(usb.status().lastSet.rate, 48000);
  await assert.rejects(usb.setRate(12345), /must be one of/);

  const busy = new UsbAudio({ getCard: () => 2, log: quiet, procRoot: fakeProc({ open: true }), run });
  const st = busy.status();
  assert.strictEqual(st.rate, 96000);
  assert.strictEqual(st.owner, 'squeezelite');
  await assert.rejects(busy.setRate(44100), /squeezelite is playing to the ADI-2 at 96 kHz/);

  // multi-channel mode: 2 channels refused, 8 accepted
  const mc = [];
  const run8 = async (args) => { mc.push(args); return args[6] === '8' ? { ok: true, out: '' } : { ok: false, out: 'Channels count non available' }; };
  const usb8 = new UsbAudio({ getCard: () => 2, log: quiet, procRoot: fakeProc({ open: false }), run: run8 });
  await usb8.setRate(96000);
  assert.strictEqual(mc[mc.length - 1][6], '8');

  const none = new UsbAudio({ getCard: () => null, log: quiet, run });
  assert.strictEqual(none.status().available, false);
  await assert.rejects(none.setRate(48000), /not found/);
});
