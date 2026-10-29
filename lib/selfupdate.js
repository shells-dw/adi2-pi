'use strict';
/**
 * Installing a release (System → ADI-2-Pi updates): uploaded as a file, downloaded from GitHub on
 * request (installRelease), or automatically when settings.updates.auto is on (autoInstall: after
 * a check found a newer release, when the Pi isn't playing; a version that failed once isn't tried
 * again by itself). Either way only a release signed with the release key is installed.
 *
 * stage(): checks the signature (lib/release-verify.js, key lib/release-key.pub) and the version,
 * then keeps both files in <data>/update/. install(): starts adi2-pi-self-update.service (root,
 * allowed by polkit), which checks the signature again on its own copy and runs the release's
 * install.sh --same-options. The installer restarts ADI-2-Pi; the new process reads the result
 * from systemd. Output: /var/log/adi2-pi/self-update.log. Events: 'status'.
 */
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const RV = require('./release-verify');
const { compareVersions } = require('./updates');

const UNIT = 'adi2-pi-self-update.service';
const UNIT_FILE = `/etc/systemd/system/${UNIT}`;
const LOG = '/var/log/adi2-pi/self-update.log';
const MAX_ARCHIVE = 64 * 1024 * 1024;
const POLL_MS = 2000;

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
  });
}

