'use strict';
/**
 * Scenes, actions on events, the sleep timer and the start volume.
 *
 * - Scene: a named list of values by name in display units ({ ch, id, side?, value }), applied
 *   with one set. Only the listed values change.
 * - Action (rule): when an event happens, apply a scene. Events: the ADI-2 becomes usable
 *   (switched on, reconnected), a Bluetooth device connects / disconnects, playback on the Pi
 *   starts / stops (per source), a time of day. With a delay the scene follows that much later;
 *   the opposite event in the meantime (input back, playback resumed, device reconnected …)
 *   cancels it. Waiting actions are not kept across a restart.
 * - Sleep timer: after the set time the chosen outputs fade down over `fadeSec` and are muted;
 *   their volume is then put back, so unmuting plays at the earlier level.
 * - Start volume: when the ADI-2 becomes usable, outputs louder than their start level are set
 *   to it.
 * - Headphone profile: values of the output and EQ sections ({ id, side?, value }) plus an
 *   optional volume limit, applied to any output. settings.activeProfile remembers which profile
 *   an output got last; it is cleared when one of the profile's values is changed another way.
 *
 * Events: 'sleep' (status), 'fired' ({ rule, scene, at }), 'pending' (waiting actions changed)
 */
const { EventEmitter } = require('events');
const cat = require('./catalog');

const FADE_STEP_MS = 500;
const SLEEP_MAX_MIN = 24 * 60;
/** Parameter ids a profile group covers (output and EQ sections; EQ ids on both sides with Dual EQ). */
const PROFILE_GROUPS = {
  eq: ['eqen', 'eqpreset', 'dualeq', 'b1type', 'b1g', 'b1f', 'b1q', 'b2g', 'b2f', 'b2q', 'b3g', 'b3f', 'b3q', 'b4g', 'b4f', 'b4q', 'b5type', 'b5g', 'b5f', 'b5q'],
  bt: ['bten', 'bass', 'bassf', 'bassq', 'treble', 'trebf', 'trebq', 'btload'],
  loudness: ['loud', 'ldbass', 'ldtreb', 'ldref'],
  xfeed: ['xfeed'],
  settings: ['ref', 'autoref', 'mono', 'ms', 'pol', 'dafilt', 'deemph', 'dcp', 'reartrs'],
};

