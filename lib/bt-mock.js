'use strict';
/**
 * Simulated Bluetooth + audio for `--mock` (development and screenshots): same interface as
 * Bluetooth (lib/bluetooth.js) and Audio (lib/audio.js).
 *   - "Studio Speaker" is paired already
 *   - a search finds "WH-1000XM5" (headphones) and "Kitchen Radio" after a moment
 *   - while the Pi is visible, "Pixel 8" (a phone) pairs and starts streaming after 3 s
 */
const { EventEmitter } = require('events');

const A2DP_SINK = 'canReceive', A2DP_SOURCE = 'canSend';
const dev = (address, name, icon, kind, extra = {}) => ({
  address, name, hasName: true, icon, paired: false, bonded: false, trusted: false, connected: false, blocked: false,
  rssi: null, battery: null, canReceive: kind === A2DP_SINK, canSend: kind === A2DP_SOURCE, audio: true, ...extra,
});

class MockBluetooth extends EventEmitter {
  constructor({ alias = 'ADI-2-Pi' } = {}) {
    super();
    this.alias = alias;
    this.devices = [dev('5C:FB:7C:11:22:33', 'Studio Speaker', 'audio-card', A2DP_SINK, { paired: true, bonded: true, trusted: true })];
    this.pairUntil = 0;
    this.scanUntil = 0;
    this.timers = [];
    this.state = this._state();
  }

  start() { this._emit(); }
  stop() { for (const t of this.timers) clearTimeout(t); }
  _later(ms, fn) { const t = setTimeout(fn, ms); t.unref?.(); this.timers.push(t); }

  _state() {
    const now = Date.now();
    return {
      available: true, reason: null,
      adapter: { address: 'DC:A6:32:00:00:01', name: this.alias, powered: true, discoverable: now < this.pairUntil, pairable: now < this.pairUntil, discovering: now < this.scanUntil },
      pairingUntil: now < this.pairUntil ? this.pairUntil : null,
      scanUntil: now < this.scanUntil ? this.scanUntil : null,
      devices: this.devices.map((d) => ({ ...d })),
    };
  }

  _emit() { this.state = this._state(); this.emit('state', this.state); }
  device(address) { return this.devices.find((d) => d.address === String(address).toUpperCase()) || null; }
  _need(address) { const d = this.device(address); if (!d) throw Object.assign(new Error('That device is no longer known – search again.'), { status: 409 }); return d; }

  async cmd(cmd, a = {}) {
    switch (cmd) {
      case 'init': case 'state': return this._state();
      case 'alias': this.alias = a.name; this._emit(); return null;
      case 'pairing': {
        const secs = Number(a.seconds ?? 120);
        this.pairUntil = secs ? Date.now() + secs * 1000 : 0;
        this._emit();
        if (secs) {
          this._later(secs * 1000 + 20, () => this._emit());
          this._later(3000, () => {
            if (Date.now() > this.pairUntil || this.device('AC:37:43:AA:BB:CC')) return;
            this.devices.push(dev('AC:37:43:AA:BB:CC', 'Pixel 8', 'phone', A2DP_SOURCE, { paired: true, bonded: true, trusted: true, connected: true }));
            this._emit();
          });
        }
        return this._state();
      }
      case 'scan': {
        const secs = Number(a.seconds ?? 30);
        this.scanUntil = secs ? Date.now() + secs * 1000 : 0;
        this._emit();
        if (secs) {
          this._later(secs * 1000 + 20, () => this._emit());
          this._later(1200, () => {
            if (!this.device('14:3F:A6:01:02:03')) this.devices.push(dev('14:3F:A6:01:02:03', 'WH-1000XM5', 'audio-headphones', A2DP_SINK, { rssi: -48, battery: 80 }));
            if (!this.device('00:1A:7D:DA:71:13')) this.devices.push(dev('00:1A:7D:DA:71:13', 'Kitchen Radio', 'audio-card', A2DP_SINK, { rssi: -77 }));
            if (!this.device('F4:60:E2:44:55:66')) this.devices.push(dev('F4:60:E2:44:55:66', 'iPhone', 'phone', A2DP_SOURCE, { rssi: -55 }));
            this._emit();
          });
        }
        return this._state();
      }
      case 'pair': {
        const d = this._need(a.address);
        await new Promise((r) => setTimeout(r, 900));
        Object.assign(d, { paired: true, bonded: true, trusted: true, connected: true });
        this._emit();
        return null;
      }
      case 'connect': {
        const d = this._need(a.address);
        await new Promise((r) => setTimeout(r, 500));
        if (d.address === '00:1A:7D:DA:71:13') throw Object.assign(new Error('Could not reach the device. Is it switched on and close by?'), { status: 409 });
        d.connected = true; this._emit(); return null;
      }
      case 'disconnect': { this._need(a.address).connected = false; this._emit(); return null; }
      case 'forget': { this.devices = this.devices.filter((d) => d.address !== String(a.address).toUpperCase()); this._emit(); return null; }
      default: throw new Error(`unknown command ${cmd}`);
    }
  }

  setAlias(name) { this.alias = name; this._emit(); return Promise.resolve(); }
}

