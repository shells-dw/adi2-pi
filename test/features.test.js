'use strict';
/**
 * Scenes, actions, sleep timer, start volume, sender volume, backup/restore, access key and MQTT,
 * against the simulated ADI-2.
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { EventEmitter } = require('events');
const { MockAdi } = require('../lib/mock-adi');
const { Adi2 } = require('../lib/device');
const { Settings } = require('../lib/settings');
const { createServer } = require('../lib/server');
const { Automation } = require('../lib/automation');
const { StreamVolume } = require('../lib/streamvol');
const { Restore, makeBackup } = require('../lib/backup');
const { MqttBridge } = require('../lib/mqtt-bridge');
const mq = require('../lib/mqtt');
const cat = require('../lib/catalog');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, what = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(15); }
  throw new Error(`timed out ${what}`);
}

async function unit(model = 'pro') {
  const mock = new MockAdi({ model });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  settings.on('change', (v) => { dev.settings = v; });
  dev.start();
  await until(() => dev.ready, 5000, 'device ready');
  return { mock, dev, settings };
}
const disp = (dev, ch, id) => { const r = cat.resolve(ch, id); const v = dev.state.get(cat.key(r.addr, r.idx)); return v === undefined ? undefined : cat.toDisplay(r.param, v); };

test('scenes: capture, apply only the listed values, delete removes its actions', async () => {
  const { dev, settings } = await unit();
  const a = new Automation({ dev, settings, log: quiet });
  try {
    dev.set([{ ch: 'ph34', id: 'vol', value: -30 }, { ch: 'ph34', id: 'loud', value: 1 }]);
    const sc = a.saveScene({ name: 'Late night', params: [{ ch: 'ph34', id: 'vol' }, { ch: 'ph34', id: 'loud' }] });
    assert.deepStrictEqual(sc.items, [{ ch: 'ph34', id: 'vol', value: -30 }, { ch: 'ph34', id: 'loud', value: 1 }]);
    dev.set([{ ch: 'ph34', id: 'vol', value: -10 }, { ch: 'ph34', id: 'loud', value: 0 }, { ch: 'line', id: 'vol', value: -12 }]);
    a.applyScene(sc.id);
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -30);
    assert.strictEqual(disp(dev, 'ph34', 'loud'), 1);
    assert.strictEqual(disp(dev, 'line', 'vol'), -12, 'not in the scene: unchanged');
    settings.update({ rules: [{ when: { type: 'unit-on' }, scene: sc.id }] });
    a.deleteScene(sc.id);
    assert.strictEqual(settings.get().scenes.length, 0);
    assert.strictEqual(settings.get().rules.length, 0, 'its action went with it');
    assert.throws(() => settings.update({ rules: [{ when: { type: 'unit-on' }, scene: 'nope' }] }), /existing scene/);
    assert.throws(() => settings.update({ scenes: [{ name: 'x', items: [{ ch: 'ph34', id: 'nope', value: 1 }] }] }), /unknown parameter/);
  } finally { a.stop(); dev.stop(); }
});

test('actions: time of day, Bluetooth connect, playback start/stop', async () => {
  const { dev, settings } = await unit();
  const bt = Object.assign(new EventEmitter(), { state: { devices: [{ address: 'AA:BB:CC:DD:EE:01', name: 'Phone', connected: false }] } });
  const audio = Object.assign(new EventEmitter(), { st: { sources: [] }, status() { return this.st; } });
  let now = new Date(2026, 9, 24, 21, 59);
  const a = new Automation({ dev, settings, bt, audio, log: quiet, now: () => now, tickMs: 10 });
  a.start();
  try {
    const mk = (name, v) => settings.update({ scenes: [...settings.get().scenes, { name, items: [{ ch: 'ph34', id: 'vol', value: v }] }] }).scenes.at(-1).id;
    const night = mk('night', -40), phone = mk('phone', -25), play = mk('play', -22), stop = mk('stop', -50);
    settings.update({ rules: [
      { when: { type: 'time', at: '22:00', days: [6] }, scene: night },  // 24 Oct 2026 is a Saturday
      { when: { type: 'bt-connect', address: 'aa:bb:cc:dd:ee:01' }, scene: phone },
      { when: { type: 'play-start', source: 'airplay' }, scene: play },
      { when: { type: 'play-stop', source: 'any' }, scene: stop },
    ] });
    dev.set([{ ch: 'ph34', id: 'vol', value: -10 }]);
    await sleep(40);
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -10, '21:59: nothing');
    now = new Date(2026, 9, 24, 22, 0);
    await until(() => disp(dev, 'ph34', 'vol') === -40, 2000, 'time action');
    bt.state.devices[0].connected = true; bt.emit('state');
    await until(() => disp(dev, 'ph34', 'vol') === -25, 2000, 'Bluetooth action');
    audio.st = { sources: [{ kind: 'receiver', receiver: 'airplay', playing: true }] }; audio.emit('status');
    await until(() => disp(dev, 'ph34', 'vol') === -22, 2000, 'play-start action');
    audio.st = { sources: [] }; audio.emit('status');
    await until(() => disp(dev, 'ph34', 'vol') === -50, 2000, 'play-stop action');
    assert.strictEqual(a.view().fired.length, 4);
    settings.update({ rules: settings.get().rules.map((r) => ({ ...r, enabled: false })) });
    bt.state.devices[0].connected = false; bt.emit('state'); bt.state.devices[0].connected = true; bt.emit('state');
    await sleep(40);
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -50, 'disabled actions do nothing');
  } finally { a.stop(); dev.stop(); }
});

test('start volume: louder outputs go down when the unit becomes usable', async () => {
  const { mock, dev, settings } = await unit();
  const a = new Automation({ dev, settings, log: quiet });
  a.start();
  try {
    settings.update({ startVolume: { enabled: true, levels: { ph34: -30, line: null } } });
    dev.set([{ ch: 'ph34', id: 'vol', value: -5 }, { ch: 'line', id: 'vol', value: 0 }, { ch: 'ph12', id: 'vol', value: -40 }]);
    await sleep(50);
    mock.stop(); await until(() => !dev.connected, 3000, 'gone');
    mock.start(); await until(() => dev.ready, 6000, 'back');
    await until(() => disp(dev, 'ph34', 'vol') === -30, 3000, 'start volume');
    assert.strictEqual(disp(dev, 'line', 'vol'), 0, 'no level: unchanged');
    assert.strictEqual(disp(dev, 'ph12', 'vol'), -40, 'quieter than its level: unchanged');
  } finally { a.stop(); dev.stop(); }
});

test('sleep timer: fades, mutes, puts the volume back; cancel restores', async () => {
  const { dev, settings } = await unit();
  const a = new Automation({ dev, settings, log: quiet });
  a.start();
  try {
    settings.update({ sleep: { outputs: ['ph34'], fadeSec: 1 } });
    dev.set([{ ch: 'ph34', id: 'vol', value: -20 }, { ch: 'ph34', id: 'mute', value: 0 }]);
    a.startSleep(1);
    a.sleepState.until = Date.now() + 1200; // shorten: fade starts now
    clearTimeout(a.sleepState.timer);
    a._fadeStart();
    await until(() => disp(dev, 'ph34', 'vol') < -30, 2000, 'fading');
    await until(() => disp(dev, 'ph34', 'mute') === 1, 3000, 'muted');
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -20, 'volume back after the mute');
    assert.strictEqual(a.sleepStatus(), null);

    dev.set([{ ch: 'ph34', id: 'mute', value: 0 }]);
    settings.update({ sleep: { fadeSec: 30 } });
    a.startSleep(1); clearTimeout(a.sleepState.timer); a._fadeStart();
    await until(() => disp(dev, 'ph34', 'vol') < -20, 3000, 'fading again');
    a.cancelSleep();
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -20, 'cancel during the fade: level back');
    assert.throws(() => a.startSleep(0), /minutes/);
  } finally { a.stop(); dev.stop(); }
});

test('sender volume: AirPlay and Spotify positions map onto the range, mute', async () => {
  const { dev, settings } = await unit();
  const sv = new StreamVolume({ dev, settings, log: quiet });
  try {
    assert.ok(sv.handle('airplay', -15).ignored, 'off by default');
    settings.update({ streamVolume: { enabled: true, outputs: ['ph34'], minDb: -60, maxDb: -10 } });
    sv.handle('airplay', -15);
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -35);
    sv.handle('airplay', 0);
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -10);
    sv.handle('airplay', -144);
    assert.strictEqual(disp(dev, 'ph34', 'mute'), 1);
    sv.handle('spotify', 65535 / 5);
    assert.strictEqual(disp(dev, 'ph34', 'mute'), 0, 'unmuted by the next volume');
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -50);
    settings.update({ limits: { ph34: -20 } });
    sv.handle('airplay', 0);
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -20, 'volume limit applies');
    settings.update({ streamVolume: { spotify: false } });
    assert.ok(sv.handle('spotify', 0).ignored);
    assert.throws(() => sv.handle('airplay', 'x'), /bad volume/);
    const recent = new StreamVolume({ dev, settings, log: quiet, receiverSince: () => Date.now() });
    assert.ok(recent.handle('airplay', 0).ignored, 'start-up messages are ignored');
  } finally { dev.stop(); }
});

test('backup and restore: values, presets, setup names, settings; other model refused', async () => {
  const { dev, settings } = await unit();
  try {
    dev.set([{ ch: 'line', id: 'vol', value: -33 }, { ch: 'ph34', id: 'xfeed', value: 2 }]);
    settings.update({ name: 'Studio', scenes: [{ name: 'A', items: [{ ch: 'line', id: 'vol', value: -20 }] }], access: { key: 'secret12' }, mqtt: { host: 'mq.local', password: 'pw' } });
    await sleep(50);
    const b = JSON.parse(JSON.stringify(makeBackup({ dev, settings, version: 'test' })));
    assert.strictEqual(b.format, 'adi2-pi-backup');
    assert.ok(!JSON.stringify(b).includes('secret12') && !JSON.stringify(b).includes('"pw"'), 'no key, no password');
    assert.ok(!Object.keys(b.values).includes(cat.key(cat.resolve('line', 'eqpreset').addr, cat.resolve('line', 'eqpreset').idx)), 'EQ Preset select left out');
    // change things, then restore
    dev.set([{ ch: 'line', id: 'vol', value: -60 }, { ch: 'ph34', id: 'xfeed', value: 0 }]);
    settings.update({ name: 'Other', scenes: [] });
    const r = new Restore({ dev, settings, log: quiet });
    r.start(b, {});
    await until(() => r.status().state !== 'running', 15000, 'restore');
    assert.strictEqual(r.status().state, 'done', JSON.stringify(r.status()));
    assert.strictEqual(disp(dev, 'line', 'vol'), -33);
    assert.strictEqual(disp(dev, 'ph34', 'xfeed'), 2);
    assert.strictEqual(settings.get().name, 'Studio');
    assert.strictEqual(settings.get().scenes[0].name, 'A');
    assert.strictEqual(settings.get().mqtt.password, 'pw', 'password on this Pi stays');
    assert.ok(settings.keyRequired, 'access key stays');
    assert.throws(() => r.start({ ...b, model: 'dac', modelName: 'ADI-2 DAC' }, { values: true }), /backup is from/);
    assert.throws(() => r.start({ format: 'x' }), /not an ADI-2-Pi backup/);
  } finally { dev.stop(); }
});

test('access key: HTTP and WebSocket need it, /api/info stays open, lockout, no key in settings', async () => {
  const { dev, settings } = await unit();
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet, trustLoopback: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, h = {}) => fetch(base + p, { headers: h }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  try {
    assert.strictEqual((await get('/api/state')).status, 200, 'no key set: open');
    settings.update({ access: { key: 'geheim12' } });
    assert.strictEqual((await get('/api/state')).status, 401);
    assert.strictEqual((await get('/api/info')).body.bridge.auth, true);
    assert.strictEqual((await get('/api/state', { Authorization: 'Bearer geheim12' })).status, 200);
    assert.strictEqual((await get('/api/state', { 'X-ADI2PI-Key': 'geheim12' })).status, 200);
    assert.strictEqual((await get('/api/state?key=geheim12')).status, 200);
    const s = (await get('/api/settings', { 'X-ADI2PI-Key': 'geheim12' })).body;
    assert.deepStrictEqual(s.access, { enabled: true, viewOpen: false });
    assert.ok(!JSON.stringify(s).includes(settings.get().access.hash));
    // WebSocket
    const closed = await new Promise((resolve) => { const w = new WebSocket(base.replace('http', 'ws') + '/ws'); w.onclose = (e) => resolve(e.code); });
    assert.strictEqual(closed, 4401);
    const ok = await new Promise((resolve) => { const w = new WebSocket(`${base.replace('http', 'ws')}/ws?key=geheim12`); w.onmessage = (e) => { if (JSON.parse(e.data).t === 'hello') { w.close(); resolve(true); } }; w.onclose = () => resolve(false); });
    assert.ok(ok);
    // the reference client with and without the key
    const { Adi2PiClient } = require('../clients/adi2pi-client');
    const c1 = new Adi2PiClient({ url: `${base.replace('http', 'ws')}/ws`, key: 'geheim12' });
    await new Promise((resolve) => { c1.on('ready', resolve); c1.start(); });
    await c1.loadSchema();
    assert.strictEqual(typeof c1.get('ph34', 'vol'), 'number');
    c1.stop();
    const c2 = new Adi2PiClient({ url: `${base.replace('http', 'ws')}/ws` });
    await new Promise((resolve) => { c2.on('unauthorized', resolve); c2.start(); });
    c2.stop();
    // ten wrong keys: locked out for a minute, even with the right one
    for (let i = 0; i < 10; i++) await get('/api/state', { 'X-ADI2PI-Key': 'wrong' });
    assert.strictEqual((await get('/api/state', { 'X-ADI2PI-Key': 'geheim12' })).status, 429);
    assert.throws(() => settings.update({ access: { key: '123' } }), /6…128/);
  } finally { wss.close(); server.close(); dev.stop(); }
});

test('access key, changes only: reads go without it, writes and the backup need it', async () => {
  const { dev, settings } = await unit();
  const automation = new Automation({ dev, settings, log: quiet });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet, automation, trustLoopback: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (p, opts = {}) => fetch(base + p, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const post = (p, body, h = {}) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
  try {
    settings.update({ access: { key: 'geheim12', viewOpen: true } });
    assert.strictEqual((await req('/api/state')).status, 200, 'state readable without the key');
    assert.strictEqual((await req('/api/info')).body.bridge.viewOpen, true);
    assert.strictEqual((await req('/api/backup')).status, 401, 'the backup holds settings: key');
    assert.strictEqual((await post('/api/set', { ch: 'ph34', id: 'vol', value: -20 })).status, 401);
    assert.strictEqual((await post('/api/set', { ch: 'ph34', id: 'vol', value: -20 }, { 'X-ADI2PI-Key': 'geheim12' })).status, 200);
    // WebSocket without the key: state and get work, set is refused with 401, the socket stays open
    const w = new WebSocket(base.replace('http', 'ws') + '/ws');
    const msgs = [];
    await new Promise((resolve, reject) => { w.onmessage = (e) => { msgs.push(JSON.parse(e.data)); if (msgs.length === 3) resolve(); }; w.onclose = (e) => reject(new Error(`closed ${e.code}`)); });
    assert.strictEqual(msgs[0].t, 'hello');
    assert.strictEqual(msgs[0].access, 'read', 'hello says the connection is read-only');
    assert.strictEqual(msgs[1].t, 'state');
    const ask = (m) => new Promise((resolve) => { const rid = Math.random().toString(36).slice(2); const h = (e) => { const x = JSON.parse(e.data); if (x.rid === rid) { w.removeEventListener('message', h); resolve(x); } }; w.addEventListener('message', h); w.send(JSON.stringify({ ...m, rid })); });
    assert.strictEqual((await ask({ t: 'get' })).t, 'state');
    assert.strictEqual((await ask({ t: 'ping' })).t, 'pong');
    const denied = await ask({ t: 'set', ch: 'ph34', id: 'vol', value: -30 });
    assert.strictEqual(denied.status, 401);
    assert.strictEqual(w.readyState, WebSocket.OPEN, 'still connected');
    // removing the key tells it that it has full access now; setting one again makes it read-only again
    const access = (v) => new Promise((resolve) => { const h = (e) => { const x = JSON.parse(e.data); if (x.t === 'access' && x.access === v) { w.removeEventListener('message', h); resolve(); } }; w.addEventListener('message', h); });
    let p = access('full'); settings.update({ access: { key: null } }); await p;
    assert.strictEqual((await ask({ t: 'set', ch: 'ph34', id: 'vol', value: -30 })).t, 'ok');
    p = access('read'); settings.update({ access: { key: 'geheim12', viewOpen: true } }); await p;
    assert.strictEqual((await ask({ t: 'set', ch: 'ph34', id: 'vol', value: -31 })).status, 401);
    // a connection with the key says full
    const full = await new Promise((resolve) => { const k = new WebSocket(base.replace('http', 'ws') + '/ws?key=geheim12'); k.onmessage = (e) => { const x = JSON.parse(e.data); if (x.t === 'hello') { k.close(); resolve(x.access); } }; });
    assert.strictEqual(full, 'full');
    // switching "changes only" off closes it
    settings.update({ access: { viewOpen: false } });
    const code = await new Promise((resolve) => { w.onclose = (e) => resolve(e.code); });
    assert.strictEqual(code, 4401);
  } finally { automation.stop(); wss.close(); server.close(); dev.stop(); }
});

test('headphone profiles: capture groups from an output, apply to another with its limit, active marker', async () => {
  const { dev, settings } = await unit();
  const a = new Automation({ dev, settings, log: quiet });
  a.start();
  try {
    dev.set([{ ch: 'ph34', id: 'eqen', value: 1 }, { ch: 'ph34', id: 'xfeed', value: 2 }, { ch: 'ph34', id: 'loud', value: 1 }, { ch: 'ph34', id: 'b3g', value: -3 }]);
    const p = a.saveProfile({ name: 'HD 650', from: 'ph34', groups: ['eq', 'xfeed', 'loudness'], limit: -12 });
    assert.strictEqual(p.limit, -12);
    const item = (id) => p.items.find((i) => i.id === id && !i.side);
    assert.strictEqual(item('eqen').value, 1);
    assert.strictEqual(item('xfeed').value, 2);
    assert.strictEqual(item('b3g').value, -3);
    assert.ok(!p.items.some((i) => i.side === 'R'), 'Dual EQ off: left side only');
    assert.ok(!item('bten'), 'Bass/Treble not asked for');
    // apply to Phones 1/2: values, limit and marker follow
    dev.set([{ ch: 'ph12', id: 'eqen', value: 0 }, { ch: 'ph12', id: 'b3g', value: 4 }]);
    const r = a.applyProfile(p.id, 'ph12');
    assert.ok(Object.keys(r.applied).length > 3);
    assert.strictEqual(disp(dev, 'ph12', 'eqen'), 1);
    assert.strictEqual(disp(dev, 'ph12', 'b3g'), -3);
    assert.strictEqual(settings.get().limits.ph12, -12);
    assert.strictEqual(settings.get().activeProfile.ph12, p.id);
    // the limit holds
    dev.set([{ ch: 'ph12', id: 'vol', value: 0 }]);
    assert.strictEqual(disp(dev, 'ph12', 'vol'), -12);
    // a value of the profile changed by hand: the marker goes
    dev.set([{ ch: 'ph12', id: 'xfeed', value: 0 }]);
    assert.strictEqual(settings.get().activeProfile.ph12, null);
    // Line Out has no Crossfeed: applying skips it instead of failing
    const r2 = a.applyProfile(p.id, 'line');
    assert.ok(!r2.errors.length, r2.errors.join('; '));
    assert.strictEqual(settings.get().activeProfile.line, p.id);
    // update keeps the limit; deleting clears markers
    const p2 = a.saveProfile({ id: p.id, name: 'HD 650', from: 'ph34', groups: ['xfeed'] });
    assert.strictEqual(p2.limit, -12);
    a.deleteProfile(p.id);
    assert.strictEqual(settings.get().activeProfile.line, null);
    assert.throws(() => a.applyProfile('nope', 'ph34'), /no profile/);
    assert.throws(() => a.saveProfile({ name: 'x', from: 'in', groups: ['eq'] }), /output/);
    assert.throws(() => settings.update({ quickLevels: { ph34: [1, 2, 3, 4, 5] } }), /up to 4/);
    assert.deepStrictEqual(settings.update({ quickLevels: { ph34: [-15, -40, -15] } }).quickLevels.ph34, [-40, -15]);
  } finally { a.stop(); dev.stop(); }
});

test('actions: end time of a time action, digital input signal, Pi idle', async () => {
  const { mock, dev, settings } = await unit();
  const audio = Object.assign(new EventEmitter(), { st: { sources: [] }, status() { return this.st; } });
  let now = new Date(2026, 9, 24, 21, 59);
  const a = new Automation({ dev, settings, audio, log: quiet, now: () => now, tickMs: 10 });
  a.start();
  try {
    const mk = (name, v) => settings.update({ scenes: [...settings.get().scenes, { name, items: [{ ch: 'ph34', id: 'vol', value: v }] }] }).scenes.at(-1).id;
    const night = mk('night', -40), day = mk('day', -20), aesOn = mk('aes on', -33), aesOff = mk('aes off', -44), idle = mk('idle', -60);
    settings.update({ rules: [
      { when: { type: 'time', at: '22:00', until: '07:00', days: [6] }, scene: night, sceneEnd: day },  // Saturday night to Sunday morning
      { when: { type: 'input-signal', input: 'aes' }, scene: aesOn },
      { when: { type: 'input-lost', input: 'any' }, scene: aesOff },
      { when: { type: 'idle', minutes: 1 }, scene: idle },
    ] });
    assert.throws(() => settings.update({ rules: [{ when: { type: 'time', at: '22:00', until: '07:00' }, scene: night }] }), /scene for the end/);
    now = new Date(2026, 9, 24, 22, 0);
    await until(() => disp(dev, 'ph34', 'vol') === -40, 2000, 'start of the time action');
    now = new Date(2026, 9, 25, 7, 0);   // Sunday: the end belongs to Saturday's action
    await until(() => disp(dev, 'ph34', 'vol') === -20, 2000, 'end of the time action');
    // digital inputs come from the status message (IOStatus1 bits 23+21 = AES)
    const status = (io1) => mock._send(require('../lib/protocol').frame(mock.id, 0x07, [0x05, (io1 >> 21) & 0x7f, (io1 >> 14) & 0x7f, (io1 >> 7) & 0x7f, io1 & 0x7f, 0, 0, 0, 0, 1, 2, 0, 0, 0]));
    status(0);
    await sleep(30);
    status((1 << 23) | (1 << 21));
    await until(() => disp(dev, 'ph34', 'vol') === -33, 2000, 'AES signal');
    status(0);
    await until(() => disp(dev, 'ph34', 'vol') === -44, 2000, 'AES lost');
    // idle: nothing played for a minute (the clock for this is Date.now; we move the start back)
    audio.st = { sources: [{ kind: 'receiver', receiver: 'airplay', playing: true }] }; audio.emit('status');
    audio.st = { sources: [] }; audio.emit('status');
    a.idleSince = Date.now() - 61000;
    await until(() => disp(dev, 'ph34', 'vol') === -60, 2000, 'idle action');
    dev.set([{ ch: 'ph34', id: 'vol', value: -10 }]);
    await sleep(50);
    assert.strictEqual(disp(dev, 'ph34', 'vol'), -10, 'fires once per quiet period');
  } finally { a.stop(); dev.stop(); }
});

/** A tiny MQTT broker for one client: records publishes, can send messages to it. */
function fakeBroker() {
  const b = Object.assign(new EventEmitter(), { retained: new Map(), subs: [], sock: null, connect: null });
  b.server = net.createServer((sock) => {
    b.sock = sock;
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      const { packets, rest } = mq.parse(Buffer.concat([buf, d]));
      buf = rest;
      for (const p of packets) {
        if (p.type === 1) { b.connect = p.body; sock.write(Buffer.from([0x20, 2, 0, 0])); }
        else if (p.type === 3) {
          const tl = p.body.readUInt16BE(0);
          const topic = p.body.subarray(2, 2 + tl).toString();
          const payload = p.body.subarray(2 + tl).toString();
          if (p.flags & 1) { if (payload) b.retained.set(topic, payload); else b.retained.delete(topic); }
          b.emit('publish', topic, payload);
        } else if (p.type === 8) {
          let i = 2;
          while (i < p.body.length) { const l = p.body.readUInt16BE(i); b.subs.push(p.body.subarray(i + 2, i + 2 + l).toString()); i += 3 + l; }
          sock.write(Buffer.from([0x90, 3, p.body[0], p.body[1], 0]));
        } else if (p.type === 12) sock.write(Buffer.from([0xd0, 0]));
      }
    });
    sock.on('error', () => {});
  });
  b.send = (topic, payload) => b.sock.write(mq.publishPacket(topic, payload, false));
  return new Promise((r) => b.server.listen(0, '127.0.0.1', () => r(b)));
}

