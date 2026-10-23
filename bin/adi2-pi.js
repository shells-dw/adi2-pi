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

// Bluetooth (BlueZ via lib/bt-helper.py) and audio routing (the adi2-pi-audio service's PipeWire)
// and the streaming receivers (lib/receivers.js), which play into that PipeWire too
let bt = null;
let audio = null;
let receivers = null;
const audioRuntime = process.env.ADI2PI_AUDIO_RUNTIME || '/run/adi2-pi-audio';
if (args.mock) {
  bt = new MockBluetooth({ alias: settings.get().name });
  audio = new MockAudio({ bt, getSettings: () => settings.get() });
  receivers = new MockReceivers({ getSettings: () => settings.get(), updateSettings: (p) => settings.update(p) });
} else if (!args.noAudio) {
  bt = new Bluetooth({ log, alias: settings.get().name });
  audio = new Audio({ log, dev, getSettings: () => settings.get(), env: { XDG_RUNTIME_DIR: audioRuntime } });
  if (!args.noStreaming) receivers = new Receivers({ log, getSettings: () => settings.get(), updateSettings: (p) => settings.update(p), audioStatus: () => audio.status(), runtime: audioRuntime, dataDir });
}

// while the Pi plays, the ADI-2's outputs switch to USB (and back afterwards)
const autoSource = audio ? new AutoSource({ dev, audio, settings, log }) : null;
// shut down with the ADI-2 (Trigger Out wired to GPIO3); simulated with --mock
const trigger = args.mock
  ? new Trigger({ getSettings: () => settings.get(), log, model: 'Raspberry Pi 4 Model B (simulated)', powerOff: async () => log.info('trigger: (simulated) poweroff'),
    run: async (cmd) => (cmd === 'gpiodetect' ? { code: 0, out: 'gpiochip0 [pinctrl-bcm2711] (58 lines)\n' } : cmd === 'gpioget' ? { code: 0, out: 'gpioget (libgpiod) v1.6.3\n0\n' } : { code: 1, out: '' }) })
  : new Trigger({ getSettings: () => settings.get(), log });
settings.on('change', () => trigger.apply());
const { server, wss } = createServer({ dev, settings, version, log, allowOrigins: args.allowOrigins, dataDir, bt, audio, receivers, autoSource, trigger });

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

function shutdown() {
  settings.flush();
  if (bt) bt.stop();
  if (audio) audio.stop();
  if (receivers) receivers.stop();
  if (autoSource) autoSource.stop();
  trigger.stop();
  wss.close();
  dev.stop();
  server.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
