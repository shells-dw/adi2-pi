'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EqData, blobSha } = require('../lib/eq-data');
const { MockAdi } = require('../lib/mock-adi');
const { Adi2 } = require('../lib/device');
const { Settings } = require('../lib/settings');
const { createServer } = require('../lib/server');

const BUNDLED = path.join(__dirname, '..', 'web', 'eq', 'data');
const quiet = { info() {}, warn() {}, debug() {} };
const idx = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'index.json'), 'utf8'));
const HP = idx.headphones.find((h) => h.name === 'Sennheiser HD 650');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adi2pi-eq-'));

const noInternet = async () => { throw new Error('test: internet must not be used'); };

/** Fake GitHub: same files as bundled, except HD 650 changed and one new headphone. */
function fakeGithub() {
  const files = new Map();
  for (const e of [...idx.headphones, ...idx.targets]) files.set(e.path, fs.readFileSync(path.join(BUNDLED, 'files', e.path)));
  files.set(HP.path, Buffer.from('frequency,raw\n20,1\n20000,2\n'));
  files.set('measurements/oratory1990/data/over-ear/Brand New Headphone.csv', Buffer.from('frequency,raw\n20,0\n20000,0\n'));
  files.set('targets/Some unrelated target.csv', Buffer.from('x'));
  const blobs = (prefix) => [...files].filter(([p]) => p.startsWith(prefix)).map(([p, b]) => ({ path: p.slice(prefix.length), type: 'blob', sha: blobSha(b) }));
  const trees = {
    root: [{ path: 'measurements', type: 'tree', sha: 'm' }, { path: 'targets', type: 'tree', sha: 't' }, { path: 'README.md', type: 'blob', sha: 'x' }],
    m: [{ path: 'oratory1990', type: 'tree', sha: 'o' }, { path: 'crinacle', type: 'tree', sha: 'c' }],
    o: [{ path: 'data', type: 'tree', sha: 'd' }],
    d: blobs('measurements/oratory1990/data/'),
    t: blobs('targets/'),
  };
  const calls = [];
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  const fn = async (url) => {
    calls.push(url);
    if (url.endsWith('/commits/HEAD')) return json({ sha: 'abcdef1234567890', commit: { tree: { sha: 'root' } } });
    const t = url.match(/\/git\/trees\/(\w+)/);
    if (t) return json({ tree: trees[t[1]], truncated: false });
    const raw = url.match(/raw\.githubusercontent\.com\/jaakkopasanen\/AutoEq\/abcdef1234567890\/(.+)$/);
    if (raw) {
      const p = raw[1].split('/').map(decodeURIComponent).join('/');
      const b = files.get(p);
      return b ? { ok: true, status: 200, arrayBuffer: async () => b } : { ok: false, status: 404 };
    }
    return { ok: false, status: 404 };
  };
  fn.calls = calls;
  return fn;
}

