'use strict';
/**
 * Audio routing on the Pi (PipeWire, run by the adi2-pi-audio service).
 *
 * What it does, every couple of seconds (pw-dump) and right after Bluetooth changes:
 *   - phones/computers streaming to the Pi (Bluetooth A2DP into the Pi) → ADI-2 USB playback
 *   - ADI-2 USB record → Bluetooth headphones/speakers, when "Bluetooth out" has a source
 *   - the ADI-2's record signal is chosen with the unit's own Loopback setting (post FX, before
 *     volume, −6 dB headroom) for "Line Out" or "Phones 3/4"; the original value comes back when
 *     no Bluetooth output is connected any more
 *   - the ADI-2 stays the default output and its PipeWire volume stays at 100 % (the unit has
 *     its own volume)
 * Talks to PipeWire with its command line tools (pw-dump, pw-link, wpctl) – no extra libraries.
 *
 * Events: 'status' (status)
 */
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

// which program belongs to which receiver (lib/receivers.js), for names on the Pi Playback tab
const RECEIVER_BINARIES = { airplay: ['shairport-sync'], spotify: ['librespot'], upnp: ['gmediarender'], squeezelite: ['squeezelite'], snapcast: ['snapclient'], roon: ['RoonBridge', 'RAATServer', 'roonbridge'] };
const RECEIVER_LABELS = { airplay: 'AirPlay', spotify: 'Spotify Connect', upnp: 'UPnP / DLNA', squeezelite: 'Squeezelite', snapcast: 'Snapcast', roon: 'Roon' };
const LOOP_POST_6DB = 3; // "post FX 1/2 −6 dB" (Pro/SE), "post −6dB" (DAC)
const CH_ORDER = ['MONO', 'FL', 'FR', 'FC', 'LFE', 'RL', 'RR', 'SL', 'SR'];

function defaultRun(env) {
  return (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '', missing: !!(err && err.code === 'ENOENT') });
    });
  });
}

const isAdi = (props) => /ADI-2/i.test(`${props['api.alsa.card.name'] || ''} ${props['alsa.card_name'] || ''} ${props['node.name'] || ''} ${props['device.description'] || ''}`);
const isBt = (props) => props['device.api'] === 'bluez5' || /^bluez_/.test(props['node.name'] || '');
const btAddress = (props) => {
  if (props['api.bluez5.address']) return String(props['api.bluez5.address']).toUpperCase();
  const m = /([0-9A-F]{2}(?:_[0-9A-F]{2}){5})/i.exec(props['node.name'] || '');
  return m ? m[1].replace(/_/g, ':').toUpperCase() : null;
};

