// Headphone EQ core: parsing, smoothing, filter maths, fitting and exports.

// Frequency grid

export const PER_OCT = 48;
export const F_MIN = 20, F_MAX = 20000;

export function makeGrid() {
  const n = Math.round(Math.log2(F_MAX / F_MIN) * PER_OCT) + 1;
  return Float64Array.from({ length: n }, (_, i) => F_MIN * 2 ** (i / PER_OCT));
}

// Parsing

// Comma, semicolon, tab or space separated; non-numeric lines skipped.
export function parseResponse(text) {
  const f = [], v = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || /^[*#;/]/.test(s)) continue;
    const cols = s.split(/[\s,;]+/).filter(Boolean);
    if (cols.length < 2) continue;
    const a = Number(cols[0]), b = Number(cols[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) continue;
    f.push(a); v.push(b);
  }
  if (f.length < 10) throw new Error('Could not find frequency / level columns in that file.');
  const idx = f.map((_, i) => i).sort((i, j) => f[i] - f[j]);
  return { f: idx.map(i => f[i]), v: idx.map(i => v[i]) };
}

// Log-frequency linear interpolation.
export function interpolate(resp, grid) {
  const { f, v } = resp;
  const out = new Float64Array(grid.length);
  let j = 0;
  for (let i = 0; i < grid.length; i++) {
    const x = grid[i];
    if (x <= f[0]) { out[i] = v[0]; continue; }
    if (x >= f[f.length - 1]) { out[i] = v[v.length - 1]; continue; }
    while (f[j + 1] < x) j++;
    const t = Math.log(x / f[j]) / Math.log(f[j + 1] / f[j]);
    out[i] = v[j] + t * (v[j + 1] - v[j]);
  }
  return out;
}

// 1/n-octave boxcar smoothing.
export function smooth(vals, fraction) {
  if (!fraction) return Float64Array.from(vals);
  const half = Math.max(1, Math.round(PER_OCT / fraction / 2));
  const n = vals.length, out = new Float64Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + vals[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

export function meanAround(vals, grid, fc, octaves = 1 / 3) {
  let s = 0, c = 0;
  const lo = fc / 2 ** (octaves / 2), hi = fc * 2 ** (octaves / 2);
  for (let i = 0; i < grid.length; i++) if (grid[i] >= lo && grid[i] <= hi) { s += vals[i]; c++; }
  return c ? s / c : 0;
}

// Biquad filters (RBJ Audio EQ Cookbook)

function coeffs(type, f0, gain, q, fs) {
  const A = 10 ** (gain / 40);
  const w0 = 2 * Math.PI * Math.min(f0, fs * 0.499) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peak') {
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  } else if (type === 'lowshelf') {
    const s = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) - (A - 1) * cw + s);
    b1 = 2 * A * ((A - 1) - (A + 1) * cw);
    b2 = A * ((A + 1) - (A - 1) * cw - s);
    a0 = (A + 1) + (A - 1) * cw + s;
    a1 = -2 * ((A - 1) + (A + 1) * cw);
    a2 = (A + 1) + (A - 1) * cw - s;
  } else if (type === 'highshelf') {
    const s = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + s);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - s);
    a0 = (A + 1) - (A - 1) * cw + s;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - s;
  } else throw new Error('Unknown filter type ' + type);
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

export function makeTrig(grid, fs) {
  const c1 = new Float64Array(grid.length), c2 = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const w = 2 * Math.PI * grid[i] / fs;
    c1[i] = Math.cos(w); c2[i] = Math.cos(2 * w);
  }
  return { c1, c2 };
}

