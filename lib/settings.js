'use strict';
/**
 * Bridge settings (name, volume limits, linked outputs …).
 * Written to disk only when something actually changes, atomically (temp file + rename),
 * and debounced so repeated changes cause one write.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const cat = require('./catalog');

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
  // loop: Loopback values the bridge replaced for Bluetooth out ({ saved: {line, ph34}, set: {line, ph34} }), so a restart can still put them back
  bluetooth: { outSource: 'line', gainDb: 6, loop: null },
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
  trigger: { enabled: false, delaySec: 10, source: 'usb', pin: 3 },
  // UPS HAT (lib/ups.js): shut down after delaySec on battery, or at lowPct
  ups: { shutdown: true, delaySec: 60, lowPct: 10 },
  // once a day, ask GitHub for the latest release (lib/updates.js); off = no connection at all
  updates: { check: false },
  // volume of AirPlay / Spotify Connect senders sets the ADI-2's volume of these outputs
  // (minDb … maxDb); the stream itself plays at full level
  streamVolume: { enabled: false, outputs: ['line'], minDb: -60, maxDb: -10, airplay: true, spotify: true },
  // when the ADI-2 is switched on or reconnects: outputs louder than these levels are turned down
  startVolume: { enabled: false, levels: { line: null, ph12: -30, ph34: -30 } },
  // volume buttons per output, in dB (up to 4 each; [] = none)
  quickLevels: { line: [], ph12: [], ph34: [] },
  // scenes: named sets of values (display units, like the API's names)
  scenes: [],
  // headphone profiles: values of one output (ids of the output and EQ sections, display units) plus
  // an optional volume limit; applied to any output. active: the profile last applied per output
  profiles: [],
  activeProfile: { line: null, ph12: null, ph34: null },
  // actions on events: { id, enabled, name, when: { type, … }, scene, sceneEnd? (time actions with until) }
  rules: [],
  // sleep timer: outputs faded and muted, fade length
  sleep: { outputs: ['line', 'ph12', 'ph34'], fadeSec: 60 },
  // optional access key (stored as salted SHA-256); viewOpen: reading works without the key, changes need it
  access: { salt: '', hash: '', viewOpen: false },
  // MQTT (Home Assistant discovery)
  mqtt: { enabled: false, host: '', port: 1883, username: '', password: '', base: 'adi2pi', discovery: true, discoveryPrefix: 'homeassistant' },
};
const OUTPUTS = ['line', 'ph12', 'ph34'];
const RULE_TYPES = ['unit-on', 'bt-connect', 'bt-disconnect', 'play-start', 'play-stop', 'time', 'input-signal', 'input-lost', 'idle'];
const DIGITAL_INPUTS = ['any', 'aes', 'spdif'];
const PLAY_SOURCES = ['any', 'bluetooth', 'airplay', 'spotify', 'upnp', 'squeezelite', 'snapcast', 'roon'];
const MAX_SCENES = 30;
const MAX_RULES = 50;
const MAX_SCENE_ITEMS = 300;
const MAX_PROFILES = 30;
const MAX_QUICK = 4;
const TRIGGER_DELAYS = [10, 30, 60, 300];
const TRIGGER_SOURCES = ['usb', 'gpio'];
// GPIO3 also wakes a halted Pi 4/3; the others only shut down (for when I²C uses GPIO3)
const TRIGGER_PINS = [3, 4, 17, 22, 23, 24, 25, 27];
const UPS_DELAYS = [10, 30, 60, 120, 300, 600];
const USB_OUTS = ['line', 'ph34'];
const RECEIVERS = ['airplay', 'spotify', 'upnp', 'squeezelite', 'snapcast'];
const RATES = [0, 44100, 48000, 88200, 96000, 176400, 192000];
const BT_SOURCES = ['line', 'ph34', 'analog', 'off'];

const SAVE_DELAY_MS = 2000;

const dbOrNull = (v, what) => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < -114.5 || n > 6) throw new Error(`${what} must be −114.5…+6 dB`);
  return Math.round(n * 2) / 2;
};
const outputList = (v, what, allowEmpty = false) => {
  if (!Array.isArray(v) || v.some((c) => !OUTPUTS.includes(c))) throw new Error(`${what} must be a list of line/ph12/ph34`);
  const out = [...new Set(v)];
  if (!out.length && !allowEmpty) throw new Error(`${what}: choose at least one output`);
  return out;
};
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const newId = () => crypto.randomBytes(4).toString('hex');
const okId = (v) => typeof v === 'string' && /^[a-z0-9-]{1,40}$/i.test(v);

/** A scene item by name, in display units: { ch, id, side?, value }. */
function sceneItem(it) {
  if (!it || typeof it !== 'object') throw new Error('scene items must be objects');
  const ch = it.ch || 'device';
  const r = cat.resolve(ch, it.id, it.side === 'R' ? 'R' : 'L');
  if (!r) throw new Error(`unknown parameter ${ch}.${it.id}`);
  if (r.param.readonly) throw new Error(`${r.param.label} is read-only`);
  const value = Number(it.value);
  if (!Number.isFinite(value)) throw new Error(`${ch}.${it.id}: value must be a number`);
  const out = { ch, id: it.id, value };
  if (it.side === 'R') out.side = 'R';
  return out;
}

