'use strict';
/**
 * API conformance: every call in docs/API.md, over WebSocket and HTTP, against the simulated
 * ADI-2 plus simulated Bluetooth, audio and receivers – what the Stream Deck plugin and apps rely on.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { MockAdi } = require('../lib/mock-adi');
const { Adi2 } = require('../lib/device');
const { Settings } = require('../lib/settings');
const { createServer } = require('../lib/server');
const { MockBluetooth, MockAudio, MockReceivers } = require('../lib/bt-mock');
const { AutoSource } = require('../lib/autosource');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, what = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(20); }
  throw new Error(`timed out ${what}`);
}

async function start() {
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  settings.on('change', (v) => { dev.settings = v; });
  const bt = new MockBluetooth({ alias: settings.get().name });
  const audio = new MockAudio({ bt, getSettings: () => settings.get() });
  const receivers = new MockReceivers({ getSettings: () => settings.get(), updateSettings: (p) => settings.update(p) });
  const autoSource = new AutoSource({ dev, audio, settings, log: quiet, holdMs: 60000 });
  const usbAudio = { status: () => ({ available: true, card: 9, open: false, rate: null, channels: null, owner: null, lastSet: null }), setRate: async (r) => { if (!(r >= 44100 && r <= 768000)) throw Object.assign(new Error('rate must be 44100…768000'), { status: 400 }); } };
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet, bt, audio, receivers, autoSource, usbAudio });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  dev.start(); bt.start(); audio.start(); receivers.start(); autoSource.start();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  await until(() => dev.ready, 5000, 'device ready');
  const stop = () => { autoSource.stop(); receivers.stop(); bt.stop(); wss.close(); dev.stop(); server.close(); };
  return { mock, dev, settings, bt, audio, base, port, stop };
}

/** WebSocket client with a message log and request/reply by rid. */
function ws(port, headers) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, headers ? { headers } : undefined);
  const msgs = [];
  let rid = 0;
  let closed = null;
  sock.onmessage = (e) => msgs.push(JSON.parse(e.data));
  sock.onclose = (e) => { closed = { code: e.code, reason: e.reason }; };
  const c = {
    msgs, sock,
    get closed() { return closed; },
    send: (o) => sock.send(typeof o === 'string' ? o : JSON.stringify(o)),
    /** send with a rid and wait for the reply carrying it */
    req: async (o) => {
      const id = `r${++rid}`;
      c.send({ ...o, rid: id });
      await until(() => msgs.some((m) => m.rid === id), 4000, `reply to ${JSON.stringify(o)}`);
      return msgs.find((m) => m.rid === id);
    },
    wait: (pred, ms = 4000, what = '') => until(() => msgs.find(pred), ms, what || pred.toString()).then(() => msgs.find(pred)),
    close: () => sock.close(),
  };
  return new Promise((resolve, reject) => { sock.onopen = () => resolve(c); sock.onerror = reject; });
}

