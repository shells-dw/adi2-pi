'use strict';
/**
 * ADI-2 USB-MIDI port through ALSA's raw MIDI device node (/dev/snd/midiC<card>D0).
 *
 * The device node is a kernel interface, not a file on the SD card: bytes written to it go
 * straight out over USB. No native add-ons or helper programs are needed.
 *
 * Finds the ADI-2 by name in /proc/asound/cards (also RAM, provided by the kernel), opens it,
 * and watches for unplug / replug.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const PROC_CARDS = '/proc/asound/cards';
const POLL_MS = 2000;
const READ_IDLE_MS = 10;

/** Parse /proc/asound/cards into [{ card, id, driver, name, long }]. */
function parseCards(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(\d+)\s+\[([^\]]*)\]:\s*(\S+)\s+-\s+(.*)$/);
    if (m) out.push({ card: Number(m[1]), id: m[2].trim(), driver: m[3], name: m[4].trim(), long: (lines[i + 1] || '').trim() });
  }
  return out;
}

/** Model hint from the USB product name: "ADI-2 DAC", "ADI-2 Pro", "ADI-2/4 Pro SE" … */
function modelHint(name) {
  if (/ADI-2\s*DAC/i.test(name)) return 'dac';
  if (/ADI-2\/4/i.test(name)) return 'se';
  if (/ADI-2/i.test(name)) return 'pro';
  return null;
}

function findAdi(procRoot = '', devRoot = '') {
  let text;
  try { text = fs.readFileSync(procRoot + PROC_CARDS, 'utf8'); } catch { return null; }
  for (const c of parseCards(text)) {
    if (!/ADI-2/i.test(c.name + ' ' + c.long)) continue;
    const dev = `${devRoot}/dev/snd/midiC${c.card}D0`;
    if (!fs.existsSync(dev)) continue;
    return { card: c.card, name: c.name, path: dev, hint: modelHint(c.name + ' ' + c.long) };
  }
  return null;
}

class AlsaMidiTransport extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.device]  fixed device path, skips auto-detection
   * @param {object} [opts.log]
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.log = opts.log || console;
    this.fdOut = null;
    this.fdIn = null;
    this.readTimer = null;
    this.info = null;
    this.timer = null;
    this.stopped = false;
    this.lastProblem = null;
  }

  get isOpen() { return this.fdOut !== null; }

  start() {
    this.stopped = false;
    this._scan();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this._close('stopped');
  }

  _schedule(ms = POLL_MS) {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => this._scan(), ms);
  }

  _problem(code, text) {
    if (this.lastProblem === code) return;
    this.lastProblem = code;
    if (code) this.log.warn(`midi: ${text}`);
    this.emit('problem', code ? { code, text } : null);
  }

  _scan() {
    if (this.stopped || this.isOpen) return;
    let found;
    if (this.opts.device) {
      found = fs.existsSync(this.opts.device)
        ? { card: null, name: path.basename(this.opts.device), path: this.opts.device, hint: null }
        : null;
    } else {
      found = findAdi();
    }
    if (!found) {
      this._problem('notfound', 'no ADI-2 found (USB connected? MIDI Control ON?)');
      return this._schedule();
    }
    try {
      // Non-blocking opens: a blocking open of a busy rawmidi port would wait forever.
      // Separate handles: ALSA opens the input and output substreams independently.
      this.fdOut = fs.openSync(found.path, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      this.fdIn = fs.openSync(found.path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (e) {
      this._closeFds();
      if (e.code === 'EBUSY') this._problem('busy', `${found.path} is busy – another program holds the ADI's MIDI port`);
      else if (e.code === 'EACCES') this._problem('access', `no permission for ${found.path} – is the service user in the "audio" group?`);
      else this._problem('open', `cannot open ${found.path}: ${e.message}`);
      return this._schedule(5000);
    }
    this.info = found;
    this._problem(null);
    this.log.info(`midi: opened ${found.path} (${found.name})`);
    this.emit('open', found);
    this._read();
  }

  /**
   * Poll the non-blocking input: read until empty, then look again in a few ms.
   * The ADI-2 sends little data (a dump is ~2 KB), so this costs next to nothing.
   */
  _read() {
    if (this.fdIn === null) return;
    const fd = this.fdIn;
    const buf = Buffer.allocUnsafe(1024);
    fs.read(fd, buf, 0, buf.length, null, (err, n) => {
      if (fd !== this.fdIn) return; // closed meanwhile
      if (err) {
        if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
          this.readTimer = setTimeout(() => this._read(), READ_IDLE_MS);
          return;
        }
        return this._close(err.code === 'ENODEV' ? 'unplugged' : err.message);
      }
      if (n === 0) return this._close('closed');
      this.emit('data', buf.subarray(0, n));
      setImmediate(() => this._read());
    });
  }

  write(buf) {
    if (!this.isOpen) return false;
    try {
      let off = 0;
      while (off < buf.length) off += fs.writeSync(this.fdOut, buf, off);
      return true;
    } catch (e) {
      if (e.code === 'EAGAIN') {
        this.log.warn('midi: output buffer full, message dropped');
        return false;
      }
      this._close(e.code === 'ENODEV' ? 'unplugged' : e.message);
      return false;
    }
  }

  _closeFds() {
    clearTimeout(this.readTimer);
    for (const k of ['fdIn', 'fdOut']) {
      if (this[k] !== null) {
        try { fs.closeSync(this[k]); } catch { /* already gone */ }
        this[k] = null;
      }
    }
  }

  _close(reason) {
    const wasOpen = this.isOpen;
    this._closeFds();
    if (wasOpen) {
      this.log.info(`midi: closed (${reason})`);
      this.emit('close', reason);
    }
    this.info = null;
    this._schedule();
  }
}

module.exports = { AlsaMidiTransport, parseCards, modelHint, findAdi };
