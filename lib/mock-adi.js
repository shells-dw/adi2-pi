'use strict';
/**
 * Simulated ADI-2 on a fake MIDI port. Used by the tests and by `adi2-pi --mock`,
 * so the page and the API can be tried without a unit.
 *
 * Behaves like the real unit as observed on an ADI-2 Pro EX:
 *  - silent until it receives a message with its own device ID
 *  - "request all" (03 09) answered after ~100 ms with parameter dumps (cmd 01),
 *    setup names (cmd 05, 0x21…0x29 + name), then a status message (cmd 07)
 *  - parameter sets (cmd 02) are applied but NOT echoed back
 *  - front-panel changes are pushed (cmd 01) once a client has talked to it
 *  - status message about once per second while a client is active
 */
const { EventEmitter } = require('events');
const P = require('./protocol');
const cat = require('./catalog');

function defaults(model) {
  const s = new Map();
  const put = (ch, id, v, side) => {
    const r = cat.resolve(ch, id, side);
    if (r) s.set(cat.key(r.addr, r.idx), v);
  };
  for (const c of cat.channels) {
    if (!cat.available(c, model)) continue;
    const list = c.kind === 'input' ? cat.sections.input : cat.sections.output;
    for (const p of Object.values(list)) if (cat.available(p, model)) put(c.key, p.id, 0);
    if (c.kind === 'output') {
      put(c.key, 'vol', c.key === 'line' ? -200 : -300);
      put(c.key, 'ldbass', 10); put(c.key, 'ldtreb', 6); put(c.key, 'ldref', -400);
      put(c.key, 'ref', c.line ? 1 : 1);
    }
    for (const side of ['L', 'R']) {
      const f = [100, 500, 1000, 5000, 10000];
      for (const p of Object.values(cat.sections.eq)) {
        let v = 0;
        if (p.role === 'freq') v = f[p.band - 1];
        if (p.role === 'q') v = 10;
        if (p.id === 'b1type' || p.id === 'b5type') v = 1;
        if (p.id === 'bassf') v = 80;
        if (p.id === 'trebf') v = 6000;
        if (p.id === 'bassq' || p.id === 'trebq') v = 9;
        put(c.key, p.id, v, side);
      }
    }
  }
  for (const p of Object.values(cat.sections.device)) if (cat.available(p, model)) put('device', p.id, 0);
  put('device', 'basic', 2);
  put('device', 'srate', 1);
  return s;
}

class MockAdi extends EventEmitter {
  /** model: pro, se, dac, or se-ex (an ADI-2/4 Pro EX: ID 0x73 with device revision 1 in the status) */
  constructor({ model = 'pro', log } = {}) {
    super();
    this.profile = model;
    this.model = model.replace('-ex', '');
    this.id = P.DEVICE_IDS[this.model];
    this.log = log || { info() {}, warn() {} };
    this.state = defaults(model);
    // ADI2PI_MOCK_UNKNOWN=1: also report parameters the schema doesn't know (tests the System tab's list)
    if (process.env.ADI2PI_MOCK_UNKNOWN) {
      this.state.set('12.44', 1); this.state.set('3.24', 0);
      const t = setInterval(() => this.frontPanel(12, 44, this.get(12, 44) ? 0 : 1), 4000); t.unref?.();
    }
    this.setupNames = ['UCX II AES', 'Speakers', 'HD 800 S', '', '', '', '', '', 'Late night'];
    this.saved = {}; // setup number → Map
    // EQ presets 1–20: { name, L: {eqIdx: value}, R } – null = empty slot
    this.eqPresets = Array(20).fill(null);
    this.presetTemp = { L: {}, R: {} }; // "temporary memory" for incoming preset data
    const eqData = (bands) => {
      const d = { 3: 1, 16: 0, 21: 0, 22: 85, 23: 9, 24: 0, 25: 6500, 26: 7 };
      const f = [100, 500, 1000, 5000, 10000];
      for (let b = 1; b <= 5; b++) { const i = b === 5 ? 17 : 1 + b * 3; d[i] = 0; d[i + 1] = f[b - 1]; d[i + 2] = 10; }
      for (const [b, g, fr, q] of bands) { const i = b === 5 ? 17 : 1 + b * 3; d[i] = g; d[i + 1] = fr; d[i + 2] = q; }
      return d;
    };
    this.eqPresets[0] = { name: 'K812-Harman', L: eqData([[1, 8, 70, 7], [2, -6, 220, 14], [3, 9, 2540, 20], [4, -11, 3800, 40], [5, -14, 15000, 8]]) };
    this.eqPresets[1] = { name: 'HD 650', L: eqData([[1, 12, 76, 8], [4, -3, 200, 16]]) };
    this.eqPresets[3] = { name: 'Late Night', L: eqData([[1, 6, 100, 7]]) };
    for (const e of this.eqPresets) if (e) { e.dual = false; e.R = Object.fromEntries(Object.entries(e.L).filter(([i]) => Number(i) <= 19)); }
    this.active = false;
    this.statusTimer = null;
    this.isOpen = false;
    this.info = null;
    this.splitter = new P.SysexSplitter((m) => this._onMessage(m));
    this.received = []; // for tests
    this.midiControl = true; // the unit's MIDI Control option; OFF = it ignores everything
  }