export function filterDb(band, trig, fs, out) {
  const n = trig.c1.length;
  out = out || new Float64Array(n);
  if (!band.gain && band.type !== 'none') { out.fill(0); return out; }
  const [b0, b1, b2, a1, a2] = coeffs(band.type, band.f, band.gain, band.q, fs);
  const nb = b0 * b0 + b1 * b1 + b2 * b2, kb1 = 2 * (b0 * b1 + b1 * b2), kb2 = 2 * b0 * b2;
  const na = 1 + a1 * a1 + a2 * a2, ka1 = 2 * (a1 + a1 * a2), ka2 = 2 * a2;
  for (let i = 0; i < n; i++) {
    const num = nb + kb1 * trig.c1[i] + kb2 * trig.c2[i];
    const den = na + ka1 * trig.c1[i] + ka2 * trig.c2[i];
    out[i] = 10 * Math.log10(num / den);
  }
  return out;
}

// Device profiles

// ADI-2 frequency steps (breakpoints approximated).
function adiFreqStep(f) { return f < 1000 ? 1 : f < 10000 ? 10 : 100; }

export function buildSlots(opt) {
  const slots = [];
  if (opt.device === 'adi2') {
    const g = 12;
    const q = (lo, hi) => ({ qMin: lo, qMax: hi, qStep: 0.1 });
    const base = { gMin: -g, gMax: g, gStep: 0.5, fStep: adiFreqStep };
    slots.push({ id: 'B1', label: 'Band 1', type: opt.band1Type, fMin: 20, fMax: 20000, ...q(0.5, 9.9), ...base });
    slots.push({ id: 'B2', label: 'Band 2', type: 'peak', fMin: 20, fMax: 20000, ...q(0.5, 9.9), ...base });
    slots.push({ id: 'B3', label: 'Band 3', type: 'peak', fMin: 20, fMax: 20000, ...q(0.5, 9.9), ...base });
    slots.push({ id: 'B4', label: 'Band 4', type: 'peak', fMin: 200, fMax: 20000, ...q(0.5, 5.0), ...base });
    const b5shelf = opt.band5Type === 'highshelf' || (opt.slowComp && opt.slowBand === 'B5');
    slots.push({ id: 'B5', label: 'Band 5', type: b5shelf ? 'highshelf' : 'peak', fMin: 200, fMax: 20000, ...q(0.5, 5.0), ...base });
    if (opt.useBT) {
      slots.push({ id: 'BB', label: 'Bass', type: 'lowshelf', fMin: 20, fMax: 150, ...q(0.5, 1.5), ...base, fStep: () => 1 });
      slots.push({ id: 'BT', label: 'Treble', type: 'highshelf', fMin: 3000, fMax: 10000, ...q(0.5, 1.5), ...base, fStep: () => 100 });
    }
  } else {
    // TotalMix Room EQ: band 1 low shelf, bands 2–8 peak, band 9 high shelf.
    const base = { fMin: 20, fMax: 20000, fStep: () => 1, gMin: -20, gMax: 20, gStep: 0.1, qMin: 0.4, qMax: 9.9, qStep: 0.1 };
    for (let i = 1; i <= 9; i++) {
      const type = i === 1 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peak';
      slots.push({ id: 'R' + i, label: 'Band ' + i, type, ...base });
    }
  }
  // Shelves only where they make sense: low shelf for bass, high shelf for the top end.
  for (const s of slots) {
    if (s.type === 'lowshelf') s.fMax = Math.min(s.fMax, 300);
    if (s.type === 'highshelf' && s.fMin < 3000) s.fMin = s.id === 'BT' ? s.fMin : 5000;
  }
  for (const s of slots) {
    s.gMin = Math.max(s.gMin, -opt.maxCut);
    s.gMax = Math.min(s.gMax, opt.maxBoost);
  }
  return slots;
}

export function slowSlotId(opt, slots) {
  if (!opt.slowComp || opt.device !== 'adi2') return null;
  return opt.slowBand === 'BT' && opt.useBT ? 'BT' : 'B5';
}

// Slow filter roll-off model

// 8th-order Butterworth magnitude, -lossAt20k dB at 20 kHz.
export function slowRolloff(grid, lossAt20k) {
  const out = new Float64Array(grid.length);
  if (!(lossAt20k > 0)) return out;
  const n = 4;
  const fc = 20000 / (10 ** (lossAt20k / 10) - 1) ** (1 / (2 * n));
  for (let i = 0; i < grid.length; i++) out[i] = -10 * Math.log10(1 + (grid[i] / fc) ** (2 * n));
  return out;
}

