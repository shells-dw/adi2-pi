'use strict';
/**
 * Streaming receivers (AirPlay, Spotify Connect, UPnP/DLNA, Squeezelite, Snapcast), run by the
 * bridge as child processes under its own user. They play into ADI-2-Pi's PipeWire through its
 * PulseAudio socket (or the ALSA device "adi2pi", which goes to the same place), so they reach the
 * ADI-2 like Bluetooth does. The packages' own system services are masked by the installer.
 *
 * Roon Bridge runs as Roon's own service (installer option --with-roon); it is only reported here.
 *
 * Events: 'status' ([receiver status])
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const ALSA_DEVICE = 'adi2pi';
const RUN_MS = 60000;       // running this long = healthy, reset the restart delay
const MAX_LOG = 30;

/** Find an executable: absolute paths first, then PATH. */
function which(cands) {
  for (const c of cands) {
    if (c.includes('/')) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { continue; } }
    for (const dir of (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')) {
      const p = path.join(dir, c);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
    }
  }
  return null;
}

function probe(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`));
  });
}

/** Is a GStreamer plugin installed? */
function gstPlugin(file) {
  const dirs = ['/usr/lib/gstreamer-1.0', '/usr/local/lib/gstreamer-1.0'];
  try { for (const d of fs.readdirSync('/usr/lib')) dirs.push(path.join('/usr/lib', d, 'gstreamer-1.0')); } catch { /* none */ }
  return dirs.some((d) => fs.existsSync(path.join(d, file)));
}

const okHost = (h) => /^[A-Za-z0-9.:\-[\]]{1,253}$/.test(h);

/**
 * Receiver definitions. args() gets { name, cfg, out, dataDir, info } and returns the command line;
 * `info` holds what probe() found out about the installed version.
 */
const DEFS = {
  airplay: {
    label: 'AirPlay',
    about: 'iPhone, iPad, Mac, Apple TV and AirPlay apps',
    binaries: ['shairport-sync'],
    find: () => which(['/usr/local/bin/shairport-sync', 'shairport-sync']),
    async probe(bin) {
      // options and backend names differ between versions (3.3 in Bookworm, 4.x in Trixie, 5.x
      // from GitHub): take them from the program's own help text
      const v = await probe(bin, ['-V']);
      const help = await probe(bin, ['-h']);
      const listed = (n) => new RegExp(`^\\s+${n}\\s*$`, 'm').test(help) || help.includes(`backend "${n}"`);
      const backend = ['pa', 'pulseaudio', 'pw', 'pipewire'].find(listed) || null;
      return { version: v.trim().split('\n')[0], airplay2: /AirPlay2/i.test(v), backend, stderr: /--use-stderr/.test(help) };
    },
    args({ name, info, dataDir, hook, hookVolume, metadataPipe }) {
      // an own config file: the package's /etc/shairport-sync.conf stays untouched. With the
      // volume hook, the stream plays at full level and volume changes go to ADI-2-Pi. Titles
      // and cover art go to the metadata pipe (lib/nowplaying.js).
      const conf = path.join(dataDir || os.tmpdir(), hookVolume ? 'shairport-sync-hook.conf' : 'shairport-sync.conf');
      const body = '// written by ADI-2-Pi\n'
        + (hookVolume ? `general = {\n  ignore_volume_control = "yes";\n  run_this_when_volume_is_set = "${hook} airplay ";\n};\n` : '')
        + (metadataPipe ? `metadata = {\n  enabled = "yes";\n  include_cover_art = "yes";\n  pipe_name = "${metadataPipe}";\n};\n` : '');
      try { if (!fs.existsSync(conf) || fs.readFileSync(conf, 'utf8') !== body) fs.writeFileSync(conf, body); } catch { /* read-only: fine */ }
      // 3.3 logs to syslog unless -u; newer versions log to stderr and don't know -u
      const a = ['-c', conf, ...(info.stderr ? ['-u'] : []), '-a', name];
      return info.backend ? [...a, '-o', info.backend] : [...a, '-o', 'alsa', '--', '-d', ALSA_DEVICE];
    },
  },
  spotify: {
    label: 'Spotify Connect',
    about: 'Spotify app on phones, computers and speakers',
    binaries: ['librespot'],
    find: () => which(['librespot']),
    async probe(bin) {
      const v = await probe(bin, ['--backend', '?']);
      const help = await probe(bin, ['--help']);
      // "--volume-ctrl fixed": volume changes are reported but not applied to the audio
      return { pulse: /pulseaudio/i.test(v), fixedVolume: /volume-ctrl/.test(help) && /\bfixed\b/.test(help), onevent: /onevent/.test(help) };
    },
    hookSupported: (info) => !!(info && info.fixedVolume && info.onevent),
    args({ name, info, dataDir, hook, hookVolume }) {
      const cache = path.join(dataDir || os.tmpdir(), 'spotify');
      try { fs.mkdirSync(cache, { recursive: true }); } catch { /* fine */ }
      const out = info.pulse ? ['--backend', 'pulseaudio'] : ['--backend', 'alsa', '--device', ALSA_DEVICE];
      // --onevent: track events (and volume changes) go to ADI-2-Pi; --volume-ctrl fixed only with the volume hook
      const vol = [...(hook && info.onevent ? ['--onevent', hook] : []), ...(hookVolume && info.fixedVolume && info.onevent ? ['--volume-ctrl', 'fixed'] : [])];
      return ['--name', name, '--device-type', 'avr', '--bitrate', '320', '--initial-volume', '100',
        '--cache', cache, '--disable-audio-cache', ...vol, ...out];
    },
  },
  upnp: {
    label: 'UPnP / DLNA',
    about: 'BubbleUPnP, foobar2000, Linn Kazoo, NAS media servers',
    binaries: ['gmediarender'],
    find: () => which(['gmediarender']),
    async probe() {
      // GStreamer's PulseAudio sink (package gstreamer1.0-pulseaudio)
      return { pulse: gstPlugin('libgstpulseaudio.so') };
    },
    args({ name, cfg, info }) {
      const out = info.pulse ? ['--gstout-audiosink', 'pulsesink'] : ['--gstout-audiosink', 'alsasink', '--gstout-audiodevice', ALSA_DEVICE];
      return ['-f', name, '-u', cfg.uuid, '--mime-filter', 'audio', '--gstout-initial-volume-db', '0', ...out];
    },
  },
  squeezelite: {
    label: 'Squeezelite',
    about: 'Lyrion Music Server (Logitech Media Server)',
    binaries: ['squeezelite'],
    server: true,
    find: () => which(['squeezelite']),
    async probe() { return {}; },
    args({ name, cfg }) {
      // -C 5: let go of the output after 5 s of silence, so other sources and the sample rate can change
      return ['-n', name, '-M', 'ADI-2-Pi', '-o', ALSA_DEVICE, '-C', '5', ...(cfg.server ? ['-s', cfg.server] : [])];
    },
  },
  snapcast: {
    label: 'Snapcast',
    about: 'synchronised multi-room playback from a Snapcast server',
    binaries: ['snapclient'],
    server: true,
    find: () => which(['snapclient']),
    async probe(bin) {
      const v = await probe(bin, ['--help']);
      return { pulse: /\bpulse\b/.test(v) };
    },
    args({ cfg, info }) {
      const out = info.pulse ? ['--player', 'pulse'] : ['--player', 'alsa', '--soundcard', ALSA_DEVICE];
      return ['--hostID', `adi2-pi-${os.hostname()}`, '--logsink', 'stderr', ...out, ...(cfg.server ? ['-h', cfg.server] : [])];
    },
  },
};

const ROON_BINARIES = ['RoonBridge', 'RAATServer', 'RoonBridgeHelper', 'roonbridge'];

class Receivers extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.getSettings  bridge settings (name, receivers)
   * @param {(patch) => void} o.updateSettings  to store generated ids (UPnP UUID)
   * @param {() => object} [o.audioStatus]  Audio.status() – for "playing" and the sample rate
   * @param {string} o.runtime  the audio service's runtime dir (PulseAudio socket inside)
   * @param {string} [o.dataDir]  /var/lib/adi2-pi (HOME of the service user: .asoundrc, caches)
   * @param {object} [o.defs]  receiver definitions (tests)
   * @param {string} [o.hook]  the hook program (bin/adi2-pi-hook.js); hookVolume(id): does the sender's volume set the ADI-2's?
   * @param {string} [o.metadataPipe]  shairport-sync's metadata pipe (lib/nowplaying.js)
   */
  constructor({ log, getSettings, updateSettings, audioStatus = () => null, runtime, dataDir = null, defs = DEFS, env = {}, roonCheck, hook = null, hookVolume = () => false, metadataPipe = null }) {
    super();
    this.log = log || console;
    this.getSettings = getSettings;
    this.updateSettings = updateSettings;
    this.audioStatus = audioStatus;
    this.runtime = runtime;
    this.dataDir = dataDir;
    this.defs = defs;
    this.env = env;
    this.roonCheck = roonCheck || defaultRoonCheck;
    this.hook = hook;
    this.hookVolume = hookVolume;
    this.metadataPipe = metadataPipe;
    this.procs = {};   // id → { child, since, logs, restarts, timer, error, info, bin }
    this.stopped = false;
    this.waitTimer = null;
    this.roon = { installed: false, active: false };
    this.lastJson = '';
  }

  pulseSocket() { return path.join(this.runtime, 'pulse', 'native'); }

  /** ALSA device "adi2pi" for programs that only speak ALSA: the HOME of the service user. */
  writeAlsaConfig() {
    if (!this.dataDir) return;
    const f = path.join(this.dataDir, '.asoundrc');
    const body = `# written by ADI-2-Pi: "${ALSA_DEVICE}" plays into ADI-2-Pi's audio service (PipeWire)\n`
      + `pcm.${ALSA_DEVICE} { type pulse server "unix:${this.pulseSocket()}" }\n`
      + `ctl.${ALSA_DEVICE} { type pulse server "unix:${this.pulseSocket()}" }\n`;
    try {
      if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8') !== body) fs.writeFileSync(f, body);
    } catch (e) { this.log.warn(`receivers: cannot write ${f}: ${e.message}`); }
  }

  start() {
    this.stopped = false;
    this.writeAlsaConfig();
    this._ensureIds();
    this.apply();
    this._roonTimer = setInterval(() => this._checkRoon(), 15000);
    this._roonTimer.unref?.();
    this._checkRoon();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.waitTimer);
    clearInterval(this._roonTimer);
    for (const id of Object.keys(this.procs)) this._kill(id);
  }

  cfg(id) {
    const r = (this.getSettings().receivers || {})[id] || {};
    return { enabled: !!r.enabled, server: r.server || '', uuid: r.uuid || '' };
  }

  _ensureIds() {
    const r = this.getSettings().receivers || {};
    if (this.defs.upnp && !(r.upnp && r.upnp.uuid)) {
      try { this.updateSettings({ receivers: { upnp: { uuid: crypto.randomUUID() } } }); } catch (e) { this.log.warn(`receivers: ${e.message}`); }
    }
  }

  /** Start what's enabled, stop what isn't; restart those whose command line changed. */
  apply() {
    if (this.stopped) return;
    if (!fs.existsSync(this.pulseSocket())) {
      // the audio service isn't up (yet): try again shortly
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => this.apply(), 2000);
      this.waitTimer.unref?.();
      this._emit();
      return;
    }
    for (const id of Object.keys(this.defs)) {
      const c = this.cfg(id);
      if (c.enabled) this._start(id); else this._kill(id);
    }
    this._emit();
  }

  async _start(id) {
    const def = this.defs[id];
    let p = this.procs[id];
    if (!p) p = this.procs[id] = { child: null, logs: [], restarts: 0, timer: null, error: null, info: null, bin: null, argv: null, starting: false };
    if (p.starting) return;
    p.starting = true;
    try {
      const bin = def.find();
      p.bin = bin;
      if (!bin) { p.error = null; this._kill(id); return; }
      if (!p.info) p.info = await def.probe(bin);
      const argv = def.args({ name: this.getSettings().name || 'ADI-2-Pi', cfg: this.cfg(id), info: p.info, dataDir: this.dataDir, hook: this.hook, hookVolume: this.hookVolume(id), metadataPipe: this.metadataPipe });
      if (p.child && JSON.stringify(argv) === JSON.stringify(p.argv)) return; // running as wanted
      if (p.child) { this._kill(id, true); }
      p.argv = argv;
      this._spawn(id);
    } finally {
      p.starting = false;
      this._emit();
    }
  }

  _spawn(id) {
    const p = this.procs[id];
    if (!p || this.stopped || !this.cfg(id).enabled) return;
    clearTimeout(p.timer);
    const env = {
      ...process.env, ...this.env,
      PULSE_SERVER: `unix:${this.pulseSocket()}`,
      XDG_RUNTIME_DIR: this.runtime,
      ...(this.dataDir ? { HOME: this.dataDir } : {}),
    };
    let child;
    try {
      child = spawn(p.bin, p.argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      p.error = e.message;
      return;
    }
    p.child = child;
    p.since = Date.now();
    p.error = null;
    this.log.info(`receivers: ${id} started (${path.basename(p.bin)} ${p.argv.join(' ')})`);
    const onLine = (l) => {
      l = l.trim();
      if (!l) return;
      p.logs.push(l);
      if (p.logs.length > MAX_LOG) p.logs.shift();
      if (/error|fatal|fail|cannot|can't|unable/i.test(l)) this.log.warn(`${id}: ${l}`);
    };
    for (const s of [child.stdout, child.stderr]) {
      s.setEncoding('utf8');
      let buf = '';
      s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    }
    child.on('error', (e) => {
      // no 'exit' follows a failed spawn: forget the child and try again later
      p.error = e.message;
      if (p.child === child) { p.child = null; p.timer = setTimeout(() => this._spawn(id), 10000); p.timer.unref?.(); this._emit(); }
    });
    child.on('exit', (code, sig) => {
      if (p.child !== child) return;
      p.child = null;
      if (this.stopped || p.killing || !this.cfg(id).enabled) { p.killing = false; this._emit(); return; }
      const ran = Date.now() - (p.since || 0);
      if (ran > RUN_MS) p.restarts = 0;
      p.restarts++;
      const last = [...p.logs].reverse().find((l) => /error|fail|cannot|can't|unable/i.test(l)) || p.logs[p.logs.length - 1];
      p.error = `stopped (${sig || `exit ${code}`})${last ? `: ${last}` : ''}`;
      const delay = Math.min(60000, 2000 * 2 ** Math.min(p.restarts - 1, 5));
      this.log.warn(`receivers: ${id} ${p.error} – restarting in ${Math.round(delay / 1000)} s`);
      p.timer = setTimeout(() => this._spawn(id), delay);
      p.timer.unref?.();
      this._emit();
    });
  }

  _kill(id, restarting = false) {
    const p = this.procs[id];
    if (!p) return;
    clearTimeout(p.timer);
    if (p.child) {
      p.killing = !restarting;
      const c = p.child;
      p.child = null;
      try { c.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref?.();
      this.log.info(`receivers: ${id} stopped`);
    }
    if (!restarting) p.restarts = 0;
  }

  async _checkRoon() {
    const r = await this.roonCheck();
    if (r.installed !== this.roon.installed || r.active !== this.roon.active) { this.roon = r; this._emit(); }
  }

  /** Status for the page and the API. */
  status() {
    const a = this.audioStatus() || {};
    const streams = a.streams || [];
    const playingOf = (bins) => {
      const s = streams.filter((x) => bins.some((b) => (x.binary || '').toLowerCase().startsWith(b.toLowerCase()) || (x.app || '').toLowerCase().includes(b.toLowerCase())));
      const run = s.find((x) => x.state === 'running') || null;
      return { playing: !!run, rate: run ? run.rate : null };
    };
    const list = Object.entries(this.defs).map(([id, def]) => {
      const p = this.procs[id] || {};
      const c = this.cfg(id);
      const installed = p.bin !== undefined && p.bin !== null ? true : !!def.find();
      const pl = playingOf(def.binaries);
      return {
        id, label: def.label, about: def.about, installed, enabled: c.enabled,
        server: def.server ? c.server : undefined, hasServer: !!def.server,
        running: !!p.child, since: p.child ? p.since : null,
        playing: pl.playing, rate: pl.rate,
        error: c.enabled ? (p.error || null) : null,
        variant: id === 'airplay' && p.info ? (p.info.airplay2 ? 'AirPlay 2' : 'AirPlay (classic)') : null,
        // can the sender's volume set the ADI-2's? (null: not known before the first start)
        volumeHook: id === 'airplay' ? true : id === 'spotify' ? (p.info ? !!def.hookSupported(p.info) : null) : false,
      };
    });
    const rp = playingOf(ROON_BINARIES);
    list.push({ id: 'roon', label: 'Roon Bridge', about: 'Roon – choose “System Output” on this Pi in Roon', installed: this.roon.installed, enabled: this.roon.active, running: this.roon.active, external: true, playing: rp.playing, rate: rp.rate, error: null });
    return { audio: !!this.runtime && fs.existsSync(this.pulseSocket()), name: this.getSettings().name, receivers: list };
  }

  _emit() {
    const s = this.status();
    const j = JSON.stringify(s);
    if (j === this.lastJson) return;
    this.lastJson = j;
    this.emit('status', s);
  }

  /** Change one receiver: { enabled?, server? } */
  set(id, patch) {
    if (!this.defs[id]) throw Object.assign(new Error(id === 'roon' ? 'Roon Bridge is switched on and off by its installer option (--with-roon)' : `unknown receiver ${id}`), { status: 400 });
    const out = {};
    if (patch.enabled !== undefined) out.enabled = !!patch.enabled;
    if (patch.server !== undefined) {
      const s = String(patch.server || '').trim();
      if (s && !okHost(s)) throw Object.assign(new Error('server must be a host name or IP address'), { status: 400 });
      if (!this.defs[id].server) throw Object.assign(new Error(`${this.defs[id].label} has no server setting`), { status: 400 });
      out.server = s;
    }
    if (out.enabled && !this.defs[id].find()) {
      const hint = { spotify: ' – install with --with-spotify' }[id] || ' – run the installer again';
      throw Object.assign(new Error(`${this.defs[id].label} is not installed${hint}`), { status: 409 });
    }
    this.updateSettings({ receivers: { [id]: out } });
    this.apply();
    return this.status();
  }

  /** When the receiver process started (ms), for ignoring its start-up messages. */
  since(id) { const p = this.procs[id]; return p && p.child ? p.since : null; }

  /** Name changed: restart running receivers so they announce the new one. */
  rename() { for (const id of Object.keys(this.procs)) if (this.procs[id].child) this._start(id); }

  logs(id) { return (this.procs[id] && this.procs[id].logs) || []; }
}

function defaultRoonCheck() {
  return new Promise((resolve) => {
    const installed = fs.existsSync('/opt/RoonBridge');
    if (!installed) return resolve({ installed: false, active: false });
    execFile('systemctl', ['is-active', 'roonbridge'], { timeout: 4000 }, (err, stdout) => resolve({ installed, active: String(stdout).trim() === 'active' }));
  });
}

module.exports = { Receivers, DEFS, ALSA_DEVICE };