function scene(sc, existing) {
  if (!sc || typeof sc !== 'object') throw new Error('a scene must be an object');
  const name = cleanText(sc.name, 40);
  if (!name) throw new Error('scene name must not be empty');
  if (!Array.isArray(sc.items) || !sc.items.length) throw new Error(`scene “${name}” has no values`);
  if (sc.items.length > MAX_SCENE_ITEMS) throw new Error(`a scene holds at most ${MAX_SCENE_ITEMS} values`);
  const id = okId(sc.id) ? sc.id : newId();
  if (existing.has(id)) throw new Error(`scene id ${id} used twice`);
  existing.add(id);
  return { id, name, items: sc.items.map(sceneItem) };
}

/** A profile item: a parameter of the output or EQ sections, in display units: { id, side?, value }. */
function profileItem(it) {
  if (!it || typeof it !== 'object') throw new Error('profile items must be objects');
  const p = cat.sections.eq[it.id] || cat.sections.output[it.id];
  if (!p) throw new Error(`${it.id} is not an output setting`);
  if (p.readonly) throw new Error(`${p.label} is read-only`);
  const value = Number(it.value);
  if (!Number.isFinite(value)) throw new Error(`${it.id}: value must be a number`);
  const out = { id: it.id, value };
  if (it.side === 'R' && cat.sections.eq[it.id]) out.side = 'R';
  return out;
}

function profile(pr, existing) {
  if (!pr || typeof pr !== 'object') throw new Error('a profile must be an object');
  const name = cleanText(pr.name, 40);
  if (!name) throw new Error('profile name must not be empty');
  if (!Array.isArray(pr.items)) throw new Error(`profile “${name}” has no values`);
  if (pr.items.length > MAX_SCENE_ITEMS) throw new Error(`a profile holds at most ${MAX_SCENE_ITEMS} values`);
  const id = okId(pr.id) ? pr.id : newId();
  if (existing.has(id)) throw new Error(`profile id ${id} used twice`);
  existing.add(id);
  const out = { id, name, items: pr.items.map(profileItem) };
  // limit: absent = leaves the output's limit alone; null = no limit; number = dB
  if (pr.limit !== undefined) out.limit = dbOrNull(pr.limit, 'volume limit');
  if (!out.items.length && out.limit === undefined) throw new Error(`profile “${name}” has no values`);
  return out;
}