// Analysis + fitting

export const DEFAULTS = {
  app: 'adi2', device: 'adi2',
  limitOn: false, limitHz: 2000, // full-range correction by default; optional cap at limitHz
  slowComp: false, slowBand: 'B5', slowLossDb: 3,
  fLow: 20,
  smoothing: 6,
  refHz: 1000,
  maxBands: 5,
  bassDb: 0, bassHz: 105, tiltDbOct: 0,
  minGainDb: 0.05,
  maxBoost: 6, maxCut: 12,
  useBT: false,
  band1Type: 'lowshelf', band5Type: 'peak',
  fs: 48000,
  quantize: true,
};

export function analyse(meas, target, opt) {
  const grid = makeGrid();
  const raw = interpolate(meas, grid);
  const tgt = target ? interpolate(target, grid) : new Float64Array(grid.length);
  if (opt.bassDb) {
    const shelf = filterDb({ type: 'lowshelf', f: opt.bassHz, gain: opt.bassDb, q: 0.7 }, makeTrig(grid, opt.fs), opt.fs);
    for (let i = 0; i < grid.length; i++) tgt[i] += shelf[i];
  }
  if (opt.tiltDbOct) for (let i = 0; i < grid.length; i++) tgt[i] += opt.tiltDbOct * Math.log2(grid[i] / opt.refHz);
  const offset = meanAround(raw, grid, opt.refHz) - meanAround(tgt, grid, opt.refHz);
  const targetAligned = tgt.map(v => v + offset);
  const error = raw.map((v, i) => v - targetAligned[i]);
  // 1-octave smoothing above 8 kHz (blended from 6 kHz): treble measurements vary with fit.
  const fine = smooth(error, opt.smoothing), coarse = smooth(error, 1);
  const errorSmoothed = fine.map((v, i) => {
    const t = Math.min(1, Math.max(0, Math.log(grid[i] / 6000) / Math.log(8000 / 6000)));
    return v + t * (coarse[i] - v);
  });

  const fHigh = opt.limitOn ? opt.limitHz : F_MAX;
  const roll = opt.slowComp ? slowRolloff(grid, opt.slowLossDb) : new Float64Array(grid.length);

  // Raised-cosine fade over the last 1/3 octave below the limit.
  const fadeStart = fHigh / 2 ** (1 / 3);
  const desired = new Float64Array(grid.length);
  const weight = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const f = grid[i];
    if (f < opt.fLow) { desired[i] = 0; weight[i] = 0.2; continue; }
    if (f <= fHigh) {
      const fade = fHigh >= F_MAX || f <= fadeStart ? 1
        : 0.5 + 0.5 * Math.cos(Math.PI * Math.log(f / fadeStart) / Math.log(fHigh / fadeStart));
      desired[i] = -errorSmoothed[i] * fade - roll[i];
      weight[i] = 1;
    } else {
      desired[i] = -roll[i];
      weight[i] = 1;
    }
    if (f > 10000) weight[i] *= 0.5;
    desired[i] = Math.max(-opt.maxCut, Math.min(opt.maxBoost, desired[i]));
  }
  return { grid, raw, targetAligned, error, errorSmoothed, desired, weight, roll, fHigh };
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Boosts stay broad (narrow measurement peaks/dips depend on fit); cuts may be narrow.
const BOOST_QMAX = 2;
// Small penalty on squared band gains: prefers the smallest EQ that does the job.
const GAIN_PENALTY = 0.002;
// Penalty for broad bands of opposite sign within an octave (bands cancelling each other).
const CONFLICT_PENALTY = 0.01;
const SHELF_QMAX = 1;

// The fit must hold at any playback rate: responses are evaluated at a low
// and a high sample rate and both are scored (bilinear warping near Nyquist).
const FIT_RATES = [44100, 192000];

// Fitting runs on every 2nd grid point (1/24 octave); results are evaluated on the full grid.
const FIT_STRIDE = 2;

