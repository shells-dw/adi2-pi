'use strict';
/**
 * RME ADI-2 series SysEx codec (the protocol ADI-2 Remote uses on the unit's USB-MIDI port).
 * Source: RME "MIDI-Protocol for RME ADI-2 DAC, ADI-2 Pro and ADI-2/4 Pro SE/EX" v1.0,
 * verified on an ADI-2 Pro EX (device ID 0x72).
 *
 *   F0 00 20 0D <device id> <command> <data…> F7
 *
 * Parameters are packed into 3 × 7-bit bytes (21 bits):
 *   channels (addr 0–11, 13, 14): addr(4) | index(5) | value(12, two's complement)
 *   device   (addr 12)          : addr(4) | index(6) | value(11, unsigned)
 * EQ frequencies use the 12-bit value as 11 bits + bit 11 = "×10" flag.
 * The API always uses plain Hz for frequencies.
 */

const MANUFACTURER = [0x00, 0x20, 0x0d];

const CMD = {
  PARAMS_TO_REMOTE: 0x01,
  PARAMS_TO_DEVICE: 0x02,
  REQUEST: 0x03,
  SETUP: 0x04,
  PRESET_NAME: 0x05, // EQ preset / setup name, unit → remote
  SETUP_NAME: 0x06,  // EQ preset / setup name, remote → unit
  STATUS: 0x07,
};

const REQ_ALL = 0x09;

const DEVICE_IDS = { dac: 0x71, pro: 0x72, se: 0x73 };
const MODEL_BY_ID = { 0x71: 'dac', 0x72: 'pro', 0x73: 'se' };

const DEVICE_ADDR = 12;
/** EQ addresses (L and R for input, line, phones 1/2, phones 3/4). */
const EQ_ADDRS = new Set([1, 2, 4, 5, 7, 8, 10, 11, 13, 14]); // 13/14 = EQ preset data L/R
/** Indices inside an EQ address that carry a frequency: bands 1–5, bass, treble. */
const FREQ_IDX = new Set([5, 8, 11, 14, 18, 22, 25]);
/** Max parameters per message: 256-byte SysEx limit minus 7 bytes framing. */
const MAX_PARAMS_PER_MSG = 80;

function isFreq(addr, idx) {
  return EQ_ADDRS.has(addr) && FREQ_IDX.has(idx);
}

function encodeFreq(hz) {
  hz = Math.round(hz);
  if (hz < 10) hz = 10;
  if (hz <= 0x7ff) return hz;
  const tens = Math.min(0x7ff, Math.round(hz / 10));
  return 0x800 | tens;
}

function decodeFreq(raw) {
  raw &= 0xfff;
  return raw & 0x800 ? (raw & 0x7ff) * 10 : raw;
}

/** Encode one parameter (API value) into its 3 bytes. */
function encodeParam(addr, idx, value) {
  let bits;
  if (addr === DEVICE_ADDR) {
    if (idx < 0 || idx > 63) throw new RangeError(`device index ${idx}`);
    const v = Math.max(0, Math.min(0x7ff, Math.round(value)));
    bits = (addr << 17) | (idx << 11) | v;
  } else {
    if (addr < 0 || addr > 15) throw new RangeError(`address ${addr}`);
    if (idx < 0 || idx > 31) throw new RangeError(`index ${idx}`);
    let raw;
    if (isFreq(addr, idx)) raw = encodeFreq(value);
    else {
      const v = Math.max(-2048, Math.min(2047, Math.round(value)));
      raw = v & 0xfff;
    }
    bits = (addr << 17) | (idx << 12) | raw;
  }
  return [(bits >> 14) & 0x7f, (bits >> 7) & 0x7f, bits & 0x7f];
}

/** Decode one 3-byte parameter into { addr, idx, value } (API value). */
function decodeParam(b0, b1, b2) {
  const bits = ((b0 & 0x7f) << 14) | ((b1 & 0x7f) << 7) | (b2 & 0x7f);
  const addr = (bits >> 17) & 0x0f;
  if (addr === DEVICE_ADDR) {
    return { addr, idx: (bits >> 11) & 0x3f, value: bits & 0x7ff };
  }
  const idx = (bits >> 12) & 0x1f;
  const raw = bits & 0xfff;
  if (isFreq(addr, idx)) return { addr, idx, value: decodeFreq(raw) };
  return { addr, idx, value: raw & 0x800 ? raw - 0x1000 : raw };
}