test('MQTT: connects, Home Assistant discovery, states, commands', async () => {
  const broker = await fakeBroker();
  const { dev, settings } = await unit();
  const a = new Automation({ dev, settings, log: quiet });
  const m = new MqttBridge({ dev, settings, log: quiet, automation: a, version: 'test' });
  try {
    settings.update({ scenes: [{ id: 'quiet', name: 'Quiet', items: [{ ch: 'line', id: 'vol', value: -45 }] }] });
    a.start(); m.start();
    settings.update({ mqtt: { enabled: true, host: '127.0.0.1', port: broker.server.address().port, username: 'u', password: 'p' } });
    await until(() => m.status().connected, 3000, 'connected');
    assert.ok(broker.connect.includes(Buffer.from('u')) && broker.connect.includes(Buffer.from('p')), 'user name and password sent');
    const base = m.base;
    await until(() => broker.retained.get(`${base}/status`) === 'online', 2000, 'online');
    await until(() => [...broker.retained.keys()].some((t) => t.endsWith('/line_vol/config')), 3000, 'discovery');
    const vol = JSON.parse(broker.retained.get(`homeassistant/number/${m.node}/line_vol/config`));
    assert.strictEqual(vol.command_topic, `${base}/line/vol/set`);
    assert.strictEqual(vol.unit_of_measurement, 'dB');
    const src = JSON.parse(broker.retained.get(`homeassistant/select/${m.node}/ph34_src/config`));
    assert.ok(src.options.includes('USB 1/2'));
    assert.ok(broker.retained.has(`homeassistant/button/${m.node}/scene_quiet/config`));
    await until(() => broker.retained.has(`${base}/line/vol/state`), 2000, 'state');
    // commands
    broker.send(`${base}/line/vol/set`, '-31.5');
    await until(() => disp(dev, 'line', 'vol') === -31.5, 2000, 'volume command');
    await until(() => broker.retained.get(`${base}/line/vol/state`) === '-31.5', 2000, 'state follows');
    broker.send(`${base}/ph34/src/set`, 'USB 3/4');
    await until(() => disp(dev, 'ph34', 'src') === 5, 2000, 'select command');
    broker.send(`${base}/ph34/mute/set`, 'ON');
    await until(() => disp(dev, 'ph34', 'mute') === 1, 2000, 'switch command');
    broker.send(`${base}/scene/quiet/set`, 'apply');
    await until(() => disp(dev, 'line', 'vol') === -45, 2000, 'scene');
    broker.send(`${base}/sleep/set`, '30');
    await until(() => a.sleepStatus(), 2000, 'sleep started');
    // a deleted scene's button is removed
    settings.update({ scenes: [] });
    await until(() => !broker.retained.has(`homeassistant/button/${m.node}/scene_quiet/config`), 3000, 'removed');
    const pub = settings.publicView().mqtt;
    assert.strictEqual(pub.password, undefined);
    assert.strictEqual(pub.hasPassword, true);
  } finally { m.stop(); a.stop(); dev.stop(); broker.server.close(); if (broker.sock) broker.sock.destroy(); }
});
