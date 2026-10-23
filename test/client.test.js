'use strict';
/** The reference client (clients/adi2pi-client.js) against the bridge with a simulated ADI-2. */
const test = require('node:test');
const assert = require('node:assert');
const { MockAdi } = require('../lib/mock-adi');
const { Adi2 } = require('../lib/device');
const { Settings } = require('../lib/settings');
const { createServer } = require('../lib/server');
const { Adi2PiClient } = require('../clients/adi2pi-client');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, what = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(20); } throw new Error(`timed out ${what}`); }
const once = (em, ev, ms = 8000) => new Promise((r, j) => { const t = setTimeout(() => j(new Error(`no '${ev}' within ${ms} ms`)), ms); em.once(ev, (...a) => { clearTimeout(t); r(a); }); });

test('reference client: ready, get/set by name, relative steps, broadcasts, errors, reconnect', async () => {
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  let { server, wss } = createServer({ dev, settings, version: 'test', log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  dev.start();
  const c = new Adi2PiClient({ url: `ws://127.0.0.1:${port}/ws` });
  try {
    const ready = once(c, 'ready');
    c.start();
    await c.loadSchema();
    await ready;
    assert.ok(c.usable);
    assert.strictEqual(c.bridge.version, 'test');
    assert.strictEqual(c.get('ph34', 'vol'), -30);

    let r = await c.set('ph34', 'vol', -12.5);
    assert.deepStrictEqual(r.applied, { '9.12': -125 });
    assert.strictEqual(c.get('ph34', 'vol'), -12.5, 'own change arrives as a broadcast');
    r = await c.set('ph34', 'vol', { delta: 0.5 });
    assert.strictEqual(c.get('ph34', 'vol'), -12);
    await c.set('ph34', 'mute', { delta: 1 });
    assert.strictEqual(c.get('ph34', 'mute'), 1);

    // a change on the unit itself
    await sleep(1800); // let the bridge's read-back of our own sets pass
    const seen = new Promise((res) => { const f = (k, v, o) => { if (k === '9.12' && v === -400) { c.off('param', f); res(o); } }; c.on('param', f); });
    mock.frontPanel(9, 12, -400);
    assert.strictEqual(await seen, 'device');
    assert.strictEqual(c.get('ph34', 'vol'), -40);

    // errors carry a status
    await assert.rejects(c.set('ph34', 'nope', 1), (e) => e.status === 400 && /unknown parameter/.test(e.message));
    mock.setMidiControl(false);
    await once(c, 'unusable');
    await assert.rejects(c.set('ph34', 'vol', -20), (e) => e.status === 409);
    mock.setMidiControl(true);
    await once(c, 'ready');

    // the bridge restarts: the client reconnects by itself
    const gone = once(c, 'disconnected');
    wss.close(); server.close(); server.closeAllConnections?.();
    await gone;
    ({ server, wss } = createServer({ dev, settings, version: 'test2', log: quiet }));
    await new Promise((res) => server.listen(port, '127.0.0.1', res));
    await until(() => c.connected && c.bridge.version === 'test2', 8000, 'reconnect');
    await until(() => c.usable);
    assert.deepStrictEqual((await c.set('ph34', 'vol', -20)).applied, { '9.12': -200 });
  } finally { c.stop(); wss.close(); server.close(); dev.stop(); }
});
