'use strict';
/**
 * Backup and restore: the unit's settings (every parameter it reports), its 20 EQ presets, its
 * setup names and ADI-2-Pi's own settings in one JSON file.
 *
 * Not included: the content of the unit's 9 setups (the unit doesn't send it over MIDI), the
 * access key and the MQTT password.
 *
 * Restoring sends the parts one after the other with pauses, so the unit keeps up; progress
 * comes as 'progress' events ({ state: running|done|error, step, done, total, message }).
 */
const { EventEmitter } = require('events');
const cat = require('./catalog');

const FORMAT = 'adi2-pi-backup';
const VERSION = 1;
const VALUE_CHUNK = 40;
const GAP_MS = 250;
const PRESET_GAP_MS = 700;
// not restored as values: EQ Preset (would load a preset over the restored bands)
const SKIP_IDS = new Set(['eqpreset']);
const SETTINGS_KEYS = ['name', 'limits', 'riseDbPerSec', 'link', 'bluetooth', 'routing', 'trigger', 'streamVolume', 'startVolume', 'quickLevels', 'scenes', 'profiles', 'activeProfile', 'rules', 'sleep', 'ups', 'updates'];

function restorable(k) {
  const e = cat.lookup(k);
  return !!(e && !e.param.readonly && !SKIP_IDS.has(e.id));
}

function makeBackup({ dev, settings, version }) {
  const values = {};
  for (const [k, v] of dev.state) if (restorable(k)) values[k] = v;
  const pub = settings.publicView();
  const s = {};
  for (const k of SETTINGS_KEYS) if (pub[k] !== undefined) s[k] = pub[k];
  if (s.routing) s.routing = { ...s.routing, held: undefined };
  const mqtt = { ...pub.mqtt };
  delete mqtt.hasPassword;
  s.mqtt = mqtt;
  return {
    format: FORMAT, version: VERSION, created: new Date().toISOString(), bridge: version,
    model: dev.model, modelName: dev.model ? cat.schema.modelNames[dev.model] : null,
    values,
    setups: [...dev.setups],
    eqPresets: dev.presets().filter((p) => p.empty === false).map((p) => ({ n: p.n, name: p.name, dual: !!p.dual, L: p.L, R: p.R })),
    settings: s,
  };
}

function check(b) {
  if (!b || typeof b !== 'object' || b.format !== FORMAT) throw Object.assign(new Error('not an ADI-2-Pi backup file'), { status: 400 });
  if (b.version !== VERSION) throw Object.assign(new Error(`backup format ${b.version} is not supported`), { status: 400 });
}

class Restore extends EventEmitter {
  constructor({ dev, settings, log }) {
    super();
    this.dev = dev;
    this.settings = settings;
    this.log = log || console;
    this.state = { state: 'idle' };
    this.running = false;
  }

  status() { return this.state; }

  _set(s) {
    this.state = { ...this.state, ...s };
    this.emit('progress', this.state);
  }

  /**
   * parts: { values, eqPresets, setups, settings } (booleans; default all).
   * Returns what will be done; the work continues in the background.
   */
  start(backup, parts = {}) {
    check(backup);
    if (this.running) throw Object.assign(new Error('a restore is running'), { status: 409 });
    const want = { values: true, eqPresets: true, setups: true, settings: true, ...parts };
    const needUnit = want.values || want.eqPresets || want.setups;
    const info = this.dev.info();
    if (needUnit && !(info.connected && info.ready && info.answering)) throw Object.assign(new Error('the ADI-2 must be connected and answering'), { status: 409 });
    if (want.values && backup.model && this.dev.model && backup.model !== this.dev.model) {
      throw Object.assign(new Error(`the backup is from an ${backup.modelName || backup.model}; this unit is an ${cat.schema.modelNames[this.dev.model]}. Leave out the unit's settings, or use a backup of this model.`), { status: 409 });
    }
    const steps = [];
    if (want.settings && backup.settings) steps.push(['settings', () => this._settings(backup.settings)]);
    if (want.values && backup.values) {
      const keys = Object.keys(backup.values).filter(restorable);
      for (let i = 0; i < keys.length; i += VALUE_CHUNK) {
        const chunk = keys.slice(i, i + VALUE_CHUNK);
        steps.push(['unit settings', () => this._values(chunk.map((k) => ({ key: k, value: Number(backup.values[k]), ramp: false }))), GAP_MS]);
      }
    }
    if (want.setups && Array.isArray(backup.setups)) {
      backup.setups.forEach((name, i) => {
        if (name && name !== this.dev.setups[i]) steps.push(['setup names', () => this.dev.renameSetup(i + 1, name), GAP_MS]);
      });
    }
    if (want.eqPresets && Array.isArray(backup.eqPresets)) {
      for (const p of backup.eqPresets) {
        if (!(p.n >= 1 && p.n <= 20) || !p.L) continue;
        steps.push(['EQ presets', () => this.dev.storeEqPreset(p.n, { L: p.L, R: p.R, dual: p.dual }, p.name || undefined), PRESET_GAP_MS]);
      }
    }
    this.running = true;
    this.errors = [];
    this._set({ state: 'running', step: steps[0] ? steps[0][0] : null, done: 0, total: steps.length, message: null, errors: 0 });
    this.log.info(`backup: restoring ${steps.length} steps`);
    this._run(steps, 0);
    return this.state;
  }

  _settings(s) {
    const patch = {};
    for (const k of SETTINGS_KEYS) if (s[k] !== undefined) patch[k] = s[k];
    if (patch.routing) { patch.routing = { ...patch.routing }; delete patch.routing.held; }
    // the MQTT password isn't in a backup: the one set on this Pi stays
    if (s.mqtt) { const m = { ...s.mqtt }; delete m.password; delete m.hasPassword; patch.mqtt = m; }
    this.settings.update(patch);
  }

  _values(items) {
    const r = this.dev.set(items, { origin: 'restore' });
    // values this unit doesn't have are skipped
    if (r.status === 409) throw new Error(r.errors[0]);
  }

  _run(steps, i) {
    if (i >= steps.length) {
      this.running = false;
      setTimeout(() => this.dev.refresh(), 800);
      this._set({ state: this.errors.length ? 'error' : 'done', step: null, done: steps.length, message: this.errors.length ? this.errors.slice(0, 3).join('; ') : 'restored', errors: this.errors.length });
      this.log.info(`backup: restore finished${this.errors.length ? ` with ${this.errors.length} errors` : ''}`);
      return;
    }
    const [name, fn, gap = 0] = steps[i];
    this._set({ step: name, done: i });
    try { fn(); } catch (e) {
      this.errors.push(`${name}: ${e.message}`);
      if (e.status === 409 || /not answering|not connected/i.test(e.message)) {
        this.running = false;
        this._set({ state: 'error', message: `stopped: ${e.message}`, errors: this.errors.length });
        return;
      }
    }
    setTimeout(() => this._run(steps, i + 1), gap).unref?.();
  }
}

module.exports = { makeBackup, Restore, FORMAT, VERSION };
