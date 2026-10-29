#!/usr/bin/env node
'use strict';
/**
 * Release files with a signature, for "Install from a file" (System → ADI-2-Pi updates).
 *
 *   node tools/release.js key          once: makes the signing key (kept outside the repository)
 *                                      and writes its public part to lib/release-key.pub – commit that
 *   node tools/release.js build        archives of HEAD in dist/: adi2-pi-<version>.tar.gz, .zip and
 *                                      adi2-pi-<version>.tar.gz.sig (attach all three to the release)
 *   node tools/release.js sign <file>  signature for one file
 *
 * Private key: ~/.config/adi2-pi/release-key.pem (Windows: %USERPROFILE%\.config\adi2-pi\), or the
 * file named by ADI2PI_RELEASE_KEY. Keep a copy: installations only accept releases signed with the
 * key whose public part they have. Needs Node.js 18+ and git; works on Linux, macOS and Windows.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const { verify, releaseVersion, untar } = require('../lib/release-verify');

const root = path.join(__dirname, '..');
const PRIVATE = process.env.ADI2PI_RELEASE_KEY || path.join(os.homedir(), '.config', 'adi2-pi', 'release-key.pem');
const PUBLIC = path.join(root, 'lib', 'release-key.pub');

function privateKey() {
  try { return crypto.createPrivateKey(fs.readFileSync(PRIVATE, 'utf8')); } catch {
    throw new Error(`no signing key at ${PRIVATE} – run: node tools/release.js key`);
  }
}

function sign(file) {
  const sig = crypto.sign(null, fs.readFileSync(file), privateKey()).toString('base64');
  fs.writeFileSync(`${file}.sig`, `adi2-pi release signature\n${sig}\n`);
  return `${file}.sig`;
}

function key() {
  if (!fs.existsSync(PRIVATE)) {
    const { privateKey: priv } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(PRIVATE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PRIVATE, priv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`signing key made: ${PRIVATE} – keep a copy somewhere safe`);
  } else console.log(`signing key: ${PRIVATE}`);
  const pub = crypto.createPublicKey(privateKey()).export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(PUBLIC, pub);
  console.log(`public key written to lib/release-key.pub – commit it`);
}

function build() {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const version = JSON.parse(git('show', 'HEAD:package.json')).version;
  let pub;
  try { pub = crypto.createPublicKey(git('show', 'HEAD:lib/release-key.pub')); } catch {
    throw new Error('lib/release-key.pub is not committed – run "node tools/release.js key" and commit it');
  }
  if (git('status', '--porcelain').trim()) console.log('note: uncommitted changes are not part of the archives (HEAD is used)');
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const base = path.join(dist, `adi2-pi-${version}`);
  // Unix line endings whatever the local Git does (core.autocrlf on Windows would break the shell scripts)
  git('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar.gz', '--prefix=adi2-pi/', '-o', `${base}.tar.gz`, 'HEAD');
  git('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', '--prefix=adi2-pi/', '-o', `${base}.zip`, 'HEAD');
  const sigFile = sign(`${base}.tar.gz`);
  const archive = fs.readFileSync(`${base}.tar.gz`);
  if (!verify(archive, fs.readFileSync(sigFile, 'utf8'), pub)) throw new Error('the signature does not match lib/release-key.pub – the signing key and the committed public key differ');
  if (releaseVersion(archive) !== version) throw new Error('version check failed');
  const crlf = untar(zlib.gunzipSync(archive)).filter((f) => /\.(sh|js|py|service)$/.test(f.name) && f.data.includes(13)).map((f) => f.name);
  if (crlf.length) throw new Error(`Windows line endings in ${crlf.slice(0, 3).join(', ')} – the Pi can't run them; check out with LF (see .gitattributes) and build again`);
  for (const f of [`${base}.tar.gz`, `${base}.zip`, sigFile]) console.log(path.relative(root, f));
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'key') key();
  else if (cmd === 'build') build();
  else if (cmd === 'sign' && arg) console.log(sign(arg));
  else { console.log('usage: node tools/release.js key | build | sign <file>'); process.exit(2); }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