export function fit(an, opt) {
  const pick = a => Float64Array.from({ length: Math.ceil(a.length / FIT_STRIDE) }, (_, i) => a[i * FIT_STRIDE]);
  const grid = pick(an.grid), PPO = PER_OCT / FIT_STRIDE;
  const n = grid.length, N = n * FIT_RATES.length;
  const trigs = FIT_RATES.map(fs => makeTrig(grid, fs));
  const desired = new Float64Array(N), weight = new Float64Array(N);
  for (let k = 0; k < FIT_RATES.length; k++) { desired.set(pick(an.desired), k * n); weight.set(pick(an.weight), k * n); }
  const slots = buildSlots(opt);
  const slowId = slowSlotId(opt, slots);
  const budget = Math.min(opt.maxBands, slots.length);

  const bands = [];
  const total = new Float64Array(N);

  const respInto = (b, out) => {
    FIT_RATES.forEach((fs, k) => filterDb(b, trigs[k], fs, out.subarray(k * n, (k + 1) * n)));
    return out;
  };
  const respOf = b => respInto(b, new Float64Array(N));
  const sumTotal = () => { total.fill(0); for (const b of bands) for (let i = 0; i < N; i++) total[i] += b.resp[i]; };

  const GP = opt.gainPenalty ?? GAIN_PENALTY;
  const broad = b => b.type !== 'peak' || b.q <= 2.5;
  const regOf = list => {
    let r = GP * list.reduce((a, b) => a + b.gain * b.gain, 0);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      if (Math.sign(x.gain) === Math.sign(y.gain) || !broad(x) || !broad(y)) continue;
      const d = Math.abs(Math.log2(x.f / y.f));
      if (d < 1) r += CONFLICT_PENALTY * Math.min(x.gain * x.gain, y.gain * y.gain) * (1 - d);
    }
    return r;
  };
  const capQ = b => {
    if (b.type === 'peak' && b.gain > 0 && b.q > BOOST_QMAX) b.q = Math.max(b.slot.qMin, BOOST_QMAX);
    if (b.type !== 'peak' && b.q > SHELF_QMAX) b.q = Math.max(b.slot.qMin, SHELF_QMAX);
    return b;
  };

  function cost(tot, reg = 0) {
    let s = 0, w = 0;
    for (let i = 0; i < N; i++) {
      const d = tot[i] - desired[i];
      s += weight[i] * d * d; w += weight[i];
      // Boost penalty.
      const over = tot[i] - opt.maxBoost;
      if (over > 0) s += 4 * over * over;
    }
    return s / w + reg;
  }

  function optimise(only, quant) {
    const active = only ? [only] : bands;
    const tmp = new Float64Array(N);
    const others = new Float64Array(N);
    let best = cost(total, regOf(bands));
    for (let pass = 0; pass < (quant ? 12 : 60); pass++) {
      let improvedAny = false;
      for (const b of active) {
        let improvedBand = false;
        for (let i = 0; i < N; i++) others[i] = total[i] - b.resp[i];
        const s = b.slot;
        const steps = quant
          ? { f: null, gain: s.gStep, q: s.qStep }
          : b.steps || (b.steps = { lf: 0.25, gain: 1.5, lq: 0.4 });
        const params = quant ? ['f', 'gain', 'q'] : ['lf', 'gain', 'lq'];
        for (const p of params) {
          let improved = true, guard = 0;
          while (improved && guard++ < 40) {
            improved = false;
            for (const dir of [1, -1]) {
              const cand = { ...b };
              if (quant) {
                if (p === 'f') cand.f = clamp(b.f + dir * s.fStep(b.f + (dir < 0 ? -1e-9 : 0)), s.fMin, s.fMax);
                if (p === 'gain') cand.gain = clamp(b.gain + dir * steps.gain, s.gMin, s.gMax);
                if (p === 'q') cand.q = +clamp(b.q + dir * steps.q, s.qMin, s.qMax).toFixed(2);
              } else {
                if (p === 'lf') cand.f = clamp(b.f * 2 ** (dir * steps.lf), s.fMin, s.fMax);
                if (p === 'gain') cand.gain = clamp(b.gain + dir * steps.gain, s.gMin, s.gMax);
                if (p === 'lq') cand.q = clamp(b.q * 2 ** (dir * steps.lq), s.qMin, s.qMax);
              }
              capQ(cand);
              if (cand.f === b.f && cand.gain === b.gain && cand.q === b.q) continue;
              respInto(cand, tmp);
              for (let i = 0; i < N; i++) tmp[i] += others[i];
              const c = cost(tmp, regOf(bands.map(x => (x === b ? cand : x))));
              if (c < best - 1e-9) {
                best = c; b.f = cand.f; b.gain = cand.gain; b.q = cand.q;
                b.resp = respOf(b);
                for (let i = 0; i < N; i++) total[i] = others[i] + b.resp[i];
                improved = true; improvedAny = true; improvedBand = true;
                break;
              }
            }
          }
        }
        if (!quant && !improvedBand) { b.steps.lf /= 2; b.steps.gain /= 2; b.steps.lq /= 2; }
      }
      if (!quant && active.every(b => b.steps.gain < 0.02)) break;
      if (quant && !improvedAny) break;
    }
    return best;
  }

  function seed(slot) {
    const resid = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let t = 0;
      for (let k = 0; k < FIT_RATES.length; k++) t += total[k * n + i];
      resid[i] = (desired[i] - t / FIT_RATES.length) * weight[i];
    }
    const r = smooth(resid, 12 * FIT_STRIDE);
    const lo = Math.max(slot.fMin, opt.fLow), hi = slot.fMax;
    if (slot.type === 'lowshelf') {
      const f = clamp(100, lo, hi);
      return { f, gain: clamp(meanAround(r, grid, Math.min(f, 60), 1), slot.gMin, slot.gMax), q: clamp(0.7, slot.qMin, slot.qMax) };
    }
    if (slot.type === 'highshelf') {
      const f = clamp(slot.id === slowId ? 12000 : Math.max(an.fHigh, 5000), lo, hi);
      return { f, gain: clamp(meanAround(r, grid, 16000, 1), slot.gMin, slot.gMax), q: clamp(0.7, slot.qMin, slot.qMax) };
    }
    // Peaks: the four largest local extremes of the residual, at least 1/2 octave apart.
    const ext = [];
    for (let i = 1; i < n - 1; i++) {
      if (grid[i] < lo || grid[i] > hi) continue;
      const v = Math.abs(r[i]);
      if (v >= Math.abs(r[i - 1]) && v >= Math.abs(r[i + 1]) && v > 0.1) ext.push(i);
    }
    ext.sort((x, y) => Math.abs(r[y]) - Math.abs(r[x]));
    const picks = [];
    for (const i of ext) {
      if (picks.every(j => Math.abs(i - j) >= PPO / 2)) picks.push(i);
      if (picks.length === 4) break;
    }
    return picks.map(bi => {
      const bv = r[bi];
      let a = bi, b = bi;
      while (a > 0 && Math.sign(r[a - 1]) === Math.sign(bv) && Math.abs(r[a - 1]) > Math.abs(bv) / 2) a--;
      while (b < n - 1 && Math.sign(r[b + 1]) === Math.sign(bv) && Math.abs(r[b + 1]) > Math.abs(bv) / 2) b++;
      const bw = Math.max(1 / 6, (b - a) / PPO);
      const q = Math.sqrt(2 ** bw) / (2 ** bw - 1);
      return { f: grid[bi], gain: clamp(bv, slot.gMin, slot.gMax), q: clamp(q, slot.qMin, slot.qMax) };
    });
  }

  function addBand(slot, start) {
    const s = start || [].concat(seed(slot))[0];
    if (!s) return null;
    const b = capQ({ slot, type: slot.type, ...s });
    b.resp = respOf(b);
    bands.push(b);
    sumTotal();
    return b;
  }

  // Roll-off shelf first.
  if (slowId) {
    const slot = slots.find(s => s.id === slowId);
    const b = addBand(slot);
    if (b) optimise(b, false);
  }

  while (bands.length < budget) {
    const free = slots.filter(s => !bands.some(b => b.slot === s));
    if (!free.length) break;
    let bestSlot = null, bestCost = cost(total, regOf(bands)), bestState = null;
    const snapshot = bands.map(b => ({ ...b, resp: b.resp }));
    // Among slots that do (almost) equally well, use the most restricted one,
    // so wide-range slots stay free for bands that need them.
    const room = sl => Math.log(sl.fMax / sl.fMin) * (sl.qMax - sl.qMin);
    const tried = [];
    for (const slot of free) {
      for (const start of [].concat(seed(slot)).filter(Boolean)) {
        const b = addBand(slot, start);
        if (!b) continue;
        tried.push({ c: optimise(b, false), slot, state: { ...b } });
        bands.length = 0; bands.push(...snapshot.map(x => ({ ...x }))); sumTotal();
      }
    }
    const minC = Math.min(bestCost, ...tried.map(t => t.c));
    const ok = tried.filter(t => t.c <= minC + 0.01 * minC + 1e-4).sort((x, y) => room(x.slot) - room(y.slot));
    if (ok.length && minC < bestCost) { bestCost = ok[0].c; bestSlot = ok[0].slot; bestState = ok[0].state; }
    if (!bestSlot || bestCost >= cost(total, regOf(bands)) - 1e-6) break;
    const b = { ...bestState, steps: null };
    b.resp = respOf(b);
    bands.push(b);
    sumTotal();
    for (const x of bands) x.steps = null;
    optimise(null, false);
  }

  // Refinement: replace each band by the best alternative (any free slot, any start) if that helps.
  for (let round = 0; round < 2; round++) {
    let changed = false;
    for (let idx = 0; idx < bands.length; idx++) {
      const old = bands[idx];
      const base = cost(total, regOf(bands));
      const rest = bands.filter((_, k) => k !== idx).map(x => ({ ...x }));
      bands.length = 0; bands.push(...rest); sumTotal();
      const free = slots.filter(s => !bands.some(x => x.slot === s));
      let best = null;
      for (const slot of free) for (const start of [].concat(seed(slot)).filter(Boolean)) {
        const nb = addBand(slot, start);
        if (!nb) continue;
        const c = optimise(nb, false);
        if (!best || c < best.c) best = { c, state: { ...nb } };
        bands.length = 0; bands.push(...rest.map(x => ({ ...x }))); sumTotal();
      }
      const better = best && best.c < base - 1e-4;
      const keep = better ? { ...best.state, steps: null } : { ...old };
      keep.resp = respOf(keep);
      bands.splice(idx, 0, keep); sumTotal();
      if (better) {
        for (const x of bands) x.steps = null;
        optimise(null, false);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Pruning: drop bands whose removal (after refitting the rest) costs less than minGainDb.
  for (;;) {
    const withAll = Math.sqrt(cost(total, regOf(bands)));
    let bestDrop = null;
    const saved = bands.map(x => ({ ...x }));
    for (let idx = 0; idx < saved.length; idx++) {
      bands.length = 0; bands.push(...saved.filter((_, k) => k !== idx).map(x => ({ ...x, steps: null }))); sumTotal();
      const c = Math.sqrt(optimise(null, false));
      if (c - withAll < opt.minGainDb && (!bestDrop || c < bestDrop.c)) bestDrop = { c, state: bands.map(x => ({ ...x })) };
    }
    bands.length = 0;
    if (!bestDrop) { bands.push(...saved); sumTotal(); break; }
    bands.push(...bestDrop.state); sumTotal();
  }

  if (opt.quantize) {
    for (const b of bands) {
      const s = b.slot;
      const st = s.fStep(b.f);
      b.f = clamp(Math.round(b.f / st) * st, s.fMin, s.fMax);
      b.gain = clamp(Math.round(b.gain / s.gStep) * s.gStep, s.gMin, s.gMax);
      b.q = +clamp(Math.round(b.q / s.qStep) * s.qStep, s.qMin, s.qMax).toFixed(2);
      capQ(b);
      b.resp = respOf(b);
    }
    sumTotal();
    optimise(null, true);
  }

  const used = bands.filter(b => Math.abs(b.gain) >= (opt.quantize ? b.slot.gStep : 0.05));
  const filters = slots
    .map(s => used.find(b => b.slot === s))
    .filter(Boolean)
    .map(b => ({
      id: b.slot.id, label: b.slot.label, type: b.type,
      f: b.f, gain: +b.gain.toFixed(2), q: +b.q.toFixed(2),
      slow: b.slot.id === slowId,
    }));
  if (opt.device === 'totalmix') {
    // Shelves keep bands 1 and 9; peaks are numbered from low to high in between.
    let k = 2;
    filters.filter(f => f.type === 'peak').sort((x, y) => x.f - y.f).forEach(f => { f.id = 'R' + k; f.label = 'Band ' + k++; });
    filters.sort((x, y) => +x.id.slice(1) - +y.id.slice(1));
  }

  const { eq, perFilter } = evaluate(an, filters, opt);
  return { filters, perFilter, eq, slots };
}

export function evaluate(an, filters, opt) {
  const trig = makeTrig(an.grid, opt.fs);
  const n = an.grid.length, eq = new Float64Array(n);
  const perFilter = filters.map(fl => {
    const r = fl.off ? new Float64Array(n) : filterDb(fl, trig, opt.fs);
    for (let i = 0; i < n; i++) eq[i] += r[i];
    return r;
  });
  return { eq, perFilter };
}

export function stats(an, eq) {
  const { grid, errorSmoothed, roll } = an;
  const hi = an.fHigh >= F_MAX ? F_MAX : an.fHigh / 2 ** (1 / 3);
  let b = 0, a = 0, c = 0, maxEq = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    maxEq = Math.max(maxEq, eq[i]);
    if (grid[i] > hi) continue;
    const before = errorSmoothed[i] + roll[i];
    const after = before + eq[i];
    b += before * before; a += after * after; c++;
  }
  return { rmsBefore: Math.sqrt(b / c), rmsAfter: Math.sqrt(a / c), maxBoost: maxEq, preamp: -Math.max(0, maxEq) };
}

// Exports

const APO_TYPE = { peak: 'PK', lowshelf: 'LSC', highshelf: 'HSC' };

// ADI-2 Remote preset. Band type codes 0 = Peak, 1 = Shelf (assumed).
export function toADI2(filters, { slot = 1, name = 'Preset', root = 'ADI-2DAC' } = {}) {
  const get = id => filters.find(f => f.id === id && !f.off);
  const v = x => `${Number(x).toFixed(2)},`;
  const val = (e, x) => `\t\t<val e="${e}" v="${v(x)}"/>`;
  const band = (i, withType) => {
    const fl = get('B' + i);
    const out = [];
    if (withType) out.push(val(`EQBand${i}Type`, fl && fl.type !== 'peak' ? 1 : 0));
    out.push(val(`EQBand${i}Gain`, fl ? fl.gain : 0));
    out.push(val(`EQBand${i}Freq`, fl ? fl.f : [100, 300, 1000, 3000, 10000][i - 1]));
    out.push(val(`EQBand${i}Q`, fl ? fl.q : 1));
    return out;
  };
  const bands = [...band(1, true), ...band(2), ...band(3), ...band(4), ...band(5, true)];
  const bass = get('BB'), treble = get('BT');
  const useBT = !!(bass || treble);
  const left = [
    val('EQEnable', 1),
    ...bands,
    val('BassTrebleEn', useBT ? 1 : 0),
    val('EQBassGain', bass ? bass.gain : 0),
    val('EQBassFreq', bass ? bass.f : 85),
    val('EQBassQ', bass ? bass.q : 0.9),
    val('EQTrebleGain', treble ? treble.gain : 0),
    val('EQTrebleFreq', treble ? treble.f : 6500),
    val('EQTrebleQ', treble ? treble.q : 0.7),
    val('DualEQ', 0),
    val('EQ Preset Select', 0),
    val('Load BT w. EQ', useBT ? 1 : 0),
  ];
  const right = [val('EQEnable', 1), ...bands];
  const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return [
    `<${root}>`,
    '\t<General>',
    '\t\t<val e="Version" v="2"/>',
    '\t</General>',
    `\t<EQPreset${slot}Left>`, ...left, `\t</EQPreset${slot}Left>`,
    `\t<EQPreset${slot}Right>`, ...right, `\t</EQPreset${slot}Right>`,
    '\t<PresetNames>',
    `\t\t<val e="EQPresetName${slot}" v="${esc(String(name).slice(0, 15))}"/>`,
    '\t</PresetNames>',
    `</${root}>`,
    '',
  ].join('\n');
}

export function toCSV(an, eq) {
  const rows = ['frequency,raw,target,error_smoothed,equalization,equalized'];
  for (let i = 0; i < an.grid.length; i++) {
    rows.push([an.grid[i].toFixed(2), an.raw[i].toFixed(2), an.targetAligned[i].toFixed(2),
      an.errorSmoothed[i].toFixed(2), eq[i].toFixed(2), (an.raw[i] + eq[i]).toFixed(2)].join(','));
  }
  return rows.join('\n') + '\n';
}

// TotalMix FX Room EQ preset (.tmreq). Band 1/9 type: 1 = shelf, 0 = peak.
export function toTMREQ(filters, preampDb) {
  const act = filters.filter(f => !f.off);
  const byId = id => act.find(f => f.id === id);
  const spare = [80, 160, 320, 640, 1250, 2500, 5000, 10000, 15000];
  const v = x => `${Number(x).toFixed(2)},`;
  const val = (e, x) => `\t\t\t<val e="${e}" v="${v(x)}"/>`;
  const params = [val('REQ Delay', 0)];
  for (let i = 1; i <= 9; i++) {
    const f = byId('R' + i) || { f: spare[i - 1], gain: 0, q: i === 1 || i === 9 ? 0.7 : 1, type: i === 1 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peak' };
    params.push(val(`REQ Band${i} Freq`, Math.round(f.f)), val(`REQ Band${i} Q`, f.q), val(`REQ Band${i} Gain`, f.gain));
  }
  const shelf = id => { const f = byId(id); return f ? (f.type === 'peak' ? 0 : 1) : 1; };
  params.push(val('REQ Band1Type', shelf('R1')), val('REQ Band8 Type', 0), val('REQ Band9 Type', shelf('R9')),
    val('Chan Gain', Math.min(0, Math.floor(preampDb * 2) / 2)));
  const ch = side => [`\t<Room EQ ${side}>`, '\t\t<Params>', ...params, '\t\t</Params>', `\t</Room EQ ${side}>`];
  return ['<Preset>', ...ch('L'), ...ch('R'), '</Preset>', ''].join('\n');
}

export function toTextTable(filters, title) {
  const name = { peak: 'Peak', lowshelf: 'Low shelf', highshelf: 'High shelf' };
  const hz = f => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);
  const act = filters.filter(f => !f.off);
  const rows = act.map(f => [f.label, name[f.type], hz(f.f), `${f.gain > 0 ? '+' : ''}${f.gain.toFixed(1)} dB`, f.q.toFixed(2)]);
  const head = ['Band', 'Type', 'Freq', 'Gain', 'Q'];
  const w = head.map((h, c) => Math.max(h.length, ...rows.map(r => r[c].length)));
  const fmt = r => r.map((v, c) => (c >= 2 ? v.padStart(w[c]) : v.padEnd(w[c]))).join('  ');
  return (title ? title + '\n' : '') + [fmt(head), w.map(x => '-'.repeat(x)).join('  '), ...rows.map(fmt)].join('\n') + '\n';
}

