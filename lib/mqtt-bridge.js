'use strict';
/**
 * MQTT connection for Home Assistant and other home automation (settings.mqtt).
 *
 * Topics (prefix `<base>/<node>`, node = host name of the Pi):
 *   …/status                       online / offline (last will), retained
 *   …/<ch>/<id>/state              current value, retained: number (display units), ON/OFF, or the
 *                                  option name of a select
 *   …/<ch>/<id>/set                to change it (same format)
 *   …/setup/set                    load a setup: its number 1–9 or its name
 *   …/scene/<scene id>/set         apply a scene (any payload)
 *   …/sleep/state, …/sleep/set     sleep timer minutes left / start (0 = cancel)
 * With discovery on, Home Assistant entity descriptions go to
 * `<discoveryPrefix>/<component>/<node>/<object>/config` (retained).
 *
 * Only parameters the unit reports are published. Events: 'status'.
 */
const os = require('os');
const { EventEmitter } = require('events');
const cat = require('./catalog');
const { MqttClient } = require('./mqtt');

const OUTPUT_PARAMS = [
  ['vol', 'number'], ['mute', 'switch'], ['dim', 'switch'], ['src', 'select'],
  ['eqen', 'switch'], ['eqpreset', 'select'], ['bten', 'switch'], ['loud', 'switch'], ['xfeed', 'select'],
];
const INPUT_PARAMS = [['eqen', 'switch'], ['eqpreset', 'select']];
const DEVICE_PARAMS = [['srate', 'sensor']];

const nodeId = () => os.hostname().toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'adi2pi';

class MqttBridge extends EventEmitter {
  constructor({ dev, settings, log, automation = null, ups = null, updates = null, nowPlaying = null, version = '', Client = MqttClient }) {
    super();
    this.dev = dev;
    this.settings = settings;
    this.log = log || console;
    this.automation = automation;
    this.ups = ups;
    this._onUps = () => this._publishUps();
    this.updates = updates;
    this._onUpdates = () => { this._discoverySoon(); this._publishUpdates(); };
    this.nowPlaying = nowPlaying;
    this._onNowPlaying = () => this._publishNowPlaying();
    this.version = version;
    this.Client = Client;
    this.client = null;
    this.error = null;
    this.cfgJson = '';
    this.published = new Set(); // discovery config topics we sent
    this.node = nodeId();
    this._onParams = (p) => this._params(p);
    this._onDevice = () => this._deviceChanged();
    this._onNames = () => this._discoverySoon();
    this._onSleep = () => this._publishSleep();
  }

  cfg() { return this.settings.get().mqtt || {}; }
  get base() { return `${this.cfg().base || 'adi2pi'}/${this.node}`; }

  status() {
    const c = this.cfg();
    return { enabled: !!c.enabled, connected: !!(this.client && this.client.connected), error: c.enabled ? this.error : null, topic: c.enabled ? this.base : null };
  }

  _emitStatus() { this.emit('status', this.status()); }

  start() {
    this.dev.on('params', this._onParams);
    this.dev.on('device', this._onDevice);
    this.dev.on('setups', this._onNames);
    this.dev.on('eqpresets', this._onNames);
    if (this.automation) this.automation.on('sleep', this._onSleep);
    if (this.ups) this.ups.on('status', this._onUps);
    if (this.updates) this.updates.on('status', this._onUpdates);
    if (this.nowPlaying) this.nowPlaying.on('change', this._onNowPlaying);
    this.settings.on('change', () => this.apply());
    this.apply();
  }

  stop() {
    this.dev.off('params', this._onParams);
    this.dev.off('device', this._onDevice);
    this.dev.off('setups', this._onNames);
    this.dev.off('eqpresets', this._onNames);
    if (this.automation) this.automation.off('sleep', this._onSleep);
    if (this.ups) this.ups.off('status', this._onUps);
    if (this.updates) this.updates.off('status', this._onUpdates);
    if (this.nowPlaying) this.nowPlaying.off('change', this._onNowPlaying);
    this._disconnect();
  }