/** Audio side of the simulation: connected devices get a codec and, for outputs, a volume. */
class MockAudio extends EventEmitter {
  constructor({ bt, getSettings }) {
    super();
    this.bt = bt;
    this.getSettings = getSettings;
    this.volumes = {};
    this.state = { available: true };
    bt.on('state', () => this._update());
  }
  start() { this._update(); }
  stop() {}
  refresh() { this._update(); }
  status() { return this.state; }
  _update() {
    const src = (this.getSettings().bluetooth || {}).outSource || 'line';
    const devs = (this.bt.state.devices || []).filter((d) => d.connected);
    const outs = devs.filter((d) => d.canReceive);
    this.state = {
      available: true, reason: null,
      adi: { sink: { id: 40, name: 'alsa_output.usb-RME_ADI-2_Pro (simulated)', state: 'running', rate: 48000 }, source: { id: 41, name: 'alsa_input.usb-RME_ADI-2_Pro (simulated)', state: outs.length ? 'running' : 'suspended', rate: 48000 } },
      inputs: devs.filter((d) => d.canSend).map((d, i) => ({ id: 60 + i, address: d.address, codec: 'sbc_xq', profile: 'a2dp-source', name: d.name, state: 'running', volume: 1, mute: false, linked: true })),
      outputs: outs.map((d, i) => ({ id: 70 + i, address: d.address, codec: d.icon === 'audio-headphones' ? 'ldac' : 'aptx_hd', profile: 'a2dp-sink', name: d.name, state: 'running', volume: this.volumes[d.address] ?? 0.7, mute: false, linked: src !== 'off' })),
      routing: { mode: (this.getSettings().routing || {}).mode || 'newest', rate: Number((this.getSettings().routing || {}).rate) || 0 },
      forceRate: Number((this.getSettings().routing || {}).rate) || 0,
      rate: Number((this.getSettings().routing || {}).rate) || 44100,
      sources: this._sources(devs),
      outSource: src,
      gainDb: (this.getSettings().bluetooth || {}).gainDb ?? 6,
      loopback: outs.length && (src === 'line' || src === 'ph34') ? { [src]: 3 } : null,
    };
    this.emit('status', this.state);
  }
  _sources(devs) {
    const mode = (this.getSettings().routing || {}).mode || 'newest';
    const list = devs.filter((d) => d.canSend).map((d) => ({ key: `bt:${d.address}`, kind: 'bluetooth', receiver: null, address: d.address, label: d.name, playing: true, rate: 44100 }));
    list.push({ key: 'node:90', kind: 'receiver', receiver: 'airplay', address: null, label: 'AirPlay', playing: true, rate: 44100 });
    const top = this.top && list.some((x) => x.key === this.top) ? this.top : list[list.length - 1].key;
    return list.map((x) => ({ ...x, active: mode === 'mix' || x.key === top, muted: mode !== 'mix' && x.key !== top }));
  }
  switchTo(key) { this.top = key; this._update(); }
  async setVolume(address, v) { this.volumes[String(address).toUpperCase()] = Number(v); this._update(); }
}

module.exports = { MockBluetooth, MockAudio };

/** Streaming receivers for --mock: AirPlay "plays" 44.1 kHz now and then; Spotify isn't installed. */
class MockReceivers extends EventEmitter {
  constructor({ getSettings, updateSettings }) {
    super();
    this.getSettings = getSettings;
    this.updateSettings = updateSettings;
    this.playing = 'airplay';
  }
  start() {
    this.t = setInterval(() => { this.playing = this.playing ? null : 'airplay'; this.emit('status', this.status()); }, 15000);
    this.t.unref?.();
    this.emit('status', this.status());
  }
  stop() { clearInterval(this.t); }
  apply() { this.emit('status', this.status()); }
  rename() { this.apply(); }
  status() {
    const r = this.getSettings().receivers || {};
    const defs = [
      ['airplay', 'AirPlay', 'iPhone, iPad, Mac, Apple TV and AirPlay apps', true],
      ['spotify', 'Spotify Connect', 'Spotify app on phones, computers and speakers', false],
      ['upnp', 'UPnP / DLNA', 'BubbleUPnP, foobar2000, Linn Kazoo, NAS media servers', true],
      ['squeezelite', 'Squeezelite', 'Lyrion Music Server (Logitech Media Server)', true, true],
      ['snapcast', 'Snapcast', 'synchronised multi-room playback from a Snapcast server', true, true],
    ];
    const list = defs.map(([id, label, about, installed, hasServer]) => {
      const c = r[id] || {};
      const enabled = !!c.enabled && installed;
      return { id, label, about, installed, enabled, hasServer: !!hasServer, server: hasServer ? (c.server || '') : undefined,
        running: enabled, since: enabled ? Date.now() - 60000 : null, playing: enabled && this.playing === id, rate: enabled && this.playing === id ? 44100 : null,
        error: null, variant: id === 'airplay' ? 'AirPlay (classic)' : null };
    });
    list.push({ id: 'roon', label: 'Roon Bridge', about: 'Roon – choose “System Output” on this Pi in Roon', installed: false, enabled: false, running: false, external: true, playing: false, rate: null, error: null });
    return { audio: true, name: this.getSettings().name, receivers: list };
  }
  set(id, patch) {
    if (id === 'roon') throw Object.assign(new Error('Roon Bridge is switched on and off by its installer option (--with-roon)'), { status: 400 });
    if (id === 'spotify' && patch.enabled) throw Object.assign(new Error('Spotify Connect is not installed – install with --with-spotify'), { status: 409 });
    this.updateSettings({ receivers: { [id]: patch } });
    this.apply();
    return this.status();
  }
}

module.exports.MockReceivers = MockReceivers;
