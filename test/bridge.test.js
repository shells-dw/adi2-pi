'use strict';
/** End-to-end: bridge + simulated ADI-2 + HTTP/WebSocket API. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const crypto = require('crypto');
const { MockAdi } = require('../lib/mock-adi');
const { Adi2 } = require('../lib/device');
const { Settings } = require('../lib/settings');
const { createServer } = require('../lib/server');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  throw new Error('timed out waiting');
}

async function start({ model = 'pro', hint, settings: s = {} } = {}) {
  const mock = new MockAdi({ model });
  if (hint) { const plug = mock.plug.bind(mock); mock.plug = () => { plug(); }; mock.start = () => setTimeout(() => { mock.isOpen = true; mock.info = { name: 'x', hint }; mock.emit('open', mock.info); }, 5); }
  const settings = new Settings(null, quiet);
  settings.update(s);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  settings.on('change', (v) => { dev.settings = v; });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  dev.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => { wss.close(); dev.stop(); server.close(); };
  return { mock, dev, settings, base, port: server.address().port, stop };
}

function wsClient(port, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, headers.origin ? { headers } : undefined);
  const msgs = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) });
    ws.onerror = reject;
  });
}
const post = (base, path, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('identifies the unit, reads all settings and setup names', async () => {
  const b = await start();
  try {
    await until(() => b.dev.ready);
    assert.strictEqual(b.dev.model, 'pro');
    assert.strictEqual(b.dev.id, 0x72);
    assert.strictEqual(b.dev.get(9, 12), -300);
    assert.strictEqual(b.dev.setups[0], 'UCX II AES');
    const info = await fetch(`${b.base}/api/info`).then((r) => r.json());
    assert.strictEqual(info.device.modelName, 'ADI-2 Pro / Pro EX');
  } finally { b.stop(); }
});

test('probes other device IDs when the USB name hint is wrong', async () => {
  const b = await start({ model: 'se', hint: 'pro' });
  try {
    await until(() => b.dev.ready);
    assert.strictEqual(b.dev.model, 'se');
    assert.strictEqual(b.dev.id, 0x73);
  } finally { b.stop(); }
});

test('profile: ADI-2/4 Pro EX from the device revision, Basic Mode DAC switches the Source list', async () => {
  const se = await start({ model: 'se' });
  try {
    await until(() => se.dev.ready && se.dev.statusInfo);
    assert.strictEqual(se.dev.profile, 'se', 'device revision 0');
    assert.strictEqual(se.dev.info().modelName, 'ADI-2/4 Pro SE / Pro EX');
  } finally { se.stop(); }
  const b = await start({ model: 'se-ex' });
  try {
    const seen = [];
    b.dev.on('device', (d) => seen.push(d.profile));
    await until(() => b.dev.ready && b.dev.statusInfo);
    assert.strictEqual(b.dev.profile, 'se-ex', 'device revision 1 in the status message');
    assert.ok(seen.includes('se') && seen.includes('se-ex'), 'device event when the status message changed the profile');
    assert.strictEqual(b.dev.info().modelName, 'ADI-2/4 Pro EX');
    let r = await post(b.base, '/api/set', { set: [{ ch: 'device', id: 'basic', value: 5 }] });
    assert.strictEqual(r.body.errors, undefined);
    await until(() => b.dev.profile === 'se-ex@dac');
    // value 3 is Optical in Basic Mode DAC
    r = await post(b.base, '/api/set', { set: [{ ch: 'line', id: 'src', value: 7 }] });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /not one of 0–6 \(Auto, AES, SPDIF c, Optical, Analog, USB 1\/2, USB 3\/4\)/);
    // input Ref Level of the EX goes down to -6 (-35 dBu)
    r = await post(b.base, '/api/set', { set: [{ ch: 'in', id: 'inref', value: -6 }] });
    assert.strictEqual(r.body.errors, undefined);
    await until(() => b.dev.get(0, 1) === -6);
    assert.match(b.dev.sentLog.at(-1).what, /Ref Level = -35 dBu/);
  } finally { b.stop(); }
});

test('toggle outputs: device parameter 63 is sent, the new state read back', async () => {
  const b = await start();
  try {
    await until(() => b.dev.ready);
    const before = b.dev.get(3, 15);
    const r = await post(b.base, '/api/toggle-outputs', {});
    assert.strictEqual(r.status, 200);
    assert.ok(b.mock.received.some((m) => m.cmd === 2 && m.params && m.params.some((p) => p.addr === 12 && p.idx === 63)));
    await until(() => b.dev.get(3, 15) === (before ? 0 : 1), 3000);
    assert.strictEqual(b.dev.get(12, 63), undefined, 'not a setting');
    assert.match(b.dev.sentLog.at(-1).what, /toggle outputs/);
  } finally { b.stop(); }
});

test('sets reach the unit (coalesced into one message) and are read back', async () => {
  const b = await start({ settings: { limits: { ph34: null } } });
  try {
    await until(() => b.dev.ready);
    const before = b.mock.received.length;
    const r = await post(b.base, '/api/set', { set: [
      { ch: 'ph34', id: 'vol', value: -12.5 },
      { ch: 'line', id: 'mute', value: 1 },
      { ch: 'ph12', id: 'b3f', side: 'R', value: 3453 },
      { key: '12.15', value: 1 },
    ] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.applied, { '9.12': -125, '3.15': 1, '8.11': 3450, '12.15': 1 });
    await until(() => b.mock.get(9, 12) === -125);
    const sets = b.mock.received.slice(before).filter((m) => m.cmd === 2);
    assert.strictEqual(sets.length, 1, 'one SysEx for four parameters');
    assert.strictEqual(b.mock.get(8, 11), 3450);
    assert.strictEqual(b.mock.get(12, 15), 1);
    // read-back request ~1.5 s later
    await until(() => b.mock.received.slice(before).some((m) => m.cmd === 3), 2500);
  } finally { b.stop(); }
});

test('relative changes and toggles by name', async () => {
  const b = await start();
  try {
    await until(() => b.dev.ready);
    await post(b.base, '/api/set', { ch: 'line', id: 'vol', delta: -1.5 });
    await post(b.base, '/api/set', { ch: 'line', id: 'mute', delta: 1 });
    await post(b.base, '/api/set', { ch: 'line', id: 'xfeed', delta: -1 });
    await until(() => b.mock.get(3, 12) === -215 && b.mock.get(3, 15) === 1);
    assert.strictEqual(b.dev.get(3, 8), 5, 'select wraps around');
    const ro = await post(b.base, '/api/set', { ch: 'device', id: 'srate', value: 3 });
    assert.strictEqual(ro.status, 400, 'sample rate is display-only');
    const st = await fetch(`${b.base}/api/status`).then((r) => r.json());
    assert.strictEqual(st.info.revision, 1);
  } finally { b.stop(); }
});

test('volume limit and linked volumes', async () => {
  const b = await start({ settings: { limits: { ph12: -10, ph34: null, line: null }, link: ['ph12', 'ph34'] } });
  try {
    await until(() => b.dev.ready);
    // ph12 −30 → −20 (+10), linked ph34 −30 → −20
    await post(b.base, '/api/set', { ch: 'ph12', id: 'vol', value: -20 });
    await until(() => b.mock.get(9, 12) === -200);
    assert.strictEqual(b.mock.get(6, 12), -200);
    // limit: ph12 can't go above −10
    const r = await post(b.base, '/api/set', { ch: 'ph12', id: 'vol', value: 6 });
    assert.strictEqual(r.body.applied['6.12'], -100);
    assert.strictEqual(r.body.applied['9.12'], -100, 'linked output follows the clamped change');
  } finally { b.stop(); }
});

test('rise speed limit ramps increases, decreases are immediate', async () => {
  const b = await start({ settings: { limits: { ph34: null }, riseDbPerSec: 40 } });
  try {
    await until(() => b.dev.ready);
    const t0 = Date.now();
    await post(b.base, '/api/set', { ch: 'ph34', id: 'vol', value: -10 }); // +20 dB at 40 dB/s ≈ 0.5 s
    await sleep(150);
    const mid = b.mock.get(9, 12);
    assert.ok(mid > -300 && mid < -100, `ramping (${mid})`);
    await until(() => b.mock.get(9, 12) === -100, 2000);
    assert.ok(Date.now() - t0 >= 400);
    await post(b.base, '/api/set', { ch: 'ph34', id: 'vol', value: -40 });
    await until(() => b.mock.get(9, 12) === -400, 200);
  } finally { b.stop(); }
});

test('WebSocket: hello/state, broadcasts, front-panel changes, errors', async () => {
  const b = await start();
  try {
    await until(() => b.dev.ready);
    const a = await wsClient(b.port);
    const c = await wsClient(b.port);
    await until(() => a.msgs.some((m) => m.t === 'state'));
    assert.strictEqual(a.msgs[0].t, 'hello');
    assert.strictEqual(a.msgs[0].api, 1);
    const st = a.msgs.find((m) => m.t === 'state');
    assert.strictEqual(st.p['9.12'], -300);

    a.send({ t: 'set', ch: 'ph34', id: 'mute', value: 1, rid: 7 });
    await until(() => a.msgs.some((m) => m.t === 'ok' && m.rid === 7));
    await until(() => c.msgs.some((m) => m.t === 'p' && m.p['9.15'] === 1 && m.origin === 'client'));

    b.mock.frontPanel(6, 12, -255); // knob turned on the unit
    await until(() => c.msgs.some((m) => m.t === 'p' && m.p['6.12'] === -255 && m.origin === 'device'));

    a.send({ t: 'set', ch: 'nope', id: 'vol', value: 1, rid: 8 });
    await until(() => a.msgs.some((m) => m.t === 'err' && m.rid === 8));
    a.send({ t: 'raw', hex: '01 02 03', rid: 9 });
    await until(() => a.msgs.some((m) => m.t === 'err' && m.rid === 9));

    a.send({ t: 'monitor', on: true });
    a.send({ t: 'refresh' });
    await until(() => a.msgs.some((m) => m.t === 'midi' && m.dir === 'rx'));
    assert.ok(!c.msgs.some((m) => m.t === 'midi'), 'monitor only goes to clients that asked');
    a.ws.close(); c.ws.close();
  } finally { b.stop(); }
});

test('setups: load and save', async () => {
  const b = await start();
  try {
    await until(() => b.dev.ready);
    await post(b.base, '/api/set', { ch: 'line', id: 'vol', value: -5 });
    await until(() => b.mock.get(3, 12) === -50);
    assert.strictEqual((await post(b.base, '/api/setup', { action: 'save', n: 4 })).status, 200);
    await post(b.base, '/api/set', { ch: 'line', id: 'vol', value: -60 });
    await until(() => b.mock.get(3, 12) === -600);
    await post(b.base, '/api/setup', { action: 'load', n: 4 });
    await until(() => b.dev.get(3, 12) === -50, 3000);
    assert.strictEqual((await post(b.base, '/api/setup', { action: 'load', n: 12 })).status, 400);
  } finally { b.stop(); }
});

test('unplug and replug', async () => {
  const b = await start();
  try {
    await until(() => b.dev.ready);
    b.mock.unplug();
    await until(() => !b.dev.connected);
    const r = await post(b.base, '/api/set', { ch: 'line', id: 'vol', value: -10 });
    assert.strictEqual(r.status, 409, 'the unit can\'t take it right now (not a bad request)');
    assert.match(r.body.error, /not connected/);
    // while unplugged, the old unit's values are gone; the replugged one is read out again
    assert.strictEqual(b.dev.state.size, 0, 'no values from the unplugged unit');
    assert.strictEqual(b.dev.lastStatus, null);
    b.mock.plug();
    await until(() => b.dev.ready);
    assert.ok(b.dev.state.size > 20, 'values read from the unit again');
  } finally { b.stop(); }
});

test('settings validation', async () => {
  const b = await start();
  try {
    assert.strictEqual((await post(b.base, '/api/settings', { limits: { ph12: 20 } })).status, 400);
    const unk = await post(b.base, '/api/settings', { trigge: { enabled: true } });
    assert.strictEqual(unk.status, 400, 'an unknown setting is an error, not silently ignored');
    assert.match(unk.body.error, /unknown setting trigge/);
    assert.strictEqual((await post(b.base, '/api/settings', { link: ['ph12'] })).body.link.length, 0, 'a link needs two outputs');
    const ok = await post(b.base, '/api/settings', { name: 'Desk', limits: { ph12: -6 } });
    assert.strictEqual(ok.body.name, 'Desk');
    assert.strictEqual(ok.body.limits.ph12, -6);
  } finally { b.stop(); }
});

test('cross-site requests from other web pages are refused', async () => {
  const b = await start();
  try {
    await until(() => b.dev.ready);
    // simple form-style POST (no preflight) must not work
    const r1 = await fetch(`${b.base}/api/set`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"ch":"line","id":"vol","value":6}' });
    assert.strictEqual(r1.status, 415);
    const r2 = await post(b.base, '/api/set', { ch: 'line', id: 'vol', value: 6 }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' });
    assert.strictEqual(r2.status, 403);
    // WebSocket from a foreign origin is closed
    const closed = await new Promise((resolve) => {
      const sock = net.connect(b.port, '127.0.0.1', () => {
        sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: https://evil.example\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`);
      });
      let data = Buffer.alloc(0);
      sock.on('data', (d) => { data = Buffer.concat([data, d]); });
      sock.on('close', () => resolve(data));
      setTimeout(() => sock.destroy(), 1500);
    });
    // 101, then a close frame (0x88) with code 1008
    const i = closed.indexOf('\r\n\r\n') + 4;
    assert.strictEqual(closed[i], 0x88);
    assert.strictEqual(closed.readUInt16BE(i + 2), 1008);
  } finally { b.stop(); }
});

test('logs every change sent to the unit with who sent it; reading sends nothing', async () => {
  const b = await start();
  try {
    await until(() => b.dev.ready);
    await sleep(300);
    assert.deepStrictEqual(b.dev.sentLog, []); // connecting and reading changes nothing
    const r = await post(b.base, '/api/set', { set: [{ ch: 'ph34', id: 'src', value: 4 }] }, { 'Content-Type': 'application/json', 'User-Agent': 'node' });
    assert.strictEqual(r.status, 200);
    const log = await fetch(`${b.base}/api/sent`).then((x) => x.json());
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].what, 'Phones 3/4 · Source = USB 1/2');
    assert.match(log[0].by, /^app .*this Pi$/);
    b.dev.set([{ ch: 'line', id: 'loop', value: 3 }], { origin: 'bridge' });
    assert.match(b.dev.sentLog[1].by, /Loopback/);
  } finally { b.stop(); }
});
