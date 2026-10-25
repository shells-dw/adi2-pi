'use strict';
/**
 * Bluetooth control for the bridge: runs lib/bt-helper.py (BlueZ over D-Bus, Python from the
 * Raspberry Pi OS repos) and talks to it in JSON lines.
 *
 * Events: 'state' (state) – adapter, pairing window, scan, devices (see bt-helper.py)
 */
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const HELPER = path.join(__dirname, 'bt-helper.py');

/** Plain-language versions of BlueZ errors. */
function explain(code, text) {
  const c = String(code || '');
  if (/AuthenticationFailed|AuthenticationRejected/.test(c)) return 'Pairing was refused or failed. Put the device in pairing mode and try again.';
  if (/AuthenticationCanceled/.test(c)) return 'Pairing was cancelled on the device.';
  if (/ConnectionAttemptFailed|PageTimeout/.test(c) || /page-timeout|connection-refused|host-down/i.test(text)) return 'Could not reach the device. Is it switched on and close by?';
  if (/AuthenticationTimeout|NoReply/.test(c) || /Timeout/i.test(text)) return 'The device did not answer in time. Is it switched on, close by and in pairing mode?';
  if (/AlreadyConnected/.test(c)) return 'Already connected.';
  if (/InProgress/.test(c)) return 'Already busy with this device – wait a moment.';
  if (/br-connection-profile-unavailable|profile-unavailable/i.test(text)) return 'No audio service for this device: the ADI-2-Pi audio service is not running, or the device offers no audio.';
  if (/NotReady/.test(c)) return 'Bluetooth is switched off.';
  if (/Blocked|rfkill/i.test(c + text)) return 'Bluetooth is blocked (rfkill). Run: sudo rfkill unblock bluetooth';
  if (/DoesNotExist|unknown device/i.test(c + text)) return 'That device is no longer known – search again.';
  return text || c || 'Bluetooth error';
}

class Bluetooth extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.python]   interpreter (python3)
   * @param {string} [o.alias]    name the Pi shows to other devices
   * @param {object} [o.env]      extra environment (tests: DBUS_SYSTEM_BUS_ADDRESS)
   */
  constructor({ log, python = 'python3', helper = HELPER, alias = 'ADI-2-Pi', env = {} } = {}) {
    super();
    this.log = log || console;
    this.python = python;
    this.helper = helper;
    this.alias = alias;
    this.env = env;
    this.proc = null;
    this.buf = '';
    this.rid = 0;
    this.waiting = new Map();
    this.state = { available: false, reason: 'starting', adapter: null, devices: [] };
    this.stopped = false;
    this.backoff = 2000;
    this.restartTimer = null;
  }

  start() {
    this.stopped = false;
    this._spawn();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* gone */ }
      const p = this.proc;
      setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* gone */ } }, 1500).unref?.();
    }
  }

  _spawn() {
    let p;
    try {
      p = spawn(this.python, ['-u', this.helper], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.env } });
    } catch (e) {
      return this._unavailable(`cannot start the Bluetooth helper: ${e.message}`);
    }
    this.proc = p;
    this.buf = '';
    p.on('error', (e) => {
      if (e.code === 'ENOENT') this._unavailable('python3 is not installed – run the installer again');
      else this._unavailable(`Bluetooth helper: ${e.message}`);
    });
    p.stdin.on('error', () => { /* EPIPE while the helper is going down: its exit handler reports */ });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => this._data(d));
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { for (const l of d.split('\n')) if (l.trim()) this.log.info(l.trim()); });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      for (const w of this.waiting.values()) w.reject(new Error('Bluetooth helper stopped'));
      this.waiting.clear();
      if (this.stopped) return;
      if (code === 3) return; // missing Python modules: reported via 'fatal', retrying won't help
      this.log.warn(`bluetooth: helper exited (${code}), restarting`);
      this.restartTimer = setTimeout(() => this._spawn(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
    });
    this.cmd('init', { alias: this.alias }).then(() => { this.backoff = 2000; }).catch(() => {});
  }

  _unavailable(reason) {
    this.state = { available: false, reason, adapter: null, devices: [] };
    this.emit('state', this.state);
  }

  _data(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { this.log.warn(`bluetooth: bad line from helper: ${line.slice(0, 120)}`); continue; }
      if (m.event === 'state') {
        this.state = m.state;
        this.emit('state', this.state);
      } else if (m.event === 'fatal') {
        this._unavailable(m.error);
      } else if (m.id !== undefined && this.waiting.has(m.id)) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        clearTimeout(w.timer);
        if (m.ok) w.resolve(m.result);
        else w.reject(Object.assign(new Error(explain(m.code, m.error)), { code: m.code, raw: m.error, status: 409 }));
      }
    }
  }

  /** Send a command; resolves with the helper's result. */
  cmd(cmd, args = {}, timeoutMs = 75000) {
    if (!this.proc) return Promise.reject(Object.assign(new Error(this.state.reason || 'Bluetooth is not available'), { status: 409 }));
    const id = ++this.rid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.waiting.delete(id)) reject(Object.assign(new Error('Bluetooth did not answer in time'), { status: 504 })); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  setAlias(name) {
    this.alias = name;
    return this.state.available ? this.cmd('alias', { name }).catch(() => {}) : Promise.resolve();
  }

  device(address) {
    return (this.state.devices || []).find((d) => d.address.toUpperCase() === String(address || '').toUpperCase()) || null;
  }
}

module.exports = { Bluetooth, explain };