  // ---- transport interface ----
  start() { setTimeout(() => this.plug(), 5); }
  stop() { this.unplug('stopped'); }
  write(buf) {
    if (!this.isOpen) return false;
    this.splitter.push(buf);
    return true;
  }

  // ---- simulation controls ----
  plug() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.info = { card: 9, name: `ADI-2 ${this.model === 'dac' ? 'DAC' : this.model === 'se' ? '/4 Pro' : 'Pro'} (simulated)`, path: 'mock', hint: this.model };
    this.emit('open', this.info);
  }
  unplug(reason = 'unplugged') {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.active = false;
    clearInterval(this.statusTimer);
    this.emit('close', reason);
  }
  /** Simulate turning a knob / pressing a key on the unit. */
  frontPanel(addr, idx, value) {
    this.state.set(cat.key(addr, idx), value);
    if (this.active) this._send(P.frame(this.id, P.CMD.PARAMS_TO_REMOTE, P.encodeParam(addr, idx, value)));
  }
  get(addr, idx) { return this.state.get(cat.key(addr, idx)); }
  /** Simulate switching MIDI Control on the unit: OFF = silent, no status messages. */
  setMidiControl(on) {
    this.midiControl = !!on;
    if (!on) { this.active = false; clearInterval(this.statusTimer); }
  }

  // ---- internals ----
  _send(buf) {
    if (this.isOpen) setImmediate(() => this.isOpen && this.emit('data', buf));
  }

  _onMessage(m) {
    const msg = P.parse(m);
    if (!msg || msg.id !== this.id) return; // the real unit ignores other IDs
    if (!this.midiControl) return;
    this.received.push(msg);
    if (!this.active) {
      this.active = true;
      clearInterval(this.statusTimer);
      this.statusTimer = setInterval(() => this._status(), 1000);
      this.statusTimer.unref?.();
    }
    switch (msg.cmd) {
      case P.CMD.PARAMS_TO_DEVICE:
        for (const p of msg.params) {
          if (p.addr === P.PRESET_ADDR_L && p.idx === P.PRESET_FLAG_IDX) continue; // like the unit: ignored
          if (p.addr === P.PRESET_ADDR_L && p.idx === P.PRESET_STORE_IDX) {
            // flags word: store the temporary preset data into the slot it names
            const f = P.decodePresetFlag(p.value);
            // like the ADI-2 Pro EX: output settings (B/T Enable 20, Load B/T 27) inside a stored
            // preset switch MIDI Control OFF
            if (this.presetTemp.L[20] !== undefined || this.presetTemp.L[27] !== undefined) {
              this.presetTemp = { L: {}, R: {} };
              this.setMidiControl(false);
              return;
            }
            const name = this.presetTemp.name ?? (this.eqPresets[f.n - 1] || {}).name ?? '';
            this.eqPresets[f.n - 1] = { name, dual: f.dual, L: { ...this.presetTemp.L }, R: { ...this.presetTemp.R } };
            this.presetTemp = { L: {}, R: {} };
          } else if (p.addr === P.PRESET_ADDR_L) this.presetTemp.L[p.idx] = p.value;
          else if (p.addr === P.PRESET_ADDR_R) this.presetTemp.R[p.idx] = p.value;
          else if (p.addr === P.DEVICE_ADDR && p.idx === 63) {
            // Do Toggle Outputs (receive only, not stored): simulated as Line Out mute on/off
            const k = cat.key(3, 15);
            this.state.set(k, this.state.get(k) ? 0 : 1);
          } else {
            this.state.set(cat.key(p.addr, p.idx), p.value);
            const ch = cat.channels.find((c) => c.eq === p.addr);
            const e = ch && p.idx === 28 && p.value >= 2 && p.value <= 21 && this.eqPresets[p.value - 2];
            if (e) {
              for (let i = 3; i <= 19; i++) { this.state.set(cat.key(ch.eq, i), e.L[i]); this.state.set(cat.key(ch.eqR, i), e.dual ? e.R[i] : e.L[i]); }
              if (this.state.get(cat.key(ch.eq, 27))) for (let i = 21; i <= 26; i++) this.state.set(cat.key(ch.eq, i), e.L[i]);
            }
          }
        }
        break;
      case P.CMD.SETUP_NAME: {
        const n = msg.data[0];
        let name = '';
        for (const b of msg.data.slice(1)) { if (b === 0) break; name += String.fromCharCode(b); }
        // assumed like the preset data: held until the flags word stores it
        if (n >= 1 && n <= 20) this.presetTemp.name = name.trim();
        if (n >= 0x21 && n <= 0x29) this.setupNames[n - 0x21] = name.trim();
        this.received.names = (this.received.names || 0) + 1;
        break;
      }
      case P.CMD.REQUEST:
        if (msg.data[0] === P.REQ_ALL) setTimeout(() => this._dumpAll(), 100);
        else if (msg.data[0] >= 0x0a && msg.data[0] <= 0x1d) this._sendPreset(msg.data[0] - 0x09);
        break;
      case P.CMD.SETUP: {
        const d = msg.data[0];
        if (d >= 1 && d <= 9) {
          const s = this.saved[d];
          if (s) this.state = new Map(s);
          else this.state.set(cat.key(3, 12), -150 - d * 10); // something visible changes
          setTimeout(() => this._dumpAll(), 300);
        } else if (d >= 0x0a && d <= 0x12) {
          this.saved[d - 9] = new Map(this.state);
        } else if (d === 0x13) {
          this.state = defaults(this.model);
          setTimeout(() => this._dumpAll(), 300);
        }
        break;
      }
      default:
        break;
    }
  }

  _dumpAll() {
    const entries = [...this.state.entries()].map(([k, v]) => {
      const [addr, idx] = k.split('.').map(Number);
      return { addr, idx, value: v };
    });
    // Real unit: 127-byte messages = 40 params each
    for (let i = 0; i < entries.length; i += 40) {
      const data = [];
      for (const p of entries.slice(i, i + 40)) data.push(...P.encodeParam(p.addr, p.idx, p.value));
      this._send(P.frame(this.id, P.CMD.PARAMS_TO_REMOTE, data));
    }
    this.setupNames.forEach((name, i) => {
      const bytes = [0x21 + i, ...Buffer.from(name.padEnd(16, ' ').slice(0, 16), 'ascii')];
      this._send(P.frame(this.id, P.CMD.PRESET_NAME, bytes));
    });
    this._status();
  }

  /** Like the unit (RME table example): name first, then flags word + data. */
  _sendPreset(n) {
    const e = this.eqPresets[n - 1];
    this._send(P.frame(this.id, P.CMD.PRESET_NAME, [n, ...P.presetName(e && e.name ? e.name : `EQ Preset ${n}`)]));
    const words = [P.encodeParam(13, P.PRESET_FLAG_IDX, e ? P.encodePresetFlag(n, e.dual) : (((n - 1) << 4) | 0xf))];
    if (e) {
      for (const [i, v] of Object.entries(e.L)) words.push(P.encodeParam(13, Number(i), v));
      for (const [i, v] of Object.entries(e.R)) words.push(P.encodeParam(14, Number(i), v));
    }
    this._send(P.frame(this.id, P.CMD.PARAMS_TO_REMOTE, words.flat()));
  }

  _status() {
    // as captured from an ADI-2 Pro EX (14 bytes, one more than RME's table): AES locked at 48 kHz,
    // clock AES, a plug in Phones 3/4, 8-channel mode. Byte 6 bits 3–2 = device revision: 1 on the
    // Pro EX and the ADI-2/4 Pro EX, 0 for the others here.
    const b6 = this.profile === 'pro' || this.profile === 'se-ex' ? 0x05 : 0x01;
    this._send(P.frame(this.id, P.CMD.STATUS, [b6, 0x75, 0x64, 0x08, 0x40, 0x00, 0x0a, 0x02, 0x00, 0x01, 0x12, 0x01, 0x00, 0x00]));
  }
}

module.exports = { MockAdi, defaults };
