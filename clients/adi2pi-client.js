'use strict';
/**
 * ADI-2-Pi API client (docs/API.md) for Node.js applications. No dependencies: uses the built-in
 * WebSocket (Node.js 22+), or a WebSocket class passed in, e.g.
 * `new Adi2PiClient({ url, WebSocket: require('ws') })`.
 *
 *   const c = new Adi2PiClient({ url: 'ws://adi2-pi.local/ws' });
 *   c.on('ready', () => c.set('ph34', 'vol', { delta: -1 }));
 *   c.on('param', (key, value, origin) => …);          // "addr.idx", protocol integer
 *   c.get('ph34', 'vol')                                // display value (dB …) or undefined
 *   c.start();
 *
 * Keeps a copy of all values (state + 'p' broadcasts), reconnects by itself (1 s … 15 s),
 * answers requests by rid and rejects them with err.status (400 bad request, 409 unit not able to execute it now).
 */
const { EventEmitter } = require('events');

const API = 1;

class Adi2PiClient extends EventEmitter {
  constructor({ url, WebSocket: WS = globalThis.WebSocket, timeoutMs = 5000 } = {}) {
    super();
    if (!url) throw new Error('url needed, e.g. ws://adi2-pi.local/ws');
    if (!WS) throw new Error('no WebSocket class: pass one, e.g. require("ws")');
    this.url = url;
    this.WS = WS;
    this.timeoutMs = timeoutMs;
    this.p = new Map();          // "addr.idx" → protocol integer
    this.device = null;          // { connected, ready, answering, model, … }
    this.bridge = null;          // { name, version, host }
    this.schema = null;          // from the first 'state' – fetched once over HTTP
    this.settings = null;
    this.waiting = new Map();
    this.rid = 0;
    this.retry = 1000;
    this.stopped = true;
  }

  start() { this.stopped = false; this._connect(); return this; }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.sock) try { this.sock.close(); } catch { /* gone */ }
  }

  /** true when values can be read and set */
  get usable() { return !!(this.device && this.device.connected && this.device.ready && this.device.answering !== false); }

  _connect() {
    const s = new this.WS(this.url);
    this.sock = s;
    const on = (ev, fn) => (s.addEventListener ? s.addEventListener(ev, fn) : s.on(ev, fn));
    on('open', () => { this.retry = 1000; });
    on('message', (e) => {
      const data = e && e.data !== undefined ? e.data : e;
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      this._onMessage(m);
    });
    on('close', () => {
      for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(Object.assign(new Error('connection closed'), { status: 503 })); }
      this.waiting.clear();
      const was = this.connected;
      this.connected = false;
      this.readySent = false;
      if (was) this.emit('disconnected');
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this._connect(), this.retry);
        this.retry = Math.min(this.retry * 2, 15000);
      }
    });
    on('error', () => { /* close follows */ });
  }

  _onMessage(m) {
    if (m.rid !== undefined && this.waiting.has(m.rid)) {
      const w = this.waiting.get(m.rid);
      this.waiting.delete(m.rid);
      clearTimeout(w.timer);
      if (m.t === 'err') w.reject(Object.assign(new Error(m.error), { status: m.status }));
      else w.resolve(m);
    }
    switch (m.t) {
      case 'hello':
        if (m.api !== API) this.emit('warning', `bridge speaks API ${m.api}, this client ${API}`);
        this.bridge = m.bridge;
        this.device = m.device;
        this.connected = true;
        this.emit('connected', m);
        break;
      case 'state':
        this.p = new Map(Object.entries(m.p));
        this.device = m.device;
        this.emit('state', m);
        if (this.usable && !this.readySent) { this.readySent = true; this.emit('ready'); }
        break;
      case 'settings': this.settings = m.settings; this.emit('settings', m.settings); break;
      case 'p':
        for (const [k, v] of Object.entries(m.p)) { this.p.set(k, v); this.emit('param', k, v, m.origin); }
        break;
      case 'device':
        this.device = m.device;
        this.emit('device', m.device);
        if (this.usable && !this.readySent) this.request({ t: 'get' }).catch(() => {}); // fresh values, then 'ready'
        if (!this.usable && this.readySent) { this.readySent = false; this.emit('unusable', m.device); }
        break;
      default:
        if (m.t) this.emit(m.t, m);
    }
  }

  /** Send a command and wait for its reply. Rejects with err.status on errors. */
  request(msg) {
    if (!this.sock || !this.connected) return Promise.reject(Object.assign(new Error('not connected to ADI-2-Pi'), { status: 503 }));
    const rid = `c${++this.rid}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(rid); reject(Object.assign(new Error('no answer from ADI-2-Pi'), { status: 504 })); }, this.timeoutMs);
      this.waiting.set(rid, { resolve, reject, timer });
      this.sock.send(JSON.stringify({ ...msg, rid }));
    });
  }

  /** Set by name, in display units: set('ph34', 'vol', -20) or set('ph34', 'vol', { delta: 0.5 }). */
  set(ch, id, v, side) {
    const item = { t: 'set', ch, id, ...(typeof v === 'object' && v !== null ? v : { value: v }) };
    if (side) item.side = side;
    return this.request(item);
  }

  /** Current value by name, in display units (needs the schema: await loadSchema() once). */
  get(ch, id, side = 'L') {
    const r = this.resolve(ch, id, side);
    if (!r) return undefined;
    const v = this.p.get(`${r.addr}.${r.idx}`);
    if (v === undefined) return undefined;
    return r.param.type === 'level' ? v * (r.param.scale ?? 1) : v;
  }

  /** GET /api/schema once (same host as the WebSocket). */
  async loadSchema(fetchFn = globalThis.fetch) {
    const httpUrl = this.url.replace(/^ws/, 'http').replace(/\/ws$/, '/api/schema');
    const r = await fetchFn(httpUrl);
    if (!r.ok) throw new Error(`schema: HTTP ${r.status}`);
    this.schema = await r.json();
    return this.schema;
  }

  /** name → { addr, idx, param } using the schema (mirrors lib/catalog.js). */
  resolve(ch, id, side = 'L') {
    const s = this.schema;
    if (!s) throw new Error('call loadSchema() first');
    if (!ch || ch === 'device') {
      const p = s.params.device.find((x) => x.id === id);
      return p ? { addr: 12, idx: p.idx, param: p } : null;
    }
    const c = s.channels.find((x) => x.key === ch);
    if (!c) return null;
    const eq = s.params.eq.find((x) => x.id === id);
    if (eq) return { addr: side === 'R' ? c.eqR : c.eq, idx: eq.idx, param: eq };
    const p = s.params[c.kind === 'input' ? 'input' : 'output'].find((x) => x.id === id);
    return p ? { addr: c.addr, idx: p.idx, param: p } : null;
  }
}

module.exports = { Adi2PiClient, API };