function frame(id, cmd, data = []) {
  return Buffer.from([0xf0, ...MANUFACTURER, id & 0x7f, cmd & 0x7f, ...data.map((b) => b & 0x7f), 0xf7]);
}

/** Build one or more "params to device" messages from [{addr, idx, value}]. */
function paramsToDevice(id, params) {
  const out = [];
  for (let i = 0; i < params.length; i += MAX_PARAMS_PER_MSG) {
    const data = [];
    for (const p of params.slice(i, i + MAX_PARAMS_PER_MSG)) data.push(...encodeParam(p.addr, p.idx, p.value));
    out.push(frame(id, CMD.PARAMS_TO_DEVICE, data));
  }
  return out;
}

const requestAll = (id) => frame(id, CMD.REQUEST, [REQ_ALL]);
/** n = 1…9 */
const loadSetup = (id, n) => frame(id, CMD.SETUP, [n]);
/** Device parameter 63 "Do Toggle Outputs" (table v1.0): receive only, value 0. */
const toggleOutputs = (id) => frame(id, CMD.PARAMS_TO_DEVICE, encodeParam(12, 63, 0));
const saveSetup = (id, n) => frame(id, CMD.SETUP, [0x09 + n]);
const loadFactory = (id) => frame(id, CMD.SETUP, [0x13]);
/** Ask for EQ preset n (1–20): the unit answers with its flags word, its data and its name. */
const requestEqPreset = (id, n) => frame(id, CMD.REQUEST, [0x09 + n]);

/*
 * EQ presets (RME table, "Sending EQ-Presets to the device"): preset data goes to address 13
 * (left bands + Bass/Treble) and 14 (right bands) and is held in a temporary memory; the flags
 * word, sent last as a separate message, stores it into the slot it names.
 * Flags word: bits 8–4 = preset number (0–19), bit 0 = Dual EQ; from the unit, all four low bits
 * set = empty slot. The unit sends the flags word at index 1 and stores a preset when it receives
 * the flags word at index 2; a flags word received at index 1 is ignored.
 */
const PRESET_ADDR_L = 13, PRESET_ADDR_R = 14, PRESET_FLAG_IDX = 1, PRESET_STORE_IDX = 2;
/*
 * Preset data is what the unit sends for a preset: bands 3–19 on both addresses, Bass/Treble
 * gain/freq/Q 21–26 on the left one. B/T Enable (20) and "Load B/T with preset" (27) are output
 * settings and are never sent in a store: an ADI-2 Pro EX switches MIDI Control off when they are.
 */
const PRESET_BT_IDX = [21, 22, 23, 24, 25, 26];
const PRESET_IDX_R = Array.from({ length: 17 }, (_, i) => i + 3); // 3–19: bands
const PRESET_IDX_L = [...PRESET_IDX_R, ...PRESET_BT_IDX];
const PRESET_NAME_LEN = 14;
function decodePresetFlag(value) {
  const empty = (value & 0xf) === 0xf;
  return { n: ((value >> 4) & 0x1f) + 1, empty, dual: !empty && (value & 1) === 1 };
}
const encodePresetFlag = (n, dual) => ((n - 1) << 4) | (dual ? 1 : 0);
/** Name as the unit sends it: right-aligned in 14 characters, then 00 00. */
function presetName(name) {
  const clean = String(name || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, PRESET_NAME_LEN);
  return [...Buffer.from(clean.padStart(PRESET_NAME_LEN, ' '), 'ascii'), 0, 0];
}
/** Messages that store an EQ preset: data, then the flags word. L/R: { eqIndex: value }. */
function storeEqPreset(id, n, { L, R, dual }) {
  const params = [];
  for (const i of PRESET_IDX_L) if (L[i] !== undefined) params.push({ addr: PRESET_ADDR_L, idx: i, value: L[i] });
  for (const i of PRESET_IDX_R) if (R[i] !== undefined) params.push({ addr: PRESET_ADDR_R, idx: i, value: R[i] });
  return [
    ...paramsToDevice(id, params),
    frame(id, CMD.PARAMS_TO_DEVICE, encodeParam(PRESET_ADDR_L, PRESET_STORE_IDX, encodePresetFlag(n, dual))),
  ];
}
const nameEqPreset = (id, n, name) => frame(id, CMD.SETUP_NAME, [n, ...presetName(name)]);
/** Setup n (1–9) name, same format as preset names (table: 06 21..29). */
const nameSetup = (id, n, name) => frame(id, CMD.SETUP_NAME, [0x20 + n, ...presetName(name)]);

