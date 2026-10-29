'use strict';
/**
 * The bridge's model of the connected ADI-2.
 *
 * - identifies the unit (device ID from the USB name, else probes DAC/Pro/SE IDs)
 * - keeps every parameter in memory, keyed "addr.idx" (nothing is written to disk)
 * - coalesces sets into as few SysEx messages as possible
 * - the unit does not echo sets, so the model is updated on send and re-read 1.5 s later
 * - full resync every 30 s (catches anything the unit didn't push)
 * - bridge-side extras like ADI-2 Remote: volume limits, rise-speed limit, linked volumes
 * - watchdog: the unit sends a status message about once a second; when that stops (MIDI Control
 *   switched off on the unit), the bridge says so, refuses sets and records what it had sent
 *   just before, then picks up again by itself once the unit answers
 *
 * Events:
 *   'device' ({connected, ready, id, model, name, problem})
 *   'params' ({ "addr.idx": value, … }, origin)   origin: 'device' | 'client' | 'auto' | 'bridge'
 *   'setups' ([9 names])
 *   'eqpresets' ([20 × {n, name, empty, L, R}])  the unit's EQ presets
 *   'status' (hex, info)
 *   'midi'   ({dir: 'rx'|'tx', hex})
 */
const { EventEmitter } = require('events');
const P = require('./protocol');
const cat = require('./catalog');

/** An error with the HTTP status the API should answer with (400 = bad request, 409 = unit not able to). */
const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_ADDR = 12;                   // 13/14 are EQ preset data: only through storeEqPreset

const PROBE_ORDER = ['pro', 'se', 'dac'];
const PROBE_TIMEOUT_MS = 700;
const READBACK_MS = 1500;
const RESYNC_MS = 30000;
const FLUSH_MS = 8;
const RAMP_TICK_MS = 50;
const EQ_PRESET_IDX = 28; // EQ Preset Select on the left EQ address
const PRESETS_MS = 120000; // re-read EQ preset names (they change when presets are stored on the unit)
const PRESET_GAP_MS = 40;
const SILENT_MS = 4000;     // no message from the unit for this long = not answering
const REPROBE_MS = 3000;    // while silent, ask again this often
const TX_LOG = 60;          // recent messages kept for the silence report

