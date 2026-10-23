'use strict';
/**
 * The ADI-2's USB playback device: setting its sample rate (used without the audio service).
 *
 * With the ADI-2 on USB, the USB host sets the sample rate (manual: "When set to Clock Source
 * Internal, the computer sets the current sample rate"); the unit's own Sample Rate menu is then
 * not available. The Pi is that host, so ADI-2-Pi sets it the way a computer does: it opens the
 * ADI's playback device at the wanted rate and plays half a second of silence (aplay, alsa-utils).
 * The unit keeps that rate until a program opens it at another one.
 *
 * Reads only kernel files under /proc/asound (RAM); nothing is written to the SD card.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const RATES = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000];

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function runAplay(args) {
  return new Promise((resolve) => {
    execFile('aplay', args, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: `${stdout || ''}${stderr || ''}`.trim(), missing: err && err.code === 'ENOENT' });
    });
  });
}

class UsbAudio {
  /**
   * @param {object} o
   * @param {() => number|null} o.getCard  ALSA card number of the ADI-2 (from the MIDI port)
   * @param {string} [o.procRoot]          for tests
   * @param {(args: string[]) => Promise} [o.run]  for tests
   */
  constructor({ getCard, log, procRoot = '', run = runAplay }) {
    this.getCard = getCard;
    this.log = log || console;
    this.procRoot = procRoot;
    this.run = run;
    this.lastSet = null; // { rate, at }
    this.busy = false;
  }

  _dir() {
    const card = this.getCard();
    if (card === null || card === undefined) return null;
    const dir = path.join(this.procRoot || '/', 'proc', 'asound', `card${card}`);
    return fs.existsSync(dir) ? { card, dir } : null;
  }

  /** { available, card, open, rate, owner, lastSet } */
  status() {
    const d = this._dir();
    if (!d) return { available: false, lastSet: this.lastSet };
    const sub = path.join(d.dir, 'pcm0p', 'sub0');
    if (!fs.existsSync(sub)) return { available: false, card: d.card, reason: 'the ADI-2 has no USB playback device on this card', lastSet: this.lastSet };
    const hw = readText(path.join(sub, 'hw_params')) || 'closed';
    const st = readText(path.join(sub, 'status')) || 'closed';
    const open = !/^closed/.test(hw.trim());
    const out = { available: true, card: d.card, open, rate: null, channels: null, owner: null, lastSet: this.lastSet };
    if (open) {
      const r = hw.match(/^rate:\s*(\d+)/m);
      const c = hw.match(/^channels:\s*(\d+)/m);
      out.rate = r ? Number(r[1]) : null;
      out.channels = c ? Number(c[1]) : null;
      const pid = st.match(/owner_pid\s*:\s*(\d+)/);
      if (pid) out.owner = (readText(path.join(this.procRoot || '/', 'proc', pid[1], 'comm')) || '').trim() || `process ${pid[1]}`;
    }
    return out;
  }

  /** Set the ADI-2's sample rate (Hz) by opening its playback device at that rate. */
  async setRate(rate) {
    rate = Number(rate);
    if (!RATES.includes(rate)) throw Object.assign(new Error(`sample rate must be one of ${RATES.map((r) => r / 1000).join(', ')} kHz`), { status: 400 });
    const st = this.status();
    if (!st.available) throw Object.assign(new Error(st.reason || 'the ADI-2\'s USB audio device was not found'), { status: 409 });
    if (st.open) throw Object.assign(new Error(`${st.owner || 'another program'} is playing to the ADI-2 at ${st.rate / 1000} kHz – that program sets the rate while it plays`), { status: 409 });
    if (this.busy) throw Object.assign(new Error('already setting the sample rate'), { status: 409 });
    this.busy = true;
    try {
      const dev = `hw:${st.card},0`;
      let last = null;
      // stereo mode: 2 channels; multi-channel mode: 8 playback channels
      for (const ch of [2, 8]) {
        for (const fmt of ['S32_LE', 'S24_3LE', 'S16_LE']) {
          const r = await this.run(['-q', '-D', dev, '-t', 'raw', '-c', String(ch), '-r', String(rate), '-f', fmt, '-s', String(Math.round(rate / 2)), '/dev/zero']);
          if (r.missing) throw Object.assign(new Error('aplay is missing – run the installer again (it installs alsa-utils)'), { status: 500 });
          if (r.ok) {
            this.lastSet = { rate, at: new Date().toISOString() };
            this.log.info(`usb: sample rate set to ${rate} Hz (${ch} ch, ${fmt})`);
            return this.lastSet;
          }
          last = r.out;
          if (/busy/i.test(r.out)) throw Object.assign(new Error('another program holds the ADI-2\'s playback device'), { status: 409 });
          if (/rate/i.test(r.out) && !/channel|format/i.test(r.out)) break; // try the other channel count once
        }
      }
      const hint = rate > 192000 ? ' (in USB multi-channel mode the unit allows up to 192 kHz)' : '';
      throw Object.assign(new Error(`the ADI-2 did not accept ${rate / 1000} kHz${hint}: ${last || 'no details'}`), { status: 409 });
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { UsbAudio, RATES };