/*
 * Status message (command 07, about once a second). RME MIDI table v1.0, "Status" sheet; byte
 * numbers there count from the first header byte, so table byte 6 = data[0].
 *   byte 6     bit 1–0 active output (DAC) / active output of channel 1/2 (Pro),
 *              bit 3–2 device revision, bit 5–4 active line output, bit 6 Phones 3/4 active
 *   7–10       IOStatus1, 28-bit word (4 × 7 bit, first byte = bits 6–0); same for IOStatus2
 *   11–14      IOStatus2, 28-bit word
 *   15         bit 2–0 current device mode, bit 3 balanced mode, bit 6–4 DSD decode on outputs
 *   16         bit 3–0 protocol revision, bit 4 8-channel mode (ADI-2 Pro, ADI-2/4)
 *   17         bit 4–0 sample rate in DAC mode, bit 5 Penta plug detected (ADI-2/4)
 *   18         bit 2–0 bit test detected, bit 3 DC detected on the line outputs, bit 4 on phones
 * Device revision 1 on an ADI-2/4 (ID 0x73) is the ADI-2/4 Pro EX. Bytes after 18 are kept in
 * `extra`.
 *
 * IOStatus1: 0/1 lock AES/SPDIF, 2/3 sync AES/SPDIF, 4 SPDIF input optical, 5 ADAT detected,
 *   7–6 clock source, 11–8 AES input rate, 15–12 SPDIF input rate, 20–16 internal rate (the
 *   table gives the codes for the inputs only; the ADI-2 Pro EX uses the same for the internal
 *   rate at 44.1, 48 and 96 kHz), 21 Phones 1 plug, 25/26 over current Phones 1/2, 27 Phones 2
 *   plug. Byte 17's DAC-mode sample rate has no code list in the table; it is passed on as is.
 * IOStatus2: 0/1 High Load, 2–7 DSD on USB/Line/Phones/digital outputs/AES/SPDIF,
 *   8/9 24 bit, 10/11 professional, 12/13 emphasis, 16/17 non-audio (AES/SPDIF),
 *   18/19 DC error Phones 1/2, 24 power fail.
 */
function word28(b) { return (b[0] & 0x7f) | ((b[1] & 0x7f) << 7) | ((b[2] & 0x7f) << 14) | ((b[3] & 0x7f) << 21); }
/** Sample rate codes in IOStatus1 (bits 11–8 AES, 15–12 SPDIF, 20–16 internal) in Hz; null = n.d. or beyond the table's list. */
const RATE_CODES = [32000, 44100, 48000, null, 64000, 88200, 96000, null, 128000, 176400, 192000];
const CLOCKS = ['internal', 'AES', 'SPDIF', 'internal'];
function parseStatus(data) {
  if (!data || data.length < 11) return null;
  const b6 = data[0], b15 = data[9], b16 = data[10];
  const io1 = word28(data.slice(1, 5)), io2 = word28(data.slice(5, 9));
  const bit = (w, n) => !!((w >> n) & 1);
  const input = (n, rateAt) => {
    const lock = bit(io1, n), sync = bit(io1, n + 2);
    return {
      lock, sync,
      rate: lock ? RATE_CODES[(io1 >> rateAt) & 0xf] ?? null : null,
      bits24: bit(io2, 8 + n), professional: bit(io2, 10 + n), emphasis: bit(io2, 12 + n), nonAudio: bit(io2, 16 + n), dsd: bit(io2, 6 + n),
    };
  };
  const has = (i) => data.length > i;
  return {
    hex: hex(data),
    activeOut: b6 & 0x3,
    revision: (b6 >> 2) & 0x3,
    activeLine: (b6 >> 4) & 0x3,
    ph34Active: !!(b6 & 0x40),
    io1,
    io2,
    mode: b15 & 0x7,
    balanced: !!(b15 & 0x8),
    dsd: (b15 >> 4) & 0x7,
    protocol: b16 & 0xf,
    eightChannel: !!(b16 & 0x10),
    aes: input(0, 8),
    spdif: { ...input(1, 12), optical: bit(io1, 4) },
    adat: bit(io1, 5),
    clock: CLOCKS[(io1 >> 6) & 0x3],
    internalRate: RATE_CODES[(io1 >> 16) & 0x1f] ?? null,
    highLoad: [bit(io2, 0), bit(io2, 1)],
    phones: {
      ph12: { plug: bit(io1, 21), overCurrent: bit(io1, 25), dcError: bit(io2, 18) },
      ph34: { plug: bit(io1, 27), overCurrent: bit(io1, 26), dcError: bit(io2, 19) },
    },
    dsdOn: { usb: bit(io2, 2), line: bit(io2, 3), phones: bit(io2, 4), digital: bit(io2, 5) },
    powerFail: bit(io2, 24),
    dacModeRateCode: has(11) ? data[11] & 0x1f : null,
    penta: has(11) ? !!(data[11] & 0x20) : null,
    bitTest: has(12) ? data[12] & 0x7 : null,
    dcLine: has(12) ? !!(data[12] & 0x08) : null,
    dcPhones: has(12) ? !!(data[12] & 0x10) : null,
    extra: hex(data.slice(13)),
  };
}

