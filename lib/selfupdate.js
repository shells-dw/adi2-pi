'use strict';
/**
 * Install from a file (System → ADI-2-Pi updates): a release archive and its signature uploaded
 * through the web page, installed without ADI-2-Pi downloading anything.
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
  constructor({ dataDir, version, log, run: runFn = run, key, installed, logFile = LOG, pollMs = POLL_MS } = {}) {
    super();
    this.dir = dataDir ? path.join(dataDir, 'update') : null;
    this.version = version;
    this.log = log || console;
    this.run = runFn;
    this.key = key === undefined ? RV.readKey() : key;
    this.installed = installed ?? fs.existsSync(UNIT_FILE);
    this.logFile = logFile;
    this.pollMs = pollMs;
    this.staged = null;      // { version, size, at }
    this.state = 'idle';     // idle | installing
    this.lastRun = null;     // { at, ok, log }
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'staged.json'), 'utf8'));
      if (j && fs.existsSync(path.join(this.dir, 'release.tar.gz'))) this.staged = j;
    } catch { /* nothing staged */ }
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

  stop() { clearTimeout(this.timer); this.timer = null; }

  _need() {
    const r = this.reason();
    if (r) throw Object.assign(new Error(r), { status: 409 });
    if (this.state === 'installing') throw Object.assign(new Error('an update is being installed'), { status: 409 });
  }

  /** Check an uploaded release and keep it for install(). */
  stage(archive, sigText) {
    this._need();
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
    this._need();
    if (!this.staged) throw Object.assign(new Error('upload a release first'), { status: 409 });
    try { fs.unlinkSync(path.join(this.dir, 'staged.json')); } catch { /* fine */ }
    this.log.info(`self-update: installing ADI-2-Pi ${this.staged.version}`);
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
    };
  }

  _emit() { this.emit('status', this.status()); }
}

module.exports = { SelfUpdate, UNIT, MAX_ARCHIVE };
