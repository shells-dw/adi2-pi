'use strict';
/**
 * Input priority: switch the chosen outputs' Source to the first input in a list that has a signal,
 * e.g. AES → Analog: AES while it has a signal, Analog when it loses it, AES again when it returns.
 *
 * - Signal detection: AES and SPDIF from the unit's status message (statusInfo.inputs; the ADI-2
 *   DAC has no AES input). Analog and USB have no detection and count as always available, so
 *   the list ends at the first of them.
 * - Switches when the first available input has been the same for delaySec (a sample-rate
 *   change re-locks the input briefly).
 * - Acts only when that input changes: a Source picked by hand stays until the next change.
 * - Outputs held on USB while the Pi plays (routing.held, lib/autosource.js) are not switched;
 *   the input they go back to afterwards is updated instead.
 */
const { EventEmitter } = require('events');
const cat = require('./catalog');
const { USB_OUTS } = require('./settings');

/** Source names per input in the schema's Source list. */
const SOURCE_NAME = { aes: 'AES', spdif: 'SPDIF', analog: 'Analog', usb: 'USB 1/2' };
const DETECTED = new Set(['aes', 'spdif']);

class InputPriority extends EventEmitter {
  constructor({ dev, settings, log }) {
    super();
    this.dev = dev;
    this.settings = settings;
    this.log = log || console;
    this.current = null;    // input the outputs were last switched to
    this.pending = null;    // { to, at }: switching to `to` once it has been first for delaySec
    this.timer = null;
    this.last = null;       // { at, to, outputs }
    this.cfgKey = '';
  }

  start() {
    this._onStatus = () => this._eval();
    this._onDevice = () => this._eval();
    this._onSettings = () => {
      const k = JSON.stringify(this.cfg());
      if (k === this.cfgKey) return;
      this.cfgKey = k;
      this.current = null; // new list or outputs: apply it once
      this._clearPending();
      this._eval();
      this.emit('status', this.view());
    };
    this.cfgKey = JSON.stringify(this.cfg());
    this.dev.on('status', this._onStatus);
    this.dev.on('device', this._onDevice);
    this.settings.on('change', this._onSettings);
    this._eval();
  }

  stop() {
    this._clearPending();
    if (this._onStatus) {
      this.dev.off('status', this._onStatus);
      this.dev.off('device', this._onDevice);
      this.settings.off('change', this._onSettings);
    }
  }

  cfg() { return this.settings.get().inputPriority; }

  _inputs() { return (this.dev.statusInfo && this.dev.statusInfo.inputs) || null; }

  _ready() { const i = this.dev.info(); return !!(i.connected && i.ready && i.answering !== false); }

  /** First input of the list that is available; undefined while the status is not known. */
  _first() {
    const inputs = this._inputs();
    for (const x of this.cfg().order) {
      if (!DETECTED.has(x)) return x;
      if (!inputs || inputs[x] === null || inputs[x] === undefined) return undefined;
      if (inputs[x]) return x;
    }
    return null; // only detected inputs, none with a signal: leave the outputs as they are
  }

  _clearPending() { clearTimeout(this.timer); this.timer = null; this.pending = null; }

  _eval() {
    const c = this.cfg();
    if (!c.enabled || !this._ready()) { if (this.pending) { this._clearPending(); this.emit('status', this.view()); } return; }
    const first = this._first();
    if (first === undefined || first === null || first === this.current) {
      if (this.pending) { this._clearPending(); this.emit('status', this.view()); }
      return;
    }
    if (this.pending && this.pending.to === first) return;
    this._clearPending();
    this.pending = { to: first, at: Date.now() };
    const ms = Math.round((Number(c.delaySec) || 0) * 1000);
    this.timer = setTimeout(() => { this.timer = null; this._apply(first); }, ms);
    this.timer.unref?.();
    this.emit('status', this.view());
  }

  _sourceValue(o, input) {
    const r = cat.resolve(o, 'src');
    if (!r) return null;
    const names = cat.valueNames(r.param, this.dev.profile, r.channel) || [];
    let i = names.indexOf(SOURCE_NAME[input]);
    // Basic Mode DAC and the ADI-2 DAC list coax and optical separately: the one the unit receives
    if (i < 0 && input === 'spdif') i = names.findIndex((n) => (this._inputs()?.spdifOptical ? /^Optical$/ : /^SPDIF c/).test(n));
    if (i < 0 && input === 'usb') i = names.indexOf('USB'); // ADI-2 DAC
    return i >= 0 ? i + cat.valueBase(r.param, this.dev.profile) : null;
  }

  _apply(input) {
    this.pending = null;
    if (!this.cfg().enabled || !this._ready() || this._first() !== input) { this._eval(); return; }
    const outs = USB_OUTS.filter((o) => this.cfg().outputs[o]);
    const held = { ...((this.settings.get().routing || {}).held || {}) };
    let heldChanged = false;
    const items = [];
    const done = [];
    for (const o of outs) {
      const v = this._sourceValue(o, input);
      if (v === null) continue;
      const r = cat.resolve(o, 'src');
      if (this.dev.get(r.addr, r.idx) === undefined) continue; // this unit doesn't report a Source here
      if (held[o] !== null && held[o] !== undefined) {         // on USB while the Pi plays
        if (held[o] !== v) { held[o] = v; heldChanged = true; done.push(o); }
        continue;
      }
      if (this.dev.get(r.addr, r.idx) !== v) items.push({ ch: o, id: 'src', value: v });
      done.push(o);
    }
    this.current = input;
    if (heldChanged) this.settings.update({ routing: { held } });
    if (items.length) {
      const res = this.dev.set(items, { origin: 'input' });
      if (res.errors.length) this.log.warn(`inputprio: ${res.errors.join('; ')}`);
    }
    if (items.length || heldChanged) {
      this.last = { at: Date.now(), to: input, outputs: done };
      this.log.info(`inputprio: ${SOURCE_NAME[input]} – ${done.join(', ')}`);
    }
    this.emit('status', this.view());
  }

  view() {
    const c = this.cfg();
    const inputs = this._inputs();
    return {
      ...c,
      available: true,
      reason: null,
      signal: inputs ? { aes: inputs.aes, spdif: inputs.spdif } : null,
      current: this.current,
      pending: this.pending ? { to: this.pending.to, at: this.pending.at } : null,
      last: this.last,
    };
  }
}

module.exports = { InputPriority, SOURCE_NAME };
