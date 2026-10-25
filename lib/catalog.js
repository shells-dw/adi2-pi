'use strict';
/**
 * Name-based access to ADI-2 parameters, built from schema.json.
 *
 * Every parameter has a protocol address: { addr, idx }. The API keys them as "addr.idx".
 * Friendly names: channel key + parameter id, e.g. ("ph34", "vol"), ("line", "b3f"),
 * ("ph12", "bass", "R") for the right-channel EQ when Dual EQ is on, (null/"device", "clock").
 */
const schema = require('./schema.json');

const DEVICE_ADDR = 12;
const channels = schema.channels;
// null-prototype tables: names from the network must not resolve to Object.prototype members
const channelByKey = Object.assign(Object.create(null), Object.fromEntries(channels.map((c) => [c.key, c])));

/** Index all params by id within their section. */
const sections = {};
for (const [section, list] of Object.entries(schema.params)) {
  sections[section] = Object.assign(Object.create(null), Object.fromEntries(list.map((p) => [p.id, { ...p, section }])));
}

function available(entry, model) {
  if (!model) return true;
  if (entry.only && !entry.only.includes(model)) return false;
  if (entry.not && entry.not.includes(model)) return false;
  return true;
}

/**
 * Resolve a friendly name to { addr, idx, param, channel }.
 * @param {string|null} ch channel key ("line", "ph12", "ph34", "in") or "device"/null
 * @param {string} id parameter id from the schema
 * @param {"L"|"R"} [side] EQ side
 */
function resolve(ch, id, side = 'L') {
  if (!ch || ch === 'device') {
    const p = sections.device[id];
    return p ? { addr: DEVICE_ADDR, idx: p.idx, param: p, channel: null } : null;
  }
  const c = channelByKey[ch];
  if (!c) return null;
  if (sections.eq[id]) return { addr: side === 'R' ? c.eqR : c.eq, idx: sections.eq[id].idx, param: sections.eq[id], channel: c };
  const list = c.kind === 'input' ? sections.input : sections.output;
  const p = list[id];
  return p ? { addr: c.addr, idx: p.idx, param: p, channel: c } : null;
}

/** Reverse lookup: "addr.idx" → { ch, id, side, param } (or null for unknown/preset data). */
const byKey = new Map();
for (const c of channels) {
  const list = c.kind === 'input' ? sections.input : sections.output;
  for (const p of Object.values(list)) byKey.set(`${c.addr}.${p.idx}`, { ch: c.key, id: p.id, param: p });
  for (const p of Object.values(sections.eq)) {
    byKey.set(`${c.eq}.${p.idx}`, { ch: c.key, id: p.id, side: 'L', param: p });
    byKey.set(`${c.eqR}.${p.idx}`, { ch: c.key, id: p.id, side: 'R', param: p });
  }
}
for (const p of Object.values(sections.device)) byKey.set(`${DEVICE_ADDR}.${p.idx}`, { ch: 'device', id: p.id, param: p });

const key = (addr, idx) => `${addr}.${idx}`;
const lookup = (k) => byKey.get(k) || null;

/** Protocol integer → display number (dB, Hz, Q …). */
function toDisplay(param, value) {
  if (param.type !== 'level') return value;
  const v = value * (param.scale ?? 1);
  return param.decimals ? Number(v.toFixed(param.decimals)) : Math.round(v);
}

/** Display number → protocol integer, clamped to the parameter's range. */
function fromDisplay(param, value) {
  value = Number(value);
  if (!Number.isFinite(value)) throw new TypeError(`${param.id}: not a number`);
  if (param.type === 'toggle') return value ? 1 : 0;
  if (param.type === 'select') return Math.max(0, Math.round(value));
  const clamped = Math.max(param.min, Math.min(param.max, value));
  if (param.unit === 'Hz' && clamped > 2047) return Math.round(clamped / 10) * 10; // stored in 10 Hz steps
  return Math.round(clamped / (param.scale ?? 1));
}

/** Clamp a protocol integer to the parameter's range (for raw "addr.idx" sets). */
function clampRaw(param, value) {
  if (!param || param.type !== 'level') return Math.round(value);
  const s = param.scale ?? 1;
  return Math.max(Math.round(param.min / s), Math.min(Math.round(param.max / s), Math.round(value)));
}

/** Value names for a select param on a given model and channel. */
function valueNames(param, model, channel) {
  let n = param.names;
  if (!n) return null;
  if (!Array.isArray(n) && (n.line || n.phones)) n = channel && channel.line ? n.line : n.phones;
  if (!Array.isArray(n)) n = n[model] || n.pro || Object.values(n)[0];
  return n || null;
}

module.exports = {
  schema, channels, channelByKey, sections, DEVICE_ADDR,
  available, resolve, lookup, key, toDisplay, fromDisplay, clampRaw, valueNames,
};