const json = (base, p, opt = {}) => fetch(base + p, opt).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), body: /json/.test(r.headers.get('content-type') || '') ? await r.json() : await r.text() }));
const post = (base, p, body, headers = {}) => json(base, p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('discovery: mDNS service _adi2._tcp with path=/ws and api=1', () => {
  const xml = fs.readFileSync(path.join(__dirname, '..', 'systemd', 'adi2-pi.avahi.xml'), 'utf8');
  assert.match(xml, /<type>_adi2\._tcp<\/type>/);
  assert.match(xml, /<txt-record>path=\/ws<\/txt-record>/);
  assert.match(xml, /<txt-record>api=1<\/txt-record>/);
});

test('WebSocket: greeting, sets by name/address, delta, clamping, broadcasts, errors', async () => {
  const b = await start();
  const a = await ws(b.port);
  const other = await ws(b.port);
  try {
    // greeting: hello, state, settings – in that order
    await a.wait((m) => m.t === 'settings');
    assert.deepStrictEqual(a.msgs.slice(0, 3).map((m) => m.t), ['hello', 'state', 'settings']);
    const hello = a.msgs[0];
    assert.strictEqual(hello.api, 1);
    assert.deepStrictEqual(Object.keys(hello.bridge).sort(), ['host', 'name', 'version']);
    for (const k of ['connected', 'ready', 'answering', 'id', 'model', 'modelName', 'port', 'card', 'problem']) assert.ok(k in hello.device, `device.${k}`);
    const st = a.msgs[1];
    for (const k of ['device', 'p', 'setups', 'eqPresets', 'status', 'statusInfo', 'silences', 'bluetooth', 'streaming', 'routing']) assert.ok(k in st, `state.${k}`);
    assert.strictEqual(st.setups.length, 9);
    assert.strictEqual(st.eqPresets.length, 20);
    assert.strictEqual(typeof st.p['9.12'], 'number');

    // by name, display units; reply with rid; the other client gets the broadcast
    let r = await a.req({ t: 'set', ch: 'ph34', id: 'vol', value: -20.5 });
    assert.deepStrictEqual(r, { t: 'ok', rid: r.rid, applied: { '9.12': -205 } });
    await other.wait((m) => m.t === 'p' && m.p['9.12'] === -205 && m.origin === 'client', 4000, 'broadcast');
    assert.strictEqual(b.dev.get(9, 12), -205);
    // without rid: no reply, but the broadcast
    const n = a.msgs.length;
    a.send({ t: 'set', ch: 'ph34', id: 'vol', value: -30 });
    await a.wait((m) => m.t === 'p' && m.p['9.12'] === -300);
    assert.ok(!a.msgs.slice(n).some((m) => m.t === 'ok'));

    // relative: volume, toggle flips, select steps and wraps
    r = await a.req({ t: 'set', ch: 'ph34', id: 'vol', delta: 0.5 });
    assert.deepStrictEqual(r.applied, { '9.12': -295 });
    const mute = b.dev.get(9, 15);
    r = await a.req({ t: 'set', ch: 'ph34', id: 'mute', delta: 1 });
    assert.deepStrictEqual(r.applied, { '9.15': mute ? 0 : 1 });
    await a.req({ t: 'set', ch: 'ph34', id: 'mute', value: 0 });
    await a.req({ t: 'set', ch: 'line', id: 'xfeed', value: 5 });
    r = await a.req({ t: 'set', ch: 'line', id: 'xfeed', delta: 1 });
    assert.deepStrictEqual(r.applied, { '3.8': 0 }, 'select wraps from the last to the first');
    r = await a.req({ t: 'set', ch: 'line', id: 'xfeed', delta: -1 });
    assert.deepStrictEqual(r.applied, { '3.8': 5 }, 'and back');

    // EQ right side, several at once, by address
    r = await a.req({ t: 'set', ch: 'line', id: 'b3g', side: 'R', value: 2 });
    assert.deepStrictEqual(r.applied, { '5.10': 4 });
    r = await a.req({ t: 'set', set: [{ ch: 'line', id: 'mute', value: 1 }, { ch: 'ph34', id: 'dim', value: 1 }] });
    assert.deepStrictEqual(r.applied, { '3.15': 1, '9.16': 1 });
    r = await a.req({ t: 'set', p: { '9.12': -205, '12.15': 1 } });
    assert.deepStrictEqual(r.applied, { '9.12': -205, '12.15': 1 });
    r = await a.req({ t: 'set', ch: 'device', id: 'clock', value: 0 });
    assert.deepStrictEqual(r.applied, { '12.15': 0 });
    r = await a.req({ t: 'set', ch: 'line', id: 'b3f', value: 12500 });
    assert.deepStrictEqual(r.applied, { '4.11': 12500 }, 'EQ frequencies in plain Hz');

    // clamping: range and the bridge's volume limits (Phones 3/4 limit 0 dB by default)
    r = await a.req({ t: 'set', ch: 'ph34', id: 'vol', value: 99 });
    assert.deepStrictEqual(r.applied, { '9.12': 0 });
    r = await a.req({ t: 'set', ch: 'line', id: 'vol', value: 99 });
    assert.deepStrictEqual(r.applied, { '3.12': 60 }, 'Line Out has no limit: the unit\'s +6 dB');
    r = await a.req({ t: 'set', ch: 'line', id: 'vol', value: -999 });
    assert.ok(r.applied['3.12'] <= -940 && r.applied['3.12'] >= -1145);
    r = await a.req({ t: 'set', p: { '9.12': 500 } });
    assert.deepStrictEqual(r.applied, { '9.12': 0 }, 'limits apply to sets by address too');

    // errors: always with the rid, and the bridge keeps running
    const bad = [
      [{ t: 'set', ch: 'ph34', id: 'nope', value: 1 }, /unknown parameter/],
      [{ t: 'set', ch: 'ph34', id: 'vol', value: 'loud' }, /not a number/],
      [{ t: 'set', ch: 'ph34', id: 'vol' }, /no value/],
      [{ t: 'set', ch: 'line', id: 'xfeed', value: 9 }, /xfeed|Crossfeed/],
      [{ t: 'set', ch: 'device', id: 'srate', value: 1 }, /read-only/],
      [{ t: 'set', p: { '12.16': 1 } }, /read-only/],
      [{ t: 'set', p: { '9.12': 'x' } }, /not a number/],
      [{ t: 'set', p: { '9.40': 1 } }, /no parameter|unknown/],
      [{ t: 'set', p: { '13.3': 1 } }, /preset|no parameter|unknown/],
      [{ t: 'set', p: { abc: 1 } }, /bad address/],
      [{ t: 'set' }, /set needs/],
      [{ t: 'setup', action: 'load', n: 10 }, /1–9/],
      [{ t: 'setup', action: 'explode', n: 1 }, /action must be/],
      [{ t: 'storePreset', n: 21, L: { 4: 1 } }, /1–20/],
      [{ t: 'renamePreset', n: 5 }, /empty|name/],
      [{ t: 'raw', hex: 'F0 01 02 F7' }, /RME/],
      [{ t: 'settings', patch: { limits: { ph34: 50 } } }, /limit/],
      [{ t: 'bt', action: 'nonsense' }, /action must be/],
      [{ t: 'routing', action: 'mode', value: 'loudest' }, /newest or mix/],
      [{ t: 'receiver', id: 'roon', enabled: false }, /installer option/],
      [{ t: 'usbRate', rate: 12 }, /rate/],
      [{ t: 'wat' }, /unknown command/],
    ];
    for (const [msg, re] of bad) {
      const e = await a.req(msg);
      assert.strictEqual(e.t, 'err', JSON.stringify(msg));
      assert.match(e.error, re, JSON.stringify(msg));
    }
    // malformed messages: an error, no crash
    for (const raw of ['{nope', 'null', '5', '[]', '"x"', '{}']) a.send(raw);
    await until(() => a.msgs.filter((m) => m.t === 'err' && m.rid === undefined).length >= 6, 4000, 'errors for malformed messages');
    assert.strictEqual((await a.req({ t: 'ping' })).t, 'pong');
    // ping and other data replies come even without a rid
    a.send({ t: 'ping' });
    await a.wait((m) => m.t === 'pong' && m.rid === undefined);

    // get, refresh, usb, sentlog
    assert.strictEqual((await a.req({ t: 'get' })).t, 'state');
    assert.strictEqual((await a.req({ t: 'refresh' })).t, 'ok');
    assert.strictEqual((await a.req({ t: 'usb' })).usb.available, true);
    const sl = await a.req({ t: 'sentlog' });
    assert.ok(sl.sent.length > 5 && sl.sent.every((x) => x.at && x.by && x.what));
    assert.ok(sl.sent.some((x) => /^app \(Stream Deck or other\), this Pi$/.test(x.by)), 'requests from apps are labelled');
  } finally { a.close(); other.close(); b.stop(); }
});

test('WebSocket: setups, EQ presets, monitor, raw, settings, Bluetooth, streaming, routing', async () => {
  const b = await start();
  const a = await ws(b.port);
  try {
    await a.wait((m) => m.t === 'settings');
    // setups
    assert.strictEqual((await a.req({ t: 'setup', action: 'rename', n: 4, name: 'Desk' })).t, 'ok');
    await a.wait((m) => m.t === 'setups' && m.setups[3] === 'Desk');
    assert.strictEqual((await a.req({ t: 'setup', action: 'save', n: 5, name: 'Late' })).t, 'ok');
    await a.wait((m) => m.t === 'setups' && m.setups[4] === 'Late');
    assert.strictEqual((await a.req({ t: 'setup', action: 'load', n: 1 })).t, 'ok');
    assert.strictEqual((await a.req({ t: 'setup', action: 'factory' })).t, 'ok');

    // EQ presets: store (missing values filled), read back, rename
    await until(() => b.dev.presets().filter((p) => p.empty !== null).length === 20, 8000, 'presets read');
    let r = await a.req({ t: 'storePreset', n: 12, name: 'API test', L: { 3: 0, 4: 12, 5: 60 }, dual: false });
    assert.strictEqual(r.t, 'ok');
    assert.strictEqual(r.preset.n, 12);
    assert.strictEqual(r.preset.L[22], 85, 'Bass freq filled from RME defaults');
    await a.wait((m) => m.t === 'eqpresets' && m.eqPresets[11].name === 'API test');
    assert.strictEqual((await a.req({ t: 'renamePreset', n: 12, name: 'Renamed' })).t, 'ok');
    await a.wait((m) => m.t === 'eqpresets' && m.eqPresets[11].name === 'Renamed');

    // monitor: raw MIDI only after asking for it
    assert.ok(!a.msgs.some((m) => m.t === 'midi'));
    assert.strictEqual((await a.req({ t: 'monitor', on: true })).t, 'ok');
    assert.strictEqual((await a.req({ t: 'raw', hex: 'F0 00 20 0D 72 03 09 F7' })).t, 'ok');
    await a.wait((m) => m.t === 'midi' && m.dir === 'tx' && /F0 00 20 0D 72 03 09 F7/i.test(m.hex));
    await a.wait((m) => m.t === 'midi' && m.dir === 'rx');
    await a.req({ t: 'monitor', on: false });

    // the status message: in the state, and as 'status' when it changes
    const gs = await a.req({ t: 'get' });
    assert.strictEqual(typeof gs.status, 'string');
    assert.ok(gs.statusInfo && typeof gs.statusInfo.revision === 'number');

    // bridge settings: patch, reply, broadcast
    r = await a.req({ t: 'settings', patch: { limits: { ph12: -6 }, link: ['line', 'ph34'] } });
    assert.strictEqual(r.t, 'settings');
    assert.strictEqual(r.settings.limits.ph12, -6);
    await a.wait((m) => m.t === 'settings' && m.rid === undefined && m.settings.link.length === 2);
    // linked volumes move together
    const before = b.dev.get(3, 12);
    r = await a.req({ t: 'set', ch: 'ph34', id: 'vol', delta: -1 });
    assert.ok('3.12' in r.applied || b.dev.get(3, 12) !== before, 'linked Line Out followed');

    // Bluetooth
    r = await a.req({ t: 'bt', action: 'pairing', seconds: 30 });
    assert.strictEqual(r.t, 'bluetooth');
    assert.ok(r.bluetooth.pairingUntil > Date.now());
    r = await a.req({ t: 'bt', action: 'gain', value: 8 });
    assert.strictEqual(r.bluetooth.gainDb, 8);
    await a.wait((m) => m.t === 'bluetooth' && m.rid === undefined, 4000, 'bluetooth broadcast');

    // streaming
    r = await a.req({ t: 'receiver', id: 'squeezelite', enabled: true, server: 'lms.local' });
    assert.strictEqual(r.t, 'streaming');
    const sq = r.streaming.receivers.find((x) => x.id === 'squeezelite');
    assert.ok(sq.enabled && sq.server === 'lms.local');
    await a.wait((m) => m.t === 'streaming' && m.rid === undefined, 4000, 'streaming broadcast');

    // routing
    r = await a.req({ t: 'routing', action: 'mode', value: 'mix' });
    assert.strictEqual(r.routing.mode, 'mix');
    r = await a.req({ t: 'routing', action: 'rate', value: 96000 });
    assert.strictEqual(r.routing.rate, 96000);
    r = await a.req({ t: 'routing', action: 'usb', value: { ph34: false } });
    assert.deepStrictEqual(r.routing.auto.usb, { line: true, ph34: false });
    r = await a.req({ t: 'routing', action: 'mode', value: 'newest' });
    const src = r.routing.sources;
    assert.ok(src.length >= 1 && src.every((s) => s.key && s.kind && 'active' in s && 'muted' in s));
    await a.wait((m) => m.t === 'routing' && m.rid === undefined, 4000, 'routing broadcast');
  } finally { a.close(); b.stop(); }
});

test('HTTP: every documented route, status codes, content types', async () => {
  const b = await start();
  const B = b.base;
  try {
    let r = await json(B, '/api/info');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.api, 1);
    assert.strictEqual(r.body.device.model, 'pro');

    r = await json(B, '/api/schema');
    for (const k of ['api', 'params', 'channels', 'groups', 'models', 'modelNames', 'eqDefaults']) assert.ok(k in r.body, `schema.${k}`);
    assert.ok(r.body.params.device.some((p) => p.id === 'loadvol' && p.idx === 62));

    r = await json(B, '/api/state');
    for (const k of ['device', 'p', 'setups', 'eqPresets', 'status', 'statusInfo', 'silences', 'bluetooth', 'streaming', 'routing']) assert.ok(k in r.body, `state.${k}`);
    r = await json(B, '/api/state?view=named');
    assert.strictEqual(typeof r.body.state.ph34.vol, 'number');
    assert.strictEqual(typeof r.body.state.line.eq.L.b3f, 'number');
    assert.strictEqual(typeof r.body.state.device.clock, 'number');
    assert.strictEqual(r.body.setups.length, 9);

    r = await post(B, '/api/set', { ch: 'ph34', id: 'vol', value: -12 });
    assert.deepStrictEqual(r.body, { t: 'ok', applied: { '9.12': -120 } });
    r = await post(B, '/api/set', { ch: 'ph34', id: 'vol', delta: -1 });
    assert.deepStrictEqual(r.body.applied, { '9.12': -130 });
    r = await post(B, '/api/set', { p: { '9.15': 1 } });
    assert.deepStrictEqual(r.body.applied, { '9.15': 1 });
    r = await post(B, '/api/set', { ch: 'ph34', id: 'nope', value: 1 });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown parameter/);

    assert.deepStrictEqual((await post(B, '/api/setup', { action: 'rename', n: 2, name: 'Speakers' })).body, { t: 'ok' });
    assert.strictEqual((await post(B, '/api/setup', { action: 'load', n: 0 })).status, 400);
    assert.deepStrictEqual((await post(B, '/api/refresh', {})).body, { t: 'ok' });

    r = await json(B, '/api/eqpresets');
    assert.strictEqual(r.body.length, 20);
    await until(async () => (await json(B, '/api/eqpresets')).body.every((p) => p.empty !== null), 8000, 'presets');
    r = await post(B, '/api/eqpresets/store', { n: 7, name: 'HTTP', L: { 4: 2 } });
    assert.strictEqual(r.body.t, 'ok');
    r = await post(B, '/api/eqpresets/rename', { n: 7, name: 'HTTP 2' });
    assert.deepStrictEqual(r.body, { t: 'ok' });

    r = await json(B, '/api/status');
    for (const k of ['status', 'info', 'answering', 'silences']) assert.ok(k in r.body);
    r = await json(B, '/api/sent');
    assert.ok(Array.isArray(r.body) && r.body.some((x) => /Phones 3\/4 · Volume = -12/.test(x.what)));

    r = await json(B, '/api/bluetooth');
    assert.strictEqual(r.body.available, true);
    r = await post(B, '/api/bluetooth', { action: 'outSource', value: 'ph34' });
    assert.strictEqual(r.body.outSource, 'ph34');
    r = await json(B, '/api/routing');
    assert.ok('sources' in r.body && 'auto' in r.body);
    r = await post(B, '/api/routing', { action: 'rate', value: 48000 });
    assert.strictEqual(r.body.rate, 48000);
    assert.strictEqual((await post(B, '/api/routing', { action: 'rate', value: 12345 })).status, 400);
    r = await json(B, '/api/streaming');
    assert.ok(r.body.receivers.length >= 5);
    r = await post(B, '/api/streaming', { id: 'upnp', enabled: false });
    assert.strictEqual(r.body.receivers.find((x) => x.id === 'upnp').enabled, false);
    r = await json(B, '/api/trigger');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.available, false, 'no trigger in this test setup');
    assert.strictEqual((await post(B, '/api/trigger', { enabled: true })).status, 409);
    r = await json(B, '/api/usb');
    assert.strictEqual(r.body.available, true);
    r = await post(B, '/api/usb/rate', { rate: 48000 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await post(B, '/api/usb/rate', { rate: 5 })).status, 400);
    r = await json(B, '/api/settings');
    assert.strictEqual(r.body.name, 'ADI-2-Pi');
    r = await post(B, '/api/settings', { riseDbPerSec: 20 });
    assert.strictEqual(r.body.riseDbPerSec, 20);
    assert.strictEqual((await post(B, '/api/settings', { name: '' })).status, 400);

    r = await json(B, '/api/eq/index');
    assert.strictEqual(r.status, 200);
    r = await json(B, '/api/eq/update');
    assert.ok(['idle', 'running', 'done', 'error'].includes(r.body.state));
    assert.strictEqual((await json(B, '/api/eq/file?path=../../etc/passwd')).status >= 400, true);

    // errors
    assert.strictEqual((await json(B, '/api/nothing')).status, 404);
    assert.strictEqual((await post(B, '/api/set', 'ch=ph34', { 'Content-Type': 'text/plain' })).status, 415);
    assert.strictEqual((await post(B, '/api/set', '{bad json')).status, 400);
    assert.strictEqual((await post(B, '/api/set', 'null')).status, 400);
    assert.strictEqual((await post(B, '/api/set', JSON.stringify({ p: { '9.12': 1 }, pad: 'x'.repeat(70000) }))).status, 413);
    r = await post(B, '/api/set', { ch: 'ph34', id: 'vol', value: -10 }, { Origin: 'https://evil.example' });
    assert.strictEqual(r.status, 403);
    r = await post(B, '/api/set', { ch: 'ph34', id: 'vol', value: -10 }, { Origin: `http://127.0.0.1:${b.port}` });
    assert.strictEqual(r.status, 200, 'same host is fine');
    r = await post(B, '/api/set', { ch: 'ph34', id: 'vol', value: -10 }, { Origin: 'null' });
    assert.strictEqual(r.status, 200, 'Origin null (file pages, Stream Deck property inspector) is fine');
  } finally { b.stop(); }
});

