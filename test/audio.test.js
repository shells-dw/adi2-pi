'use strict';
/** Audio routing against a real (private) PipeWire with stand-ins for the ADI-2 and Bluetooth nodes. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Audio } = require('../lib/audio');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(50); }
  throw new Error('timed out');
}
const has = (c) => spawnSync('sh', ['-c', `command -v ${c}`], { stdio: 'ignore' }).status === 0;
const canRun = ['pipewire', 'wireplumber', 'pw-dump', 'pw-link', 'pw-loopback', 'wpctl', 'dbus-run-session'].every(has);
const FIXTURE = path.join(__dirname, 'pw-fixture.sh');

/** The bits of the device model Audio uses for the Loopback setting. */
function fakeDev() {
  const vals = { '3.17': 0, '9.17': 2 }; // Phones 3/4 already feeds USB record (post FX 1/2)
  return {
    id: 0x72, ready: true, answering: true, vals, sets: [],
    get(addr, idx) { return vals[`${addr}.${idx}`]; },
    set(items) {
      for (const it of items) { vals[`${it.ch === 'line' ? 3 : 9}.17`] = it.value; this.sets.push(`${it.ch}=${it.value}`); }
      return { applied: {}, errors: [] };
    },
  };
}

test('routes Bluetooth in → ADI-2 and ADI-2 → Bluetooth out, keeps the ADI-2 default and at 100 %', { skip: !canRun && 'PipeWire tools missing' }, async () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2pi-pw-'));
  const env = { ...process.env, XDG_RUNTIME_DIR: rt };
  const fx = spawn(FIXTURE, [rt], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  await new Promise((r) => fx.stdout.on('data', (d) => { if (/ready/.test(String(d))) r(); }));
  const extra = [];
  const settings = { bluetooth: { outSource: 'line' } };
  const dev = fakeDev();
  const audio = new Audio({ log: quiet, dev, getSettings: () => settings, env: { XDG_RUNTIME_DIR: rt }, pollMs: 200 });
  const pw = (...a) => spawnSync(a[0], a.slice(1), { env, encoding: 'utf8' });
  const links = () => pw('pw-link', '-l').stdout;
  try {
    audio.start();
    await until(() => audio.status().available && audio.status().adi.sink);
    // the ADI-2 becomes the default output even though another sink has a higher priority
    await until(() => /Default Configured Audio Sink[\s\S]*ADI-2/i.test(pw('wpctl', 'inspect', '@DEFAULT_AUDIO_SINK@').stdout) || /RME_ADI-2/.test(pw('wpctl', 'inspect', '@DEFAULT_AUDIO_SINK@').stdout));
    // and its PipeWire volume is put back to 100 %
    pw('wpctl', 'set-volume', String(((audio.status().adi || {}).sink || {}).id), '0.4');
    await until(() => /Volume: 1\.00/.test(pw('wpctl', 'get-volume', String(((audio.status().adi || {}).sink || {}).id)).stdout));
    // the record side carries the Bluetooth level: +6 dB by default = linear 2 = wpctl 1.26
    await until(() => /Volume: 1\.26/.test(pw('wpctl', 'get-volume', String(((audio.status().adi || {}).source || {}).id)).stdout));
    settings.bluetooth.gainDb = 12;
    audio.refresh();
    await until(() => /Volume: 1\.58/.test(pw('wpctl', 'get-volume', String(((audio.status().adi || {}).source || {}).id)).stdout));

    // a phone streams to the Pi → linked to the ADI-2's playback, channel by channel
    const phone = spawn(FIXTURE, ['--source', 'bluez_input.AA_AA_AA_AA_AA_02.2', 'device.api=bluez5 api.bluez5.address=\"AA:AA:AA:AA:AA:02\" api.bluez5.codec=sbc'], { env, stdio: 'ignore' });
    extra.push(phone);
    await until(() => audio.status().inputs.length === 1 && audio.status().inputs[0].linked);
    const inp = audio.status().inputs[0];
    assert.strictEqual(inp.address, 'AA:AA:AA:AA:AA:02');
    assert.strictEqual(inp.codec, 'sbc');
    assert.match(links(), /bluez_input\.AA_AA_AA_AA_AA_02\.2:capture_FL\n\s+\|->\s+alsa_output\.usb-RME_ADI-2_Pro_12345-00\.analog-stereo:playback_FL/);
    assert.match(links(), /bluez_input\.AA_AA_AA_AA_AA_02\.2:capture_FR\n\s+\|->\s+alsa_output\.usb-RME_ADI-2_Pro_12345-00\.analog-stereo:playback_FR/);
    assert.ok(!/bluez_input[^\n]*\n\s+\|->\s+alsa_output\.platform-hdmi/.test(links()), 'nothing to HDMI');

    // headphones connect → ADI-2 record → headphones; Loopback set for Line Out (post FX, −6 dB), Phones 3/4 freed
    spawnSync(FIXTURE, ['--node', 'bluez_output.00_11_22_33_44_55.1', 'Audio/Sink', 'device.api=bluez5 api.bluez5.address=\"00:11:22:33:44:55\" api.bluez5.codec=ldac'], { env });
    await until(() => audio.status().outputs.length === 1 && audio.status().outputs[0].linked);
    assert.strictEqual(audio.status().outputs[0].codec, 'ldac');
    assert.match(links(), /alsa_input\.usb-RME_ADI-2_Pro_12345-00\.analog-stereo:capture_FL\n\s+\|->\s+bluez_output\.00_11_22_33_44_55\.1:playback_FL/);
    await until(() => dev.vals['3.17'] === 3 && dev.vals['9.17'] === 0);
    assert.ok(!/bluez_input[^\n]*\n\s+\|->\s+bluez_output/.test(links()), 'the phone does not go straight to the headphones');
    // …and if something links it there anyway (WirePlumber, another client), that link goes
    pw('pw-link', 'bluez_input.AA_AA_AA_AA_AA_02.2:capture_FL', 'bluez_output.00_11_22_33_44_55.1:playback_FL');
    pw('pw-link', 'bluez_input.AA_AA_AA_AA_AA_02.2:capture_FL', 'alsa_output.platform-hdmi.stereo:playback_FL');
    await until(() => !/bluez_input\.AA_AA_AA_AA_AA_02\.2:capture_FL\n(\s+\|->[^\n]*\n)*\s+\|->\s+(bluez_output|alsa_output\.platform-hdmi)/.test(links()));
    assert.match(links(), /bluez_input\.AA_AA_AA_AA_AA_02\.2:capture_FL\n\s+\|->\s+alsa_output\.usb-RME_ADI-2/, 'the ADI-2 link stays');

    // volume of the headphones
    await audio.setVolume('00:11:22:33:44:55', 0.5);
    await until(() => Math.abs((audio.status().outputs[0].volume || 0) - 0.5) < 0.02);

    // source "Phones 3/4": Loopback moves
    settings.bluetooth.outSource = 'ph34';
    audio.refresh();
    await until(() => dev.vals['9.17'] === 3 && dev.vals['3.17'] === 0);
    // source "off": the link goes, and the Loopback setting is put back as it was
    settings.bluetooth.outSource = 'off';
    audio.refresh();
    await until(() => !/alsa_input\.usb-RME_ADI-2[^\n]*\n\s+\|->\s+bluez_output/.test(links()));
    await until(() => dev.vals['3.17'] === 0 && dev.vals['9.17'] === 2);
    assert.strictEqual(audio.status().outputs[0].linked, false);

    // back on, then the headphones disconnect: Loopback restored again
    settings.bluetooth.outSource = 'line';
    audio.refresh();
    await until(() => dev.vals['3.17'] === 3);
    const id = audio.status().outputs[0].id;
    pw('pw-cli', 'destroy', String(id));
    await until(() => audio.status().outputs.length === 0);
    await until(() => dev.vals['3.17'] === 0 && dev.vals['9.17'] === 2);

    // the phone stops
    phone.kill();
    await until(() => audio.status().inputs.length === 0);
  } finally {
    audio.stop();
    for (const p of extra) try { p.kill(); } catch { /* gone */ }
    try { process.kill(-fx.pid, 'SIGTERM'); } catch { /* gone */ }
    spawnSync('pkill', ['-f', rt]);
  }
});

