'use strict';
/**
 * System updates (settings.osUpdates.mode: off | notify | install).
 *
 * Runs unprivileged and starts two root services through polkit: adi2-pi-os-check.service
 * (apt-get update) and adi2-pi-os-upgrade.service (lib/os-upgrade.sh). Available updates come from
 * `apt-get -s full-upgrade`; the result is kept in <data>/os-updates.json. Automatic runs: 5 min
 * after the Pi starts, then every 24 h. Exits after a Node.js update so systemd restarts it.
 * Events: 'status'.
 */
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODES = ['off', 'notify', 'install'];
const UNIT_CHECK = 'adi2-pi-os-check.service';
const UNIT_UPGRADE = 'adi2-pi-os-upgrade.service';
const UNIT_DIR = '/etc/systemd/system';
const LOG_DIR = '/var/log/adi2-pi';
const AFTER_BOOT_MS = 5 * 60 * 1000;
const START_WINDOW_MS = 10 * 60 * 1000; // the bridge started together with the Pi
const EVERY_MS = 24 * 3600 * 1000;
const RETRY_MS = 3600 * 1000;
const POLL_MS = 3000;
const MAX_RUN_MS = { check: 15 * 60 * 1000, install: 2 * 3600 * 1000 };
const LOG_LINES = 30;

function run(cmd, args, { timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', ...env } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
  });
}

/** `apt-get -s full-upgrade` output → { updates: [{ name, from, to, origin, security }], removes: [name] } */
function parseSimulation(text) {
  const updates = [];
  const removes = [];
  for (const line of String(text).split('\n')) {
    let m = /^Inst (\S+)(?: \[([^\]]*)\])? \((\S+) ([^)]*?)(?: \[[^\]]*\])?\)/.exec(line);
    if (m) {
      // "Debian:13.1/stable, Debian-Security:13/stable-security" → "Debian-Security" for the first one
      const origin = m[4].split(',')[0].trim().replace(/:.*$/, '') || null;
      updates.push({ name: m[1], from: m[2] || null, to: m[3], origin, security: /security/i.test(m[4]) });
      continue;
    }
    m = /^Remv (\S+)/.exec(line);
    if (m) removes.push(m[1]);
  }
  return { updates, removes };
}

