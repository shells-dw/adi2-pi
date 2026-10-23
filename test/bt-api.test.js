'use strict';
/** Bluetooth through the API (simulated Bluetooth + audio). */
const test = require('node:test');
const assert = require('node:assert');
const { MockAdi } = require('../lib/mock-adi');
const { Adi2 } = require('../lib/device');
const { Settings } = require('../lib/settings');
const { createServer } = require('../lib/server');
const { MockBluetooth, MockAudio } = require('../lib/bt-mock');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); } throw new Error('timed out'); }

test('Bluetooth API: view, pairing window, search, pair, volume, out source, name', async () => {
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  const bt = new MockBluetooth({ alias: settings.get().name });
  const audio = new MockAudio({ bt, getSettings: () => settings.get() });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet, bt, audio });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = () => fetch(`${base}/api/bluetooth`).then((r) => r.json());
  const post = (body) => fetch(`${base}/api/bluetooth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    bt.start(); audio.start();
    let v = await get();
    assert.strictEqual(v.available, true);
    assert.deepStrictEqual(v.devices.map((d) => d.name), ['Studio Speaker'], 'only paired devices when not searching');
    assert.strictEqual(v.outSource, 'line');

    assert.ok((await post({ action: 'pairing', seconds: 60 })).body.pairingUntil > Date.now());
    await until(async () => (await get()).devices.some((d) => d.name === 'Pixel 8' && d.audioIn && d.audioIn.linked));

    await post({ action: 'scan', seconds: 20 });
    await until(async () => (await get()).devices.some((d) => d.name === 'WH-1000XM5'));
    const r = await post({ action: 'pair', address: '14:3F:A6:01:02:03' });
    assert.strictEqual(r.status, 200);
    const hp = r.body.devices.find((d) => d.address === '14:3F:A6:01:02:03');
    assert.ok(hp.connected && hp.audioOut && hp.audioOut.codec === 'ldac');
    assert.deepStrictEqual(r.body.loopback, { line: 3 });

    v = (await post({ action: 'volume', address: '14:3F:A6:01:02:03', value: 0.4 })).body;
    assert.strictEqual(v.devices.find((d) => d.address === '14:3F:A6:01:02:03').audioOut.volume, 0.4);

    v = (await post({ action: 'outSource', value: 'off' })).body;
    assert.strictEqual(v.outSource, 'off');
    assert.strictEqual(settings.get().bluetooth.outSource, 'off');
    assert.strictEqual((await post({ action: 'outSource', value: 'radio' })).status, 400);
    assert.strictEqual((await post({ action: 'nonsense' })).status, 400);

    const fail = await post({ action: 'connect', address: '00:1A:7D:DA:71:13' });
    assert.strictEqual(fail.status, 409);
    assert.match(fail.body.error, /Could not reach/);

    // the name other devices see follows the bridge name
    settings.update({ name: 'Living Room' });
    await until(async () => (await get()).adapter.name === 'Living Room');

    // it's part of the full state too
    const st = await fetch(`${base}/api/state`).then((x) => x.json());
    assert.ok(st.bluetooth && Array.isArray(st.bluetooth.devices));
  } finally { bt.stop(); wss.close(); dev.stop(); server.close(); }
});

test('without Bluetooth (--no-bluetooth) the API says so', async () => {
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const v = await fetch(`${base}/api/bluetooth`).then((r) => r.json());
    assert.strictEqual(v.available, false);
    assert.match(v.reason, /no-bluetooth/);
    const r = await fetch(`${base}/api/bluetooth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"scan"}' });
    assert.strictEqual(r.status, 409);
  } finally { wss.close(); dev.stop(); server.close(); }
});

test('Streaming API: list, switch on/off, server, refusals', async () => {
  const { MockReceivers } = require('../lib/bt-mock');
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  const receivers = new MockReceivers({ getSettings: () => settings.get(), updateSettings: (p) => settings.update(p) });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet, receivers });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/streaming`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const v = await fetch(`${base}/api/streaming`).then((r) => r.json());
    assert.deepStrictEqual(v.receivers.map((r) => r.id), ['airplay', 'spotify', 'upnp', 'squeezelite', 'snapcast', 'roon']);
    assert.strictEqual(v.receivers.find((r) => r.id === 'airplay').enabled, true, 'AirPlay on by default');
    let r = await post({ id: 'squeezelite', enabled: true, server: 'lms.local' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(settings.get().receivers.squeezelite, { enabled: true, server: 'lms.local' });
    r = await post({ id: 'squeezelite', server: 'bad host;' });
    assert.strictEqual(r.status, 400);
    r = await post({ id: 'spotify', enabled: true });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /--with-spotify/);
    assert.strictEqual((await post({ id: 'roon', enabled: false })).status, 400);
    const st = await fetch(`${base}/api/state`).then((x) => x.json());
    assert.ok(st.streaming && st.streaming.receivers.length === 6);
  } finally { wss.close(); dev.stop(); server.close(); }
});

test('Routing API: sources, switch, mode, fixed rate, refusals', async () => {
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  const bt = new MockBluetooth({ alias: 'ADI-2-Pi' });
  const audio = new MockAudio({ bt, getSettings: () => settings.get() });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet, bt, audio });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/routing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    bt.start(); audio.start();
    let v = await fetch(`${base}/api/routing`).then((r) => r.json());
    assert.strictEqual(v.available, true);
    assert.strictEqual(v.mode, 'newest');
    assert.strictEqual(v.rate, 0);
    const air = v.sources.find((x) => x.receiver === 'airplay');
    assert.ok(air && air.active);
    // a phone starts streaming via Bluetooth, then switch back to AirPlay
    await bt.cmd('pairing', { seconds: 30 });
    await until(async () => (await fetch(`${base}/api/routing`).then((r) => r.json())).sources.length === 2);
    v = (await post({ action: 'switch', key: air.key })).body;
    assert.ok(v.sources.find((x) => x.key === air.key).active);
    assert.ok(v.sources.find((x) => x.kind === 'bluetooth').muted);
    v = (await post({ action: 'mode', value: 'mix' })).body;
    assert.strictEqual(v.mode, 'mix');
    assert.ok(v.sources.every((x) => !x.muted));
    v = (await post({ action: 'rate', value: 96000 })).body;
    assert.strictEqual(v.rate, 96000);
    assert.strictEqual(settings.get().routing.rate, 96000);
    assert.strictEqual((await post({ action: 'rate', value: 12345 })).status, 400);
    assert.strictEqual((await post({ action: 'mode', value: 'loudest' })).status, 400);
    assert.strictEqual((await post({ action: 'nope' })).status, 400);
    const st = await fetch(`${base}/api/state`).then((x) => x.json());
    assert.ok(st.routing && Array.isArray(st.routing.sources));
  } finally { bt.stop(); wss.close(); dev.stop(); server.close(); }
});
