'use strict';
/**
 * What the Pi plays: title, artist, album, play state per source.
 *
 * - AirPlay: shairport-sync's metadata pipe (`metadata = { enabled, pipe_name }` in the config the
 *   bridge writes). Items arrive as `<item><type>hex</type><code>hex</code><length>n</length>
 *   <data encoding="base64">…</data></item>`: core/minm title, core/asar artist, core/asal album,
 *   ssnc/snam sender, ssnc/PICT cover image, ssnc/prgr progress (start/current/end, RTP time at
 *   44.1 kHz), ssnc/pbeg, prsm (playing), pfls (paused), pend (stopped), mden (bundle complete).
 * - Spotify Connect: librespot `--onevent` → bin/adi2-pi-hook.js → POST /api/hook with
 *   `event` (track_changed, playing, paused, stopped … – names of librespot 0.5; 0.4 sends
 *   changed/started/playing/paused/stopped without titles) and the track fields.
 * - Bluetooth: AVRCP, from the Bluetooth helper's state (device.player: status, track).
 *
 * Events: 'change' (status)
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const PIPE_NAME = 'shairport-sync-metadata';
const READ_IDLE_MS = 150;
const NO_WRITER_MS = 600;
const MAX_BUF = 4 * 1024 * 1024;   // a cover image is a few hundred KB of base64
const ITEM = /<item><type>([0-9a-f]{8})<\/type><code>([0-9a-f]{8})<\/code><length>(\d+)<\/length>(?:\s*<data encoding="base64">\s*([^<]*)<\/data>)?\s*<\/item>/g;
const SOURCES = ['airplay', 'spotify', 'bluetooth'];

const fromHex = (h) => Buffer.from(h, 'hex').toString('latin1');
const imageType = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0x47 && b[1] === 0x49 ? 'image/gif' : 'application/octet-stream');
const clean = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) || null;

function empty(source) {
  return { source, state: 'stopped', title: null, artist: null, album: null, duration: null, position: null, positionAt: null, sender: null, cover: null, since: null };
}

class NowPlaying extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.dataDir]  where shairport-sync's metadata pipe lives (null = no AirPlay metadata)
   * @param {object} [o.bt]       Bluetooth (state.devices[].player)
   */
  constructor({ dataDir = null, bt = null, log } = {}) {
    super();
    this.log = log || console;
    this.bt = bt;
    this.pipe = dataDir ? path.join(dataDir, PIPE_NAME) : null;
    this.fd = null;
    this.timer = null;
    this.buf = '';
    this.stopped = false;
    this.entries = Object.fromEntries(SOURCES.map((s) => [s, empty(s)]));
    this.covers = { airplay: null }; // { data, type, v }
    this.coverV = 0;
    this.pending = null;              // AirPlay fields of the bundle being received
    this.lastJson = '';
    this._onBt = () => this._bluetooth();
  }

  /** The pipe path for shairport-sync's config, or null. */
  get pipePath() { return this.pipe; }

  start() {
    this.stopped = false;
    if (this.bt) { this.bt.on('state', this._onBt); this._bluetooth(); }
    if (this.pipe) this._open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.bt) this.bt.off('state', this._onBt);
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* gone */ } this.fd = null; }
  }

  // ------------------------------------------------------------------ AirPlay (metadata pipe)

  _open() {
    if (this.stopped) return;
    try {
      if (!fs.existsSync(this.pipe)) {
        // created here so the reader is ready before shairport-sync starts; mode as shairport-sync uses
        execFile('mkfifo', ['-m', '0644', this.pipe], () => this._later(500));
        return;
      }
      if (!fs.statSync(this.pipe).isFIFO()) { this.log.warn(`nowplaying: ${this.pipe} is not a pipe – no AirPlay titles`); return; }
      this.fd = fs.openSync(this.pipe, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      this._read();
    } catch (e) {
      this.log.warn(`nowplaying: ${e.message}`);
      this._later(5000);
    }
  }

  _later(ms) {
    clearTimeout(this.timer);
    if (!this.stopped) { this.timer = setTimeout(() => (this.fd === null ? this._open() : this._read()), ms); this.timer.unref?.(); }
  }

  _read() {
    if (this.fd === null || this.stopped) return;
    const fd = this.fd;
    const chunk = Buffer.allocUnsafe(65536);
    fs.read(fd, chunk, 0, chunk.length, null, (err, n) => {
      if (fd !== this.fd) return;
      if (err) {
        if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') return this._later(READ_IDLE_MS);
        this.log.warn(`nowplaying: pipe: ${err.message}`);
        try { fs.closeSync(fd); } catch { /* gone */ }
        this.fd = null;
        return this._later(5000);
      }
      if (n === 0) return this._later(NO_WRITER_MS); // no writer at the moment
      this.buf += chunk.toString('latin1', 0, n);
      if (this.buf.length > MAX_BUF) this.buf = this.buf.slice(-MAX_BUF);
      this._parse();
      setImmediate(() => this._read());
    });
  }

  _parse() {
    let last = 0, m;
    ITEM.lastIndex = 0;
    while ((m = ITEM.exec(this.buf))) {
      last = ITEM.lastIndex;
      const type = fromHex(m[1]), code = fromHex(m[2]);
      const data = m[4] ? Buffer.from(m[4].replace(/\s+/g, ''), 'base64') : Buffer.alloc(0);
      this._item(type, code, data);
    }
    if (last) this.buf = this.buf.slice(last);
    else if (this.buf.length > 1024 && !this.buf.includes('<item>')) this.buf = '';
  }

  _item(type, code, data) {
    const e = this.entries.airplay;
    const text = () => clean(data.toString('utf8'));
    if (type === 'core') {
      if (!this.pending) this.pending = {};
      if (code === 'minm') this.pending.title = text();
      else if (code === 'asar') this.pending.artist = text();
      else if (code === 'asal') this.pending.album = text();
      return;
    }
    if (type !== 'ssnc') return;
    switch (code) {
      case 'mdst': this.pending = {}; break;
      case 'mden':
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          const changed = ['title', 'artist', 'album'].some((k) => p[k] !== undefined && p[k] !== e[k]);
          for (const k of ['title', 'artist', 'album']) if (p[k] !== undefined) e[k] = p[k];
          if (changed) { e.since = Date.now(); this._changed(); }
        }
        break;
      case 'snam': e.sender = text(); this._changed(); break;
      case 'PICT':
        if (data.length) { this.covers.airplay = { data, type: imageType(data), v: ++this.coverV }; e.cover = `/api/nowplaying/cover?source=airplay&v=${this.coverV}`; } else { this.covers.airplay = null; e.cover = null; }
        this._changed();
        break;
      case 'prgr': {
        const [a, b, c] = String(data.toString('utf8')).split('/').map(Number);
        if ([a, b, c].every(Number.isFinite) && c > a) { e.duration = Math.round((c - a) / 44100); e.position = Math.max(0, Math.round((b - a) / 44100)); e.positionAt = Date.now(); this._changed(); }
        break;
      }
      case 'pbeg': case 'prsm': this._state('airplay', 'playing'); break;
      case 'pfls': this._state('airplay', 'paused'); break;
      case 'pend':
        Object.assign(e, empty('airplay'));
        this.covers.airplay = null;
        this._changed();
        break;
      default: break;
    }
  }

  _state(source, state) {
    const e = this.entries[source];
    if (e.state === state) return;
    e.state = state;
    if (state === 'playing' && !e.since) e.since = Date.now();
    this._changed();
  }

  // ------------------------------------------------------------------ Spotify Connect (hook)

  /** From bin/adi2-pi-hook.js: { receiver: 'spotify', event, name, artists, album, durationMs, positionMs, coverUrl }. */
  handleHook(b) {
    if (b.receiver !== 'spotify') return { ignored: 'unknown receiver' };
    const e = this.entries.spotify;
    const ev = String(b.event || '');
    switch (ev) {
      case 'track_changed': case 'changed': {
        const title = clean(b.name), artist = clean(b.artists), album = clean(b.album);
        if (title !== e.title || artist !== e.artist || album !== e.album) { e.title = title; e.artist = artist; e.album = album; e.since = Date.now(); }
        e.duration = b.durationMs > 0 ? Math.round(b.durationMs / 1000) : null;
        e.cover = clean(b.coverUrl, 500);   // Spotify's image server; the web page doesn't load it
        e.position = 0; e.positionAt = Date.now();
        this._changed();
        break;
      }
      case 'playing': case 'started':
        if (b.positionMs >= 0) { e.position = Math.round(b.positionMs / 1000); e.positionAt = Date.now(); }
        if (b.durationMs > 0) e.duration = Math.round(b.durationMs / 1000);
        this._state('spotify', 'playing');
        break;
      case 'paused':
        if (b.positionMs >= 0) { e.position = Math.round(b.positionMs / 1000); e.positionAt = Date.now(); }
        this._state('spotify', 'paused');
        break;
      case 'stopped': case 'end_of_track': case 'session_disconnected':
        Object.assign(e, empty('spotify'));
        this._changed();
        break;
      default: return { ignored: `event ${ev}` };
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ Bluetooth (AVRCP)

  _bluetooth() {
    const devs = (this.bt && this.bt.state && this.bt.state.devices) || [];
    const d = devs.find((x) => x.connected && x.player && x.player.status === 'playing') || devs.find((x) => x.connected && x.player && x.player.track && (x.player.track.title || x.player.track.artist)) || devs.find((x) => x.connected && x.player);
    const e = this.entries.bluetooth;
    if (!d) {
      if (e.state !== 'stopped' || e.title) { Object.assign(e, empty('bluetooth')); this._changed(); }
      return;
    }
    const t = d.player.track || {};
    const next = {
      ...e, sender: d.name || null,
      title: clean(t.title), artist: clean(t.artist), album: clean(t.album),
      duration: t.duration > 0 ? Math.round(t.duration / 1000) : null,
      state: d.player.status === 'playing' ? 'playing' : d.player.status === 'paused' ? 'paused' : 'stopped',
    };
    if (next.title !== e.title || next.artist !== e.artist) next.since = Date.now();
    if (JSON.stringify(next) !== JSON.stringify(e)) { this.entries.bluetooth = next; this._changed(); }
  }

  // ------------------------------------------------------------------ status

  cover(source) { return this.covers[source] || null; }

  status() {
    const list = SOURCES.map((s) => this.entries[s]);
    // the source to show first: playing, most recently started
    const current = list.filter((e) => e.state === 'playing').sort((a, b) => (b.since || 0) - (a.since || 0))[0]
      || list.filter((e) => e.state === 'paused').sort((a, b) => (b.since || 0) - (a.since || 0))[0] || null;
    return { current: current ? current.source : null, sources: Object.fromEntries(list.map((e) => [e.source, { ...e }])) };
  }

  _changed() {
    const s = this.status();
    const j = JSON.stringify(s);
    if (j === this.lastJson) return;
    this.lastJson = j;
    this.emit('change', s);
  }
}

module.exports = { NowPlaying, PIPE_NAME };
