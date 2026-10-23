'use strict';
/** EQ presets: reading (against RME's own example bytes), storing and renaming. */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const P = require('../lib/protocol');
const { MockAdi } = require('../lib/mock-adi');
const { Adi2 } = require('../lib/device');
const { Settings } = require('../lib/settings');
const { createServer } = require('../lib/server');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(20); }
  throw new Error('timed out');
}

test('reads a preset exactly as in RME\'s table example (ADI-2/4 Pro SE, preset 2)', async () => {
  // a transport that is "open" and lets the test inject the unit's bytes
  const t = new EventEmitter();
  t.start = () => setTimeout(() => t.emit('open', { name: 'ADI-2/4 Pro SE', hint: 'se' }), 1);
  t.stop = () => {};
  t.write = () => true;
  const dev = new Adi2({ transport: t, settings: { limits: {} }, log: quiet });
  dev.start();
  await sleep(10);
  const rx = (hex) => t.emit('data', P.unhex(hex));
  rx('F0 00 20 0D 73 07 11 30 7E 08 00 00 00 02 04 01 11 00 F7'); // identifies 0x73
  rx('F0 00 20 0D 73 01 00 20 03 F7');
  await until(() => dev.id === 0x73);
  // "Request EQ-Preset 2" → answer from the table
  rx('F0 00 20 0D 73 05 02 20 20 20 20 50 72 6F 50 68 69 6C 65 20 38 00 00 F7');
  rx('F0 00 20 0D 73 01 68 20 10 68 60 00 69 00 0C 69 20 19 69 40 0A 69 60 00 6A 03 74 6A 20 0A 6A 40 00 6A 67 68 6B 00 0A 6B 20 00 6B 53 74 6B 60 0A 6C 00 01 6C 20 00 6C 57 68 6C 60 0A 70 60 00 71 00 0C 71 20 19 71 40 0A 71 60 00 72 03 74 72 20 0A 72 40 00 72 67 68 73 00 0A 73 20 00 73 53 74 73 60 0A 74 00 01 74 20 00 74 57 68 74 60 0A 6D 40 55 6D 20 00 6D 60 07 6E 35 0A 6E 00 00 F7');
  rx('F0 00 20 0D 73 01 6E 35 0A 6E 00 00 6E 40 07 F7');
  // "Request EQ-Preset 3" → empty
  rx('F0 00 20 0D 73 01 68 20 2F F7');
  rx('F0 00 20 0D 73 05 03 20 20 45 51 20 50 72 65 73 65 74 20 33 00 7F 00 F7');
  const p = dev.presets();
  assert.strictEqual(p[1].name, 'ProPhile 8');
  assert.strictEqual(p[1].empty, false);
  assert.strictEqual(p[1].dual, false);
  assert.deepStrictEqual([p[1].L[4], p[1].L[5], p[1].L[6]], [12, 25, 10], 'band 1: +6 dB, 25 Hz, Q 1.0');
  assert.strictEqual(p[1].L[11], 1000);
  assert.strictEqual(p[1].L[22], 85, 'bass freq');
  assert.strictEqual(p[1].L[25], 6500, 'treble freq (×10 flag)');
  assert.strictEqual(p[1].R[18], 10000);
  assert.strictEqual(p[2].empty, true);
  assert.ok(!Object.keys(dev.snapshot()).some((k) => k.startsWith('13.') || k.startsWith('14.')), 'preset data is not a live setting');
  dev.stop();
});

