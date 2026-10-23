'use strict';
/**
 * Streaming receivers against a real private PipeWire (+ its PulseAudio server):
 * UPnP (gmediarender) is told over UPnP to play a WAV, Snapcast plays from a local snapserver,
 * and both end up as streams linked to the ADI-2 stand-in.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { Audio } = require('../lib/audio');
const { Receivers, DEFS } = require('../lib/receivers');
const { Settings } = require('../lib/settings');

const quiet = process.env.RXDEBUG ? { info: (m) => console.log('I', m), warn: (m) => console.log('W', m), debug() {} } : { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, what = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(100); }
  throw new Error(`timed out ${what || fn.toString().slice(0, 120)}`);
}
const has = (c) => spawnSync('sh', ['-c', `command -v ${c}`], { stdio: 'ignore' }).status === 0;
const canRun = ['pipewire', 'wireplumber', 'pipewire-pulse', 'pw-dump', 'gmediarender', 'snapclient', 'snapserver', 'dbus-run-session'].every(has);
const FIXTURE = path.join(__dirname, 'pw-fixture.sh');

/** 2 s of a 1 kHz tone as WAV (16 bit, 44.1 kHz, stereo). */
function wav() {
  const rate = 44100, n = rate * 2;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * 1000 * i / rate) * 8000); b.writeInt16LE(v, 44 + i * 4); b.writeInt16LE(v, 46 + i * 4); }
  return b;
}

// libupnp listens on the first network interface, not on localhost
const HOST = (Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal) || {}).address || '127.0.0.1';

/** UPnP control request; gmediarender may drop a connection while busy, so retry a few times. */
async function soap(port, action, body) {
  for (let i = 0; ; i++) {
    try { return await soapOnce(port, action, body); } catch (e) { if (i >= 4) throw e; await sleep(300); }
  }
}

