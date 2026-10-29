'use strict';
/**
 * Release archives: Ed25519 signature check and the version inside.
 *
 * A release is adi2-pi-<version>.tar.gz (git archive, top folder adi2-pi/) and
 * adi2-pi-<version>.tar.gz.sig (base64 Ed25519 signature of the archive's bytes), made by
 * tools/release.js. The public key is lib/release-key.pub (PEM); an installation without it
 * can't check releases.
 *
 * Command line (used as root by lib/self-update.sh):
 *   node release-verify.js <archive> <signature>   prints the version, exit 0 = valid
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KEY_FILE = path.join(__dirname, 'release-key.pub');
const MAX_UNPACKED = 512 * 1024 * 1024;

function readKey(file = KEY_FILE) {
  try { return crypto.createPublicKey(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The signature from a .sig file: its last base64 word. */
function parseSignature(text) {
  const words = String(text || '').trim().split(/\s+/).filter((w) => /^[A-Za-z0-9+/]+={0,2}$/.test(w));
  if (!words.length) return null;
  const sig = Buffer.from(words[words.length - 1], 'base64');
  return sig.length === 64 ? sig : null;
}

function verify(archive, sigText, key = readKey()) {
  const sig = parseSignature(sigText);
  if (!key || !sig) return false;
  try { return crypto.verify(null, archive, key, sig); } catch { return false; }
}

/** Files of a tar archive (ustar/pax, as git archive writes it): [{ name, type, data }]. */
function untar(tar) {
  const out = [];
  let pax = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = h.subarray(257, 263).toString('latin1').startsWith('ustar') ? str(345, 500) : '';
    let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = data.toString('utf8'); continue; }  // extended header for the next entry
    if (type === 'g') continue;                                      // global header (git's commit id)
    if (pax) { const m = /\d+ path=([^\n]*)\n/.exec(pax); if (m) name = m[1]; pax = null; }
    out.push({ name, type, data });
  }
  return out;
}

/** Version of the release: adi2-pi/package.json inside the archive. Throws if it isn't one. */
function releaseVersion(archive) {
  let tar;
  try { tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_UNPACKED }); } catch { throw new Error('not a .tar.gz file'); }
  const files = untar(tar);
  if (!files.length || !files.every((f) => f.name === 'adi2-pi/' || f.name.startsWith('adi2-pi/'))) throw new Error('not an ADI-2-Pi release (top folder adi2-pi/ expected)');
  const pkg = files.find((f) => f.name === 'adi2-pi/package.json');
  if (!pkg || !files.some((f) => f.name === 'adi2-pi/install.sh')) throw new Error('not an ADI-2-Pi release (package.json or install.sh missing)');
  const j = JSON.parse(pkg.data.toString('utf8'));
  if (j.name !== 'adi2-pi' || !/^\d+\.\d+\.\d+/.test(String(j.version))) throw new Error('not an ADI-2-Pi release');
  return String(j.version);
}

module.exports = { verify, readKey, parseSignature, releaseVersion, untar, KEY_FILE };

if (require.main === module) {
  const [archiveFile, sigFile] = process.argv.slice(2);
  try {
    const archive = fs.readFileSync(archiveFile);
    if (!readKey()) throw new Error(`no release key (${KEY_FILE})`);
    if (!verify(archive, fs.readFileSync(sigFile, 'utf8'))) throw new Error('the signature does not match – not an unchanged ADI-2-Pi release');
    process.stdout.write(`${releaseVersion(archive)}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
