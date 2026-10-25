'use strict';
/**
 * Volume of AirPlay and Spotify Connect senders → the ADI-2's volume.
 *
 * With streamVolume on, the receivers play at full level and report volume changes through a
 * hook program (bin/adi2-pi-hook.js), which posts them to POST /api/hook on this Pi:
 *   - AirPlay (shairport-sync): `ignore_volume_control` + `run_this_when_volume_is_set`;
 *     volume −30 … 0 (AirPlay's scale), −144 = mute
 *   - Spotify Connect (librespot): `--volume-ctrl fixed` + `--onevent`; VOLUME 0 … 65535
 * The sender's slider position maps linearly onto minDb … maxDb of the chosen outputs (the
 * bridge's volume limits still apply). Mute on the sender mutes the outputs.
 *
 * One way only: turning the knob on the ADI-2 doesn't move the slider on the phone.
 */
const cat = require('./catalog');

const IGNORE_AFTER_START_MS = 5000; // librespot reports its initial volume when it starts

class StreamVolume {
  constructor({ dev, settings, log, receiverSince = () => null }) {
    this.dev = dev;
    this.settings = settings;
    this.log = log || console;
    this.receiverSince = receiverSince; // id → ms timestamp the receiver process started
    this.mutedByUs = new Set();
    this.last = null; // { at, receiver, position, db }
  }

  cfg() { return this.settings.get().streamVolume || {}; }

  /** Is the hook active for this receiver (decides its command line)? */
  active(id) {
    const c = this.cfg();
    return !!(c.enabled && c[id]);
  }

  /** Sender position 0…1, or null for mute. */
  static position(receiver, raw) {
    const v = Number(raw);
    if (!Number.isFinite(v)) return undefined;
    if (receiver === 'airplay') {
      if (v <= -144) return null;
      return Math.max(0, Math.min(1, (v + 30) / 30));
    }
    if (receiver === 'spotify') return Math.max(0, Math.min(1, v / 65535));
    return undefined;
  }

  /** From the hook: { receiver, value }. Returns what was done. */
  handle(receiver, value) {
    if (!this.active(receiver)) return { ignored: 'stream volume is off for this receiver' };
    const since = this.receiverSince(receiver);
    if (since && Date.now() - since < IGNORE_AFTER_START_MS) return { ignored: 'receiver just started' };
    const pos = StreamVolume.position(receiver, value);
    if (pos === undefined) throw Object.assign(new Error(`bad volume ${value} for ${receiver}`), { status: 400 });
    const c = this.cfg();
    const items = [];
    const hasMute = (ch) => { const r = cat.resolve(ch, 'mute'); return this.dev.state.has(cat.key(r.addr, r.idx)); };
    if (pos === null) {
      for (const ch of c.outputs) if (hasMute(ch)) { items.push({ ch, id: 'mute', value: 1 }); this.mutedByUs.add(ch); }
    } else {
      const db = Math.round((c.minDb + pos * (c.maxDb - c.minDb)) * 2) / 2;
      for (const ch of c.outputs) {
        if (this.mutedByUs.has(ch)) { items.push({ ch, id: 'mute', value: 0 }); this.mutedByUs.delete(ch); }
        items.push({ ch, id: 'vol', value: db });
      }
      this.last = { at: Date.now(), receiver, position: Math.round(pos * 1000) / 1000, db };
    }
    if (!items.length) return { applied: {} };
    const r = this.dev.set(items, { origin: 'stream' });
    return { applied: r.applied, errors: r.errors.length ? r.errors : undefined };
  }

  view() {
    return { ...this.cfg(), last: this.last };
  }
}

module.exports = { StreamVolume };