function soapOnce(port, action, body) {
  const xml = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID>${body}</u:${action}></s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port, path: '/upnp/control/rendertransport1', method: 'POST', agent: false, headers: { Connection: 'close', 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`, 'Content-Length': Buffer.byteLength(xml) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end(xml);
  });
}

test('UPnP and Snapcast receivers play into the ADI-2 through the audio service', { skip: !canRun && 'PipeWire / receivers not installed' }, async () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2pi-rx-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2pi-home-'));
  const env = { ...process.env, XDG_RUNTIME_DIR: rt };
  const fx = spawn(FIXTURE, [rt], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  await new Promise((r) => fx.stdout.on('data', (d) => { if (/ready/.test(String(d))) r(); }));
  const others = [];
  const settings = new Settings(null, quiet);
  settings.update({ name: 'ADI-2-Pi Test', receivers: { airplay: { enabled: false }, spotify: { enabled: false }, upnp: { enabled: true }, snapcast: { enabled: true, server: '127.0.0.1' } } });
  const audio = new Audio({ log: quiet, getSettings: () => settings.get(), env: { XDG_RUNTIME_DIR: rt }, pollMs: 300 });
  const UPNP_PORT = 50000 + Math.floor(Math.random() * 5000); // gmediarender accepts 49152–65535
  const defs = { upnp: { ...DEFS.upnp, args: (o) => [...DEFS.upnp.args(o), '-p', String(UPNP_PORT)] }, snapcast: DEFS.snapcast };
  const rx = new Receivers({ log: quiet, getSettings: () => settings.get(), updateSettings: (p) => settings.update(p), audioStatus: () => audio.status(), runtime: rt, dataDir: home, defs, roonCheck: async () => ({ installed: false, active: false }) });
  // a WAV over HTTP for the UPnP renderer
  const file = wav();
  const web = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': file.length }); r.end(file); });
  await new Promise((r) => web.listen(0, '0.0.0.0', r));
  try {
    audio.start();
    await until(() => audio.status().available && audio.status().adi && audio.status().adi.sink);
    // snapserver with a pipe source we feed with silence-free noise
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2pi-snap-'));
    const fifo = path.join(sdir, 'fifo');
    spawnSync('mkfifo', [fifo]);
    const port = 17000 + Math.floor(Math.random() * 500);
    const srv = spawn('snapserver', ['--server.datadir', sdir, '--stream.source', `pipe://${fifo}?name=test&sampleformat=48000:16:2`, '--stream.port', String(port), '--tcp.enabled', 'false', '--http.enabled', 'false'], { stdio: 'ignore' });
    others.push(srv);
    settings.update({ receivers: { snapcast: { server: `127.0.0.1` } } });
    // snapclient needs the stream port: pass it through the definition
    defs.snapcast = { ...DEFS.snapcast, args: (o) => [...DEFS.snapcast.args(o), '-p', String(port)] };
    await sleep(500);
    const feeder = fs.createWriteStream(fifo);
    feeder.on('error', () => {}); // the reader (snapserver) goes away at the end
    let feeding = true;
    (async () => { const chunk = Buffer.alloc(19200); for (let i = 0; i < chunk.length; i += 2) chunk.writeInt16LE(Math.round(Math.sin(i / 20) * 6000), i); while (feeding) { if (!feeder.write(chunk)) await new Promise((r) => feeder.once('drain', r)); await sleep(90); } })().catch(() => {});

    rx.start();
    // the ALSA device for ALSA-only receivers was written to the service user's HOME
    assert.match(fs.readFileSync(path.join(home, '.asoundrc'), 'utf8'), /pcm\.adi2pi \{ type pulse server "unix:.*\/pulse\/native" \}/);
    // a UUID was generated for UPnP and kept
    assert.match(settings.get().receivers.upnp.uuid, /^[0-9a-f-]{36}$/);
    await until(() => rx.status().receivers.filter((r) => r.running).length === 2);

    // Snapcast plays into the ADI-2
    await until(() => (audio.status().streams || []).some((s) => /snapclient/i.test(`${s.binary} ${s.app}`) && s.state === 'running' && s.toAdi), 20000);
    await until(() => rx.status().receivers.find((r) => r.id === 'snapcast').playing);

    // UPnP: a controller sends a URL and presses play
    await until(async () => { try { return (await soap(UPNP_PORT, 'Stop', '')).status === 200; } catch { return false; } });
    const url = `http://${HOST}:${web.address().port}/tone.wav`;
    const r1 = await soap(UPNP_PORT, 'SetAVTransportURI', `<CurrentURI>${url}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`);
    assert.strictEqual(r1.status, 200, r1.body);
    assert.strictEqual((await soap(UPNP_PORT, 'Play', '<Speed>1</Speed>')).status, 200);
    await until(() => (audio.status().streams || []).some((s) => /gmediarender|gst/i.test(`${s.binary} ${s.app}`) && s.state === 'running' && s.toAdi), 20000);
    const up = rx.status().receivers.find((r) => r.id === 'upnp');
    assert.ok(up.running);

    // switching a receiver off stops it
    rx.set('snapcast', { enabled: false });
    await until(() => !rx.status().receivers.find((r) => r.id === 'snapcast').running);
    assert.strictEqual(settings.get().receivers.snapcast.enabled, false);
    // and bad input is refused
    assert.throws(() => rx.set('snapcast', { server: 'bad host;rm' }), /host name/);
    assert.throws(() => rx.set('roon', { enabled: false }), /installer option/);
    feeding = false;
    feeder.destroy();
  } finally {
    rx.stop();
    audio.stop();
    web.close();
    for (const p of others) try { p.kill(); } catch { /* gone */ }
    try { process.kill(-fx.pid, 'SIGTERM'); } catch { /* gone */ }
    spawnSync('pkill', ['-f', rt]);
  }
});

test('a receiver that crashes is restarted, with the reason in its status', async () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2pi-rx2-'));
  fs.mkdirSync(path.join(rt, 'pulse'));
  fs.writeFileSync(path.join(rt, 'pulse', 'native'), ''); // "audio service is up"
  const settings = new Settings(null, quiet);
  settings.update({ receivers: { squeezelite: { enabled: true } } });
  const defs = { squeezelite: { ...DEFS.squeezelite, find: () => '/bin/sh', probe: async () => ({}), args: () => ['-c', 'echo "cannot open output device" >&2; exit 3'] } };
  const rx = new Receivers({ log: quiet, getSettings: () => settings.get(), updateSettings: (p) => settings.update(p), runtime: rt, defs, roonCheck: async () => ({ installed: false, active: false }) });
  try {
    rx.start();
    await until(() => (rx.status().receivers[0].error || '').includes('cannot open output device'), 5000);
    assert.ok(rx.procs.squeezelite.restarts >= 1);
    // not installed → refused with a hint
    const rx2 = new Receivers({ log: quiet, getSettings: () => settings.get(), updateSettings: (p) => settings.update(p), runtime: rt, defs: { spotify: { ...DEFS.spotify, find: () => null } }, roonCheck: async () => ({ installed: false, active: false }) });
    assert.throws(() => rx2.set('spotify', { enabled: true }), /--with-spotify/);
    assert.strictEqual(rx2.status().receivers[0].installed, false);
  } finally { rx.stop(); }
});