class Automation extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.dev       Adi2
   * @param {object} o.settings  Settings
   * @param {object} [o.bt]      Bluetooth (state.devices[].connected)
   * @param {object} [o.audio]   Audio (status().sources[].playing)
   * @param {() => Date} [o.now]
   */
  constructor({ dev, settings, bt = null, audio = null, log, now = () => new Date(), tickMs = 15000 }) {
    super();
    this.dev = dev;
    this.settings = settings;
    this.bt = bt;
    this.audio = audio;
    this.log = log || console;
    this.now = now;
    this.tickMs = tickMs;
    this.usable = false;
    this.btConnected = null;   // Map address → name, null until the first Bluetooth state
    this.playing = null;       // Set of playing source ids, null until the first audio status
    this.lastMinute = null;
    this.sleepState = null;    // { until, fadeSec, outputs, fading, timer, fadeTimer, start }
    this.lastFired = [];       // [{ at, rule, scene, event }] newest last
    this.inputs = null;        // last { aes, spdif } from the status message
    this.idleSince = null;     // when the Pi stopped playing (null while it plays or before the first status)
    this.idleFired = new Set(); // rule ids fired since the Pi stopped playing
    this.waiting = new Map();   // `${rule}:${sceneKey}` → { rule, sceneKey, type, subject, due, event, timer }
    this._onDevice = (d) => this._device(d);
    this._onBt = () => this._btChanged();
    this._onAudio = () => this._audioChanged();
    this._onStatus = (h, info) => this._statusChanged(info);
    this._onParams = (p, origin) => this._paramsChanged(p, origin);
  }

  start() {
    this.usable = this._isUsable(this.dev.info());
    this.dev.on('device', this._onDevice);
    this.dev.on('status', this._onStatus);
    this.dev.on('params', this._onParams);
    if (this.bt) this.bt.on('state', this._onBt);
    if (this.audio) this.audio.on('status', this._onAudio);
    this.timer = setInterval(() => this._tick(), this.tickMs);
    this.timer.unref?.();
    this._btChanged();
    this._audioChanged();
  }

  stop() {
    clearInterval(this.timer);
    this.dev.off('device', this._onDevice);
    this.dev.off('status', this._onStatus);
    this.dev.off('params', this._onParams);
    if (this.bt) this.bt.off('state', this._onBt);
    if (this.audio) this.audio.off('status', this._onAudio);
    this._clearSleep();
    for (const w of this.waiting.values()) clearTimeout(w.timer);
    this.waiting.clear();
  }

  _isUsable(d) { return !!(d && d.connected && d.ready && d.answering !== false); }

  // ------------------------------------------------------------------ scenes

  scenes() { return this.settings.get().scenes || []; }

  /** Apply a scene by id. Returns dev.set()'s result. */
  applyScene(id, origin = 'scene') {
    const sc = this.scenes().find((s) => s.id === id);
    if (!sc) throw Object.assign(new Error(`no scene ${id}`), { status: 404 });
    const r = this.dev.set(sc.items.map((i) => ({ ...i })), { origin });
    if (r.errors.length && !Object.keys(r.applied).length) throw Object.assign(new Error(r.errors.join('; ')), { status: r.status || 400 });
    this.log.info(`automation: scene “${sc.name}” applied`);
    return r;
  }

  /** Current values of the listed parameters as scene items. */
  capture(params) {
    if (!Array.isArray(params) || !params.length) throw Object.assign(new Error('choose the values to keep in the scene'), { status: 400 });
    const items = [];
    for (const p of params) {
      const ch = p.ch || 'device';
      const side = p.side === 'R' ? 'R' : 'L';
      const r = cat.resolve(ch, p.id, side);
      if (!r) throw Object.assign(new Error(`unknown parameter ${ch}.${p.id}`), { status: 400 });
      const v = this.dev.state.get(cat.key(r.addr, r.idx));
      if (v === undefined) continue; // the unit doesn't report it
      const item = { ch, id: p.id, value: cat.toDisplay(r.param, v) };
      if (side === 'R' && cat.sections.eq[p.id]) item.side = 'R';
      items.push(item);
    }
    if (!items.length) throw Object.assign(new Error('the unit reports none of these values'), { status: 409 });
    return items;
  }

  /** Save (new or existing id) a scene; items given, or captured from `params`. */
  saveScene({ id, name, items, params }) {
    const list = [...this.scenes()];
    const scene = { id, name, items: items || this.capture(params) };
    const i = id ? list.findIndex((s) => s.id === id) : -1;
    if (i >= 0) list[i] = scene; else list.push(scene);
    const s = this.settings.update({ scenes: list });
    return i >= 0 ? s.scenes[i] : s.scenes[s.scenes.length - 1];
  }

  deleteScene(id) {
    this.settings.update({ scenes: this.scenes().filter((s) => s.id !== id) });
  }

  // ------------------------------------------------------------------ headphone profiles

  profiles() { return this.settings.get().profiles || []; }

  /** Apply profile `id` to output `ch`: its values, then its volume limit (if it has one). */
  applyProfile(id, ch, origin = 'profile') {
    const pr = this.profiles().find((p) => p.id === id);
    if (!pr) throw Object.assign(new Error(`no profile ${id}`), { status: 404 });
    if (!cat.channelByKey[ch] || cat.channelByKey[ch].kind !== 'output') throw Object.assign(new Error('ch must be an output (line, ph12, ph34)'), { status: 400 });
    let r = { applied: {}, errors: [] };
    if (pr.items.length) {
      // values the unit reports for this output only (e.g. no Crossfeed on Line Out)
      const items = pr.items.filter((it) => { const x = cat.resolve(ch, it.id, it.side); return x && this.dev.state.has(cat.key(x.addr, x.idx)); }).map((it) => ({ ch, ...it }));
      if (items.length) {
        r = this.dev.set(items, { origin });
        if (r.errors.length && !Object.keys(r.applied).length) throw Object.assign(new Error(r.errors.join('; ')), { status: r.status || 400 });
      }
    }
    const patch = { activeProfile: { [ch]: id } };
    if (pr.limit !== undefined) patch.limits = { [ch]: pr.limit };
    this.settings.update(patch);
    this.log.info(`automation: profile “${pr.name}” on ${ch}`);
    return r;
  }

  /** Current values of output `ch` for the groups (keys of PROFILE_GROUPS) as profile items. */
  captureProfile(ch, groups) {
    if (!cat.channelByKey[ch] || cat.channelByKey[ch].kind !== 'output') throw Object.assign(new Error('from must be an output (line, ph12, ph34)'), { status: 400 });
    if (!Array.isArray(groups) || !groups.length || groups.some((g) => !PROFILE_GROUPS[g])) throw Object.assign(new Error(`groups must be a list of ${Object.keys(PROFILE_GROUPS).join(', ')}`), { status: 400 });
    const items = [];
    const dualR = cat.resolve(ch, 'dualeq');
    const dual = !!(dualR && this.dev.state.get(cat.key(dualR.addr, dualR.idx)));
    for (const g of groups) {
      for (const id of PROFILE_GROUPS[g]) {
        for (const side of cat.sections.eq[id] && dual ? ['L', 'R'] : ['L']) {
          const r = cat.resolve(ch, id, side);
          if (!r || r.param.readonly) continue;
          const v = this.dev.state.get(cat.key(r.addr, r.idx));
          if (v === undefined) continue; // the unit doesn't report it
          const item = { id, value: cat.toDisplay(r.param, v) };
          if (side === 'R') item.side = 'R';
          items.push(item);
        }
      }
    }
    return items;
  }

  /** Save a profile (new or existing id); items given, or captured from output `from` for `groups`. limit: see settings. */
  saveProfile({ id, name, items, from, groups, limit }) {
    const list = [...this.profiles()];
    const pr = { id, name, items: items || this.captureProfile(from, groups) };
    if (limit !== undefined) pr.limit = limit;
    const i = id ? list.findIndex((p) => p.id === id) : -1;
    if (i >= 0) { if (limit === undefined && list[i].limit !== undefined) pr.limit = list[i].limit; list[i] = pr; } else list.push(pr);
    const s = this.settings.update({ profiles: list });
    return i >= 0 ? s.profiles[i] : s.profiles[s.profiles.length - 1];
  }

  deleteProfile(id) {
    this.settings.update({ profiles: this.profiles().filter((p) => p.id !== id) });
  }

  /** A value of an active profile changed by someone else: that output no longer shows the profile. */
  _paramsChanged(p, origin) {
    if (origin === 'profile' || origin === 'device' && !this.dev.ready) return;
    const active = this.settings.get().activeProfile || {};
    const patch = {};
    for (const [ch, id] of Object.entries(active)) {
      if (!id) continue;
      const pr = this.profiles().find((x) => x.id === id);
      if (!pr) continue;
      const left = pr.items.some((it) => {
        const r = cat.resolve(ch, it.id, it.side);
        if (!r) return false;
        const v = p[cat.key(r.addr, r.idx)];
        return v !== undefined && cat.toDisplay(r.param, v) !== it.value;
      });
      if (left) patch[ch] = null;
    }
    if (Object.keys(patch).length) this.settings.update({ activeProfile: patch });
  }

  // ------------------------------------------------------------------ events

  /**
   * Apply the scene (field `sceneKey`) of every enabled rule of event.type that `match(when, rule)`
   * accepts – now, or after the rule's delaySec. event.subject (device address, source, input)
   * lets the opposite event cancel a waiting action.
   */
  _fire(event, match, mark = null, sceneKey = 'scene') {
    const rules = (this.settings.get().rules || []).filter((r) => r.enabled && r.when.type === event.type && r[sceneKey] && match(r.when, r));
    for (const r of rules) {
      if (mark) mark(r);
      if (r.delaySec > 0) { this._wait(r, sceneKey, event); continue; }
      this._run(r, sceneKey, event);
    }
  }

  _wait(r, sceneKey, event) {
    const k = `${r.id}:${sceneKey}`;
    if (this.waiting.has(k)) return; // already waiting for this action
    const w = { rule: r.id, sceneKey, type: event.type, subject: event.subject ?? null, due: Date.now() + r.delaySec * 1000, event: event.text };
    w.timer = setTimeout(() => {
      this.waiting.delete(k);
      const cur = (this.settings.get().rules || []).find((x) => x.id === r.id);
      if (cur && cur.enabled && cur[sceneKey]) this._run(cur, sceneKey, { ...event, text: `${event.text}, ${r.delaySec} s later` });
      this.emit('pending');
    }, r.delaySec * 1000);
    w.timer.unref?.();
    this.waiting.set(k, w);
    this.emit('pending');
  }

  /** Drop waiting actions of `type` whose subject `match` accepts (the event they wait on was undone). */
  _cancel(type, match = () => true) {
    let n = 0;
    const rules = this.settings.get().rules || [];
    for (const [k, w] of this.waiting) {
      if (w.type !== type || !match(w, rules.find((r) => r.id === w.rule))) continue;
      clearTimeout(w.timer);
      this.waiting.delete(k);
      n++;
    }
    if (n) this.emit('pending');
  }

  _run(r, sceneKey, event) {
    try {
      if (!this.usable) { this.log.info(`automation: “${r.name || r.id}” not applied – ADI-2 not usable`); return; }
      this.applyScene(r[sceneKey], 'rule');
      const f = { at: Date.now(), rule: r.id, scene: r[sceneKey], event: event.text };
      this.lastFired.push(f);
      if (this.lastFired.length > 20) this.lastFired.shift();
      this.emit('fired', f);
    } catch (e) {
      this.log.warn(`automation: action “${r.name || r.id}”: ${e.message}`);
    }
  }

  _device(d) {
    const was = this.usable;
    this.usable = this._isUsable(d);
    if (!this.usable && was) this._cancel('unit-on');
    if (this.usable && !was) {
      // values are read once the unit is ready; give the dump a moment
      setTimeout(() => {
        if (!this.usable) return;
        this._startVolume();
        this._fire({ type: 'unit-on', text: 'ADI-2 on', subject: 'unit' }, () => true);
      }, 500).unref?.();
    }
  }

  _btChanged() {
    const s = this.bt && this.bt.state;
    if (!s || !Array.isArray(s.devices)) return;
    const now = new Map(s.devices.filter((d) => d.connected).map((d) => [String(d.address).toUpperCase(), d.name || d.address]));
    const before = this.btConnected;
    this.btConnected = now;
    if (!before) return; // first state after start: nothing "happened"
    for (const [a, name] of now) {
      if (before.has(a)) continue;
      this._cancel('bt-disconnect', (w) => w.subject === a);
      this._fire({ type: 'bt-connect', text: `${name} connected`, subject: a }, (w) => w.address === 'any' || w.address === a);
    }
    for (const [a, name] of before) {
      if (now.has(a)) continue;
      this._cancel('bt-connect', (w) => w.subject === a);
      this._fire({ type: 'bt-disconnect', text: `${name} disconnected`, subject: a }, (w) => w.address === 'any' || w.address === a);
    }
  }

  _statusChanged(info) {
    const now = info && info.inputs;
    if (!now) return;
    const before = this.inputs;
    this.inputs = { aes: now.aes, spdif: now.spdif };
    if (!before) return;
    for (const inp of ['aes', 'spdif']) {
      if (before[inp] === now[inp] || now[inp] === null) continue;
      const type = now[inp] ? 'input-signal' : 'input-lost';
      this._cancel(now[inp] ? 'input-lost' : 'input-signal', (w) => w.subject === inp);
      this._fire({ type, text: `${inp.toUpperCase()} ${now[inp] ? 'signal' : 'no signal'}`, subject: inp }, (w) => w.input === 'any' || w.input === inp);
    }
  }

  /** Playing sources by kind: 'bluetooth' or the receiver id. */
  _playingNow() {
    const st = this.audio && this.audio.status();
    if (!st || !Array.isArray(st.sources)) return null;
    const out = new Set();
    for (const src of st.sources) {
      if (!src.playing) continue;
      out.add(src.kind === 'bluetooth' ? 'bluetooth' : (src.receiver || 'app'));
    }
    return out;
  }

  _audioChanged() {
    const now = this._playingNow();
    if (!now) return;
    const before = this.playing;
    this.playing = now;
    if (!before) { if (!now.size) this.idleSince = Date.now(); return; } // the quiet period starts with the bridge
    if (now.size) { this.idleSince = null; this.idleFired.clear(); this._cancel('idle'); } else if (this.idleSince === null) this.idleSince = Date.now();
    const started = [...now].filter((x) => !before.has(x));
    const stopped = [...before].filter((x) => !now.has(x));
    // a waiting "stops" action is undone when that source (or, for "anything", any source) plays again; "starts" likewise
    for (const x of started) this._cancel('play-stop', (w, r) => w.subject === x || (r && r.when.source === 'any'));
    for (const x of stopped) this._cancel('play-start', (w, r) => w.subject === x || (r && r.when.source === 'any' && now.size === 0));
    for (const x of started) this._fire({ type: 'play-start', text: `${x} started`, subject: x }, (w) => w.source === 'any' ? before.size === 0 : w.source === x);
    for (const x of stopped) this._fire({ type: 'play-stop', text: `${x} stopped`, subject: x }, (w) => w.source === 'any' ? now.size === 0 : w.source === x);
  }

  _tick() {
    const d = this.now();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    // idle: the Pi has played nothing for the rule's minutes (once per quiet period)
    if (this.idleSince !== null) {
      const idleMin = (Date.now() - this.idleSince) / 60000;
      this._fire({ type: 'idle', text: `nothing played for ${Math.floor(idleMin)} min` }, (w, r) => idleMin >= w.minutes && !this.idleFired.has(r.id), (r) => this.idleFired.add(r.id));
    }
    if (hm === this.lastMinute) return;
    this.lastMinute = hm;
    const day = d.getDay();
    this._fire({ type: 'time', text: hm }, (w) => w.at === hm && w.days.includes(day));
    // the end of a time action: its end scene (the end may be on the next day)
    const dayBefore = (day + 6) % 7;
    this._fire({ type: 'time', text: `${hm} (end)` }, (w) => w.until === hm && w.days.includes(w.until > w.at ? day : dayBefore), null, 'sceneEnd');
  }

  // ------------------------------------------------------------------ start volume

  _startVolume() {
    const sv = this.settings.get().startVolume || {};
    if (!sv.enabled) return;
    const items = [];
    for (const [ch, level] of Object.entries(sv.levels || {})) {
      if (level === null || level === undefined) continue;
      const r = cat.resolve(ch, 'vol');
      const cur = this.dev.state.get(cat.key(r.addr, r.idx));
      if (cur === undefined) continue;
      if (cat.toDisplay(r.param, cur) > level) items.push({ ch, id: 'vol', value: level, ramp: false });
    }
    if (!items.length) return;
    const res = this.dev.set(items, { origin: 'start' });
    if (Object.keys(res.applied).length) this.log.info(`automation: start volume – ${items.map((i) => `${i.ch} ${i.value} dB`).join(', ')}`);
  }

  // ------------------------------------------------------------------ sleep timer

  sleepStatus() {
    const s = this.sleepState;
    return s ? { until: s.until, fadeSec: s.fadeSec, outputs: s.outputs, fading: !!s.fading } : null;
  }

  /** Start (minutes 1…1440) or replace the sleep timer. */
  startSleep(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 1 || m > SLEEP_MAX_MIN) throw Object.assign(new Error(`sleep timer: 1…${SLEEP_MAX_MIN} minutes`), { status: 400 });
    this._clearSleep();
    const cfg = this.settings.get().sleep || {};
    const fadeSec = Math.min(cfg.fadeSec ?? 60, m * 60);
    const until = Date.now() + Math.round(m * 60000);
    const s = { until, fadeSec, outputs: [...(cfg.outputs || ['line', 'ph12', 'ph34'])], fading: false };
    this.sleepState = s;
    s.timer = setTimeout(() => this._fadeStart(), Math.max(0, until - fadeSec * 1000 - Date.now()));
    s.timer.unref?.();
    this.log.info(`automation: sleep timer ${m} min`);
    this.emit('sleep', this.sleepStatus());
    return this.sleepStatus();
  }

  cancelSleep() {
    const s = this.sleepState;
    if (!s) return null;
    // during the fade: back to the levels from before
    if (s.fading && s.start) this._setVolumes(s.start, 'sleep');
    this._clearSleep();
    this.log.info('automation: sleep timer cancelled');
    this.emit('sleep', null);
    return null;
  }

  _clearSleep() {
    const s = this.sleepState;
    if (!s) return;
    clearTimeout(s.timer);
    clearInterval(s.fadeTimer);
    this.sleepState = null;
  }

  _vol(ch) {
    const r = cat.resolve(ch, 'vol');
    const v = this.dev.state.get(cat.key(r.addr, r.idx));
    return v === undefined ? undefined : cat.toDisplay(r.param, v);
  }

  _setVolumes(levels, origin) {
    const items = Object.entries(levels).filter(([, v]) => v !== undefined).map(([ch, value]) => ({ ch, id: 'vol', value, ramp: false }));
    if (items.length) this.dev.set(items, { origin });
  }

  _fadeStart() {
    const s = this.sleepState;
    if (!s) return;
    s.fading = true;
    s.start = {};
    for (const ch of s.outputs) s.start[ch] = this._vol(ch);
    this.emit('sleep', this.sleepStatus());
    const t0 = Date.now();
    const total = s.fadeSec * 1000;
    const step = () => {
      const k = total ? Math.min(1, (Date.now() - t0) / total) : 1;
      // −40 dB over the fade, in steps the unit takes (0.5 dB)
      const levels = {};
      for (const [ch, v] of Object.entries(s.start)) if (v !== undefined) levels[ch] = Math.max(-114.5, Math.round((v - 40 * k) * 2) / 2);
      if (this.usable) this._setVolumes(levels, 'sleep');
      if (k >= 1) this._sleepDone();
    };
    s.fadeTimer = setInterval(step, FADE_STEP_MS);
    s.fadeTimer.unref?.();
    step();
  }

  _sleepDone() {
    const s = this.sleepState;
    if (!s) return;
    clearInterval(s.fadeTimer);
    if (this.usable) {
      const items = [];
      for (const ch of s.outputs) {
        const r = cat.resolve(ch, 'mute');
        if (this.dev.state.has(cat.key(r.addr, r.idx))) items.push({ ch, id: 'mute', value: 1 });
      }
      // muted: the volume goes back, so unmuting plays at the earlier level; outputs without
      // a mute stay turned down
      for (const [ch, v] of Object.entries(s.start)) {
        if (v === undefined) continue;
        if (items.some((i) => i.ch === ch)) items.push({ ch, id: 'vol', value: v, ramp: false });
      }
      if (items.length) this.dev.set(items, { origin: 'sleep' });
    }
    this.log.info('automation: sleep timer – outputs muted');
    this.sleepState = null;
    this.emit('sleep', null);
  }

  view() {
    return {
      sleep: this.sleepStatus(), fired: this.lastFired,
      waiting: [...this.waiting.values()].map((w) => ({ rule: w.rule, scene: (this.settings.get().rules || []).find((r) => r.id === w.rule)?.[w.sceneKey] ?? null, end: w.sceneKey === 'sceneEnd', due: w.due, event: w.event })),
    };
  }
}

module.exports = { Automation, PROFILE_GROUPS };