class Adi2 extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.transport  AlsaMidiTransport or MockAdi
   * @param {object} o.settings   live settings object (limits, link, riseDbPerSec)
   * @param {object} [o.log]
   */
  constructor({ transport, settings, log, silentMs = SILENT_MS }) {
    super();
    this.silentMs = silentMs;
    this.answering = false;
    this.lastRx = 0;
    this.lastTx = 0;
    this.txLog = []; // [{ at, hex, what }]
    this.sentLog = []; // changes sent to the unit: [{ at, by, what }] (newest last)
    this.by = null;    // who the current request comes from (set by the server around a command)
    this.silences = []; // last few: { at, lastRx, back, sent: [{ at, what, hex }] }
    this.watchdog = null;
    this.card = null;
    this.t = transport;
    this.settings = settings;
    this.log = log || console;
    this.state = new Map();
    this.setups = Array(9).fill('');
    this.lastStatus = null;
    this.statusInfo = null;
    this.id = null;
    this.model = null;
    this.connected = false;
    this.ready = false;
    this.portName = null;
    this.problem = null;
    this.pending = new Map(); // key → value queued for sending
    this.flushTimer = null;
    this.readbackTimer = null;
    this.resyncTimer = null;
    this.probeTimer = null;
    this.readyTimer = null;
    this.ramps = new Map(); // ch → { target, timer }
    this.eqPresets = this._emptyPresets();
    this.presetTimer = null;
    this.presetEmitTimer = null;
    this.presetCursor = null; // preset whose data is arriving (from its flag word)
    this.splitter = new P.SysexSplitter((m) => this._onSysex(m));

    this.t.on('open', (info) => this._onOpen(info));
    this.t.on('close', (reason) => this._onClose(reason));
    this.t.on('data', (chunk) => this.splitter.push(chunk));
    this.t.on('problem', (p) => { this.problem = p; this._emitDevice(); });
  }

  start() { this.t.start(); }
  stop() {
    this._clearTimers();
    this.t.stop();
  }

  info() {
    return {
      connected: this.connected,
      ready: this.ready,
      id: this.id,
      model: this.model,
      modelName: this.model ? cat.schema.modelNames[this.model] : null,
      port: this.portName,
      card: this.card,
      answering: this.answering,
      problem: this.connected && this.answering ? null : this.problem,
    };
  }

  snapshot() { return Object.fromEntries(this.state); }

  _emptyPresets() {
    return Array.from({ length: 20 }, (_, i) => ({ n: i + 1, name: '', empty: null, dual: false, L: {}, R: {} }));
  }

  /** The unit's 20 EQ presets: name, empty flag and data (protocol integers by EQ index). */
  presets() { return this.eqPresets.map((p) => ({ ...p, L: { ...p.L }, R: { ...p.R } })); }

  requestEqPresets() {
    if (!this.id) return;
    for (let n = 1; n <= 20; n++) {
      setTimeout(() => { if (this.id) this._tx(P.requestEqPreset(this.id, n)); }, (n - 1) * PRESET_GAP_MS);
    }
  }

  _presetsChanged() {
    clearTimeout(this.presetEmitTimer);
    this.presetEmitTimer = setTimeout(() => this.emit('eqpresets', this.presets()), 150);
  }
  get(addr, idx) { return this.state.get(cat.key(addr, idx)); }

  // ------------------------------------------------------------------ connection

  _onOpen(info) {
    this.connected = true;
    this.ready = false;
    this.portName = info.name;
    this.card = info.card ?? null;
    this.answering = false;
    this.splitter.buf = null;
    const first = info.hint && PROBE_ORDER.includes(info.hint) ? info.hint : PROBE_ORDER[0];
    this.probeList = [first, ...PROBE_ORDER.filter((m) => m !== first)];
    this.id = null;
    this.model = null;
    this._forget();
    this._emitDevice();
    this._probe();
  }

  /** The unit is gone (or a new one is connected): its values, setup names, presets and status with it. */
  _forget() {
    this.state.clear();
    this.setups = Array(9).fill('');
    this.lastStatus = null;
    this.statusInfo = null;
    this.eqPresets = this._emptyPresets();
  }

  _probe() {
    clearTimeout(this.probeTimer);
    const m = this.probeList.shift();
    if (!m) {
      // nobody answered: MIDI Control is probably off. Keep trying slowly.
      this.problem = { code: 'silent', text: 'ADI-2 found but it does not answer – set MIDI Control to ON in the Device Mode menu' };
      this._emitDevice();
      this.probeList = [...PROBE_ORDER];
      this.probeTimer = setTimeout(() => this._probe(), 5000);
      return;
    }
    this._probingId = P.DEVICE_IDS[m];
    this._tx(P.requestAll(this._probingId));
    this.probeTimer = setTimeout(() => this._probe(), PROBE_TIMEOUT_MS);
  }

  _identified(id) {
    clearTimeout(this.probeTimer);
    this.id = id;
    this.model = P.MODEL_BY_ID[id] || 'pro';
    this.problem = null;
    this.answering = true;
    this.log.info(`adi2: ${cat.schema.modelNames[this.model]} answers on ID 0x${id.toString(16)}`);
    this._emitDevice();
    this._scheduleResync();
    this._startWatchdog();
    // the dump takes ~1.5 s; ready once the setup names arrived, or after 3 s
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => this._setReady(), 3000);
  }

  _setReady() {
    clearTimeout(this.readyTimer);
    if (this.ready || !this.id) return;
    this.ready = true;
    this._emitDevice();
    this.requestEqPresets();
    clearInterval(this.presetTimer);
    this.presetTimer = setInterval(() => this.requestEqPresets(), PRESETS_MS);
    this.presetTimer.unref?.();
  }

  _onClose(reason) {
    this._clearTimers();
    this.connected = false;
    this.ready = false;
    this.answering = false;
    this.id = null;
    this.pending.clear();
    this._forget();
    this.problem = { code: 'disconnected', text: `ADI-2 disconnected (${reason})` };
    this._emitDevice();
  }

  _clearTimers() {
    for (const t of [this.flushTimer, this.readbackTimer, this.probeTimer, this.readyTimer]) clearTimeout(t);
    clearInterval(this.resyncTimer);
    clearInterval(this.presetTimer);
    clearInterval(this.watchdog);
    clearTimeout(this.presetEmitTimer);
    for (const r of this.ramps.values()) clearInterval(r.timer);
    this.ramps.clear();
  }

  _emitDevice() { this.emit('device', this.info()); }

  _scheduleResync() {
    clearInterval(this.resyncTimer);
    this.resyncTimer = setInterval(() => this.refresh(), RESYNC_MS);
    this.resyncTimer.unref?.();
  }

  // ------------------------------------------------------------------ receive

  _tx(buf) {
    const hex = P.hex(buf);
    this.emit('midi', { dir: 'tx', hex });
    const at = Date.now();
    this.lastTx = at;
    this.txLog.push({ at, hex });
    if (this.txLog.length > TX_LOG) this.txLog.shift();
    return this.t.write(buf);
  }

  // ------------------------------------------------------------------ watchdog

  _startWatchdog() {
    clearInterval(this.watchdog);
    this.lastRx = Date.now();
    this.watchdog = setInterval(() => this._watch(), Math.min(1000, this.silentMs / 2));
    this.watchdog.unref?.();
  }

  _watch() {
    if (!this.id || !this.connected) return;
    const now = Date.now();
    if (this.answering && now - this.lastRx > this.silentMs) {
      this.answering = false;
      this._clearPending();
      // what went to the unit in the last 20 s before it fell silent (the routine re-reads excluded)
      const sent = this.txLog.filter((m) => m.at >= this.lastRx - 20000)
        .map((m) => ({ at: new Date(m.at).toISOString(), what: P.describe(P.unhex(m.hex)), hex: m.hex }))
        .map((m) => (/^read (all|EQ preset)/.test(m.what) ? { ...m, what: `${m.what} (routine)` } : m));
      const s = { at: new Date(now).toISOString(), lastRx: new Date(this.lastRx).toISOString(), back: null, sent };
      this.silences.push(s);
      if (this.silences.length > 5) this.silences.shift();
      this.problem = { code: 'silent', text: 'The ADI-2 stopped answering. MIDI Control on the unit is probably OFF: set SETUP – Options – Device Mode – MIDI Control to ON. ADI-2-Pi picks up again by itself.' };
      this.log.warn(`adi2: unit stopped answering (last message ${s.lastRx}). Sent before:${sent.length ? '' : ' nothing but routine re-reads'}`);
      for (const m of sent) this.log.warn(`adi2:   ${m.at} ${m.what}  [${m.hex}]`);
      this._emitDevice();
      this.emit('silence', this.silences);
      this._reprobeAt = now;
    }
    if (!this.answering && now - (this._reprobeAt || 0) >= REPROBE_MS) {
      this._reprobeAt = now;
      this._tx(P.requestAll(this.id));
    }
  }

  _clearPending() {
    this.pending.clear();
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const r of this.ramps.values()) clearInterval(r.timer);
    this.ramps.clear();
  }

  _answeringAgain() {
    this.answering = true;
    this.problem = null;
    const s = this.silences[this.silences.length - 1];
    if (s && !s.back) s.back = new Date().toISOString();
    this.log.info('adi2: unit answers again');
    this._emitDevice();
    this.emit('silence', this.silences);
    // everything may have changed meanwhile (settings on the unit, setups, presets)
    this.refresh();
    this.requestEqPresets();
  }

  _onSysex(buf) {
    this.emit('midi', { dir: 'rx', hex: P.hex(buf) });
    const msg = P.parse(buf);
    if (!msg) return;
    if (this.id && msg.id === this.id) {
      this.lastRx = Date.now();
      if (!this.answering) this._answeringAgain();
    }
    if (!this.id) {
      if (msg.id === this._probingId) this._identified(msg.id);
      else return;
    } else if (msg.id !== this.id) return;

    switch (msg.cmd) {
      case P.CMD.PARAMS_TO_REMOTE: {
        const changed = {};
        let presetsTouched = false;
        for (const p of msg.params) {
          // EQ preset data (addresses 13 = left, 14 = right) is not a live setting
          if (p.addr === P.PRESET_ADDR_L && p.idx === P.PRESET_FLAG_IDX) {
            // flags word comes first; the preset's data follows (also in the next message)
            const f = P.decodePresetFlag(p.value);
            this.presetCursor = f.n;
            const e = this.eqPresets[f.n - 1];
            if (e) {
              if (e.empty !== f.empty || e.dual !== f.dual) presetsTouched = true;
              e.empty = f.empty;
              e.dual = f.dual;
              if (f.empty && (Object.keys(e.L).length || Object.keys(e.R).length || e.name)) { e.L = {}; e.R = {}; e.name = ''; presetsTouched = true; }
            }
            continue;
          }
          if (p.addr === P.PRESET_ADDR_L || p.addr === P.PRESET_ADDR_R) {
            const e = this.presetCursor && this.eqPresets[this.presetCursor - 1];
            if (e) {
              const side = p.addr === P.PRESET_ADDR_L ? 'L' : 'R';
              if (e[side][p.idx] !== p.value) { e[side][p.idx] = p.value; presetsTouched = true; }
            }
            continue;
          }
          const k = cat.key(p.addr, p.idx);
          if (this.pending.has(k)) continue; // our own newer value wins until sent
          if (this.state.get(k) !== p.value) {
            this.state.set(k, p.value);
            changed[k] = p.value;
          }
        }
        for (const p of msg.params) {
          if (p.idx === EQ_PRESET_IDX && changed[cat.key(p.addr, p.idx)] !== undefined && !msg.params.some((q) => q.addr === p.addr && q.idx !== EQ_PRESET_IDX)) {
            this._presetLoaded(p.addr, p.value, changed); // only when the unit sent the selection alone
          }
        }
        if (Object.keys(changed).length) this.emit('params', changed, 'device');
        if (presetsTouched) this._presetsChanged();
        break;
      }
      case P.CMD.PRESET_NAME:
      case P.CMD.SETUP_NAME:
        if (msg.eqPreset) {
          const e = this.eqPresets[msg.eqPreset.n - 1];
          // an empty slot reports a placeholder ("EQ Preset 3"); its flags word clears it again
          const name = e.empty === true ? '' : msg.eqPreset.name;
          if (e.name !== name) { e.name = name; this._presetsChanged(); }
        }
        if (msg.setup) {
          if (this.setups[msg.setup.n - 1] !== msg.setup.name) {
            this.setups[msg.setup.n - 1] = msg.setup.name;
            if (msg.setup.n === 9 || this.ready) this.emit('setups', this.setups);
          }
          if (msg.setup.n === 9) {
            this.emit('setups', this.setups);
            this._setReady();
          }
        }
        break;
      case P.CMD.STATUS: {
        const h = P.hex(msg.data);
        if (h !== this.lastStatus) {
          this.lastStatus = h;
          const prev = this.statusInfo;
          this.statusInfo = P.parseStatus(msg.data);
          if (this.statusInfo) {
            this.statusInfo.inputs = P.digitalInputs(this.statusInfo, this.model, prev && prev.inputs);
            this.statusInfo.jacks = P.phoneJacks(this.statusInfo, this.model);
          }
          this.emit('status', h, this.statusInfo);
        }
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ send

  /**
   * Set parameters. Accepts a list of
   *   { addr, idx, value }                 protocol integers (freq in Hz)
   *   { key: "addr.idx", value }
   *   { ch, id, side?, value }             display units (dB, Hz, Q …)
   *   { ch, id, side?, delta }             relative, display units
   * Returns { applied: {key: value}, errors: [] }.
   */
  set(list, { origin = 'client' } = {}) {
    const errors = [];
    const applied = {};
    if (!this.connected || !this.id) return { applied, errors: ['ADI-2 not connected'], status: 409 };
    if (!this.answering) return { applied, errors: ['The ADI-2 is not answering – is MIDI Control ON?'], status: 409 };
    let status;
    for (const item of list) {
      try {
        const r = this._resolveItem(item);
        this._applyOne(r.addr, r.idx, r.value, applied, item.ramp !== false);
      } catch (e) {
        errors.push(e.message);
        status = Math.max(status || 0, e.status || 400);
      }
    }
    if (Object.keys(applied).length) {
      this.emit('params', applied, origin);
      this._note(origin, Object.entries(applied).map(([k, v]) => this._describe(k, v)).join(', '));
    }
    return { applied, errors, status };
  }

  /** "Phones 3/4 · Source = USB 1/2" for a protocol key and value. */
  _describe(k, v) {
    const e = cat.lookup(k);
    if (!e) return `${k} = ${v}`;
    const ch = e.ch === 'device' ? 'Device' : (cat.channelByKey[e.ch]?.name || e.ch);
    const names = e.param.type === 'select' ? cat.valueNames(e.param, this.model, cat.channelByKey[e.ch]) : null;
    const val = names ? (names[v] ?? v) : e.param.type === 'toggle' ? (v ? 'on' : 'off') : `${cat.toDisplay(e.param, v)}${e.param.unit ? ` ${e.param.unit}` : ''}`;
    return `${ch}${e.side === 'R' ? ' EQ R' : ''} · ${e.param.label} = ${val}`;
  }

  /** Log a change sent to the unit, with who asked for it. */
  _note(origin, what) {
    const BY = {
      auto: 'ADI-2-Pi: USB while the Pi plays', input: 'ADI-2-Pi: input priority', profile: 'ADI-2-Pi: headphone profile', bridge: 'ADI-2-Pi: Bluetooth headphones (Loopback)',
      stream: 'ADI-2-Pi: volume of the AirPlay/Spotify sender', start: 'ADI-2-Pi: start volume',
      rule: 'ADI-2-Pi: action', sleep: 'ADI-2-Pi: sleep timer', restore: 'ADI-2-Pi: restore from backup', mqtt: 'MQTT (Home Assistant)',
    };
    const by = BY[origin] || this.by || origin;
    this.sentLog.push({ at: Date.now(), by, what });
    if (this.sentLog.length > 100) this.sentLog.shift();
    this.emit('sent', this.sentLog[this.sentLog.length - 1]);
  }

  _resolveItem(item) {
    if (!item || typeof item !== 'object') throw httpError('each set item must be an object');
    const r = this._resolveItem2(item);
    const k = cat.key(r.addr, r.idx);
    const e = cat.lookup(k);
    if (e && e.param.readonly) throw httpError(`${e.param.label} (${k}) is read-only`);
    // after the unit has read out its settings, ones it never reported don't exist on it
    if (this.ready && !this.state.has(k) && !this.pending.has(k)) {
      throw httpError(`${e ? `${e.param.label} (${k})` : k}: this ${cat.schema.modelNames[this.model] || 'unit'} has no such setting`);
    }
    if (e && e.param.type === 'select') {
      const names = cat.valueNames(e.param, this.model, cat.channelByKey[e.ch]);
      if (names && (r.value < 0 || r.value >= names.length)) throw httpError(`${e.param.label} (${k}): ${r.value} is not one of 0–${names.length - 1} (${names.join(', ')})`);
    }
    return r;
  }

  _resolveItem2(item) {
    let addr, idx, param;
    const num = (v, what) => {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (!Number.isFinite(n)) throw httpError(`${what}: not a number`);
      return n;
    };
    if (item.key !== undefined || item.addr !== undefined) {
      if (item.key !== undefined) {
        if (!/^\d+\.\d+$/.test(String(item.key))) throw httpError(`bad address ${item.key} (use "addr.idx")`);
        [addr, idx] = String(item.key).split('.').map(Number);
      } else { addr = Number(item.addr); idx = Number(item.idx); }
      const k = `${addr}.${idx}`;
      if (!Number.isInteger(addr) || !Number.isInteger(idx)) throw httpError(`bad address ${k}`);
      if (addr === 13 || addr === 14) throw httpError(`${k}: EQ preset data – use storePreset`);
      if (addr < 0 || addr > MAX_ADDR || idx < 0 || idx > (addr === cat.DEVICE_ADDR ? 63 : 31)) throw httpError(`no parameter ${k}`);
      param = cat.lookup(k)?.param;
      if (!param && !this.state.has(k)) throw httpError(`no parameter ${k}`);
      if (item.value === undefined) throw httpError(`${k}: no value`);
      const v = Math.round(num(item.value, k));
      if (param) return { addr, idx, value: cat.clampRaw(param, v) };
      // reported by the unit but not in the schema: the container's range
      const [lo, hi] = addr === cat.DEVICE_ADDR ? [0, 2047] : [-2048, 2047];
      return { addr, idx, value: Math.max(lo, Math.min(hi, v)) };
    }
    if (item.id) {
      const r = cat.resolve(item.ch, item.id, item.side === 'R' ? 'R' : 'L');
      if (!r) throw httpError(`unknown parameter ${item.ch || 'device'}/${item.id}`);
      if (r.param.readonly) throw httpError(`${item.id} is read-only`);
      addr = r.addr; idx = r.idx; param = r.param;
      let disp = item.value;
      if (item.delta !== undefined) {
        const cur = this.state.get(cat.key(addr, idx));
        if (cur === undefined) throw httpError(`${item.id}: value not known yet`, 409);
        if (!Number.isFinite(Number(item.delta))) throw httpError(`${item.id}: delta is not a number`);
        if (param.type === 'toggle') disp = cur ? 0 : 1; // delta on a toggle = flip
        else if (param.type === 'select') {
          const n = cat.valueNames(param, this.model, r.channel)?.length || 1;
          disp = (((cur + Math.sign(item.delta)) % n) + n) % n;
        } else disp = cat.toDisplay(param, cur) + Number(item.delta);
      }
      if (disp === undefined || disp === null) throw httpError(`${item.id}: no value`);
      if (typeof disp !== 'number' && typeof disp !== 'boolean' && !(typeof disp === 'string' && disp.trim() !== '')) throw httpError(`${item.id}: not a number`);
      try { return { addr, idx, value: cat.fromDisplay(param, disp) }; } catch (e) { throw httpError(e.message); }
    }
    throw httpError('item needs key, addr/idx or ch/id');
  }

  _channelForVol(addr, idx) {
    const c = cat.channels.find((ch) => ch.kind === 'output' && ch.addr === addr);
    return c && idx === cat.sections.output.vol.idx ? c : null;
  }

  _applyOne(addr, idx, value, applied, allowRamp) {
    const ch = this._channelForVol(addr, idx);
    if (ch) {
      value = this._limitVolume(ch.key, value);
      const cur = this.state.get(cat.key(addr, idx));
      // linked volumes: same change on the other linked outputs
      const link = this.settings.link || [];
      if (link.includes(ch.key) && cur !== undefined && !this._inLink) {
        const delta = value - cur;
        this._inLink = true;
        try {
          for (const other of link) {
            if (other === ch.key) continue;
            const oc = cat.channelByKey[other];
            const ov = this.state.get(cat.key(oc.addr, idx));
            if (ov !== undefined && delta) this._applyOne(oc.addr, idx, ov + delta, applied, allowRamp);
          }
        } finally { this._inLink = false; }
      }
      const rate = Number(this.settings.riseDbPerSec) || 0;
      if (allowRamp && rate > 0 && cur !== undefined && value > cur) {
        this._ramp(ch.key, addr, idx, value, rate);
        return;
      }
      this._stopRamp(ch.key);
    }
    this._queue(addr, idx, value, applied);
  }

  _limitVolume(chKey, value) {
    const lim = this.settings.limits?.[chKey];
    if (lim === null || lim === undefined || lim === '') return value;
    return Math.min(value, Math.round(Number(lim) * 10));
  }

  _ramp(chKey, addr, idx, target, rateDbPerSec) {
    let r = this.ramps.get(chKey);
    if (!r) {
      r = { target, timer: null };
      this.ramps.set(chKey, r);
    }
    r.target = target;
    if (r.timer) return;
    const stepRaw = Math.max(1, Math.round((rateDbPerSec * 10 * RAMP_TICK_MS) / 1000));
    r.timer = setInterval(() => {
      const cur = this.state.get(cat.key(addr, idx));
      if (cur === undefined || !this.connected) return this._stopRamp(chKey);
      const next = Math.min(r.target, cur + stepRaw);
      const applied = {};
      this._queue(addr, idx, next, applied);
      this.emit('params', applied, 'client');
      if (next >= r.target) this._stopRamp(chKey);
    }, RAMP_TICK_MS);
  }

  _stopRamp(chKey) {
    const r = this.ramps.get(chKey);
    if (r) {
      clearInterval(r.timer);
      this.ramps.delete(chKey);
    }
  }

  _queue(addr, idx, value, applied) {
    const k = cat.key(addr, idx);
    this.state.set(k, value);
    this.pending.set(k, value);
    applied[k] = value;
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this._flush(), FLUSH_MS);
    if (idx === EQ_PRESET_IDX) this._presetLoaded(addr, value, applied);
  }

  /**
   * Selecting EQ preset n on an output makes the unit load that preset into the output's EQ.
   * The unit doesn't report that back by itself, so the model takes the preset's values now
   * (bands always, Bass/Treble only when the output has "Load B/T with preset" on);
   * the read-back confirms them.
   */
  _presetLoaded(eqAddr, value, applied) {
    const ch = cat.channels.find((c) => c.eq === eqAddr);
    const p = value >= 2 && value <= 21 && this.eqPresets[value - 2];
    if (!ch || !p || p.empty !== false || !Object.keys(p.L).length) return;
    const put = (addr, i, v) => {
      if (v === undefined) return;
      const k = cat.key(addr, i);
      if (this.state.get(k) !== v) { this.state.set(k, v); applied[k] = v; }
    };
    for (const i of P.PRESET_IDX_R) {
      put(ch.eq, i, p.L[i]);
      put(ch.eqR, i, p.dual && p.R[i] !== undefined ? p.R[i] : p.L[i]);
    }
    // Bass/Treble come along when the output's own "Load B/T with preset" is on
    if (this.state.get(cat.key(ch.eq, 27))) for (const i of P.PRESET_BT_IDX) put(ch.eq, i, p.L[i]);
    const dualIdx = (ch.kind === 'input' ? cat.sections.input.indualeq : cat.sections.output.dualeq).idx;
    put(ch.addr, dualIdx, p.dual ? 1 : 0);
  }

  _flush() {
    this.flushTimer = null;
    if (!this.pending.size || !this.id) return;
    const params = [...this.pending.entries()].map(([k, value]) => {
      const [addr, idx] = k.split('.').map(Number);
      return { addr, idx, value };
    });
    this.pending.clear();
    for (const m of P.paramsToDevice(this.id, params)) this._tx(m);
    // the unit doesn't echo sets: read back once things have settled
    clearTimeout(this.readbackTimer);
    this.readbackTimer = setTimeout(() => this.refresh(), READBACK_MS);
  }

  _flushNow() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this._flush(); }
  }

  refresh() {
    if (this.id) this._tx(P.requestAll(this.id));
  }

  /** n = 1…9 */
  loadSetup(n) {
    n = Number(n);
    if (!this.id) throw httpError('ADI-2 not connected', 409);
    this._needAnswer();
    if (!(Number.isInteger(n) && n >= 1 && n <= 9)) throw new Error('setup must be 1–9');
    this._note('client', `load setup ${n}`);
    this._tx(P.loadSetup(this.id, n));
    setTimeout(() => { this.refresh(); this.requestEqPresets(); }, 600);
  }

  /** Save the current state to setup n; with a name, the name goes first (the unit names a setup while storing it). */
  saveSetup(n, name) {
    n = Number(n);
    if (!this.id) throw httpError('ADI-2 not connected', 409);
    this._needAnswer();
    if (!(Number.isInteger(n) && n >= 1 && n <= 9)) throw new Error('setup must be 1–9');
    this._flushNow(); // pending sets belong in the saved state
    if (name !== undefined && name !== null && name !== '') this._setupName(n, name);
    this._note('client', `save setup ${n}${name ? ` as “${name}”` : ''}`);
    this._tx(P.saveSetup(this.id, n));
    setTimeout(() => this.refresh(), 600); // the dump ends with the setup names: confirms the name
  }

  /** Rename setup n (1–9) without saving the current state into it. */
  renameSetup(n, name) {
    n = Number(n);
    if (!this.id) throw httpError('ADI-2 not connected', 409);
    this._needAnswer();
    if (!(Number.isInteger(n) && n >= 1 && n <= 9)) throw new Error('setup must be 1–9');
    this._setupName(n, name);
    this._note('client', `rename setup ${n} to “${name}”`);
    setTimeout(() => this.refresh(), 600);
  }

  _setupName(n, name) {
    const clean = String(name ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, P.PRESET_NAME_LEN);
    if (!clean) throw new Error('name must not be empty');
    this._tx(P.nameSetup(this.id, n, clean));
    this.setups[n - 1] = clean;
    this.emit('setups', this.setups);
  }

  loadFactory() {
    if (!this.id) throw httpError('ADI-2 not connected', 409);
    this._needAnswer();
    this._note('client', 'load factory settings');
    this._tx(P.loadFactory(this.id));
    setTimeout(() => { this.refresh(); this.requestEqPresets(); }, 800);
  }

  /**
   * Store an EQ preset in slot n (1–20), as ADI-2 Remote does.
   * values: { L: {eqIndex: value}, R: {eqIndex: value}, dual } with protocol integers
   * (frequencies in Hz); name optional (max 14 characters).
   */
  storeEqPreset(n, values, name) {
    n = Number(n);
    if (!this.id) throw httpError('ADI-2 not connected', 409);
    this._needAnswer();
    if (!(Number.isInteger(n) && n >= 1 && n <= 20)) throw new Error('preset must be 1–20');
    if (!values || !values.L || !Object.keys(values.L).length) throw new Error('no EQ values to store');
    const clean = (side, list) => {
      const out = {};
      for (const i of list) {
        const v = values[side] && values[side][i];
        if (v === undefined || v === null || v === '') continue;
        const param = cat.lookup(cat.key(4, i))?.param; // line EQ L has the same indices
        out[i] = cat.clampRaw(param, Number(v));
        if (!Number.isFinite(out[i])) throw new Error(`bad value for EQ index ${i}`);
      }
      return out;
    };
    // complete partial presets with RME's defaults, so a stored preset is always whole
    const def = cat.schema.eqDefaults.values;
    const withDefaults = (vals, list) => Object.fromEntries(list.map((i) => [i, vals[i] ?? def[i]]));
    const L = withDefaults(clean('L', P.PRESET_IDX_L), P.PRESET_IDX_L);
    const R = withDefaults(values.dual ? clean('R', P.PRESET_IDX_R) : clean('L', P.PRESET_IDX_R), P.PRESET_IDX_R);

    this._note('client', `store EQ preset ${n}${name ? ` “${name}”` : ''}`);
    this._storeMsgs(n, { L, R, dual: !!values.dual }, name);
    // show it right away; the read-back confirms it
    const e = this.eqPresets[n - 1];
    Object.assign(e, { empty: false, dual: !!values.dual, L: { ...L }, R: { ...R } });
    if (name !== undefined && name !== null) e.name = String(name).trim().slice(0, P.PRESET_NAME_LEN);
    this._presetsChanged();
    return this.presets()[n - 1];
  }

  /**
   * Like ADI-2 Remote: the unit keeps preset data – and the name – in a temporary memory and
   * only stores them when the flags word for the slot arrives. So: data, name, then flags.
   */
  _storeMsgs(n, values, name) {
    const msgs = P.storeEqPreset(this.id, n, values);
    msgs.slice(0, -1).forEach((m) => this._tx(m));
    if (name !== undefined && name !== null) this._tx(P.nameEqPreset(this.id, n, name));
    setTimeout(() => {
      if (!this.id) return;
      this._tx(msgs[msgs.length - 1]); // flags word: store now
      setTimeout(() => { if (this.id) this._tx(P.requestEqPreset(this.id, n)); }, 400); // read back
    }, 30);
  }

  /** Rename a stored preset: its current data is sent again with the new name, then stored. */
  renameEqPreset(n, name) {
    n = Number(n);
    if (!this.id) throw httpError('ADI-2 not connected', 409);
    this._needAnswer();
    if (!(Number.isInteger(n) && n >= 1 && n <= 20)) throw new Error('preset must be 1–20');
    const e = this.eqPresets[n - 1];
    if (!e || e.empty !== false || !Object.keys(e.L).length) throw new Error(`preset ${n} is empty – store an EQ in it first`);
    if (typeof name !== 'string' || !name.trim()) throw new Error('name required');
    const R = e.dual ? e.R : Object.fromEntries(P.PRESET_IDX_R.map((i) => [i, e.L[i]]));
    this._note('client', `rename EQ preset ${n} to “${name}”`);
    this._storeMsgs(n, { L: e.L, R, dual: e.dual }, name);
    e.name = String(name || '').trim().slice(0, P.PRESET_NAME_LEN);
    this._presetsChanged();
  }

  _needAnswer() {
    if (!this.answering) throw httpError('The ADI-2 is not answering – is MIDI Control ON?', 409);
  }

  /** Send raw SysEx (developer tool). Only RME ADI-2 frames are allowed. */
  raw(hexString) {
    const buf = P.unhex(hexString);
    if (!P.parse(buf)) throw new Error('only complete RME SysEx messages (F0 00 20 0D … F7)');
    if (!this.connected) throw httpError('ADI-2 not connected', 409);
    this._note('client', `raw: ${P.describe(buf)}`);
    this._tx(buf);
  }
}

module.exports = { Adi2 };
