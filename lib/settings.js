'use strict';
/**
 * Bridge settings (name, volume limits, linked outputs …).
 * Written to disk only when something actually changes, atomically (temp file + rename),
 * and debounced so repeated changes cause one write.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = {
  name: 'ADI-2-Pi',
  port: 80,
  // highest volume the bridge will send per output, in dB (null = unit's own maximum)
  limits: { line: null, ph12: 0, ph34: 0 },
  // max volume increase speed in dB per second (0 = off), like ADI-2 Remote's "limit volume rise speed"
  riseDbPerSec: 0,
  // outputs whose volumes move together when changed through the bridge
  link: [],
  // what Bluetooth headphones/speakers play: 'line' / 'ph34' (that output after its EQ, through
  // the unit's Loopback), 'analog' (the analog input), 'off'
  // gainDb: added to what Bluetooth headphones get (the unit sends Line Out/Phones 3/4 6 dB lower
  // for EQ headroom, so +6 dB brings it back to the level the unit plays)
  bluetooth: { outSource: 'line', gainDb: 6 },
  // streaming receivers (lib/receivers.js); server: '' = find it on the network
  receivers: {
    airplay: { enabled: true },
    spotify: { enabled: true },
    upnp: { enabled: true, uuid: '' },
    squeezelite: { enabled: false, server: '' },
    snapcast: { enabled: false, server: '' },
  },
  // several sources at once: 'newest' (the last one to start is heard, others muted) or 'mix';
  // rate: 0 = the ADI-2 follows what plays, else fixed (everything resampled to it)
  // usb: switch these ADI-2 outputs' Source to USB while the Pi plays, back afterwards;
  // held: what they were set to before (kept here so a restart can still put it back)
  routing: { mode: 'newest', rate: 0, usb: { line: true, ph34: true }, held: { line: null, ph34: null } },
  // shut the Pi down when the ADI-2's Trigger Out (wired to GPIO3) stays off for delaySec
  trigger: { enabled: false, delaySec: 10 },
};
const TRIGGER_DELAYS = [10, 30, 60, 300];
const USB_OUTS = ['line', 'ph34'];
const RECEIVERS = ['airplay', 'spotify', 'upnp', 'squeezelite', 'snapcast'];
const RATES = [0, 44100, 48000, 88200, 96000, 176400, 192000];
const BT_SOURCES = ['line', 'ph34', 'analog', 'off'];

const SAVE_DELAY_MS = 2000;

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

class Settings extends EventEmitter {
  constructor(file, log) {
    super();
    this.file = file;
    this.log = log || console;
    this.data = merge(DEFAULTS, {});
    this.timer = null;
    if (file) {
      try {
        this.data = merge(DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (e) {
        if (e.code !== 'ENOENT') this.log.warn(`settings: ${file} unreadable (${e.message}), using defaults`);
      }
    }
  }

  get() { return this.data; }

  /** Validate and apply a partial update. Returns the new settings. */
  update(patch) {
    const next = JSON.parse(JSON.stringify(this.data)); // deep copy: nested objects are edited below
    if (patch.name !== undefined) {
      const n = String(patch.name).trim().slice(0, 40);
      if (!n) throw new Error('name must not be empty');
      next.name = n;
    }
    if (patch.limits !== undefined) {
      for (const [ch, v] of Object.entries(patch.limits)) {
        if (!['line', 'ph12', 'ph34'].includes(ch)) throw new Error(`unknown output ${ch}`);
        if (v === null || v === '') next.limits[ch] = null;
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < -114.5 || n > 6) throw new Error(`limit for ${ch} must be −114.5…+6 dB`);
          next.limits[ch] = Math.round(n * 2) / 2;
        }
      }
    }
    if (patch.riseDbPerSec !== undefined) {
      const n = Number(patch.riseDbPerSec);
      if (!Number.isFinite(n) || n < 0 || n > 200) throw new Error('rise speed must be 0…200 dB/s');
      next.riseDbPerSec = n;
    }
    if (patch.link !== undefined) {
      if (!Array.isArray(patch.link) || patch.link.some((c) => !['line', 'ph12', 'ph34'].includes(c))) throw new Error('link must be a list of line/ph12/ph34');
      next.link = [...new Set(patch.link)];
      if (next.link.length < 2) next.link = [];
    }
    if (patch.bluetooth !== undefined) {
      const b = patch.bluetooth || {};
      if (b.outSource !== undefined) {
        if (!BT_SOURCES.includes(b.outSource)) throw new Error(`Bluetooth out source must be one of ${BT_SOURCES.join(', ')}`);
        next.bluetooth.outSource = b.outSource;
      }
      if (b.gainDb !== undefined) {
        const g = Number(b.gainDb);
        if (!Number.isFinite(g) || g < 0 || g > 20) throw new Error('Bluetooth level must be 0…+20 dB');
        next.bluetooth.gainDb = Math.round(g);
      }
    }
    if (patch.receivers !== undefined) {
      for (const [id, r] of Object.entries(patch.receivers || {})) {
        if (!RECEIVERS.includes(id)) throw new Error(`unknown receiver ${id}`);
        const cur = next.receivers[id] || (next.receivers[id] = {});
        if (r.enabled !== undefined) cur.enabled = !!r.enabled;
        if (r.server !== undefined) {
          const h = String(r.server || '').trim();
          if (h && !/^[A-Za-z0-9.:\-[\]]{1,253}$/.test(h)) throw new Error('server must be a host name or IP address');
          cur.server = h;
        }
        if (r.uuid !== undefined) cur.uuid = String(r.uuid).slice(0, 64);
      }
    }
    if (patch.routing !== undefined) {
      const r = patch.routing || {};
      if (r.mode !== undefined) {
        if (!['newest', 'mix'].includes(r.mode)) throw new Error('routing mode must be newest or mix');
        next.routing.mode = r.mode;
      }
      if (r.rate !== undefined) {
        const v = Number(r.rate);
        if (!RATES.includes(v)) throw new Error(`sample rate must be one of ${RATES.join(', ')} (0 = follow what plays)`);
        next.routing.rate = v;
      }
      for (const [field, ok] of [['usb', (v) => typeof v === 'boolean'], ['held', (v) => v === null || (Number.isInteger(v) && v >= 0 && v < 16)]]) {
        if (r[field] === undefined) continue;
        for (const [o, v] of Object.entries(r[field] || {})) {
          if (!USB_OUTS.includes(o)) throw new Error(`unknown output ${o}`);
          if (!ok(v)) throw new Error(`routing.${field}.${o}: ${field === 'usb' ? 'true or false' : 'a source number or null'}`);
          next.routing[field] = { ...(next.routing[field] || {}), [o]: v };
        }
      }
    }
    if (patch.trigger !== undefined) {
      const t = patch.trigger || {};
      if (t.enabled !== undefined) next.trigger.enabled = !!t.enabled;
      if (t.delaySec !== undefined) {
        const d = Number(t.delaySec);
        if (!TRIGGER_DELAYS.includes(d)) throw new Error(`trigger delay must be one of ${TRIGGER_DELAYS.join(', ')} s`);
        next.trigger.delaySec = d;
      }
    }
    if (JSON.stringify(next) === JSON.stringify(this.data)) return this.data;
    this.data = next;
    this.emit('change', this.data);
    this._scheduleSave();
    return this.data;
  }

  _scheduleSave() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.warn(`settings: could not save (${e.message})`);
    }
  }
}

module.exports = { Settings, DEFAULTS, BT_SOURCES, RECEIVERS, USB_OUTS, TRIGGER_DELAYS };
