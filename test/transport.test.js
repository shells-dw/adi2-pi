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

test('reads and writes through a non-blocking device node (FIFO stand-in)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2-'));
  const fifo = path.join(dir, 'midi');
  execFileSync('mkfifo', [fifo]);
  const hold = fs.openSync(fifo, fs.constants.O_RDWR);
  const t = new AlsaMidiTransport({ device: fifo, log: { info() {}, warn() {} } });
  const got = [];
  t.on('data', (d) => got.push(...d));
  await new Promise((r) => { t.on('open', r); t.start(); });
  fs.writeSync(hold, Buffer.from([0xf0, 0x01, 0xf7]));
  assert.ok(t.write(Buffer.from([0xf0, 0x02, 0xf7])));
  const t0 = Date.now();
  while (got.length < 6 && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(got, [0xf0, 0x01, 0xf7, 0xf0, 0x02, 0xf7]);
  t.stop();
  fs.closeSync(hold);
  fs.rmSync(dir, { recursive: true });
});