async function waitDone(eq) {
  for (let i = 0; i < 400; i++) {
    const s = eq.status();
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('update did not finish');
}

test('serves the bundled data without any internet access', () => {
  const eq = new EqData({ bundledDir: BUNDLED, dataDir: tmp(), fetch: noInternet, log: quiet });
  assert.strictEqual(eq.getIndex().headphones.length, idx.headphones.length);
  assert.match(eq.get(HP.path), /^frequency/i);
  assert.strictEqual(eq.info().source, 'bundled');
  assert.throws(() => eq.get('../../etc/passwd'), (e) => e.status === 404);
  assert.throws(() => eq.get('README.md'), (e) => e.status === 404);
});

test('update on request downloads only new and changed files, then reset', async () => {
  const dir = tmp();
  const gh = fakeGithub();
  const eq = new EqData({ bundledDir: BUNDLED, dataDir: dir, fetch: gh, log: quiet });
  eq.startUpdate();
  const s = await waitDone(eq);
  assert.strictEqual(s.state, 'done', s.message);
  assert.strictEqual(s.added, 1);
  assert.strictEqual(s.changed, 1);
  const downloads = gh.calls.filter((u) => u.includes('raw.githubusercontent.com'));
  assert.strictEqual(downloads.length, 2, 'unchanged files are not downloaded');
  assert.ok(gh.calls.every((u) => u.startsWith('https://api.github.com/repos/jaakkopasanen/AutoEq/') || u.startsWith('https://raw.githubusercontent.com/jaakkopasanen/AutoEq/')));
  assert.strictEqual(eq.info().source, 'updated');
  assert.strictEqual(eq.get(HP.path), 'frequency,raw\n20,1\n20000,2\n');
  assert.ok(eq.getIndex().headphones.some((h) => h.name === 'Brand New Headphone' && h.form === 'over-ear'));
  assert.ok(!eq.getIndex().targets.some((t) => t.name === 'Some unrelated target'), 'only the known targets');
  assert.ok(eq.get(idx.headphones[0].path).length > 0, 'unchanged files still come from the bundle');
  // only the two differing files are stored on the Pi
  const stored = fs.readdirSync(path.join(dir, 'files'), { recursive: true }).filter((f) => f.endsWith('.csv'));
  assert.strictEqual(stored.length, 2);

  // a second update keeps earlier downloads and fetches nothing new
  gh.calls.length = 0;
  eq.startUpdate();
  const s2 = await waitDone(eq);
  assert.strictEqual(s2.added + s2.changed, 0);
  assert.strictEqual(gh.calls.filter((u) => u.includes('raw.')).length, 0);
  assert.strictEqual(eq.get(HP.path), 'frequency,raw\n20,1\n20000,2\n');

  eq.reset();
  assert.strictEqual(eq.info().source, 'bundled');
  assert.notStrictEqual(eq.get(HP.path), 'frequency,raw\n20,1\n20000,2\n');
});

test('update with nothing new (fresh install) works', async () => {
  const dir = tmp();
  // GitHub has exactly the shipped files
  const same = async (url) => {
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.endsWith('/commits/HEAD')) return json({ sha: idx.ref, commit: { tree: { sha: 'root' } } });
    const blobs = (prefix, list) => list.filter((e) => e.path.startsWith(prefix)).map((e) => ({ path: e.path.slice(prefix.length), type: 'blob', sha: blobSha(fs.readFileSync(path.join(BUNDLED, 'files', e.path))) }));
    const trees = {
      root: [{ path: 'measurements', type: 'tree', sha: 'm' }, { path: 'targets', type: 'tree', sha: 't' }],
      m: [{ path: 'oratory1990', type: 'tree', sha: 'o' }], o: [{ path: 'data', type: 'tree', sha: 'd' }],
      d: blobs('measurements/oratory1990/data/', idx.headphones), t: blobs('targets/', idx.targets),
    };
    const t = url.match(/\/git\/trees\/(\w+)/);
    if (t) return json({ tree: trees[t[1]], truncated: false });
    throw new Error('no downloads expected: ' + url);
  };
  const eq = new EqData({ bundledDir: BUNDLED, dataDir: dir, fetch: same, log: quiet });
  eq.startUpdate();
  const s = await waitDone(eq);
  assert.strictEqual(s.state, 'done', s.message);
  assert.strictEqual(s.added + s.changed, 0);
  assert.strictEqual(eq.getIndex().headphones.length, idx.headphones.length);
});

test('explains when GitHub cannot be reached', async () => {
  const eq = new EqData({ bundledDir: BUNDLED, dataDir: tmp(), fetch: async () => { throw new Error('ENOTFOUND'); }, log: quiet });
  eq.startUpdate();
  const s = await waitDone(eq);
  assert.strictEqual(s.state, 'error');
  assert.match(s.message, /Could not reach GitHub/);
  assert.strictEqual(eq.info().source, 'bundled', 'nothing changed');
});

test('HTTP routes and the planner page work offline', async () => {
  const mock = new MockAdi({ model: 'pro' });
  const settings = new Settings(null, quiet);
  const dev = new Adi2({ transport: mock, settings: settings.get(), log: quiet });
  const eqData = new EqData({ bundledDir: BUNDLED, dataDir: tmp(), fetch: noInternet, log: quiet });
  const { server, wss } = createServer({ dev, settings, version: 'test', log: quiet, eqData });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const index = await (await fetch(`${base}/api/eq/index`)).json();
    assert.strictEqual(index.origin.source, 'bundled');
    const ok = await fetch(`${base}/api/eq/file?path=${encodeURIComponent(HP.path)}`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await fetch(`${base}/api/eq/file?path=nope.csv`)).status, 404);
    assert.strictEqual((await fetch(`${base}/eq`, { redirect: 'manual' })).status, 301);
    const html = await (await fetch(`${base}/eq/`)).text();
    assert.ok(!/ko-fi|buymeacoffee|googleapis|gstatic|Barlow|Source Sans|Plex/i.test(html), 'no badges, no web fonts');
    assert.ok(/api\.github\.com/.test(html) && /raw\.githubusercontent\.com/.test(html), 'page says what the update button contacts');
    assert.ok(!/src="https?:|href="https?:[^"]*\.css/.test(html), 'no external scripts, images or styles');
    for (const f of ['/eq/css/style.css', '/eq/css/site.css']) {
      const css = await (await fetch(base + f)).text();
      assert.ok(!/url\(|@import|https?:/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), `${f} loads nothing`);
    }
    assert.ok(!/href="https?:/.test(html), 'no outside links on the page');
    for (const f of ['/eq/js/app.js', '/eq/js/core.js', '/eq/js/worker.js', '/logo.svg', '/icon.svg']) {
      assert.strictEqual((await fetch(base + f)).status, 200, f);
    }
    // the update can't be triggered from another web site
    const evil = await fetch(`${base}/api/eq/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.strictEqual(evil.status, 403);
  } finally { wss.close(); server.close(); }
});