  /** Settings changed: connect, reconnect or disconnect as needed; refresh discovery. */
  apply() {
    const c = this.cfg();
    const json = JSON.stringify(c);
    if (json === this.cfgJson) { this._discoverySoon(); this._publishProfiles(); return; }
    this.cfgJson = json;
    this._disconnect();
    if (!c.enabled || !c.host) { this._emitStatus(); return; }
    this.error = null;
    const client = new this.Client({
      host: c.host, port: c.port || 1883, clientId: `adi2-pi-${this.node}`,
      username: c.username || undefined, password: c.password || undefined,
      will: { topic: `${this.base}/status`, payload: 'offline', retain: true },
    });
    this.client = client;
    client.on('connect', () => {
      this.error = null;
      this.log.info(`mqtt: connected to ${c.host}:${c.port || 1883}`);
      client.publish(`${this.base}/status`, 'online', { retain: true });
      client.subscribe([`${this.base}/+/+/set`, `${this.base}/setup/set`, `${this.base}/sleep/set`]); // scene/<id>/set and <ch>/<id>/set match +/+/set
      this.published.clear();
      this._discovery();
      this._publishAll();
      this._emitStatus();
    });
    client.on('message', (t, p) => this._command(t, p));
    client.on('error', (e) => { if (this.error !== e.message) { this.error = e.message; this.log.warn(`mqtt: ${e.message}`); this._emitStatus(); } });
    client.on('close', () => this._emitStatus());
    client.start();
    this._emitStatus();
  }

  _disconnect() {
    if (!this.client) return;
    try { this.client.publish(`${this.base}/status`, 'offline', { retain: true }); } catch { /* closing */ }
    this.client.stop();
    this.client = null;
  }

  // ------------------------------------------------------------------ entities

  /** Entities of what the unit reports: [{ ch, id, kind, r }] */
  entities() {
    const model = this.dev.model;
    if (!model || !this.dev.ready) return [];
    const out = [];
    const add = (ch, id, kind) => {
      const r = cat.resolve(ch, id);
      if (!r || !cat.available(r.param, model)) return;
      if (r.channel && r.channel.not && r.channel.not.includes(model)) return;
      if (!this.dev.state.has(cat.key(r.addr, r.idx))) return;
      out.push({ ch, id, kind, r });
    };
    for (const ch of ['line', 'ph12', 'ph34']) for (const [id, kind] of OUTPUT_PARAMS) add(ch, id, kind);
    for (const [id, kind] of INPUT_PARAMS) add('in', id, kind);
    for (const [id, kind] of DEVICE_PARAMS) add('device', id, kind);
    return out;
  }

  _options(e) {
    const names = cat.valueNames(e.r.param, this.dev.model, e.r.channel) || [];
    const hide = new Set(e.r.param.hide || []);
    if (e.id === 'eqpreset') return names.map((n, i) => this._presetLabel(i, n)).filter((_, i) => !hide.has(i));
    return names.filter((_, i) => !hide.has(i));
  }

  _presetLabel(v, fallback) {
    if (v < 2 || v > 21) return fallback;
    const p = this.dev.eqPresets[v - 2];
    return p && p.name ? `${v - 1} · ${p.name}` : fallback;
  }

  _chName(ch) {
    if (ch === 'device') return 'Device';
    const c = cat.channelByKey[ch];
    return this.dev.model === 'dac' && c.dacName ? c.dacName : c.name;
  }

  _valueText(e, v) {
    if (e.kind === 'switch') return v ? 'ON' : 'OFF';
    if (e.kind === 'number') return String(cat.toDisplay(e.r.param, v));
    const names = cat.valueNames(e.r.param, this.dev.model, e.r.channel) || [];
    return e.id === 'eqpreset' ? this._presetLabel(v, names[v] ?? String(v)) : (names[v] ?? String(v));
  }