/**
 * Digital inputs: `true` while the AES input / the SPDIF input chosen under SPDIF In (coax or
 * optical, `spdifOptical`) is locked to a valid signal – also when the source is stopped or
 * muted. Sync without lock occurs for a moment during a sample rate change; the previous value
 * stays then. The ADI-2 DAC has no AES input (`aes` false). Matches the ADI-2 Pro EX captures in
 * test/protocol.test.js; not tried on the other models. IOStatus1 bit 5 "ADAT detected" is not
 * used: in the captures it is set at times with nothing connected.
 */
function digitalInputs(info, model, prev) {
  if (!info) return null;
  const sig = (x, old) => (x.lock ? true : x.sync ? (old ?? null) : false);
  const dac = model === 'dac';
  return {
    aes: dac ? false : sig(info.aes, prev && prev.aes), spdif: sig(info.spdif, prev && prev.spdif), spdifOptical: info.spdif.optical,
    aesRate: dac ? null : info.aes.rate, spdifRate: info.spdif.rate,
  };
}

/**
 * Headphone jacks: a plug is in Phones 1/2 / 3/4 (IOStatus1 "Phones 1 plug" / "Phones 2 plug").
 * Matches the ADI-2 Pro EX captures in test/protocol.test.js. `null` on the ADI-2 DAC, whose
 * jacks (Phones, IEM) the table does not assign to the two bits.
 */
function phoneJacks(info, model) {
  if (!info || model === 'dac') return null;
  return { ph12: info.phones.ph12.plug, ph34: info.phones.ph34.plug };
}

/** Parse a complete SysEx message. Returns null if it is not an RME ADI-2 message. */
function parse(buf) {
  if (buf.length < 7 || buf[0] !== 0xf0 || buf[buf.length - 1] !== 0xf7) return null;
  if (buf[1] !== 0x00 || buf[2] !== 0x20 || buf[3] !== 0x0d) return null;
  const id = buf[4];
  const cmd = buf[5];
  const data = Array.from(buf.subarray(6, buf.length - 1));
  const msg = { id, cmd, data };
  if (cmd === CMD.PARAMS_TO_REMOTE || cmd === CMD.PARAMS_TO_DEVICE) {
    msg.params = [];
    for (let i = 0; i + 2 < data.length; i += 3) msg.params.push(decodeParam(data[i], data[i + 1], data[i + 2]));
  } else if (cmd === CMD.PRESET_NAME) {
    // <number> <name, padded with spaces> 00 …   1–20 = EQ preset, 0x21–0x29 = setup 1–9
    const slot = data[0];
    let name = '';
    for (const b of data.slice(1)) { if (b === 0) break; if (b >= 0x20 && b < 0x7f) name += String.fromCharCode(b); }
    name = name.trim();
    if (slot >= 0x21 && slot <= 0x29) msg.setup = { n: slot - 0x20, name };
    else if (slot >= 1 && slot <= 20) msg.eqPreset = { n: slot, name };
    else msg.name = { slot, name };
  }
  return msg;
}