test('WebSocket origin rules: foreign sites refused, apps and same host allowed', async () => {
  const b = await start();
  try {
    const evil = await ws(b.port, { Origin: 'https://evil.example' });
    await until(() => evil.closed, 3000, 'close');
    assert.strictEqual(evil.closed.code, 1008);
    assert.ok(!evil.msgs.some((m) => m.t === 'state'), 'no data before closing');
    for (const h of [undefined, { Origin: 'null' }, { Origin: `http://127.0.0.1:${b.port}` }]) {
      const c = await ws(b.port, h);
      await c.wait((m) => m.t === 'hello');
      c.close();
    }
  } finally { b.stop(); }
});

test('unit not answering / not connected: 409 with a clear message, and the device events', async () => {
  const b = await start();
  const a = await ws(b.port);
  try {
    await a.wait((m) => m.t === 'settings');
    // MIDI Control switched off on the unit
    b.mock.midiControl = false;
    if (typeof b.mock.setMidiControl === 'function') b.mock.setMidiControl(false);
    await a.wait((m) => m.t === 'device' && m.device.answering === false, 8000, 'not answering');
    let r = await post(b.base, '/api/set', { ch: 'ph34', id: 'vol', value: -10 });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /not answering|MIDI Control/);
    r = await post(b.base, '/api/setup', { action: 'load', n: 1 });
    assert.strictEqual(r.status, 409);
    const e = await a.req({ t: 'set', ch: 'ph34', id: 'vol', value: -10 });
    assert.strictEqual(e.t, 'err');
    assert.strictEqual(e.status, 409);
    // back
    b.mock.midiControl = true;
    if (typeof b.mock.setMidiControl === 'function') b.mock.setMidiControl(true);
    await a.wait((m) => m.t === 'device' && m.device.answering === true && m.device.ready, 12000, 'answering again');
    // unplugged
    b.mock.unplug('test');
    await a.wait((m) => m.t === 'device' && m.device.connected === false && m.device.problem && m.device.problem.code === 'disconnected');
    r = await post(b.base, '/api/set', { ch: 'ph34', id: 'vol', value: -10 });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /not connected/);
  } finally { a.close(); b.stop(); }
});
