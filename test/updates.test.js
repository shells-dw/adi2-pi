'use strict';
/** Update check: version comparison, GitHub answers, no request while switched off. */
const test = require('node:test');
const assert = require('node:assert');
const { Updates, compareVersions, parseVersion, API_URL, RELEASES_URL } = require('../lib/updates');
const { Settings } = require('../lib/settings');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const a = typeof answer === 'function' ? answer() : answer;
    if (a instanceof Error) throw a;
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body };
  };
  fn.calls = calls;
  return fn;
}

test('versions', () => {
  assert.deepStrictEqual(parseVersion('v1.2.3'), [1, 2, 3, null]);
  assert.strictEqual(parseVersion('latest'), null);
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
  assert.ok(compareVersions('v1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('1.1.0-beta.1', '1.1.0') < 0);
  assert.ok(compareVersions('1.1.0-beta.1', '1.0.9') > 0);
  assert.ok(compareVersions('0.9.0', '1.0.0') < 0);
});

test('off by default: no request; check now still works', async () => {
  const settings = new Settings(null, quiet);
  assert.strictEqual(settings.get().updates.check, false);
  const f = fakeFetch({ status: 200, body: { tag_name: 'v1.0.1', html_url: 'https://github.com/shells-dw/adi2-pi/releases/tag/v1.0.1', name: 'ADI-2-Pi 1.0.1', published_at: '2026-11-01T10:00:00Z' } });
  const u = new Updates({ settings, version: '1.0.0', log: quiet, fetch: f });
  u.start();
  await sleep(50);
  assert.strictEqual(f.calls.length, 0);
  const st = await u.check({ manual: true });
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].url, API_URL);
  assert.match(f.calls[0].opts.headers['User-Agent'], /^adi2-pi\/1\.0\.0$/);
  assert.strictEqual(st.available, true);
  assert.deepStrictEqual(st.latest, { version: '1.0.1', name: 'ADI-2-Pi 1.0.1', url: 'https://github.com/shells-dw/adi2-pi/releases/tag/v1.0.1', published: '2026-11-01T10:00:00Z' });
  // a second "check now" right away is refused
  await assert.rejects(u.check({ manual: true }), (e) => e.status === 429);
  u.stop();
});

test('switching it on checks right away; same version = up to date; foreign link replaced', async () => {
  const settings = new Settings(null, quiet);
  const f = fakeFetch({ status: 200, body: { tag_name: '1.0.0', html_url: 'https://example.com/x' } });
  const u = new Updates({ settings, version: '1.0.0', log: quiet, fetch: f });
  const seen = [];
  u.on('status', (s) => seen.push(s));
  u.start();
  settings.update({ updates: { check: true } });
  for (let i = 0; i < 100 && !u.lastCheck; i++) await sleep(5);
  assert.strictEqual(f.calls.length, 1);
  const st = u.status();
  assert.strictEqual(st.check, true);
  assert.strictEqual(st.available, false);
  assert.strictEqual(st.latest.url, RELEASES_URL);
  assert.ok(seen.some((s) => s.checking));
  settings.update({ updates: { check: false } });
  assert.strictEqual(u.timer, null);
  u.stop();
});

test('no release yet, HTTP errors and network errors', async () => {
  const settings = new Settings(null, quiet);
  let answer = { status: 404, body: {} };
  const u = new Updates({ settings, version: '1.0.0', log: quiet, fetch: fakeFetch(() => answer) });
  let st = await u.check();
  assert.strictEqual(st.latest, null);
  assert.strictEqual(st.available, false);
  assert.strictEqual(st.error, null);
  answer = { status: 403, body: {} };
  st = await u.check();
  assert.match(st.error, /rate limit/);
  answer = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  st = await u.check();
  assert.strictEqual(st.error, 'fetch failed (ENOTFOUND)');
  answer = { status: 200, body: { tag_name: 'nightly' } };
  st = await u.check();
  assert.match(st.error, /no version tag/);
  u.stop();
});
