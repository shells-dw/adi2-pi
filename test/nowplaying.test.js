'use strict';
/** Now playing: shairport-sync metadata items, librespot events through the hook, Bluetooth AVRCP. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');
const { NowPlaying, PIPE_NAME } = require('../lib/nowplaying');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(10); } throw new Error('timed out'); }
const hex = (s) => Buffer.from(s, 'latin1').toString('hex');
const item = (type, code, data) => `<item><type>${hex(type)}</type><code>${hex(code)}</code><length>${data ? data.length : 0}</length>${data ? `\n<data encoding="base64">\n${Buffer.from(data).toString('base64')}</data>` : ''}</item>\n`;

test('AirPlay: a metadata bundle, progress, play state, cover, end', async () => {
  const np = new NowPlaying({ log: quiet });
  const changes = [];
  np.on('change', (s) => changes.push(s));
  np.buf = item('ssnc', 'mdst') + item('core', 'minm', 'Blue in Green') + item('core', 'asar', 'Miles Davis') + item('core', 'asal', 'Kind of Blue') + item('ssnc', 'mden');
  np._parse();
  let a = np.status().sources.airplay;
  assert.strictEqual(a.title, 'Blue in Green');
  assert.strictEqual(a.artist, 'Miles Davis');
  assert.strictEqual(a.album, 'Kind of Blue');
  assert.strictEqual(a.state, 'stopped');
  np.buf = item('ssnc', 'snam', 'Phone') + item('ssnc', 'pbeg') + item('ssnc', 'prgr', '1000/45100/13231000');
  np._parse();
  a = np.status().sources.airplay;
  assert.strictEqual(a.state, 'playing');
  assert.strictEqual(a.sender, 'Phone');
  assert.strictEqual(a.duration, 300);
  assert.strictEqual(a.position, 1);
  assert.strictEqual(np.status().current, 'airplay');
  // cover in two reads (the item is split)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(3000, 7)]);
  const pict = item('ssnc', 'PICT', png);
  np.buf = pict.slice(0, 500); np._parse();
  assert.strictEqual(np.cover('airplay'), null, 'not complete yet');
  np.buf += pict.slice(500); np._parse();
  assert.strictEqual(np.cover('airplay').type, 'image/png');
  assert.strictEqual(np.cover('airplay').data.length, png.length);
  assert.match(np.status().sources.airplay.cover, /^\/api\/nowplaying\/cover\?source=airplay&v=\d+$/);
  np.buf = item('ssnc', 'pfls'); np._parse();
  assert.strictEqual(np.status().sources.airplay.state, 'paused');
  np.buf = item('ssnc', 'pend'); np._parse();
  a = np.status().sources.airplay;
  assert.strictEqual(a.state, 'stopped');
  assert.strictEqual(a.title, null);
  assert.strictEqual(np.cover('airplay'), null);
  assert.ok(changes.length >= 5);
  np.stop();
});

test('Spotify Connect: librespot 0.5 events and 0.4 events without titles', () => {
  const np = new NowPlaying({ log: quiet });
  np.handleHook({ receiver: 'spotify', event: 'track_changed', name: 'So What', artists: 'Miles Davis', album: 'Kind of Blue', durationMs: 562000, coverUrl: 'https://i.scdn.co/image/x' });
  np.handleHook({ receiver: 'spotify', event: 'playing', positionMs: 5000 });
  let e = np.status().sources.spotify;
  assert.deepStrictEqual([e.title, e.artist, e.album, e.duration, e.position, e.state], ['So What', 'Miles Davis', 'Kind of Blue', 562, 5, 'playing']);
  assert.strictEqual(e.cover, 'https://i.scdn.co/image/x');
  np.handleHook({ receiver: 'spotify', event: 'paused', positionMs: 9000 });
  assert.strictEqual(np.status().sources.spotify.state, 'paused');
  np.handleHook({ receiver: 'spotify', event: 'stopped' });
  assert.strictEqual(np.status().sources.spotify.title, null);
  // 0.4: no names
  np.handleHook({ receiver: 'spotify', event: 'started' });
  e = np.status().sources.spotify;
  assert.strictEqual(e.state, 'playing');
  assert.strictEqual(e.title, null);
  assert.deepStrictEqual(np.handleHook({ receiver: 'spotify', event: 'preloading' }), { ignored: 'event preloading' });
  np.stop();
});

test('Bluetooth: AVRCP track of the connected phone', () => {
  const bt = Object.assign(new EventEmitter(), { state: { devices: [] } });
  const np = new NowPlaying({ bt, log: quiet });
  np.start();
  bt.state.devices = [{ address: 'AA', name: 'Phone', connected: true, player: { status: 'playing', track: { title: 'Freddie Freeloader', artist: 'Miles Davis', album: 'Kind of Blue', duration: 585000 } } }];
  bt.emit('state');
  const e = np.status().sources.bluetooth;
  assert.deepStrictEqual([e.title, e.artist, e.duration, e.state, e.sender], ['Freddie Freeloader', 'Miles Davis', 585, 'playing', 'Phone']);
  assert.strictEqual(np.status().current, 'bluetooth');
  bt.state.devices[0].connected = false;
  bt.emit('state');
  assert.strictEqual(np.status().sources.bluetooth.state, 'stopped');
  np.stop();
});

test('the metadata pipe is created and read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2np-'));
  const np = new NowPlaying({ dataDir: dir, log: quiet });
  np.start();
  await until(() => np.fd !== null);
  assert.ok(fs.statSync(path.join(dir, PIPE_NAME)).isFIFO());
  // a writer like shairport-sync
  execFileSync('sh', ['-c', `printf '%s' "$1" > "$2"`, 'x', item('ssnc', 'mdst') + item('core', 'minm', 'All Blues') + item('ssnc', 'mden') + item('ssnc', 'pbeg'), path.join(dir, PIPE_NAME)]);
  await until(() => np.status().sources.airplay.title === 'All Blues');
  assert.strictEqual(np.status().sources.airplay.state, 'playing');
  np.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