  _publishAll() {
    if (!this.client || !this.client.connected) return;
    for (const e of this.entities()) {
      const v = this.dev.state.get(cat.key(e.r.addr, e.r.idx));
      if (v !== undefined) this.client.publish(`${this.base}/${e.ch}/${e.id}/state`, this._valueText(e, v), { retain: true });
    }
    this._publishSleep();
    this._publishProfiles();
    this._publishNowPlaying();
    this._publishUps();
    this._publishUpdates();
  }

  _publishUps() {
    if (!this.client || !this.client.connected || !this.ups) return;
    const u = this.ups.status();
    if (!u.available) return;
    const wasPresent = this.upsPresent;
    this.upsPresent = true;
    if (!wasPresent) this._discoverySoon();
    this.client.publish(`${this.base}/ups/battery/state`, String(u.percent), { retain: true });
    this.client.publish(`${this.base}/ups/mains/state`, u.mains ? 'ON' : 'OFF', { retain: true });
  }

  /** Home Assistant update entity: installed and latest version (no install from Home Assistant). */
  _publishUpdates() {
    if (!this.client || !this.client.connected || !this.updates) return;
    const u = this.updates.status();
    if (!u.check || !u.lastCheck) return;
    this.client.publish(`${this.base}/update/state`, JSON.stringify({
      installed_version: u.current,
      latest_version: u.latest ? u.latest.version : u.current,
      title: 'ADI-2-Pi',
      release_url: u.latest ? u.latest.url : u.releasesUrl,
    }), { retain: true });
  }

  _params(p) {
    if (!this.client || !this.client.connected) return;
    const keys = new Set(Object.keys(p));
    for (const e of this.entities()) {
      const k = cat.key(e.r.addr, e.r.idx);
      if (keys.has(k)) this.client.publish(`${this.base}/${e.ch}/${e.id}/state`, this._valueText(e, p[k]), { retain: true });
    }
  }

  /** Headphone profile per output: the one applied last, or "—". */
  _publishProfiles() {
    if (!this.client || !this.client.connected || !this.automation) return;
    const st = this.settings.get();
    const names = new Map((st.profiles || []).map((p) => [p.id, p.name]));
    for (const ch of ['line', 'ph12', 'ph34']) {
      this.client.publish(`${this.base}/${ch}/profile/state`, names.get((st.activeProfile || {})[ch]) || '—', { retain: true });
    }
  }

  /** Now playing: "Artist – Title" (empty when nothing plays) and the details as attributes. */
  _publishNowPlaying() {
    if (!this.client || !this.client.connected || !this.nowPlaying) return;
    const n = this.nowPlaying.status();
    const e = n.current ? n.sources[n.current] : null;
    const text = e ? [e.artist, e.title].filter(Boolean).join(' – ') || e.source : '';
    this.client.publish(`${this.base}/nowplaying/state`, text, { retain: true });
    this.client.publish(`${this.base}/nowplaying/attributes`, JSON.stringify(e ? { source: e.source, state: e.state, title: e.title, artist: e.artist, album: e.album, duration: e.duration, sender: e.sender } : { source: null, state: 'stopped' }), { retain: true });
  }

  _publishSleep() {
    if (!this.client || !this.client.connected || !this.automation) return;
    const s = this.automation.sleepStatus();
    this.client.publish(`${this.base}/sleep/state`, String(s ? Math.max(1, Math.ceil((s.until - Date.now()) / 60000)) : 0), { retain: true });
  }

  _deviceChanged() {
    const d = this.dev.info();
    if (d.ready) { this._discoverySoon(); setTimeout(() => this._publishAll(), 1500).unref?.(); }
  }

  _discoverySoon() {
    clearTimeout(this.discTimer);
    this.discTimer = setTimeout(() => this._discovery(), 1000);
    this.discTimer.unref?.();
  }

