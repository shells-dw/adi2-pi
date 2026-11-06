'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { AlsaMidiTransport, parseCards, modelHint, findAdi } = require('../lib/transport-alsa');

const CARDS = ` 0 [vc4hdmi0       ]: vc4-hdmi - vc4-hdmi-0
                      vc4-hdmi-0
 1 [vc4hdmi1       ]: vc4-hdmi - vc4-hdmi-1
                      vc4-hdmi-1
 2 [Pro            ]: USB-Audio - ADI-2 Pro (61234567)
                      RME ADI-2 Pro (61234567) at usb-0000:01:00.0-1.3, high speed
`;

test('finds the ADI-2 in /proc/asound/cards', () => {
  const cards = parseCards(CARDS);
  assert.strictEqual(cards.length, 3);
  assert.deepStrictEqual(cards[2], { card: 2, id: 'Pro', driver: 'USB-Audio', name: 'ADI-2 Pro (61234567)', long: 'RME ADI-2 Pro (61234567) at usb-0000:01:00.0-1.3, high speed' });
  assert.strictEqual(modelHint('ADI-2 DAC (1)'), 'dac');
  assert.strictEqual(modelHint('ADI-2/4 Pro SE (1)'), 'se');
  assert.strictEqual(modelHint('ADI-2 Pro (1)'), 'pro');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2-'));
  fs.mkdirSync(path.join(root, 'proc/asound'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dev/snd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proc/asound/cards'), CARDS);
  assert.strictEqual(findAdi(root, root), null, 'no MIDI device node yet');
  fs.writeFileSync(path.join(root, 'dev/snd/midiC2D0'), '');
  assert.deepStrictEqual(findAdi(root, root), { card: 2, name: 'ADI-2 Pro (61234567)', path: `${root}/dev/snd/midiC2D0`, hint: 'pro' });
  fs.rmSync(root, { recursive: true });
});

for (const poll of [false, true]) {
  test(`reads and writes through a device node (FIFO stand-in), input ${poll ? 'polled' : 'through cat'}`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2-'));
    const fifo = path.join(dir, 'midi');
    execFileSync('mkfifo', [fifo]);
    const hold = fs.openSync(fifo, fs.constants.O_RDWR);
    const t = new AlsaMidiTransport({ device: fifo, poll, log: { info() {}, warn() {} } });
    const got = [];
    t.on('data', (d) => got.push(...d));
    await new Promise((r) => { t.on('open', r); t.start(); });
    assert.strictEqual(!!t.reader, !poll);
    fs.writeSync(hold, Buffer.from([0xf0, 0x01, 0xf7]));
    assert.ok(t.write(Buffer.from([0xf0, 0x02, 0xf7])));
    const t0 = Date.now();
    while (got.length < 6 && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(got, [0xf0, 0x01, 0xf7, 0xf0, 0x02, 0xf7]);
    // nothing to read: no reads at all through cat, every 10 ms when polling
    const reads = [];
    const orig = fs.read;
    fs.read = (...a) => { reads.push(1); return orig(...a); };
    await new Promise((r) => setTimeout(r, 200));
    fs.read = orig;
    if (poll) assert.ok(reads.length >= 10, 'polling reads');
    else assert.strictEqual(reads.length, 0, 'no polling reads with cat');
    t.stop();
    assert.strictEqual(t.reader, null);
    fs.closeSync(hold);
    fs.rmSync(dir, { recursive: true });
  });
}

test('the input reader ending closes the port (unplugged) and it is looked for again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2-'));
  const fifo = path.join(dir, 'midi');
  execFileSync('mkfifo', [fifo]);
  const hold = fs.openSync(fifo, fs.constants.O_RDWR);
  const t = new AlsaMidiTransport({ device: fifo, log: { info() {}, warn() {} } });
  const closed = [];
  t.on('close', (r) => closed.push(r));
  await new Promise((r) => { t.on('open', r); t.start(); });
  t.reader.stderr.emit('data', 'cat: /dev/snd/midiC2D0: No such device\n');
  t.reader.kill();
  const t0 = Date.now();
  while (!closed.length && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(closed, ['unplugged']);
  assert.strictEqual(t.isOpen, false);
  assert.ok(t.timer, 'scanning again');
  t.stop();
  fs.closeSync(hold);
  fs.rmSync(dir, { recursive: true });
});