test('store and rename go to the unit in the documented order', async () => {
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    dev.start();
    await until(() => dev.ready && dev.presets().every((x) => x.empty !== null));
    assert.strictEqual(dev.presets()[2].empty, true);

    const L = { 3: 1, 4: 8, 5: 70, 6: 7, 7: -4, 8: 220, 9: 14, 11: 2540, 18: 15000, 20: 1, 21: 4, 22: 85, 23: 9, 27: 1 };
    const sent = [];
    const tx = mock.write.bind(mock);
    mock.write = (buf) => { sent.push(P.parse(buf)); return tx(buf); };
    const r = await post('/api/eqpresets/store', { n: 3, name: 'HD 800 S Harman', L, dual: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await until(() => mock.eqPresets[2] && mock.eqPresets[2].name);
    // data first, flags word after it, then the name
    const iFlag = sent.findIndex((m) => m.cmd === 2 && m.params.some((p) => p.addr === 13 && p.idx === 2));
    const iData = sent.findIndex((m) => m.cmd === 2 && m.params.some((p) => p.addr === 13 && p.idx === 4));
    const iName = sent.findIndex((m) => m.cmd === 6);
    assert.ok(iData >= 0 && iData < iName && iName < iFlag, `order data ${iData}, name ${iName}, then flags ${iFlag}`);
    assert.ok(!sent.some((m) => m.cmd === 2 && m.params.some((p) => p.addr === 13 && (p.idx === 20 || p.idx === 27))), 'B/T Enable and Load B/T are output settings, never preset data');
    assert.strictEqual(mock.midiControl, true, 'MIDI Control stays ON');
    assert.strictEqual(mock.eqPresets[2].L[11], 2540);
    assert.strictEqual(mock.eqPresets[2].R[11], 2540, 'without Dual EQ the right side gets the left values');
    assert.strictEqual(mock.eqPresets[2].R[22], undefined, 'Bass/Treble only on the left address');
    assert.strictEqual(mock.eqPresets[2].name, 'HD 800 S Harma', 'names are max. 14 characters');
    // read back
    await until(() => dev.presets()[2].empty === false && dev.presets()[2].name === 'HD 800 S Harma');

    sent.length = 0;
    assert.strictEqual((await post('/api/eqpresets/rename', { n: 3, name: 'Late' })).status, 200);
    await until(() => mock.eqPresets[2].name === 'Late');
    assert.strictEqual(mock.eqPresets[2].L[11], 2540, 'rename keeps the EQ');
    assert.ok(sent.some((m) => m.cmd === 2 && m.params.some((p) => p.addr === 13 && p.idx === 2)), 'rename is committed with the flags word (index 2)');
    assert.strictEqual((await post('/api/eqpresets/rename', { n: 8, name: 'x' })).status, 400, 'empty slot');

    // picking a preset on an output shows its EQ right away (and the unit agrees)
    const r2 = await post('/api/set', { ch: 'ph12', id: 'eqpreset', value: 3 }); // preset 2 "HD 650"
    assert.strictEqual(r2.body.applied['7.4'], 12, 'band 1 gain from preset 2 in the reply');
    assert.strictEqual(r2.body.applied['8.5'], 76, 'right side too');
    assert.strictEqual(dev.get(7, 13), -3);
    await until(() => mock.get(7, 4) === 12);
    assert.strictEqual((await post('/api/eqpresets/store', { n: 21, L })).status, 400);
    assert.strictEqual((await post('/api/eqpresets/store', { n: 2, L: {} })).status, 400);
    // partial data is completed with RME's defaults
    await post('/api/eqpresets/store', { n: 6, L: { 4: 6 } });
    await until(() => mock.eqPresets[5] && mock.eqPresets[5].L[11] === 1000 && mock.eqPresets[5].L[25] === 6500 && mock.eqPresets[5].R[18] === 10000);
  } finally { wss.close(); dev.stop(); server.close(); }
});

test('setups can be renamed, and saved under a name', async () => {
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    dev.start();
    await until(() => dev.ready);
    const sent = [];
    const tx = mock.write.bind(mock);
    mock.write = (buf) => { sent.push(P.parse(buf)); return tx(buf); };
    assert.strictEqual((await post('/api/setup', { action: 'rename', n: 4, name: 'Bedroom' })).status, 200);
    await until(() => mock.setupNames[3] === 'Bedroom');
    const nameMsg = sent.find((m) => m.cmd === 6);
    assert.deepStrictEqual(nameMsg.data, [0x24, ...Buffer.from('       Bedroom', 'ascii'), 0, 0], 'like the unit: 14 characters right-aligned, then 00 00');
    assert.ok(!sent.some((m) => m.cmd === 4), 'rename does not save the setup');
    sent.length = 0;
    assert.strictEqual((await post('/api/setup', { action: 'save', n: 5, name: 'Studio' })).status, 200);
    await until(() => sent.some((m) => m.cmd === 4));
    const iName = sent.findIndex((m) => m.cmd === 6), iSave = sent.findIndex((m) => m.cmd === 4);
    assert.ok(iName >= 0 && iName < iSave, 'name first, then save');
    await until(() => dev.setups[4] === 'Studio');
    assert.strictEqual((await post('/api/setup', { action: 'rename', n: 4, name: '   ' })).status, 400);
  } finally { wss.close(); dev.stop(); server.close(); }
});
