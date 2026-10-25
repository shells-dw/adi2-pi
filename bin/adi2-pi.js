#!/usr/bin/env node
'use strict';
/**
 * ADI-2-Pi – network remote for RME ADI-2 series converters on a Raspberry Pi.
 *
 *   adi2-pi [--port 80] [--data /var/lib/adi2-pi] [--device /dev/snd/midiC1D0]
 *               [--mock pro|se|dac] [--host ::] [--allow-origin https://example] [--no-audio] [--no-streaming] [--verbose]
 */
const path = require('path');
const { Settings } = require('../lib/settings');
const { Adi2 } = require('../lib/device');
const { createServer } = require('../lib/server');
const { AlsaMidiTransport } = require('../lib/transport-alsa');
const { MockAdi } = require('../lib/mock-adi');
const { Bluetooth } = require('../lib/bluetooth');
const { Audio } = require('../lib/audio');
const { MockBluetooth, MockAudio, MockReceivers } = require('../lib/bt-mock');
const { Receivers } = require('../lib/receivers');
const { AutoSource } = require('../lib/autosource');
const { Trigger } = require('../lib/trigger');
const { Automation } = require('../lib/automation');
const { StreamVolume } = require('../lib/streamvol');
const { Restore } = require('../lib/backup');
const { MqttBridge } = require('../lib/mqtt-bridge');
const { Ups } = require('../lib/ups');
const { Updates } = require('../lib/updates');
const { NowPlaying } = require('../lib/nowplaying');
const { version } = require('../package.json');

function parseArgs(argv) {
  const a = { allowOrigins: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case '--port': a.port = Number(next()); break;
      case '--data': a.data = next(); break;
      case '--device': a.device = next(); break;
      case '--host': a.host = next(); break;
      case '--mock': a.mock = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : 'pro'; break;
      case '--allow-origin': a.allowOrigins.push(next()); break;
      case '--verbose': a.verbose = true; break;
      case '--no-audio': a.noAudio = true; break;
      case '--no-streaming': a.noStreaming = true; break;
      case '--version': console.log(version); process.exit(0); break;
      case '-h': case '--help':
        console.log('usage: adi2-pi [--port N] [--data DIR] [--device PATH] [--mock pro|se|dac] [--host ADDR] [--allow-origin URL] [--no-audio] [--no-streaming] [--verbose]');
        process.exit(0); break;
      default:
        console.error(`unknown option ${k}`);
        process.exit(2);
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
// systemd adds timestamps; keep lines short and only log what matters
const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  debug: args.verbose ? (m) => console.log(m) : () => {},
};

const dataDir = args.data ?? (args.mock ? null : '/var/lib/adi2-pi');
const settings = new Settings(dataDir ? path.join(dataDir, 'settings.json') : null, log);
const port = args.port ?? settings.get().port ?? 80;

const transport = args.mock
  ? new MockAdi({ model: args.mock, log })
  : new AlsaMidiTransport({ device: args.device, log });
const dev = new Adi2({ transport, settings: settings.get(), log });
settings.on('change', (s) => { dev.settings = s; });

// the receivers' volume hook posts to this bridge on the Pi itself
const hookHost = args.host && !['::', '0.0.0.0'].includes(args.host) ? (args.host.includes(':') ? `[${args.host}]` : args.host) : '127.0.0.1';
const HOOK_PROGRAM = path.join(__dirname, 'adi2-pi-hook.js');
let streamVolume = null;

// Bluetooth (BlueZ via lib/bt-helper.py) and audio routing (the adi2-pi-audio service's PipeWire)
// and the streaming receivers (lib/receivers.js), which play into that PipeWire too
let bt = null;
let audio = null;
let receivers = null;
let nowPlaying = null;
const audioRuntime = process.env.ADI2PI_AUDIO_RUNTIME || '/run/adi2-pi-audio';
if (args.mock) {
  bt = new MockBluetooth({ alias: settings.get().name });
  audio = new MockAudio({ bt, getSettings: () => settings.get() });
  receivers = new MockReceivers({ getSettings: () => settings.get(), updateSettings: (p) => settings.update(p) });
  nowPlaying = new NowPlaying({ bt, log });
  // something to show on the Pi Playback tab
  nowPlaying.handleHook({ receiver: 'spotify', event: 'track_changed', name: 'Simulated Song', artists: 'The Mock Band', album: 'Test Signals', durationMs: 214000 });
  nowPlaying.handleHook({ receiver: 'spotify', event: 'playing', positionMs: 42000 });
} else if (!args.noAudio) {
  bt = new Bluetooth({ log, alias: settings.get().name });
  audio = new Audio({ log, dev, getSettings: () => settings.get(), env: { XDG_RUNTIME_DIR: audioRuntime } });
  nowPlaying = new NowPlaying({ dataDir: args.noStreaming ? null : dataDir, bt, log });
  if (!args.noStreaming) {
    receivers = new Receivers({
      log, getSettings: () => settings.get(), updateSettings: (p) => settings.update(p), audioStatus: () => audio.status(), runtime: audioRuntime, dataDir,
      env: { ADI2PI_HOOK_URL: `http://${hookHost}:${port}/api/hook` },
      hook: HOOK_PROGRAM, hookVolume: (id) => !!(streamVolume && streamVolume.active(id)), metadataPipe: nowPlaying.pipePath,
    });
  }
}
if (receivers) {
  streamVolume = new StreamVolume({ dev, settings, log, receiverSince: (id) => (receivers.since ? receivers.since(id) : null) });
  // switching the sender volume on or off changes the receivers' command lines: restart them
  let svLast = JSON.stringify([settings.get().streamVolume.enabled, settings.get().streamVolume.airplay, settings.get().streamVolume.spotify]);
  settings.on('change', (s) => {
    const now = JSON.stringify([s.streamVolume.enabled, s.streamVolume.airplay, s.streamVolume.spotify]);
    if (now !== svLast) { svLast = now; receivers.apply(); }
  });
}
const automation = new Automation({ dev, settings, bt, audio, log });
const restore = new Restore({ dev, settings, log });
// Waveshare UPS HAT on I²C (if there is one); simulated with --mock
const ups = args.mock
  ? new Ups({ getSettings: () => settings.get(), log, devPath: __filename, powerOff: async () => log.info('ups: (simulated) poweroff'), run: mockUpsRun() })
  : new Ups({ getSettings: () => settings.get(), log });
// update check (off by default): GitHub's latest release, notification only
const updates = new Updates({ settings, version, log });
const mqtt = new MqttBridge({ dev, settings, log, automation, version, ups, updates, nowPlaying });

// while the Pi plays, the ADI-2's outputs switch to USB (and back afterwards)
const autoSource = audio ? new AutoSource({ dev, audio, settings, log }) : null;
// shut down with the ADI-2 (USB connection, or Trigger Out wired to GPIO3); GPIO and poweroff simulated with --mock
const trigger = args.mock
  ? new Trigger({ getSettings: () => settings.get(), getDevice: () => dev.info(), log, model: 'Raspberry Pi 4 Model B (simulated)', powerOff: async () => log.info('trigger: (simulated) poweroff'),
    run: async (cmd) => (cmd === 'gpiodetect' ? { code: 0, out: 'gpiochip0 [pinctrl-bcm2711] (58 lines)\n' } : cmd === 'gpioget' ? { code: 0, out: 'gpioget (libgpiod) v1.6.3\n0\n' } : { code: 1, out: '' }) })
  : new Trigger({ getSettings: () => settings.get(), getDevice: () => dev.info(), log });
settings.on('change', () => trigger.apply());
const { server, wss } = createServer({ dev, settings, version, log, allowOrigins: args.allowOrigins, dataDir, bt, audio, receivers, autoSource, trigger, automation, streamVolume, restore, mqtt, ups, updates, nowPlaying });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log.warn(`port ${port} is already in use – set another one with --port or in settings.json`);
  else if (e.code === 'EACCES') log.warn(`no permission for port ${port} (ports below 1024 need CAP_NET_BIND_SERVICE)`);
  else log.warn(`http: ${e.message}`);
  process.exit(1);
});