  /** Home Assistant discovery: one config per entity; removed entities get an empty config. */
  _discovery() {
    const c = this.cfg();
    if (!this.client || !this.client.connected || !c.discovery || !this.dev.ready) return;
    const prefix = c.discoveryPrefix || 'homeassistant';
    const device = {
      identifiers: [`adi2pi_${this.node}`],
      name: this.settings.get().name || 'ADI-2-Pi',
      model: this.dev.model ? cat.schema.modelNames[this.dev.model] : 'ADI-2',
      manufacturer: 'ADI-2-Pi',
      sw_version: this.version,
    };
    const avail = { availability_topic: `${this.base}/status` };
    const now = new Map();
    for (const e of this.entities()) {
      const obj = `${e.ch}_${e.id}`;
      const conf = {
        name: `${this._chName(e.ch)} ${e.r.param.label}`,
        unique_id: `adi2pi_${this.node}_${obj}`,
        state_topic: `${this.base}/${e.ch}/${e.id}/state`,
        device, ...avail,
      };
      if (e.kind !== 'sensor') conf.command_topic = `${this.base}/${e.ch}/${e.id}/set`;
      if (e.kind === 'number') Object.assign(conf, { min: e.r.param.min, max: e.r.param.max, step: e.r.param.step || 1, unit_of_measurement: e.r.param.unit, mode: 'slider' });
      if (e.kind === 'select') conf.options = this._options(e);
      if (e.kind === 'switch') Object.assign(conf, { payload_on: 'ON', payload_off: 'OFF' });
      if (e.id === 'vol') conf.icon = 'mdi:volume-high';
      now.set(`${prefix}/${e.kind}/${this.node}/${obj}/config`, conf);
    }
    if (this.entities().length) {
      // load a setup
      now.set(`${prefix}/select/${this.node}/setup/config`, {
        name: 'Load setup', unique_id: `adi2pi_${this.node}_setup`, command_topic: `${this.base}/setup/set`,
        options: this.dev.setups.map((n, i) => (n ? `${i + 1} · ${n}` : `Setup ${i + 1}`)), device, ...avail, icon: 'mdi:playlist-play',
      });
      for (const sc of this.settings.get().scenes || []) {
        now.set(`${prefix}/button/${this.node}/scene_${sc.id}/config`, {
          name: `Scene ${sc.name}`, unique_id: `adi2pi_${this.node}_scene_${sc.id}`, command_topic: `${this.base}/scene/${sc.id}/set`, payload_press: 'apply', device, ...avail, icon: 'mdi:palette',
        });
      }
      const profiles = this.settings.get().profiles || [];
      if (this.automation && profiles.length) {
        for (const ch of ['line', 'ph12', 'ph34']) {
          if (!this.entities().some((e) => e.ch === ch)) continue;
          now.set(`${prefix}/select/${this.node}/${ch}_profile/config`, {
            name: `${this._chName(ch)} Headphone profile`, unique_id: `adi2pi_${this.node}_${ch}_profile`, state_topic: `${this.base}/${ch}/profile/state`, command_topic: `${this.base}/${ch}/profile/set`,
            options: ['—', ...profiles.map((p) => p.name)], device, ...avail, icon: 'mdi:headphones',
          });
        }
      }
      if (this.automation) {
        now.set(`${prefix}/number/${this.node}/sleep/config`, {
          name: 'Sleep timer', unique_id: `adi2pi_${this.node}_sleep`, state_topic: `${this.base}/sleep/state`, command_topic: `${this.base}/sleep/set`,
          min: 0, max: 240, step: 5, unit_of_measurement: 'min', mode: 'box', device, ...avail, icon: 'mdi:sleep',
        });
      }
    }
    if (this.ups && this.ups.status().available) {
      now.set(`${prefix}/sensor/${this.node}/ups_battery/config`, {
        name: 'UPS battery', unique_id: `adi2pi_${this.node}_ups_battery`, state_topic: `${this.base}/ups/battery/state`,
        unit_of_measurement: '%', device_class: 'battery', state_class: 'measurement', device, ...avail,
      });
      now.set(`${prefix}/binary_sensor/${this.node}/ups_mains/config`, {
        name: 'UPS mains power', unique_id: `adi2pi_${this.node}_ups_mains`, state_topic: `${this.base}/ups/mains/state`,
        payload_on: 'ON', payload_off: 'OFF', device_class: 'power', device, ...avail,
      });
    }
    if (this.nowPlaying) {
      now.set(`${prefix}/sensor/${this.node}/nowplaying/config`, {
        name: 'Now playing', unique_id: `adi2pi_${this.node}_nowplaying`, state_topic: `${this.base}/nowplaying/state`,
        json_attributes_topic: `${this.base}/nowplaying/attributes`, device, ...avail, icon: 'mdi:music-note',
      });
    }
    if (this.updates && this.updates.status().check) {
      now.set(`${prefix}/update/${this.node}/bridge/config`, {
        name: 'ADI-2-Pi update', unique_id: `adi2pi_${this.node}_update`, state_topic: `${this.base}/update/state`,
        device_class: 'firmware', entity_category: 'diagnostic', device, ...avail,
      });
    }
    for (const t of this.published) if (!now.has(t)) this.client.publish(t, '', { retain: true });
    for (const [t, conf] of now) this.client.publish(t, JSON.stringify(conf), { retain: true });
    this.published = new Set(now.keys());
  }

