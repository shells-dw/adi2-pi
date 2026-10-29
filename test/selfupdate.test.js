'use strict';
/** Install from a file: signature check, version from the archive, staging, the root service (faked). */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const RV = require('../lib/release-verify');
const { SelfUpdate } = require('../lib/selfupdate');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(5); } throw new Error('timed out'); }

const root = path.join(__dirname, '..');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const sigOf = (buf, key = privateKey) => `adi2-pi release signature\n${crypto.sign(null, buf, key).toString('base64')}\n`;
// a release archive like tools/release.js makes it (git archive of HEAD); skipped outside a git checkout
let archive = null, version = null;
try {
  archive = execFileSync('git', ['-C', root, 'archive', '--format=tar.gz', '--prefix=adi2-pi/', 'HEAD'], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  version = JSON.parse(execFileSync('git', ['-C', root, 'show', 'HEAD:package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).version;
} catch { /* not a git checkout */ }
const opts = { skip: archive ? false : 'needs a git checkout' };

test('release check: signature and version', opts, () => {
  assert.strictEqual(RV.verify(archive, sigOf(archive), publicKey), true);
  assert.strictEqual(RV.releaseVersion(archive), version);
  const changed = Buffer.from(archive); changed[changed.length - 20] ^= 1;
  assert.strictEqual(RV.verify(changed, sigOf(archive), publicKey), false, 'a changed archive');
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.strictEqual(RV.verify(archive, sigOf(archive, other), publicKey), false, 'signed with another key');
  assert.strictEqual(RV.verify(archive, 'nonsense', publicKey), false);
  assert.strictEqual(RV.verify(archive, sigOf(archive), null), false, 'no key');
  // not a release: another top folder
  const tar = Buffer.alloc(1024);
  tar.write('other/package.json', 0); tar.write('0000644', 100); tar.write('00000000000', 124); tar.write('0', 156);
  assert.throws(() => RV.releaseVersion(zlib.gzipSync(tar)), /not an ADI-2-Pi release/);
  assert.throws(() => RV.releaseVersion(Buffer.from('plain text')), /not a \.tar\.gz/);
});

test('stage, discard, install through the root service', opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'su-'));
  const logFile = path.join(dir, 'self-update.log');
  const calls = [];
  let active = false, result = 'success';
  const fakeRun = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'start') { active = true; setTimeout(() => { active = false; }, 60); return { code: 0, out: '' }; }
    return { code: 0, out: `ActiveState=${active ? 'activating' : 'inactive'}\nResult=${result}\nExecMainExitTimestamp=@1793000000\n` };
  };
  const su = new SelfUpdate({ dataDir: dir, version: '1.0.0', log: quiet, key: publicKey, installed: true, run: fakeRun, logFile, pollMs: 10 });
  assert.strictEqual(su.status().available, true);
  assert.throws(() => su.stage(archive, sigOf(Buffer.from('x'))), /signature does not match/);
  assert.throws(() => su.stage(archive, ''), /signature file/);
  await assert.rejects(su.install(), /upload a release first/);

  let s = su.stage(archive, sigOf(archive));
  assert.strictEqual(s.staged.version, version);
  assert.strictEqual(s.staged.newer, true);
  assert.ok(fs.existsSync(path.join(dir, 'update', 'release.tar.gz')) && fs.existsSync(path.join(dir, 'update', 'release.tar.gz.sig')));
  // kept across a restart of the bridge
  assert.strictEqual(new SelfUpdate({ dataDir: dir, version: '1.0.0', log: quiet, key: publicKey, installed: true, run: fakeRun }).status().staged.version, version);
  s = su.discard();
  assert.strictEqual(s.staged, null);
  assert.ok(!fs.existsSync(path.join(dir, 'update', 'release.tar.gz')));

  // install, then the service fails (the installer didn't get to restart ADI-2-Pi)
  su.stage(archive, sigOf(archive));
  fs.writeFileSync(logFile, 'signature valid – ADI-2-Pi x\n\x1b[31m✗ the bridge did not start\x1b[0m\n');
  result = 'exit-code';
  await su.install();
  assert.ok(calls.includes('systemctl start --no-block adi2-pi-self-update.service'));
  assert.strictEqual(su.status().state, 'installing');
  assert.throws(() => su.stage(archive, sigOf(archive)), /being installed/);
  await until(() => su.status().state === 'idle');
  assert.strictEqual(su.status().lastRun.ok, false);
  assert.deepStrictEqual(su.status().lastRun.log.slice(-1), ['✗ the bridge did not start']);

  // the new process after a successful install reads the result from systemd
  result = 'success';
  const after = new SelfUpdate({ dataDir: dir, version, log: quiet, key: publicKey, installed: true, run: fakeRun, logFile });
  await after.start();
  assert.deepStrictEqual(after.status().lastRun, { at: 1793000000000, ok: true, log: [] });

  // not usable without the key or the service
  assert.match(new SelfUpdate({ dataDir: dir, version, log: quiet, key: null, installed: true }).status().reason, /release key/);
  assert.match(new SelfUpdate({ dataDir: dir, version, log: quiet, key: publicKey, installed: false }).status().reason, /installer/);
});