function rule(r, sceneIds, existing) {
  if (!r || typeof r !== 'object') throw new Error('an action must be an object');
  const w = r.when || {};
  if (!RULE_TYPES.includes(w.type)) throw new Error(`action trigger must be one of ${RULE_TYPES.join(', ')}`);
  const when = { type: w.type };
  if (w.type === 'bt-connect' || w.type === 'bt-disconnect') {
    const a = String(w.address || 'any').toUpperCase();
    if (a !== 'ANY' && !/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(a)) throw new Error('Bluetooth address must look like 14:3F:A6:01:02:03 (or any)');
    when.address = a === 'ANY' ? 'any' : a;
    if (w.name) when.name = cleanText(w.name, 60);
  } else if (w.type === 'play-start' || w.type === 'play-stop') {
    const src = w.source || 'any';
    if (!PLAY_SOURCES.includes(src)) throw new Error(`playback source must be one of ${PLAY_SOURCES.join(', ')}`);
    when.source = src;
  } else if (w.type === 'time') {
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hhmm.test(String(w.at || ''))) throw new Error('time must be HH:MM (24 h)');
    when.at = w.at;
    const days = w.days === undefined ? [0, 1, 2, 3, 4, 5, 6] : w.days;
    if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('days must be a list of 0 (Sunday) … 6');
    when.days = [...new Set(days)].sort();
    if (w.until !== undefined && w.until !== null && w.until !== '') {
      if (!hhmm.test(String(w.until))) throw new Error('end time must be HH:MM (24 h)');
      if (w.until === w.at) throw new Error('the end time must differ from the start time');
      when.until = w.until;
    }
  } else if (w.type === 'input-signal' || w.type === 'input-lost') {
    const inp = w.input || 'any';
    if (!DIGITAL_INPUTS.includes(inp)) throw new Error(`input must be one of ${DIGITAL_INPUTS.join(', ')}`);
    when.input = inp;
  } else if (w.type === 'idle') {
    const m = Number(w.minutes);
    if (!Number.isInteger(m) || m < 1 || m > 720) throw new Error('idle time must be 1…720 minutes');
    when.minutes = m;
  }
  if (!sceneIds.has(r.scene)) throw new Error('an action must name an existing scene');
  const id = okId(r.id) ? r.id : newId();
  if (existing.has(id)) throw new Error(`action id ${id} used twice`);
  existing.add(id);
  const out = { id, enabled: r.enabled !== false, name: cleanText(r.name, 60), when, scene: r.scene };
  if (when.until) {
    if (!sceneIds.has(r.sceneEnd)) throw new Error('an action with an end time must name a scene for the end');
    out.sceneEnd = r.sceneEnd;
  }
  return out;
}