test('reports a missing audio service in plain words', async () => {
  const audio = new Audio({ log: quiet, getSettings: () => ({}), run: async () => ({ ok: false, missing: false, stdout: '', stderr: 'connection refused' }) });
  audio.start();
  await until(() => audio.status().reason && audio.status().reason !== 'starting');
  audio.stop();
  assert.strictEqual(audio.status().available, false);
  assert.match(audio.status().reason, /adi2-pi-audio/);
});

test('newest source wins, switch back, mix, fixed sample rate', { skip: !canRun && 'PipeWire tools missing' }, async () => {
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2pi-route-'));
  const env = { ...process.env, XDG_RUNTIME_DIR: rt };
  const fx = spawn(FIXTURE, [rt], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  await new Promise((r) => fx.stdout.on('data', (d) => { if (/ready/.test(String(d))) r(); }));
  // a long, quiet WAV to play
  const wavFile = path.join(rt, 'tone.wav');
  const rate = 44100, n = rate * 60, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  fs.writeFileSync(wavFile, b);
  const settings = { bluetooth: { outSource: 'off' }, routing: { mode: 'newest', rate: 0 } };
  const audio = new Audio({ log: quiet, getSettings: () => settings, env: { XDG_RUNTIME_DIR: rt }, pollMs: 200 });
  const players = [];
  const play = (name) => { const p = spawn('pw-play', ['-P', `{ application.name = "${name}" node.name = "${name}" }`, wavFile], { env, stdio: 'ignore' }); players.push(p); return p; };
  const src = (name) => (audio.status().sources || []).find((x) => x.label === name);
  const meta = () => spawnSync('pw-metadata', ['-n', 'settings', '0', 'clock.force-rate'], { env, encoding: 'utf8' }).stdout;
  try {
    audio.start();
    await until(() => audio.status().available && audio.status().adi && audio.status().adi.sink);
    play('first');
    await until(() => src('first') && src('first').playing && src('first').active && !src('first').muted);
    await sleep(400);
    play('second');
    await until(() => src('second') && src('second').active && !src('second').muted && src('first') && src('first').muted);
    // switch back to the first
    audio.switchTo(src('first').key);
    await until(() => src('first').active && !src('first').muted && src('second').muted);
    assert.throws(() => audio.switchTo('node:999999'), /not playing/);
    // the heard one stops: the other is heard again
    players[0].kill();
    await until(() => !src('first') && src('second') && src('second').active && !src('second').muted);
    // mix: nobody muted
    play('third');
    await until(() => src('third') && src('second').muted);
    settings.routing.mode = 'mix';
    audio.refresh();
    await until(() => !src('second').muted && !src('third').muted);
    // fixed sample rate, and back to following what plays
    settings.routing.rate = 96000;
    audio.refresh();
    await until(() => /96000/.test(meta()) && audio.status().forceRate === 96000);
    settings.routing.rate = 0;
    audio.refresh();
    await until(() => audio.status().forceRate === 0);
  } finally {
    audio.stop();
    for (const p of players) try { p.kill(); } catch { /* gone */ }
    try { process.kill(-fx.pid, 'SIGTERM'); } catch { /* gone */ }
    spawnSync('pkill', ['-f', rt]);
  }
});