// no host = all addresses, IPv6 when the system has it, else IPv4
server.listen(port, args.host, () => {
  log.info(`adi2-pi ${version} on port ${port}${args.mock ? ` (simulated ADI-2 ${args.mock})` : ''}`);
  dev.start();
  if (bt) bt.start();
  if (audio) audio.start();
  if (receivers) receivers.start();
  if (autoSource) autoSource.start();
  trigger.start();
  automation.start();
  ups.start();
  updates.start();
  if (nowPlaying) nowPlaying.start();
  mqtt.start();
});

if (args.mock) {
  // kill -USR2 <pid>: switch the simulated unit's MIDI Control off / on
  process.on('SIGUSR2', () => { transport.setMidiControl(!transport.midiControl); log.info(`mock: MIDI Control ${transport.midiControl ? 'ON' : 'OFF'}`); });
  // so the page shows something moving: "turn the knob" on the simulated unit now and then
  setInterval(() => {
    const v = transport.get(9, 12);
    if (v !== undefined && transport.active) transport.frontPanel(9, 12, v + (Math.random() < 0.5 ? -5 : 5));
  }, 20000).unref();
}

/** Simulated UPS HAT (E) for --mock: mains on, 83 %, charging. kill -USR1 <pid> pulls the plug / plugs it in. */
function mockUpsRun() {
  let mains = true;
  process.on('SIGUSR1', () => { mains = !mains; log.info(`mock: UPS ${mains ? 'on mains' : 'on battery'}`); });
  const w = (v) => [v & 0xff, (v >> 8) & 0xff];
  return async (cmd, a) => {
    if (cmd !== 'i2ctransfer') return { code: 1, out: '', err: '' };
    if (a[0] === '-V') return { code: 0, out: 'i2ctransfer version 4.3\n', err: '' };
    const addr = parseInt(a[2].split('@')[1], 16), reg = parseInt(a[3], 16), n = Number(a[4].slice(1));
    if (addr !== 0x2d) return { code: 1, out: '', err: 'Error: Sending messages failed: Remote I/O error' };
    const regs = new Array(0x30).fill(0);
    regs[0] = 0x0a;
    regs[2] = mains ? 0xa2 : 0x00;
    [regs[0x10], regs[0x11]] = w(mains ? 5120 : 0); [regs[0x14], regs[0x15]] = w(mains ? 6800 : 0);
    [regs[0x20], regs[0x21]] = w(15880); [regs[0x22], regs[0x23]] = w(mains ? 420 : 0x10000 - 610);
    [regs[0x24], regs[0x25]] = w(83); [regs[0x26], regs[0x27]] = w(4150); [regs[0x28], regs[0x29]] = w(mains ? 0 : 214); [regs[0x2a], regs[0x2b]] = w(mains ? 38 : 0);
    return { code: 0, out: regs.slice(reg, reg + n).map((x) => `0x${x.toString(16).padStart(2, '0')}`).join(' ') + '\n', err: '' };
  };
}

function shutdown() {
  settings.flush();
  if (bt) bt.stop();
  if (audio) audio.stop();
  if (receivers) receivers.stop();
  if (autoSource) autoSource.stop();
  trigger.stop();
  automation.stop();
  ups.stop();
  updates.stop();
  if (nowPlaying) nowPlaying.stop();
  mqtt.stop();
  wss.close();
  dev.stop();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