function hashKey(key, salt) { return crypto.createHash('sha256').update(`${salt}:${key}`).digest('hex'); }

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
    this.setMaxListeners(40); // one per module that follows settings changes
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
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings must be an object');
    const unknown = Object.keys(patch).filter((k) => !Object.hasOwn(DEFAULTS, k));
    if (unknown.length) throw new Error(`unknown setting${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`);
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
      if (b.loop !== undefined) {
        if (b.loop !== null) {
          const okMap = (m) => m && typeof m === 'object' && Object.entries(m).every(([o, v]) => USB_OUTS.includes(o) && Number.isInteger(v) && v >= 0 && v < 16);
          if (!okMap(b.loop.saved) || !okMap(b.loop.set)) throw new Error('bluetooth.loop: { saved, set } with Loopback values per output, or null');
        }
        next.bluetooth.loop = b.loop === null ? null : { saved: { ...b.loop.saved }, set: { ...b.loop.set } };
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
      if (t.source !== undefined) {
        if (!TRIGGER_SOURCES.includes(t.source)) throw new Error(`trigger source must be one of ${TRIGGER_SOURCES.join(', ')}`);
        next.trigger.source = t.source;
      }
      if (t.delaySec !== undefined) {
        const d = Number(t.delaySec);
        if (!TRIGGER_DELAYS.includes(d)) throw new Error(`trigger delay must be one of ${TRIGGER_DELAYS.join(', ')} s`);
        next.trigger.delaySec = d;
      }
      if (t.pin !== undefined) {
        const p = Number(t.pin);
        if (!TRIGGER_PINS.includes(p)) throw new Error(`trigger GPIO must be one of ${TRIGGER_PINS.join(', ')}`);
        next.trigger.pin = p;
      }
    }
    if (patch.ups !== undefined) {
      const u = patch.ups || {};
      if (u.shutdown !== undefined) next.ups.shutdown = !!u.shutdown;
      if (u.delaySec !== undefined) {
        const d = Number(u.delaySec);
        if (!UPS_DELAYS.includes(d)) throw new Error(`UPS delay must be one of ${UPS_DELAYS.join(', ')} s`);
        next.ups.delaySec = d;
      }
      if (u.lowPct !== undefined) {
        const p = Number(u.lowPct);
        if (!Number.isInteger(p) || p < 5 || p > 50) throw new Error('UPS low battery level must be 5…50 %');
        next.ups.lowPct = p;
      }
    }
    if (patch.updates !== undefined) {
      const u = patch.updates || {};
      if (u.check !== undefined) next.updates.check = !!u.check;
    }
    if (patch.streamVolume !== undefined) {
      const v = patch.streamVolume || {};
      const sv = next.streamVolume;
      if (v.enabled !== undefined) sv.enabled = !!v.enabled;
      if (v.airplay !== undefined) sv.airplay = !!v.airplay;
      if (v.spotify !== undefined) sv.spotify = !!v.spotify;
      if (v.outputs !== undefined) sv.outputs = outputList(v.outputs, 'stream volume outputs');
      if (v.minDb !== undefined) sv.minDb = dbOrNull(v.minDb, 'lowest volume') ?? -60;
      if (v.maxDb !== undefined) sv.maxDb = dbOrNull(v.maxDb, 'highest volume') ?? 0;
      if (sv.minDb >= sv.maxDb) throw new Error('the lowest volume must be below the highest');
    }
    if (patch.startVolume !== undefined) {
      const v = patch.startVolume || {};
      if (v.enabled !== undefined) next.startVolume.enabled = !!v.enabled;
      for (const [ch, l] of Object.entries(v.levels || {})) {
        if (!OUTPUTS.includes(ch)) throw new Error(`unknown output ${ch}`);
        next.startVolume.levels[ch] = dbOrNull(l, `start volume of ${ch}`);
      }
    }
    if (patch.quickLevels !== undefined) {
      for (const [ch, list] of Object.entries(patch.quickLevels || {})) {
        if (!OUTPUTS.includes(ch)) throw new Error(`unknown output ${ch}`);
        if (!Array.isArray(list) || list.length > MAX_QUICK) throw new Error(`quick levels: up to ${MAX_QUICK} values per output`);
        const vals = list.map((v) => dbOrNull(v, 'quick level')).filter((v) => v !== null);
        next.quickLevels[ch] = [...new Set(vals)].sort((a, b) => a - b);
      }
    }
    if (patch.profiles !== undefined) {
      if (!Array.isArray(patch.profiles)) throw new Error('profiles must be a list');
      if (patch.profiles.length > MAX_PROFILES) throw new Error(`at most ${MAX_PROFILES} profiles`);
      const ids = new Set();
      next.profiles = patch.profiles.map((pr) => profile(pr, ids));
      // an output's active profile that was deleted
      for (const ch of OUTPUTS) if (next.activeProfile[ch] && !ids.has(next.activeProfile[ch])) next.activeProfile[ch] = null;
    }
    if (patch.activeProfile !== undefined) {
      const ids = new Set(next.profiles.map((x) => x.id));
      for (const [ch, id] of Object.entries(patch.activeProfile || {})) {
        if (!OUTPUTS.includes(ch)) throw new Error(`unknown output ${ch}`);
        if (id !== null && !ids.has(id)) throw new Error(`no profile ${id}`);
        next.activeProfile[ch] = id;
      }
    }
    if (patch.scenes !== undefined) {
      if (!Array.isArray(patch.scenes)) throw new Error('scenes must be a list');
      if (patch.scenes.length > MAX_SCENES) throw new Error(`at most ${MAX_SCENES} scenes`);
      const ids = new Set();
      next.scenes = patch.scenes.map((sc) => scene(sc, ids));
    }
    if (patch.rules !== undefined || patch.scenes !== undefined) {
      const list = patch.rules !== undefined ? patch.rules : next.rules;
      if (!Array.isArray(list)) throw new Error('actions must be a list');
      if (list.length > MAX_RULES) throw new Error(`at most ${MAX_RULES} actions`);
      const sceneIds = new Set(next.scenes.map((x) => x.id));
      const ids = new Set();
      // actions whose scene was deleted go with it
      next.rules = list.filter((r) => patch.rules !== undefined || sceneIds.has(r.scene)).map((r) => rule(r, sceneIds, ids));
    }
    if (patch.sleep !== undefined) {
      const v = patch.sleep || {};
      if (v.outputs !== undefined) next.sleep.outputs = outputList(v.outputs, 'sleep timer outputs');
      if (v.fadeSec !== undefined) {
        const f = Number(v.fadeSec);
        if (!Number.isFinite(f) || f < 0 || f > 600) throw new Error('fade must be 0…600 s');
        next.sleep.fadeSec = Math.round(f);
      }
    }
    if (patch.access !== undefined) {
      const a = patch.access || {};
      if (a.key !== undefined) {
        const key = String(a.key ?? '');
        if (!key) next.access = { ...next.access, salt: '', hash: '' };
        else {
          if (key.length < 6 || key.length > 128) throw new Error('the access key must have 6…128 characters');
          const salt = crypto.randomBytes(8).toString('hex');
          next.access = { ...next.access, salt, hash: hashKey(key, salt) };
        }
      }
      if (a.viewOpen !== undefined) next.access.viewOpen = !!a.viewOpen;
    }
    if (patch.mqtt !== undefined) {
      const v = patch.mqtt || {};
      const m = next.mqtt;
      if (v.enabled !== undefined) m.enabled = !!v.enabled;
      if (v.host !== undefined) {
        const h = String(v.host || '').trim();
        if (h && !/^[A-Za-z0-9.:\-[\]]{1,253}$/.test(h)) throw new Error('MQTT server must be a host name or IP address');
        m.host = h;
      }
      if (v.port !== undefined) {
        const n = Number(v.port);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('MQTT port must be 1…65535');
        m.port = n;
      }
      if (v.username !== undefined) m.username = cleanText(v.username, 100);
      if (v.password !== undefined) m.password = String(v.password ?? '').slice(0, 200);
      if (v.base !== undefined) {
        const b = String(v.base || '').trim().replace(/\/+$/, '');
        if (!/^[A-Za-z0-9_\-/]{1,60}$/.test(b) || b.startsWith('/')) throw new Error('MQTT topic must be letters, digits, - _ /');
        m.base = b;
      }
      if (v.discovery !== undefined) m.discovery = !!v.discovery;
      if (v.discoveryPrefix !== undefined) {
        const b = String(v.discoveryPrefix || '').trim();
        if (!/^[A-Za-z0-9_\-/]{1,60}$/.test(b)) throw new Error('discovery prefix must be letters, digits, - _ /');
        m.discoveryPrefix = b;
      }
      if (m.enabled && !m.host) throw new Error('MQTT needs a server');
    }
    if (JSON.stringify(next) === JSON.stringify(this.data)) return this.data;
    this.data = next;
    this.emit('change', this.data);
    this._scheduleSave();
    return this.data;
  }

  /** Settings as clients see them: no key hash, no MQTT password. */
  publicView() {
    const d = this.data;
    const { password, ...mqtt } = d.mqtt;
    return { ...d, access: { enabled: !!d.access.hash, viewOpen: !!d.access.viewOpen }, mqtt: { ...mqtt, hasPassword: !!password } };
  }

  /** Is `key` the access key? (true when none is set) */
  checkKey(key) {
    const a = this.data.access;
    if (!a.hash) return true;
    if (typeof key !== 'string' || !key) return false;
    const h = Buffer.from(hashKey(key, a.salt), 'hex');
    const want = Buffer.from(a.hash, 'hex');
    return h.length === want.length && crypto.timingSafeEqual(h, want);
  }

  get keyRequired() { return !!this.data.access.hash; }

  /** With a key set: may reads (state, WebSocket without commands) go without it? */
  get viewOpen() { return !!(this.data.access.hash && this.data.access.viewOpen); }

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
      // only the service user may read it: it holds the access key's hash and the MQTT password
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.warn(`settings: could not save (${e.message})`);
    }
  }
}

module.exports = { Settings, DEFAULTS, BT_SOURCES, RECEIVERS, USB_OUTS, TRIGGER_DELAYS, TRIGGER_SOURCES, TRIGGER_PINS, UPS_DELAYS, OUTPUTS, RULE_TYPES, PLAY_SOURCES, DIGITAL_INPUTS, MAX_QUICK };
