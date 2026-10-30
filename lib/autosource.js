'use strict';
/**
 * While the Pi plays something into the ADI-2 (Bluetooth from a phone, a network receiver …),
 * switch the chosen outputs' Source to USB, and back to what they were set to when it stops.
 *
 * - Switches once per playing session. If someone picks another source meanwhile (on the unit,
 *   the web page, Stream Deck), that output is left alone and not put back later.
 * - Puts the old source back HOLD_MS after the last source stopped (track gaps, pause/resume).
 * - Only puts it back if the output is still on USB.
 * - What was set before is kept in the settings (routing.held), so a restart can still restore it.
 */
const cat = require('./catalog');
const { USB_OUTS } = require('./settings');

const HOLD_MS = 10000;

class AutoSource {
  constructor({ dev, audio, settings, log, holdMs = HOLD_MS }) {
    this.dev = dev;
    this.audio = audio;
    this.settings = settings;
    this.log = log || console;
    this.holdMs = holdMs;
    this.session = false;      // the Pi plays (or played less than holdMs ago)
    this.todo = new Set();     // outputs still to switch in this session (unit wasn't ready)
    this.stopTimer = null;
    this.last = null;          // what happened last, for the routing view
    const held = this._held();
    if (USB_OUTS.some((o) => held[o] !== null && held[o] !== undefined)) this.session = true; // restart mid-session
  }

  start() {
    this.audio.on('status', () => this._tick());
    this.dev.on('device', () => this._tick());
    this.dev.on('params', (p, origin) => this._onParams(p, origin));
    this.settings.on('change', () => this._tick());
    this._tick();
  }

  stop() { clearTimeout(this.stopTimer); }

  _held() { return { ...((this.settings.get().routing || {}).held || {}) }; }
  _wanted() { const u = (this.settings.get().routing || {}).usb || {}; return USB_OUTS.filter((o) => u[o] !== false); }
  _playing() { const a = this.audio.status() || {}; return !!a.available && (a.sources || []).some((s) => s.playing); }
  _ready() { const i = this.dev.info(); return i.connected && i.ready && i.answering; }

  _usbValue(o) {
    const r = cat.resolve(o, 'src');
    if (!r) return null;
    const names = cat.valueNames(r.param, this.dev.profile, r.channel) || [];
    const i = names.findIndex((n) => /^USB( 1\/2)?$/.test(n));
    return i >= 0 ? i : null;
  }

  _src(o) { const r = cat.resolve(o, 'src'); return r ? this.dev.get(r.addr, r.idx) : undefined; }

  _tick() {
    if (this._playing()) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
      if (!this.session) {
        this.session = true;
        this.todo = new Set(this._wanted());
      }
      if (this.todo.size && this._ready()) this._switchToUsb();
    } else if (this.session && !this.stopTimer) {
      this.stopTimer = setTimeout(() => { this.stopTimer = null; this._end(); }, this.holdMs);
      this.stopTimer.unref?.();
    }
  }

  _switchToUsb() {
    const held = this._held();
    const items = [];
    for (const o of [...this.todo]) {
      const usb = this._usbValue(o);
      const cur = this._src(o);
      if (usb === null) { this.todo.delete(o); continue; }  // this output has no Source (or no USB)
      if (cur === undefined) continue;                      // not read from the unit yet
      this.todo.delete(o);
      if (cur === usb) continue;                            // already on USB: nothing to put back
      held[o] = cur;
      items.push({ ch: o, id: 'src', value: usb });
    }
    if (!items.length) return;
    this.settings.update({ routing: { held } });
    const r = this.dev.set(items, { origin: 'auto' });
    if (r.errors.length) this.log.warn(`autosource: ${r.errors.join('; ')}`);
    this.last = { at: Date.now(), what: 'usb', outputs: items.map((i) => i.ch) };
    this.log.info(`autosource: the Pi plays – ${items.map((i) => i.ch).join(', ')} switched to USB`);
  }

  _end() {
    if (this._playing()) return;
    if (!this._ready()) { this._tick(); return; }           // try again once the unit answers
    this.session = false;
    this.todo.clear();
    const held = this._held();
    const items = [];
    for (const o of USB_OUTS) {
      const was = held[o];
      if (was === null || was === undefined) continue;
      if (this._src(o) === this._usbValue(o)) items.push({ ch: o, id: 'src', value: was });
      held[o] = null;
    }
    this.settings.update({ routing: { held } });
    if (!items.length) return;
    const r = this.dev.set(items, { origin: 'auto' });
    if (r.errors.length) this.log.warn(`autosource: ${r.errors.join('; ')}`);
    this.last = { at: Date.now(), what: 'restored', outputs: items.map((i) => i.ch) };
    this.log.info(`autosource: nothing plays – ${items.map((i) => i.ch).join(', ')} back to the source set before`);
  }

  /** Someone else changed a source we switched: leave that output alone from now on. */
  _onParams(p, origin) {
    if (origin === 'auto') return;
    const held = this._held();
    let touched = false;
    for (const o of USB_OUTS) {
      const r = cat.resolve(o, 'src');
      if (!r) continue;
      const v = p[cat.key(r.addr, r.idx)];
      if (v === undefined) continue;
      if (this.todo.has(o) && this.session) {
        // first reading of the unit during a session: switch now (handled by _tick)
        continue;
      }
      if (held[o] !== null && held[o] !== undefined && v !== this._usbValue(o)) { held[o] = null; touched = true; }
    }
    if (touched) this.settings.update({ routing: { held } });
    if (this.todo.size) this._tick();
  }

  view() {
    const held = this._held();
    const u = (this.settings.get().routing || {}).usb || {};
    return {
      usb: Object.fromEntries(USB_OUTS.map((o) => [o, u[o] !== false])),
      held: Object.fromEntries(USB_OUTS.map((o) => [o, held[o] ?? null])),
      active: this.session,
      last: this.last,
    };
  }
}

module.exports = { AutoSource, HOLD_MS };
