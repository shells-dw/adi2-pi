'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { AutoSource } = require('../lib/autosource');
const { Settings } = require('../lib/settings');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINE = '3.1', PH34 = '9.1';

function fakes({ line = 0, ph34 = 3 } = {}) {
  const dev = new EventEmitter();
  dev.model = 'pro';
  dev.profile = 'pro';
  dev.state = new Map([[LINE, line], [PH34, ph34]]);
  dev.sent = [];
  dev.info = () => ({ connected: true, ready: true, answering: true });
  dev.get = (a, i) => dev.state.get(`${a}.${i}`);
  dev.set = (items, { origin }) => {
    const applied = {};
    for (const it of items) { const k = it.ch === 'line' ? LINE : PH34; dev.state.set(k, it.value); applied[k] = it.value; dev.sent.push(`${it.ch}=${it.value}`); }
    dev.emit('params', applied, origin);
    return { applied, errors: [] };
  };
  // someone changes a source on the unit
  dev.unit = (k, v) => { dev.state.set(k, v); dev.emit('params', { [k]: v }, 'device'); };
  const audio = new EventEmitter();
  audio.playing = false;
  audio.status = () => ({ available: true, sources: audio.playing ? [{ key: 'bt:x', playing: true }] : [] });
  audio.play = (on) => { audio.playing = on; audio.emit('status'); };
  return { dev, audio };
}

test('outputs switch to USB while the Pi plays and back afterwards', async () => {
  const { dev, audio } = fakes({ line: 0, ph34: 3 }); // Line Auto, Phones 3/4 Analog
  const settings = new Settings(null, quiet);
  const a = new AutoSource({ dev, audio, settings, log: quiet, holdMs: 80 });
  a.start();
  assert.deepStrictEqual(dev.sent, []);
  audio.play(true);
  assert.deepStrictEqual(dev.sent, ['line=4', 'ph34=4']);
  assert.deepStrictEqual(settings.get().routing.held, { line: 0, ph34: 3 });
  // a short gap (next track) doesn't switch back
  audio.play(false); await sleep(30); audio.play(true); await sleep(100);
  assert.strictEqual(dev.sent.length, 2);
  audio.play(false); await sleep(150);
  assert.deepStrictEqual(dev.sent.slice(2), ['line=0', 'ph34=3']);
  assert.deepStrictEqual(settings.get().routing.held, { line: null, ph34: null });
  a.stop();
});

test('a source picked by hand while playing is left alone; outputs switched off are not touched', async () => {
  const { dev, audio } = fakes({ line: 0, ph34: 4 }); // Phones 3/4 already on USB 1/2
  const settings = new Settings(null, quiet);
  settings.update({ routing: { usb: { ph34: true, line: true } } });
  const a = new AutoSource({ dev, audio, settings, log: quiet, holdMs: 50 });
  a.start();
  audio.play(true);
  assert.deepStrictEqual(dev.sent, ['line=4']);           // ph34 was on USB already
  dev.unit(LINE, 1);                                      // someone picks AES on the unit
  assert.strictEqual(settings.get().routing.held.line, null);
  audio.play(false); await sleep(100);
  assert.deepStrictEqual(dev.sent, ['line=4']);           // nothing put back
  assert.strictEqual(dev.state.get(LINE), 1);

  settings.update({ routing: { usb: { line: false } } });
  audio.play(true);
  assert.deepStrictEqual(dev.sent, ['line=4']);
  a.stop();
});

test('after a restart, a source switched before is still put back', async () => {
  const { dev, audio } = fakes({ line: 4, ph34: 4 });
  const settings = new Settings(null, quiet);
  settings.update({ routing: { held: { line: 0, ph34: null } } });
  const a = new AutoSource({ dev, audio, settings, log: quiet, holdMs: 50 });
  a.start();
  await sleep(100);
  assert.deepStrictEqual(dev.sent, ['line=0']);
  assert.throws(() => settings.update({ routing: { held: { ph12: 1 } } }), /unknown output/);
  a.stop();
});