  // ------------------------------------------------------------------ commands

  _command(topic, payload) {
    if (!topic.startsWith(`${this.base}/`)) return;
    const parts = topic.slice(this.base.length + 1).split('/');
    const text = String(payload).trim();
    try {
      if (parts[0] === 'setup' && parts[1] === 'set') {
        const m = /^(?:Setup )?(\d)/.exec(text); // "3 · name", "Setup 3" (unnamed) or the name itself
        const n = m ? Number(m[1]) : this.dev.setups.findIndex((s) => s === text) + 1;
        this.dev.by = 'MQTT (Home Assistant)';
        try { this.dev.loadSetup(n); } finally { this.dev.by = null; }
        return;
      }
      if (parts[0] === 'scene' && parts[2] === 'set') {
        if (this.automation) this.automation.applyScene(parts[1], 'mqtt');
        return;
      }
      if (parts[0] === 'sleep' && parts[1] === 'set') {
        if (!this.automation) return;
        const m = Number(text);
        if (!m) this.automation.cancelSleep(); else this.automation.startSleep(m);
        return;
      }
      const [ch, id, verb] = parts;
      if (verb !== 'set') return;
      if (id === 'profile') {
        if (!this.automation) return;
        const pr = (this.settings.get().profiles || []).find((p) => p.name === text);
        if (!pr) { if (text === '—') this.settings.update({ activeProfile: { [ch]: null } }); else throw new Error(`unknown profile “${text}”`); return; }
        this.automation.applyProfile(pr.id, ch, 'mqtt');
        return;
      }
      const e = this.entities().find((x) => x.ch === ch && x.id === id);
      if (!e || e.kind === 'sensor') return;
      let value;
      if (e.kind === 'switch') value = /^(on|1|true)$/i.test(text) ? 1 : 0;
      else if (e.kind === 'number') { if (!text) throw new Error('empty value'); value = Number(text); }
      else {
        const names = cat.valueNames(e.r.param, this.dev.model, e.r.channel) || [];
        const labels = e.id === 'eqpreset' ? names.map((n, i) => this._presetLabel(i, n)) : names;
        value = labels.indexOf(text);
        if (value < 0) value = names.indexOf(text);
        if (value < 0) throw new Error(`unknown option “${text}”`);
      }
      const r = this.dev.set([{ ch, id, value }], { origin: 'mqtt' });
      if (r.errors.length) throw new Error(r.errors.join('; '));
    } catch (e) {
      this.log.warn(`mqtt: ${topic}: ${e.message}`);
    }
  }
}

module.exports = { MqttBridge };