/** Splits a raw MIDI byte stream into complete SysEx messages. */
class SysexSplitter {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buf = null;
  }
  push(chunk) {
    for (const b of chunk) {
      if (b === 0xf0) {
        this.buf = [b];
      } else if (this.buf) {
        if (b === 0xf7) {
          this.buf.push(b);
          const m = Buffer.from(this.buf);
          this.buf = null;
          this.onMessage(m);
        } else if (b >= 0xf8) {
          // real-time byte inside SysEx: ignore
        } else if (b & 0x80) {
          this.buf = null; // aborted SysEx
        } else {
          this.buf.push(b);
          if (this.buf.length > 4096) this.buf = null;
        }
      }
    }
  }
}

/** Short plain description of a message (for logs and the silence report). */
function describe(buf) {
  const m = parse(buf);
  if (!m) return 'not an ADI-2 message';
  const d = m.data;
  switch (m.cmd) {
    case CMD.REQUEST:
      if (d[0] === REQ_ALL) return 'read all settings';
      if (d[0] >= 0x0a && d[0] <= 0x1d) return `read EQ preset ${d[0] - 0x09}`;
      return `request ${hex(d)}`;
    case CMD.SETUP:
      if (d[0] >= 1 && d[0] <= 9) return `load setup ${d[0]}`;
      if (d[0] >= 0x0a && d[0] <= 0x12) return `save setup ${d[0] - 0x09}`;
      if (d[0] === 0x13) return 'load factory defaults';
      return `setup command ${hex(d)}`;
    case CMD.SETUP_NAME: {
      const name = Buffer.from(d.slice(1).filter((b) => b >= 0x20 && b < 0x7f)).toString('ascii').trim();
      if (d[0] >= 1 && d[0] <= 20) return `name EQ preset ${d[0]} "${name}"`;
      if (d[0] >= 0x21 && d[0] <= 0x29) return `name setup ${d[0] - 0x20} "${name}"`;
      return `name ${hex(d)}`;
    }
    case CMD.PARAMS_TO_DEVICE: {
      const flag = m.params.find((p) => p.addr === PRESET_ADDR_L && p.idx === (m.cmd === CMD.PARAMS_TO_DEVICE ? PRESET_STORE_IDX : PRESET_FLAG_IDX));
      if (flag) { const f = decodePresetFlag(flag.value); return `store EQ preset ${f.n}${f.dual ? ' (dual)' : ''} (flags word)`; }
      if (m.params.every((p) => p.addr === PRESET_ADDR_L || p.addr === PRESET_ADDR_R)) return `EQ preset data (${m.params.length} values)`;
      const list = m.params.map((p) => `${p.addr}.${p.idx}=${p.value}`);
      return `set ${list.slice(0, 8).join(' ')}${list.length > 8 ? ` … (${list.length})` : ''}`;
    }
    default:
      return `command ${m.cmd}`;
  }
}

const hex = (buf) => Array.from(buf, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
function unhex(s) {
  const clean = String(s).replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('odd number of hex digits');
  return Buffer.from(clean, 'hex');
}

module.exports = {
  CMD, REQ_ALL, DEVICE_IDS, MODEL_BY_ID, DEVICE_ADDR, MAX_PARAMS_PER_MSG,
  isFreq, encodeFreq, decodeFreq, encodeParam, decodeParam,
  frame, paramsToDevice, requestAll, loadSetup, toggleOutputs, saveSetup, loadFactory,
  requestEqPreset, decodePresetFlag, encodePresetFlag, storeEqPreset, nameEqPreset, nameSetup, presetName,
  PRESET_ADDR_L, PRESET_ADDR_R, PRESET_FLAG_IDX, PRESET_STORE_IDX, PRESET_IDX_L, PRESET_IDX_R, PRESET_BT_IDX, PRESET_NAME_LEN,
  parse, parseStatus, describe, SysexSplitter, hex, unhex, digitalInputs, phoneJacks,
};