/** "6.12.47+rpt-rpi-v8" → [6, 12, 47]; compares the numbers only. */
function kernelNewer(a, b) {
  const x = (a.match(/\d+/g) || []).map(Number), y = (b.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** A newer kernel of the running flavour (e.g. "-rpi-v8") is installed: a restart uses it. */
function newerKernelInstalled({ release = os.release(), dirs } = {}) {
  let list = dirs;
  if (!list) {
    for (const d of ['/lib/modules', '/usr/lib/modules']) { try { list = fs.readdirSync(d); break; } catch { /* next */ } }
  }
  if (!list) return null;
  // "6.12.47+rpt-rpi-v8" → "-rpi-v8", "6.1.0-28-arm64" → "-arm64"
  const m = /-([a-z][\w+]*(?:-[a-z0-9][\w+]*)*)$/i.exec(release);
  const flavour = m ? `-${m[1]}` : '';
  return list.find((k) => k !== release && k.endsWith(flavour) && kernelNewer(k, release)) || null;
}

class OsUpdates extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.settings
   * @param {string} [o.dataDir] where os-updates.json is kept
   * @param {Function} [o.run] for tests and --mock
   * @param {number} [o.uptime] seconds since boot (default: os.uptime())
   * @param {boolean} [o.installed] the services are set up (default: their unit files exist)
   * @param {() => void} [o.restartSelf] after Node.js was replaced
   */
  constructor({ settings, dataDir = null, log, run: runFn = run, uptime, installed, restartSelf, logDir = LOG_DIR, kernel = newerKernelInstalled, nodeVersion = process.version, pollMs = POLL_MS } = {}) {
    super();
    this.settings = settings;
    this.log = log || console;
    this.run = runFn;
    this.logDir = logDir;
    this.kernel = kernel;
    this.nodeVersion = nodeVersion;
    this.pollMs = pollMs;
    this.restartSelf = restartSelf || (() => { this.log.info('os updates: Node.js was updated – restarting ADI-2-Pi'); setTimeout(() => process.exit(0), 500); });
    this.file = dataDir ? path.join(dataDir, 'os-updates.json') : null;
    this.installed = installed ?? (fs.existsSync(path.join(UNIT_DIR, UNIT_CHECK)) && fs.existsSync(path.join(UNIT_DIR, UNIT_UPGRADE)));
    this.startedAt = Date.now();
    this.bootAt = Date.now() - (uptime ?? os.uptime()) * 1000;
    this.bootStart = Date.now() - this.bootAt < START_WINDOW_MS;
    this.state = 'idle';          // idle | checking | installing
    this.timer = null;
    this.nextAt = null;
    this.mode = null;
    this.firstRunDone = !this.bootStart; // the run after the start (the trigger's start shutdown waits for it)
    this.r = { checkedAt: null, updates: [], removes: [], lastRun: null, error: null };
    try { if (this.file) Object.assign(this.r, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* none yet */ }
    this.restart = null;          // newer kernel installed
  }

  cfg() {
    const o = (this.settings.get().osUpdates) || {};
    return { mode: MODES.includes(o.mode) ? o.mode : 'off' };
  }

  start() {
    this._onSettings = () => this._apply();
    this.settings.on('change', this._onSettings);
    this._refreshRestart();
    this._apply(true);
    // a run started before the bridge (re)started: follow it
    if (this.installed) {
      this._unitState(UNIT_UPGRADE).then((st) => { if (st === 'activating' && this.state === 'idle') this._follow('install', UNIT_UPGRADE); }).catch(() => {});
    }
  }

  stop() {
    clearTimeout(this.timer); this.timer = null;
    clearTimeout(this.pollTimer); this.pollTimer = null;
    if (this._onSettings) this.settings.off('change', this._onSettings);
  }

  _apply(first = false) {
    const { mode } = this.cfg();
    if (mode === this.mode && !first) return;
    const was = this.mode;
    this.mode = mode;
    if (mode === 'off') {
      clearTimeout(this.timer); this.timer = null; this.nextAt = null;
      this.firstRunDone = true;
    } else if (this.installed && (was === 'off' || was === null)) {
      const now = Date.now();
      const lastDue = this.r.checkedAt ? this.r.checkedAt + EVERY_MS : 0;
      let at;
      if (first && this.bootStart) at = this.bootAt + AFTER_BOOT_MS;      // 5 min after the Pi started
      else if (first) at = Math.max(now + AFTER_BOOT_MS, lastDue);        // the service restarted later
      else at = lastDue > now ? lastDue : now + 60000;                     // switched on
      this._schedule(at - now);
    }
    if (!first) this._emit();
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    this.timer = null; this.nextAt = null;
    if (this.cfg().mode === 'off' || !this.installed) return;
    const wait = Math.max(1000, ms);
    this.nextAt = Date.now() + wait;
    this.timer = setTimeout(() => this._auto(), wait);
    this.timer.unref?.();
  }

  async _auto() {
    const { mode } = this.cfg();
    this.timer = null; this.nextAt = null;
    if (mode === 'off') return;
    if (this.state !== 'idle') { this._schedule(RETRY_MS); return; }
    let ok = false;
    try {
      if (mode === 'install') { await this.install({ auto: true }); } else { await this.check(); }
      ok = !this.r.error;
    } catch (e) { this.log.warn(`os updates: ${e.message}`); }
    this.firstRunDone = true;
    this._schedule(ok ? EVERY_MS : RETRY_MS);
    this._emit();
  }

  /** The first run after the Pi started is still to come or running (mode notify/install). */
  pendingAfterStart() {
    return this.installed && this.cfg().mode !== 'off' && !this.firstRunDone && Date.now() - this.bootAt < AFTER_BOOT_MS + 30 * 60000;
  }

  busy() { return this.state !== 'idle'; }

  assertReady() {
    if (!this.installed) throw Object.assign(new Error('system updates are not set up – run the installer again'), { status: 409 });
    if (this.state !== 'idle') throw Object.assign(new Error(this.state === 'installing' ? 'updates are being installed' : 'a check is running'), { status: 409 });
  }

  /** Refresh the package lists and list what would be updated. */
  async check() {
    this.assertReady();
    await this._runUnit('check', UNIT_CHECK);
    return this.status();
  }

  /** Install all available updates (apt-get full-upgrade). */
  async install({ auto = false } = {}) {
    this.assertReady();
    this.log.info(`os updates: installing${auto ? ' (automatic)' : ''}`);
    await this._runUnit('install', UNIT_UPGRADE);
    return this.status();
  }

  async _runUnit(kind, unit) {
    this.state = kind === 'install' ? 'installing' : 'checking';
    this._emit();
    const r = await this.run('systemctl', ['start', '--no-block', unit], { timeout: 30000 });
    if (r.code !== 0) {
      this.state = 'idle';
      this.r.error = (r.err || r.out).trim().split('\n').pop() || `systemctl start ${unit} failed`;
      this.r.lastRun = { kind, at: Date.now(), ok: false, log: [] };
      this._save();
      this._emit();
      throw Object.assign(new Error(this.r.error), { status: 500 });
    }
    await new Promise((resolve) => this._follow(kind, unit, resolve));
  }

  /** Wait until the service has finished, then read its result and list the updates again. */
  _follow(kind, unit, done = () => {}) {
    this.state = kind === 'install' ? 'installing' : 'checking';
    this._emit();
    const t0 = Date.now();
    let seenActive = false;
    const poll = async () => {
      const st = await this._unitState(unit);
      if (st === 'activating' || st === 'active' || st === 'reloading' || st === 'deactivating') seenActive = true;
      const running = st === 'activating' || st === 'reloading' || st === 'deactivating' || (!seenActive && Date.now() - t0 < 10000);
      if (running && Date.now() - t0 < MAX_RUN_MS[kind]) { this.pollTimer = setTimeout(poll, this.pollMs); return; }
      await this._finished(kind, unit);
      done();
    };
    this.pollTimer = setTimeout(poll, this.pollMs);
  }

  async _unitState(unit) {
    const r = await this.run('systemctl', ['show', '-p', 'ActiveState', '--value', unit], { timeout: 10000 });
    return r.out.trim();
  }

  async _finished(kind, unit) {
    const r = await this.run('systemctl', ['show', '-p', 'Result', '--value', unit], { timeout: 10000 });
    const ok = r.out.trim() === 'success';
    const log = this._logTail(kind === 'install' ? 'os-upgrade.log' : 'os-check.log');
    this.r.lastRun = { kind, at: Date.now(), ok, log: ok ? [] : log };
    this.r.error = ok ? null : (kind === 'install' ? 'installing the updates failed' : 'the package lists could not be loaded') + (log.length ? `: ${log[log.length - 1]}` : '');
    if (!ok) this.log.warn(`os updates: ${this.r.error}`);
    else if (kind === 'install') this.log.info('os updates: installed');
    await this._simulate();
    this.state = 'idle';
    this._refreshRestart();
    this._save();
    this._emit();
    if (kind === 'install') await this._checkNode();
  }

  async _simulate() {
    const r = await this.run('apt-get', ['-s', '-q', '-o', 'Debug::NoLocking=true', 'full-upgrade'], { timeout: 180000 });
    if (r.code !== 0) {
      this.r.error = this.r.error || `apt-get: ${(r.err || r.out).trim().split('\n').pop() || 'failed'}`;
      return;
    }
    const s = parseSimulation(r.out);
    this.r.updates = s.updates;
    this.r.removes = s.removes;
    this.r.checkedAt = Date.now();
    if (s.updates.length) this.log.info(`os updates: ${s.updates.length} update(s) available`);
  }

  _logTail(name) {
    try {
      const lines = fs.readFileSync(path.join(this.logDir, name), 'utf8').split('\n').map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd()).filter(Boolean);
      return lines.slice(-LOG_LINES);
    } catch { return []; }
  }

  _refreshRestart() {
    try { this.restart = this.kernel() || null; } catch { this.restart = null; }
  }

  /** Node.js replaced by the update: run ADI-2-Pi on the new version. */
  async _checkNode() {
    const r = await this.run(process.execPath, ['--version'], { timeout: 10000 });
    const v = r.out.trim();
    if (r.code === 0 && /^v\d/.test(v) && v !== this.nodeVersion) {
      this.log.info(`os updates: Node.js ${this.nodeVersion} → ${v}`);
      this.restartSelf();
    }
  }

  /** Restart the Pi (after a kernel update). */
  async reboot() {
    if (this.state === 'installing') throw Object.assign(new Error('updates are being installed'), { status: 409 });
    const r = await this.run('systemctl', ['reboot'], { timeout: 30000 });
    if (r.code !== 0) throw Object.assign(new Error((r.err || r.out).trim() || 'systemctl reboot failed'), { status: 500 });
    this.log.info('os updates: restarting the Pi');
    return this.status();
  }

  _save() {
    if (!this.file) return;
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.r));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) { this.log.warn(`os updates: could not save ${this.file}: ${e.message}`); }
  }

  status() {
    const { mode } = this.cfg();
    return {
      mode,
      available: this.installed,
      reason: this.installed ? null : 'system updates are not set up – run the installer again',
      state: this.state,
      checkedAt: this.r.checkedAt,
      count: this.r.updates.length,
      updates: this.r.updates,
      removes: this.r.removes,
      node: this.r.updates.find((u) => u.name === 'nodejs') || null,
      restart: this.restart,       // newer kernel installed: a restart of the Pi uses it
      lastRun: this.r.lastRun,
      error: this.r.error,
      nextAt: this.cfg().mode === 'off' ? null : this.nextAt,
    };
  }

  _emit() {
    const s = JSON.stringify(this.status());
    if (s === this._last) return;
    this._last = s;
    this.emit('status', this.status());
  }
}

module.exports = { OsUpdates, parseSimulation, newerKernelInstalled, MODES, UNIT_CHECK, UNIT_UPGRADE };