class SelfUpdate extends EventEmitter {
  constructor({ dataDir, version, log, run: runFn = run, key, installed, logFile = LOG, pollMs = POLL_MS, fetch: fetchFn = globalThis.fetch } = {}) {
    super();
    this.dir = dataDir ? path.join(dataDir, 'update') : null;
    this.version = version;
    this.log = log || console;
    this.run = runFn;
    this.key = key === undefined ? RV.readKey() : key;
    this.installed = installed ?? fs.existsSync(UNIT_FILE);
    this.logFile = logFile;
    this.pollMs = pollMs;
    this.fetch = fetchFn;
    this.staged = null;      // { version, size, at }
    this.state = 'idle';     // idle | downloading | installing
    this.error = null;       // last download or check problem
    this.autoTimer = null;
    this.lastRun = null;     // { at, ok, log }
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'staged.json'), 'utf8'));
      if (j && fs.existsSync(path.join(this.dir, 'release.tar.gz'))) this.staged = j;
    } catch { /* nothing staged */ }
    // the version an automatic install was last tried with, and whether it failed
    this.auto = { tried: null, failed: null };
    try { Object.assign(this.auto, JSON.parse(fs.readFileSync(path.join(this.dir, 'auto.json'), 'utf8'))); } catch { /* none */ }
  }

  reason() {
    if (!this.dir) return 'not available in this installation';
    if (!this.installed) return 'not set up – run the installer once by hand';
    if (!this.key) return 'this installation has no release key (lib/release-key.pub)';
    return null;
  }

  /** After a start: an install that was running, or how the last one ended. */
  async start() {
    if (this.reason()) return;
    const st = await this._show();
    if (st.ActiveState === 'activating') this._follow();
    else if (st.Result && st.ExecMainExitTimestamp) {
      const ok = st.Result === 'success';
      const at = /^@(\d+)/.exec(st.ExecMainExitTimestamp);
      this.lastRun = { at: at ? Number(at[1]) * 1000 : null, ok, log: ok ? [] : this._logTail() };
      this._emit();
    }
  }

  stop() { clearTimeout(this.timer); this.timer = null; clearTimeout(this.autoTimer); this.autoTimer = null; }

  busy() { return this.state !== 'idle'; }

  assertReady() {
    const r = this.reason();
    if (r) throw Object.assign(new Error(r), { status: 409 });
    if (this.state === 'installing') throw Object.assign(new Error('an update is being installed'), { status: 409 });
    if (this.state === 'downloading') throw Object.assign(new Error('a release is being downloaded'), { status: 409 });
  }

  /** Download a release's archive and signature (latest.files from lib/updates.js) and stage them. */
  async download(files) {
    this.assertReady();
    if (!files || !files.archive || !files.signature) throw Object.assign(new Error('this release has no signed files – install it by hand'), { status: 409 });
    if (typeof this.fetch !== 'function') throw Object.assign(new Error('this Node.js has no fetch'), { status: 409 });
    this.state = 'downloading';
    this.error = null;
    this._emit();
    const get = async (url, max) => {
      const r = await this.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000), headers: { 'User-Agent': `adi2-pi/${this.version}` } });
      if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
      if (Number(r.headers.get('content-length') || 0) > max) throw new Error('the download is too large for a release');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max) throw new Error('the download is too large for a release');
      return buf;
    };
    try {
      const sig = (await get(files.signature, 4096)).toString('utf8');
      const archive = await get(files.archive, MAX_ARCHIVE);
      this.state = 'idle';
      return this.stage(archive, sig);
    } catch (e) {
      this.state = 'idle';
      this.error = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'the download took too long' : e.message;
      this.log.warn(`self-update: ${this.error}`);
      this._emit();
      throw Object.assign(new Error(this.error), { status: e.status || 502 });
    }
  }

  /** Download, check and install a release from GitHub. */
  async installRelease(files) {
    await this.download(files);
    return this.install();
  }

  /**
   * After a check found a newer release (settings.updates.auto): install it when the Pi isn't
   * playing (`playing()`), else try again in 30 minutes. A version whose installation failed is
   * left to the user.
   */
  autoInstall(latest, { playing = () => false, enabled = () => true } = {}) {
    clearTimeout(this.autoTimer);
    this.autoTimer = null;
    if (!latest || !latest.files || this.reason() || !enabled()) return false;
    if (compareVersions(latest.version, this.version) <= 0 || this.auto.failed === latest.version) return false;
    if (this.state !== 'idle' || playing()) {
      this.autoTimer = setTimeout(() => this.autoInstall(latest, { playing, enabled }), 30 * 60 * 1000);
      this.autoTimer.unref?.();
      return false;
    }
    this.log.info(`self-update: installing ADI-2-Pi ${latest.version} automatically`);
    this._saveAuto({ tried: latest.version, failed: null });
    this.installRelease(latest.files).catch(() => this._saveAuto({ tried: latest.version, failed: latest.version }));
    return true;
  }

  _saveAuto(a) {
    this.auto = a;
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(path.join(this.dir, 'auto.json'), JSON.stringify(a)); } catch { /* not kept */ }
  }

  /** Check an uploaded release and keep it for install(). */
  stage(archive, sigText) {
    this.assertReady();
    if (!archive || !archive.length) throw Object.assign(new Error('no file'), { status: 400 });
    if (archive.length > MAX_ARCHIVE) throw Object.assign(new Error('the file is too large for a release'), { status: 413 });
    if (!RV.parseSignature(sigText)) throw Object.assign(new Error('the signature file (.sig) is missing or not valid'), { status: 400 });
    if (!RV.verify(archive, sigText, this.key)) throw Object.assign(new Error('the signature does not match – this is not an unchanged ADI-2-Pi release'), { status: 400 });
    let version;
    try { version = RV.releaseVersion(archive); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o750 });
    fs.writeFileSync(path.join(this.dir, 'release.tar.gz'), archive, { mode: 0o640 });
    fs.writeFileSync(path.join(this.dir, 'release.tar.gz.sig'), String(sigText), { mode: 0o640 });
    this.staged = { version, size: archive.length, at: Date.now() };
    this.error = null;
    fs.writeFileSync(path.join(this.dir, 'staged.json'), JSON.stringify(this.staged));
    this.log.info(`self-update: ADI-2-Pi ${version} uploaded, signature valid`);
    this._emit();
    return this.status();
  }

  discard() {
    for (const f of ['release.tar.gz', 'release.tar.gz.sig', 'staged.json']) { try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* gone */ } }
    this.staged = null;
    this._emit();
    return this.status();
  }

  async install() {
    this.assertReady();
    if (!this.staged) throw Object.assign(new Error('upload a release first'), { status: 409 });
    try { fs.unlinkSync(path.join(this.dir, 'staged.json')); } catch { /* fine */ }
    this.log.info(`self-update: installing ADI-2-Pi ${this.staged.version}`);
    this.installing = this.staged.version;
    const r = await this.run('systemctl', ['start', '--no-block', UNIT]);
    if (r.code !== 0) throw Object.assign(new Error((r.err || r.out).trim().split('\n').pop() || `systemctl start ${UNIT} failed`), { status: 500 });
    this._follow();
    return this.status();
  }

  _follow() {
    this.state = 'installing';
    this._emit();
    const t0 = Date.now();
    let seen = false;
    const poll = async () => {
      const st = await this._show();
      if (st.ActiveState === 'activating') seen = true;
      if (st.ActiveState === 'activating' || (!seen && Date.now() - t0 < 10000)) { this.timer = setTimeout(poll, this.pollMs); return; }
      // still here: the installer didn't restart ADI-2-Pi, so it stopped early
      const ok = st.Result === 'success';
      this.state = 'idle';
      this.staged = null;
      this.lastRun = { at: Date.now(), ok, log: ok ? [] : this._logTail() };
      if (!ok) this.log.warn('self-update: the install failed – see /var/log/adi2-pi/self-update.log');
      if (!ok && this.auto.tried && this.auto.tried === this.installing) this._saveAuto({ tried: this.auto.tried, failed: this.auto.tried });
      this._emit();
    };
    this.timer = setTimeout(poll, this.pollMs);
  }

  async _show() {
    const r = await this.run('systemctl', ['show', '--timestamp=unix', '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainExitTimestamp', UNIT]);
    const o = {};
    for (const l of r.out.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1).trim(); }
    return o;
  }

  _logTail() {
    try {
      return fs.readFileSync(this.logFile, 'utf8').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd()).filter(Boolean).slice(-25);
    } catch { return []; }
  }

  status() {
    const s = this.staged;
    return {
      available: !this.reason(),
      reason: this.reason(),
      current: this.version,
      state: this.state,
      staged: s ? { ...s, newer: compareVersions(s.version, this.version) > 0, same: compareVersions(s.version, this.version) === 0 } : null,
      lastRun: this.lastRun,
      error: this.error,
      autoFailed: this.auto.failed,     // automatic install of this version failed; not tried again by itself
    };
  }

  _emit() { this.emit('status', this.status()); }
}

module.exports = { SelfUpdate, UNIT, MAX_ARCHIVE };