class Audio extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} [o.dev]          Adi2 (for the Loopback setting); optional
   * @param {() => object} o.getSettings  live bridge settings
   * @param {object} [o.env]          { XDG_RUNTIME_DIR } of the audio service
   */
  constructor({ log, dev = null, getSettings, settings = null, env = {}, run, pollMs = 2000 }) {
    super();
    this.log = log || console;
    this.dev = dev;
    this.getSettings = getSettings;
    this.settings = settings;        // Settings instance; keeps the Loopback save across restarts
    this.run = run || defaultRun(env);
    this.pollMs = pollMs;
    this.timer = null;
    this.busy = false;
    this.again = false;
    this.fast = 0;                  // quick re-reads in a row (capped: a change that doesn't take must not spin)
    this.ours = new Set();          // "outPort>inPort" links we made
    // Loopback values before we changed them for Bluetooth out, and what we set (bluetooth.loop in the settings)
    const loop = settings ? settings.get().bluetooth?.loop : null;
    this.loopSaved = loop ? { ...loop.saved } : null;
    this.loopSet = loop ? { ...loop.set } : null;
    this.model = null;
    this.state = { available: false, reason: 'starting' };
    this.lastJson = '';
    this.started = new Map(); // source key → when it started playing
    this.muted = new Set();   // node ids muted by "newest wins"
    this.active = null;
    this.warned = new Set();
  }

  start() {
    this._tick();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  /** Poll now (e.g. after a Bluetooth connect). */
  refresh() {
    if (this.busy) { this.again = true; return; }
    clearTimeout(this.timer);
    this._tick();
  }

  status() { return this.state; }

  async _tick() {
    if (this.stopped) return;
    this.busy = true;
    try {
      await this._poll();
    } catch (e) {
      this._warnOnce('poll', `audio: ${e.message}`);
    } finally {
      this.busy = false;
      if (!this.stopped) {
        const again = this.again && this.fast < 5;
        this.fast = this.again ? this.fast + 1 : 0;
        this.again = false;
        this.timer = setTimeout(() => this._tick(), again ? 50 : this.pollMs);
        this.timer.unref?.();
      }
    }
  }

  _warnOnce(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(msg);
  }

  _setState(s) {
    this.state = s;
    const j = JSON.stringify(s);
    if (j !== this.lastJson) {
      this.lastJson = j;
      this.emit('status', s);
    }
  }

  // ------------------------------------------------------------------ read PipeWire

  async _poll() {
    const r = await this.run('pw-dump', []);
    if (r.missing) return this._setState({ available: false, reason: 'PipeWire is not installed – run the installer again' });
    if (!r.ok) {
      // one failed read can happen while PipeWire is busy; say "not running" only when it lasts
      this.fails = (this.fails || 0) + 1;
      if (this.fails >= 3 || !this.state.available) return this._setState({ available: false, reason: 'the audio service (adi2-pi-audio) is not running' });
      return;
    }
    this.fails = 0;
    let dump;
    try { dump = JSON.parse(r.stdout); } catch { return this._setState({ available: false, reason: 'unexpected answer from PipeWire' }); }
    this.warned.delete('poll');
    const m = this.parse(dump);
    this.model = m;
    await this._reconcile(m);
    this._setState(this._status(m));
  }

  /** Nodes, ports and links from pw-dump. */
  parse(dump) {
    const nodes = new Map();
    const ports = [];
    const links = [];
    let defaults = {};
    const clock = {};
    for (const o of dump) {
      if (!o) continue;
      if (o.type === 'PipeWire:Interface:Metadata' && o.props && o.props['metadata.name'] === 'default') {
        for (const e of o.metadata || []) if (e.subject === 0) defaults[e.key] = e.value;
        continue;
      }
      if (o.type === 'PipeWire:Interface:Metadata' && o.props && o.props['metadata.name'] === 'settings') {
        for (const e of o.metadata || []) if (e.subject === 0) clock[e.key] = e.value;
        continue;
      }
      if (!o.info) continue;
      if (o.type === 'PipeWire:Interface:Node') {
        const props = o.info.props || {};
        const p = (o.info.params && o.info.params.Props && o.info.params.Props[0]) || {};
        nodes.set(o.id, {
          id: o.id, props, name: props['node.name'] || '', cls: props['media.class'] || '', state: o.info.state || '',
          volumes: p.channelVolumes || null, mute: !!p.mute,
          format: (o.info.params && o.info.params.Format && o.info.params.Format[0]) || null,
        });
      } else if (o.type === 'PipeWire:Interface:Port') {
        const props = o.info.props || {};
        ports.push({
          id: o.id, node: Number(props['node.id']), dir: o.info.direction === 'output' || props['port.direction'] === 'out' ? 'out' : 'in',
          name: props['port.name'] || '', channel: props['audio.channel'] || '', monitor: props['port.monitor'] === true || props['port.monitor'] === 'true' || /^monitor_/.test(props['port.name'] || ''),
          portId: Number(props['port.id'] ?? 0),
        });
      } else if (o.type === 'PipeWire:Interface:Link') {
        links.push({ id: o.id, out: o.info['output-port-id'], in: o.info['input-port-id'], state: o.info.state });
      }
    }
    const list = [...nodes.values()];
    const adiSink = list.find((n) => n.cls === 'Audio/Sink' && isAdi(n.props)) || null;
    const adiSource = list.find((n) => n.cls === 'Audio/Source' && isAdi(n.props)) || null;
    const btIn = list.filter((n) => isBt(n.props) && /^(Audio\/Source|Stream\/Output\/Audio)$/.test(n.cls));
    const btOut = list.filter((n) => isBt(n.props) && /^(Audio\/Sink|Stream\/Input\/Audio)$/.test(n.cls));
    const name = (v) => (v && typeof v === 'object' ? v.name : typeof v === 'string' ? (() => { try { return JSON.parse(v).name; } catch { return null; } })() : null);
    // playback streams of the streaming receivers (AirPlay, UPnP, Squeezelite …)
    const streams = list.filter((n) => n.cls === 'Stream/Output/Audio' && !isBt(n.props));
    // defaultSink: the sink in use; configuredSink: the one chosen explicitly (both must be the ADI-2)
    return { nodes, ports, links, adiSink, adiSource, btIn, btOut, streams, forceRate: Number(clock['clock.force-rate'] || 0), defaultSink: name(defaults['default.audio.sink']), configuredSink: name(defaults['default.configured.audio.sink']) };
  }

  _ports(m, node, dir) {
    return m.ports.filter((p) => p.node === node.id && p.dir === dir && !p.monitor)
      .sort((a, b) => {
        const ia = CH_ORDER.indexOf(a.channel), ib = CH_ORDER.indexOf(b.channel);
        if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        const ax = /^AUX(\d+)$/.exec(a.channel), bx = /^AUX(\d+)$/.exec(b.channel);
        if (ax && bx) return Number(ax[1]) - Number(bx[1]);
        return a.portId - b.portId;
      });
  }

  /** Port pairs for out-node → in-node: by channel order; a mono output feeds every input. */
  _pairs(m, from, to) {
    const outs = this._ports(m, from, 'out');
    const ins = this._ports(m, to, 'in');
    if (!outs.length || !ins.length) return [];
    if (outs.length === 1) return ins.map((i) => [outs[0].id, i.id]);
    const n = Math.min(outs.length, ins.length);
    return Array.from({ length: n }, (_, i) => [outs[i].id, ins[i].id]);
  }

  gainDb() {
    const s = this.getSettings();
    const g = s.bluetooth && Number(s.bluetooth.gainDb);
    return Number.isFinite(g) ? Math.max(0, Math.min(20, g)) : 6;
  }

  outSource() {
    const s = this.getSettings();
    return (s.bluetooth && s.bluetooth.outSource) || 'line';
  }

  // ------------------------------------------------------------------ make it so

  routing() {
    const r = this.getSettings().routing || {};
    return { mode: r.mode === 'mix' ? 'mix' : 'newest', rate: Number(r.rate) || 0 };
  }

  /** Everything that plays into the ADI-2: Bluetooth phones and the receivers' streams. */
  _sources(m) {
    const list = [];
    for (const n of m.btIn) list.push({ node: n, kind: 'bluetooth', key: `bt:${btAddress(n.props) || n.id}`, label: n.props['node.description'] || n.props['device.description'] || btAddress(n.props) || 'Bluetooth', address: btAddress(n.props) });
    for (const n of m.streams) {
      const bin = n.props['application.process.binary'] || '';
      const rx = Object.keys(RECEIVER_BINARIES).find((id) => RECEIVER_BINARIES[id].some((b) => bin.toLowerCase().startsWith(b.toLowerCase())));
      list.push({ node: n, kind: rx ? 'receiver' : 'app', receiver: rx || null, key: `node:${n.id}`, label: rx ? RECEIVER_LABELS[rx] : (n.props['application.name'] || bin || `stream ${n.id}`) });
    }
    return list;
  }

  /**
   * Newest wins: the source that started playing last is heard, the others playing are muted
   * until it stops (then the one before it is heard again). switchTo() moves one to the top.
   */
  async _arbitrate(m) {
    const { mode } = this.routing();
    const now = Date.now();
    const srcs = this._sources(m);
    const running = new Set();
    for (const s of srcs) {
      if (s.node.state === 'running') {
        running.add(s.key);
        if (!this.started.has(s.key)) this.started.set(s.key, now);
      }
    }
    for (const k of [...this.started.keys()]) if (!running.has(k)) this.started.delete(k);
    const order = [...this.started.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const active = mode === 'newest' ? order[0] || null : null;
    for (const s of srcs) {
      const mute = mode === 'newest' && running.has(s.key) && s.key !== active;
      if (mute && !s.node.mute) {
        await this.run('wpctl', ['set-mute', String(s.node.id), '1']);
        this.muted.add(s.node.id);
        this.again = true;
      } else if (!mute && s.node.mute && (this.muted.has(s.node.id) || s.key === active)) {
        // also unmutes a stream that WirePlumber restored as muted from an earlier session
        await this.run('wpctl', ['set-mute', String(s.node.id), '0']);
        this.muted.delete(s.node.id);
        this.again = true;
      }
    }
    for (const id of [...this.muted]) if (!m.nodes.has(id)) this.muted.delete(id);
    this.active = active;
  }

  /** Make a playing source the one that's heard. */
  switchTo(key) {
    if (!this.started.has(key)) throw Object.assign(new Error('that source is not playing'), { status: 409 });
    this.started.set(key, Date.now());
    this.refresh();
  }

  async _reconcile(m) {
    await this._arbitrate(m);
    // sample rate: follow what plays (0) or fixed
    const { rate } = this.routing();
    if (m.forceRate !== rate) {
      await this.run('pw-metadata', ['-n', 'settings', '0', 'clock.force-rate', String(rate)]);
      this.again = true;
    }
    const want = new Set();
    if (m.adiSink) for (const n of m.btIn) for (const [o, i] of this._pairs(m, n, m.adiSink)) want.add(`${o}>${i}`);
    const src = this.outSource();
    if (m.adiSource && src !== 'off') for (const n of m.btOut) for (const [o, i] of this._pairs(m, m.adiSource, n)) want.add(`${o}>${i}`);

    const have = new Map(m.links.map((l) => [`${l.out}>${l.in}`, l]));
    for (const k of want) {
      if (have.has(k)) { this.ours.add(k); continue; }
      const [o, i] = k.split('>');
      const r = await this.run('pw-link', [o, i]);
      if (r.ok || /exist/i.test(r.stderr)) this.ours.add(k);
      else this._warnOnce(`link ${k}`, `audio: could not link ports ${o} → ${i}: ${r.stderr.trim()}`);
      this.again = true; // read the result back
    }
    // anything else touching Bluetooth goes: phones only feed the ADI-2, headphones only get the ADI-2
    // (WirePlumber may link a phone to a freshly connected headphone while it is briefly the default)
    const nodeOf = new Map(m.ports.map((p) => [p.id, p.node]));
    const inIds = new Set(m.btIn.map((n) => n.id)), outIds = new Set(m.btOut.map((n) => n.id));
    for (const l of m.links) {
      const k = `${l.out}>${l.in}`;
      if (want.has(k)) continue;
      const from = nodeOf.get(l.out), to = nodeOf.get(l.in);
      const foreign = (inIds.has(from) && (!m.adiSink || to !== m.adiSink.id)) || (outIds.has(to) && (!m.adiSource || from !== m.adiSource.id || src === 'off'));
      if (foreign) { await this.run('pw-link', ['-d', String(l.id)]); this.ours.delete(k); this.again = true; }
    }
    for (const k of [...this.ours]) {
      if (want.has(k)) continue;
      const l = have.get(k);
      if (l) { await this.run('pw-link', ['-d', String(l.id)]); this.again = true; }
      this.ours.delete(k);
    }

    // the ADI-2 stays the default output, so nothing else ends up on the Bluetooth headphones
    if (m.adiSink && (m.defaultSink !== m.adiSink.name || m.configuredSink !== m.adiSink.name)) {
      await this.run('wpctl', ['set-default', String(m.adiSink.id)]);
    }
    // playback stays at 100 % (the unit has its own volume); the record side carries the
    // Bluetooth level (only Bluetooth outputs use it). wpctl volumes are cubic: linear = v³.
    const gain = Math.pow(10, this.gainDb() / 20);
    for (const [n, lin] of [[m.adiSink, 1], [m.adiSource, gain]]) {
      if (!n || !n.volumes) continue;
      if (n.volumes.some((v) => Math.abs(v - lin) > lin * 0.01)) await this.run('wpctl', ['set-volume', String(n.id), Math.cbrt(lin).toFixed(4)]);
      if (n.mute) await this.run('wpctl', ['set-mute', String(n.id), '0']);
    }

    this._loopback(m.btOut.length > 0, src);
  }

  /** Point the ADI-2's USB record signal at what Bluetooth out should play. */
  _loopback(active, src) {
    const dev = this.dev;
    if (!dev || !dev.id || dev.answering === false || !dev.ready) return;
    const cur = { line: dev.get(3, 17), ph34: dev.get(9, 17) };
    if (cur.line === undefined) return;
    let want = null;
    if (active && (src === 'line' || src === 'ph34')) {
      const other = src === 'line' ? 'ph34' : 'line';
      want = { [src]: LOOP_POST_6DB };
      // only one output can feed USB record 1/2 (values 1–3); free it
      if (cur[other] !== undefined && cur[other] >= 1 && cur[other] <= 3) want[other] = 0;
    } else if (active && src === 'analog') {
      want = {};
      for (const k of ['line', 'ph34']) if (cur[k] !== undefined && cur[k] >= 1 && cur[k] <= 3) want[k] = 0;
    }
    if (want) {
      const items = Object.entries(want).filter(([k, v]) => cur[k] !== v);
      if (!items.length) return;
      if (!this.loopSaved) this.loopSaved = { ...cur };
      this.loopSet = { ...this.loopSet, ...want };
      this._keepLoop();
      const r = dev.set(items.map(([ch, value]) => ({ ch, id: 'loop', value })), { origin: 'bridge' });
      if (r.errors.length) this._warnOnce('loop', `audio: could not set Loopback: ${r.errors.join('; ')}`);
      else this.log.info(`audio: Loopback ${items.map(([k, v]) => `${k}=${v}`).join(' ')} for Bluetooth out`);
    } else if (this.loopSaved) {
      // nothing on Bluetooth out any more: put back what was there, unless someone changed it meanwhile
      const items = Object.entries(this.loopSaved)
        .filter(([k, v]) => v !== undefined && this.loopSet && this.loopSet[k] !== undefined && cur[k] === this.loopSet[k] && cur[k] !== v);
      if (items.length) {
        const r = dev.set(items.map(([ch, value]) => ({ ch, id: 'loop', value })), { origin: 'bridge' });
        if (r.errors.length) return; // try again next time
        this.log.info(`audio: Loopback back to ${items.map(([k, v]) => `${k}=${v}`).join(' ')}`);
      }
      this.loopSaved = null;
      this.loopSet = null;
      this._keepLoop();
    }
  }

  _keepLoop() {
    if (!this.settings) return;
    const loop = this.loopSaved ? { saved: { ...this.loopSaved }, set: { ...this.loopSet } } : null;
    try { this.settings.update({ bluetooth: { loop } }); } catch (e) { this.log.warn(`audio: could not keep the Loopback values: ${e.message}`); }
  }

  // ------------------------------------------------------------------ status / controls

  _linked(m, from, to) {
    const pairs = this._pairs(m, from, to);
    if (!pairs.length) return false;
    const have = new Set(m.links.map((l) => `${l.out}>${l.in}`));
    return pairs.every(([o, i]) => have.has(`${o}>${i}`));
  }

  _status(m) {
    const vol = (n) => (n.volumes && n.volumes.length ? Math.round(Math.cbrt(n.volumes.reduce((a, b) => a + b, 0) / n.volumes.length) * 100) / 100 : null);
    const node = (n) => n && { id: n.id, name: n.name, state: n.state, rate: Number(n.props['audio.rate'] || 0) || null };
    const bt = (n, linked) => ({
      id: n.id, address: btAddress(n.props), codec: n.props['api.bluez5.codec'] || null, profile: n.props['api.bluez5.profile'] || null,
      name: n.props['node.description'] || n.props['device.description'] || n.name, state: n.state, volume: vol(n), mute: n.mute, linked,
    });
    const src = this.outSource();
    return {
      available: true,
      reason: m.adiSink ? null : 'the ADI-2\'s USB audio device is not visible to the audio service',
      adi: { sink: node(m.adiSink), source: node(m.adiSource) },
      inputs: m.btIn.map((n) => bt(n, !!m.adiSink && this._linked(m, n, m.adiSink))),
      outputs: m.btOut.map((n) => bt(n, !!m.adiSource && src !== 'off' && this._linked(m, m.adiSource, n))),
      routing: this.routing(),
      forceRate: m.forceRate,
      rate: (m.adiSink && m.adiSink.state === 'running' && m.adiSink.format && m.adiSink.format.rate) || null,
      sources: this._sources(m).map((s) => ({
        key: s.key, kind: s.kind, receiver: s.receiver || null, address: s.address || null, label: s.label,
        playing: s.node.state === 'running', active: s.key === this.active || (this.routing().mode === 'mix' && s.node.state === 'running'),
        muted: !!s.node.mute, rate: (s.node.format && s.node.format.rate) || null,
      })),
      streams: m.streams.map((n) => {
        const to = new Set(m.links.filter((l) => m.ports.some((p) => p.id === l.out && p.node === n.id)).map((l) => (m.ports.find((p) => p.id === l.in) || {}).node));
        return {
          id: n.id, state: n.state,
          app: n.props['application.name'] || null,
          binary: n.props['application.process.binary'] || null,
          rate: (n.format && n.format.rate) || Number(n.props['audio.rate'] || 0) || null,
          toAdi: !!m.adiSink && to.has(m.adiSink.id),
        };
      }),
      outSource: src,
      gainDb: this.gainDb(),
      loopback: this.loopSaved ? { ...this.loopSet } : null,
    };
  }

  /** Volume of a Bluetooth output (0–1.5, cubic like wpctl). */
  async setVolume(address, value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 1.5) throw Object.assign(new Error('volume must be 0…1.5'), { status: 400 });
    const m = this.model;
    const n = m && [...m.btOut, ...m.btIn].find((x) => btAddress(x.props) === String(address).toUpperCase());
    if (!n) throw Object.assign(new Error('that device has no audio connection'), { status: 409 });
    const r = await this.run('wpctl', ['set-volume', String(n.id), v.toFixed(3)]);
    if (!r.ok) throw Object.assign(new Error(`could not set the volume: ${r.stderr.trim() || 'wpctl failed'}`), { status: 500 });
    this.refresh();
  }
}

module.exports = { Audio, btAddress };
