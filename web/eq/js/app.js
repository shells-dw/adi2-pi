import * as C from './core.js';

// page language (web/i18n.js); English without it
const tr = (k, v) => (globalThis.I18N ? globalThis.I18N.tr(k, v) : k);

// Data

const EMBED = globalThis.HPEQ_EMBED || null;
let INDEX = null;
const csvCache = new Map();

async function loadIndex() {
  if (EMBED) return EMBED.index;
  const msg = tr('Could not load the headphone list from the ADI-2-Pi.');
  const r = await fetch('/api/eq/index', { cache: 'no-cache' }).catch(() => { throw new Error(msg); });
  if (!r.ok) throw new Error(msg);
  return r.json();
}

async function loadCsv(path) {
  if (csvCache.has(path)) return csvCache.get(path);
  let text;
  if (EMBED && EMBED.files[path]) text = EMBED.files[path];
  else {
    // measurements are stored on the Pi (shipped, or updated on request)
    const r = await fetch(`/api/eq/file?path=${encodeURIComponent(path)}`)
      .catch(() => { throw new Error(tr('Cannot reach the ADI-2-Pi.')); });
    if (!r.ok) {
      let msg = tr('Could not load {0}.', [path.split('/').pop()]);
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    text = await r.text();
  }
  const parsed = C.parseResponse(text);
  csvCache.set(path, parsed);
  return parsed;
}

// State

const STORE_KEY = 'hpeq.v1';
const OPT_KEYS = Object.keys(C.DEFAULTS);
const APPS = { // equalizer targets
  adi2: { device: 'adi2', out: 'adi', hint: () => tr('Gain ±12 dB, 0.5 dB steps. Q 0.5–9.9 (bands 4/5: 0.5–5.0, from 200 Hz).') },
  totalmix: { device: 'totalmix', out: 'totalmix', hint: () => tr('Band 1 low shelf, bands 2–8 peak, band 9 high shelf. ±20 dB, Q 0.4–9.9.') },
};
const COMMON_OUT = ['table', 'png', 'csv'];

// Fit options derived from the selected app.
function effective(o) {
  const a = APPS[o.app] || APPS.adi2;
  const e = { ...o, device: a.device };
  if (e.device !== 'adi2') e.slowComp = false;
  e.maxBands = Math.min(slotCount(e), Math.max(1, Math.round(o.maxBands)));
  return e;
}
const CHARTS = ['meas', 'eq', 'result'];

const state = {
  opt: { ...C.DEFAULTS },
  hp: null,
  target: null,
  targetAuto: true,
  adiSlot: 1,
  adiName: '',
  form: 'all',
  show: { meas: false, eq: false, result: true },
  result: null,
  filters: [],
  edited: false,
  pendingEdits: null,
};

function snapshot() {
  return {
    opt: state.opt,
    hp: state.hp && state.hp.kind === 'repo' ? state.hp.path : null,
    target: state.target && state.target.kind === 'repo' && !state.targetAuto ? state.target.path : null,
    adiSlot: state.adiSlot,
    show: state.show,
    edits: state.edited ? state.filters.map(f => [f.id, f.type, f.f, f.gain, f.q, f.off ? 1 : 0]) : null,
  };
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(snapshot())); } catch {}
}

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch { return null; }
}

function applySaved(s) {
  if (!s) return;
  if (s.opt) for (const k of OPT_KEYS) if (k in s.opt && typeof s.opt[k] === typeof C.DEFAULTS[k]) state.opt[k] = s.opt[k];
  if (!APPS[state.opt.app]) state.opt.app = C.DEFAULTS.app;
  for (const [k, ok] of [['band1Type', ['peak', 'lowshelf']], ['band5Type', ['peak', 'highshelf']], ['slowBand', ['B5', 'BT']]])
    if (!ok.includes(state.opt[k])) state.opt[k] = C.DEFAULTS[k];
  if (![3, 6, 12, 24].includes(state.opt.smoothing)) state.opt.smoothing = C.DEFAULTS.smoothing;
  if (s.adiSlot) state.adiSlot = s.adiSlot;
  if (s.show) for (const k of CHARTS) if (k in s.show) state.show[k] = !!s.show[k];
  if (Array.isArray(s.edits)) state.pendingEdits = s.edits;
}

function applySavedRefs(s) {
  if (!s) return;
  if (s.hp) {
    const h = INDEX.headphones.find(x => x.path === s.hp);
    if (h) state.hp = { kind: 'repo', ...h };
  }
  if (s.target) {
    const t = INDEX.targets.find(x => x.path === s.target);
    if (t) { state.target = { kind: 'repo', ...t }; state.targetAuto = false; }
  }
}

// DOM helpers

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
};

function setStatus(msg, isError = false) {
  const s = $('status');
  s.textContent = msg || '';
  s.classList.toggle('error', !!isError);
}

function flash(btn, text) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text; btn.classList.add('done');
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1400);
}

async function copyText(text, btn, fallbackEl) {
  // the clipboard API needs https or localhost; on plain http try the classic copy command first
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); flash(btn, tr('Copied')); return; }
    const ta = document.createElement('textarea');
    ta.value = text; ta.readOnly = true;
    Object.assign(ta.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0' });
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('copy failed');
    flash(btn, tr('Copied'));
  } catch {
    if (fallbackEl) {
      const r = document.createRange(); r.selectNodeContents(fallbackEl);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      flash(btn, tr('Selected, press Ctrl+C'));
    } else flash(btn, tr('Copy failed'));
  }
}

// Non-.txt files as octet-stream, so Safari doesn't append ".txt".
function download(name, content, type = /\.(txt|csv)$/i.test(name) ? 'text/plain' : 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ADI-2 preset names are short (15 characters in ADI-2 Remote's files, 14 on the unit): drop the
// part in brackets, then a brand of up to 3 words in front of the model, then cut.
function presetName(name) {
  let n = name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const words = n.split(' ');
  for (let i = 1; n.length > 15 && i < words.length && i <= 3; i++) {
    if (words[i] === '&') continue; // "Bowers & Wilkins": the brand goes as a whole
    const rest = words.slice(i).join(' ');
    if (rest.length <= 15 || /\d/.test(words[i])) { n = rest; break; }
  }
  return n.slice(0, 15);
}
const safeName = s => s.replace(/[\\/:*?"<>|]+/g, '').trim() || 'eq';
const fmtHz = f => f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`;
const fmtHzLong = f => f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
const TYPE_NAME = { peak: () => tr('Peak'), lowshelf: () => tr('Low shelf'), highshelf: () => tr('High shelf') };
// band names from core.js ("Band 1", "Bass", …) in the page language
const bandName = l => {
  const m = /^(Band|Filter) (\d+)$/.exec(l);
  return !m ? tr(l) : m[1] === 'Band' ? tr('Band {0}', [m[2]]) : tr('Filter {0}', [m[2]]);
};
const formName = f => (f === 'over-ear' ? tr('over-ear') : f === 'in-ear' ? tr('in-ear') : f);
const TYPE_SHORT = { peak: 'PK', lowshelf: 'LS', highshelf: 'HS' };

// Settings

const NUM = ['limitHz', 'slowLossDb', 'maxBands', 'maxBoost', 'maxCut', 'fLow', 'refHz', 'minGainDb',
  'bassDb', 'bassHz', 'tiltDbOct'];
const SEL_NUM = ['smoothing'];
const SEL = ['app', 'slowBand', 'band1Type', 'band5Type'];
const BOOL = ['slowComp', 'useBT', 'quantize'];

function slotCount(o) {
  return o.device === 'adi2' ? (o.useBT ? 7 : 5) : 9;
}

// Selected state of segmented controls and chips (fallback for browsers without CSS :has()).
function syncToggles() {
  document.querySelectorAll('.seg label, .chip').forEach(l => {
    const i = l.querySelector('input');
    if (i) l.classList.toggle('is-on', i.checked);
  });
}

function writeForm() {
  const o = state.opt;
  for (const k of NUM) $(k).value = o[k];
  for (const k of SEL_NUM) $(k).value = String(o[k]);
  for (const k of SEL) $(k).value = o[k];
  for (const k of BOOL) $(k).checked = !!o[k];
  $(o.limitOn ? 'range-cap' : 'range-full').checked = true;
  $('adiSlot').value = state.adiSlot;
  for (const k of CHARTS) $('show-' + k).checked = state.show[k];
  syncVisibility();
  syncToggles();
}

function readForm() {
  const o = state.opt;
  const prev = { app: o.app, useBT: o.useBT };
  for (const k of NUM) {
    const v = parseFloat($(k).value);
    if (Number.isFinite(v)) o[k] = v;
  }
  for (const k of SEL_NUM) o[k] = Number($(k).value);
  for (const k of SEL) o[k] = $(k).value;
  for (const k of BOOL) o[k] = $(k).checked;
  o.limitOn = $('range-cap').checked;
  o.limitHz = Math.min(20000, Math.max(200, o.limitHz));
  o.fLow = Math.min(500, Math.max(20, o.fLow));
  o.bassHz = Math.min(250, Math.max(40, o.bassHz));
  if (o.app !== prev.app) renderOutputVisibility();
  if (o.app !== prev.app || o.useBT !== prev.useBT) {
    o.maxBands = slotCount(effective({ ...o, maxBands: 99 }));
    $('maxBands').value = o.maxBands;
  }
  o.maxBands = effective(o).maxBands;
  state.adiSlot = Math.min(20, Math.max(1, Math.round(Number($('adiSlot').value) || 1)));
}


function syncVisibility() {
  const o = state.opt, a = APPS[o.app] || APPS.adi2, e = effective(o), dev = e.device;
  $('adi-fields').hidden = dev !== 'adi2';
  $('device-hint').textContent = a.hint ? a.hint() : '';
  $('slow-rec').hidden = dev !== 'adi2';
  $('slow-fields').hidden = !o.slowComp;
  $('slow-band-field').hidden = dev !== 'adi2';
  $('slowBand').querySelector('option[value="BT"]').disabled = !o.useBT;
  if (!o.useBT && $('slowBand').value === 'BT') { $('slowBand').value = 'B5'; o.slowBand = 'B5'; }
  $('cap-field').hidden = !o.limitOn;
  $('cap-label').textContent = tr('{0} kHz cap', [+(o.limitHz / 1000).toFixed(1)]);
  $('band5Type').disabled = dev === 'adi2' && o.slowComp && o.slowBand === 'B5';
  $('maxBands').max = slotCount(e);
  const ignore = ['app', 'device', 'maxBands'];
  $('adv-changed').hidden = Object.keys(C.DEFAULTS).every(k => ignore.includes(k) || o[k] === C.DEFAULTS[k])
    && state.targetAuto && (!state.target || state.target.kind === 'repo');
}

function renderOutputVisibility() {
  const primary = APPS[state.opt.app]?.out || 'table';
  document.querySelectorAll('.export[data-out]').forEach(card => {
    const k = card.dataset.out;
    if (k === primary) { $('export-main').append(card); card.hidden = false; }
    else if (COMMON_OUT.includes(k)) { $('export-more').append(card); card.hidden = false; }
    else card.hidden = true;
  });
  for (const k of CHARTS) $('chart-' + k).hidden = !state.show[k];
}

// Headphone list

function renderList() {
  if (!INDEX) return;
  const q = $('hp-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const form = state.form;
  const all = INDEX.headphones.filter(h =>
    (form === 'all' || h.form === form) && q.every(w => h.name.toLowerCase().includes(w)));
  const ul = $('hp-list');
  ul.replaceChildren(...all.map(h => {
    const li = el('li', { role: 'option', tabindex: '-1', 'aria-selected': String(state.hp?.path === h.path) },
      el('span', {}, h.name), el('span', { class: 'form' }, formName(h.form)));
    const pick = () => selectHeadphone(h);
    li.addEventListener('click', pick);
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
        if (next) next.focus(); else if (e.key === 'ArrowUp') $('hp-search').focus();
      }
    });
    return li;
  }));
  // One tab stop: the selected entry, or the first one.
  const stop = ul.querySelector('[aria-selected="true"]') || ul.firstElementChild;
  if (stop) stop.tabIndex = 0;
  $('hp-count').textContent = tr('{0} of {1} measurements', [all.length, INDEX.headphones.length]);
}

function selectHeadphone(h) {
  state.hp = { kind: 'repo', ...h };
  state.adiName = '';
  $('hp-file').value = '';
  if (state.targetAuto) autoTarget();
  renderList();
  run();
}

function defaultTargetFor(form) {
  const want = form === 'over-ear' ? 'Harman over-ear 2018' : 'Harman in-ear 2019';
  return INDEX.targets.find(t => t.name === want) || INDEX.targets[0];
}

function autoTarget() {
  const t = defaultTargetFor(state.hp?.form || 'over-ear');
  state.target = { kind: 'repo', ...t };
  $('target').value = t.path;
}

function renderTargets() {
  $('target').replaceChildren(...INDEX.targets.map(t => el('option', { value: t.path }, t.name)));
}

// Charts

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const charts = [];
let cursorIdx = null;

function niceRange(arrays, minSpan = 20) {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrays) for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const mid = (lo + hi) / 2;
  if (hi - lo < minSpan) { lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const step = hi - lo > 45 ? 10 : 5;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

const X_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

function drawChart(spec, width, height) {
  const pad = { l: 38, r: 10, t: 16, b: 22 };
  const W = width, H = height, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const lx = Math.log(C.F_MIN), lspan = Math.log(C.F_MAX) - lx;
  const X = f => pad.l + (Math.log(f) - lx) / lspan * iw;
  const { lo, hi, step } = niceRange(spec.series.map(s => s.values), spec.minSpan);
  const Y = v => pad.t + (hi - v) / (hi - lo) * ih;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('role', 'img');
  const mk = (tag, a, parent = svg) => { const e = document.createElementNS(ns, tag); for (const k in a) e.setAttribute(k, a[k]); parent.append(e); return e; };
  const gridC = css('--grid'), lineC = css('--line'), mutedC = css('--muted');
  const fontAttrs = { 'font-family': 'IBM Plex Mono, ui-monospace, monospace', 'font-size': '10.5', fill: mutedC };

  if (spec.shadeFrom && spec.shadeFrom < C.F_MAX) {
    const x0 = X(spec.shadeFrom);
    mk('rect', { x: x0, y: pad.t, width: pad.l + iw - x0, height: ih, fill: css('--c-shade') });
    if (spec.shadeLabel && iw >= 420) mk('text', { x: pad.l + iw - 6, y: pad.t + 13, 'text-anchor': 'end', ...fontAttrs }).textContent = spec.shadeLabel;
  }
  for (let d = 10; d <= 10000; d *= 10) for (let k = 2; k <= 9; k++) {
    const f = d * k; if (f < C.F_MIN || f > C.F_MAX) continue;
    mk('line', { x1: X(f), x2: X(f), y1: pad.t, y2: pad.t + ih, stroke: gridC, 'stroke-width': 0.6 });
  }
  for (let v = lo; v <= hi + 1e-9; v += step) {
    mk('line', { x1: pad.l, x2: pad.l + iw, y1: Y(v), y2: Y(v), stroke: v === 0 && spec.zero ? lineC : gridC, 'stroke-width': v === 0 && spec.zero ? 1.2 : 0.8 });
    mk('text', { x: pad.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', ...fontAttrs }).textContent = (v > 0 && spec.zero ? '+' : '') + v;
  }
  const ticks = iw < 420 ? [20, 100, 200, 1000, 2000, 10000, 20000] : X_TICKS;
  for (const f of ticks) {
    mk('line', { x1: X(f), x2: X(f), y1: pad.t, y2: pad.t + ih, stroke: lineC, 'stroke-width': 0.8 });
    mk('text', { x: X(f), y: H - 6, 'text-anchor': f === 20 ? 'start' : f === 20000 ? 'end' : 'middle', ...fontAttrs }).textContent = fmtHz(f);
  }
  mk('text', { x: pad.l - 6, y: 9, 'text-anchor': 'end', ...fontAttrs }).textContent = 'dB';
  mk('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'none', stroke: lineC, 'stroke-width': 1 });

  const clipId = 'c' + Math.random().toString(36).slice(2);
  const defs = mk('defs', {});
  mk('rect', { x: pad.l, y: pad.t, width: iw, height: ih }, mk('clipPath', { id: clipId }, defs));
  const g = mk('g', { 'clip-path': `url(#${clipId})` });
  for (const s of spec.series) {
    let d = '';
    for (let i = 0; i < spec.grid.length; i++) d += (i ? 'L' : 'M') + X(spec.grid[i]).toFixed(1) + ' ' + Y(s.values[i]).toFixed(1);
    mk('path', {
      d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 1.6,
      'stroke-dasharray': s.dash || 'none', opacity: s.opacity ?? 1,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, g);
  }
  const cursor = mk('line', { x1: 0, x2: 0, y1: pad.t, y2: pad.t + ih, stroke: css('--ink'), 'stroke-width': 0.8, opacity: 0, 'stroke-dasharray': '2 3' });
  return { svg, X, pad, iw, cursor };
}

function makeChart(key) {
  const fig = $('chart-' + key), plot = fig.querySelector('.plot');
  const readout = el('div', { class: 'readout', hidden: '' });
  const chart = { key, fig, plot, readout, draw: null };
  chart.render = () => {
    const spec = S[key] && S[key]();
    if (!spec || fig.hidden) { plot.replaceChildren(); chart.draw = null; return; }
    const w = Math.max(300, plot.clientWidth || 600);
    const h = w < 520 ? 190 : 230;
    const d = drawChart(spec, w, h);
    chart.draw = d; chart.spec = spec;
    plot.replaceChildren(d.svg, readout);
    d.svg.addEventListener('pointermove', e => {
      const r = d.svg.getBoundingClientRect();
      const x = (e.clientX - r.left) * (w / r.width);
      const t = (x - d.pad.l) / d.iw;
      if (t < 0 || t > 1) return setCursor(null);
      setCursor(Math.round(t * (spec.grid.length - 1)));
    });
    d.svg.addEventListener('pointerleave', () => setCursor(null));
    updateCursor(chart);
  };
  charts.push(chart);
  return chart;
}

function setCursor(i) { cursorIdx = i; charts.forEach(updateCursor); }

function updateCursor(chart) {
  const d = chart.draw;
  if (!d) return;
  if (cursorIdx == null) { d.cursor.setAttribute('opacity', 0); chart.readout.hidden = true; return; }
  const f = chart.spec.grid[cursorIdx];
  const x = d.X(f);
  d.cursor.setAttribute('x1', x); d.cursor.setAttribute('x2', x); d.cursor.setAttribute('opacity', 0.7);
  const parts = [fmtHzLong(f)];
  for (const s of chart.spec.series) if (s.readout) parts.push(`${s.readout} ${s.values[cursorIdx] >= 0 ? '+' : ''}${s.values[cursorIdx].toFixed(1)}`);
  chart.readout.textContent = parts.join('  ·  ');
  chart.readout.hidden = false;
  const w = chart.plot.clientWidth, px = x / Number(d.svg.getAttribute('width')) * w;
  chart.readout.style.left = px > w / 2 ? 'auto' : `${px + 10}px`;
  chart.readout.style.right = px > w / 2 ? `${w - px + 10}px` : 'auto';
}

function legend(id, items) {
  $(id).replaceChildren(...items.map(([label, color, kind]) =>
    el('span', {}, (() => { const i = el('i', { class: kind || '' }); i.style.borderColor = color; return i; })(), label)));
}

const CHART_TITLES = { meas: () => tr('Measurement and target'), eq: () => tr('EQ curve'), result: () => tr('With EQ') };

function specs() {
  const R = state.result;
  if (!R) return {};
  const { an, opt, eq, perFilter } = R;
  const shadeFrom = opt.limitOn ? an.fHigh : null;
  const shadeLabel = tr('not corrected');
  const equalized = an.raw.map((v, i) => v + eq[i] + an.roll[i]);
  return {
    meas: () => ({
      grid: an.grid, shadeFrom, shadeLabel, minSpan: 30,
      series: [
        { values: an.targetAligned, color: css('--c-target'), dash: '5 4', width: 1.5, readout: tr('target') },
        { values: an.raw, color: css('--c-meas'), width: 1.8, readout: tr('measured') },
      ],
    }),
    eq: () => ({
      grid: an.grid, shadeFrom, shadeLabel, minSpan: 16, zero: true,
      series: [
        ...perFilter.map(v => ({ values: v, color: css('--c-band'), width: 1, opacity: 0.9 })),
        { values: an.desired, color: css('--c-target'), dash: '1.5 3', width: 1.6, readout: tr('wanted') },
        { values: eq, color: css('--c-eq'), width: 2.4, readout: 'EQ' },
      ],
    }),
    result: () => ({
      grid: an.grid, shadeFrom, shadeLabel, minSpan: 30,
      series: [
        { values: an.raw, color: css('--c-meas'), width: 1.1, opacity: 0.35, readout: tr('before') },
        { values: an.targetAligned, color: css('--c-target'), dash: '5 4', width: 1.5, readout: tr('target') },
        { values: equalized, color: css('--c-result'), width: 1.9, readout: tr('with EQ') },
      ],
    }),
  };
}

let S = {};
CHARTS.forEach(makeChart);

function renderCharts() {
  S = specs();
  charts.forEach(c => c.render());
  if (!state.result) return;
  legend('lg-meas', [[tr('measured'), css('--c-meas')], [tr('target'), css('--c-target'), 'dash']]);
  legend('lg-eq', [[tr('EQ total'), css('--c-eq')], [tr('single bands'), css('--c-band')], [tr('wanted correction'), css('--c-target'), 'dot']]);
  legend('lg-result', [[tr('with EQ'), css('--c-result')], [tr('target'), css('--c-target'), 'dash'], [tr('before'), css('--c-meas')]]);
}

// Main pipeline

let runToken = 0;

// Fitting runs in a worker; a new request replaces a running one.
let worker = null, busy = false, jobId = 0;
function getWorker() {
  if (worker) return worker;
  try {
    worker = globalThis.HPEQ_WORKER_SRC
      ? new Worker(URL.createObjectURL(new Blob([globalThis.HPEQ_WORKER_SRC], { type: 'text/javascript' })), { type: 'module' })
      : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch { worker = null; }
  return worker;
}
function computeHere(meas, target, opt) {
  const an = C.analyse(meas, target, opt);
  return { an, fit: C.fit(an, opt) };
}
function compute(meas, target, opt) {
  if (busy && worker) { worker.terminate(); worker = null; }
  const w = getWorker();
  if (!w) return Promise.resolve(computeHere(meas, target, opt));
  busy = true;
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    w.onmessage = e => {
      if (e.data.id !== id) return;
      busy = false;
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data);
    };
    w.onerror = ev => {
      ev.preventDefault();
      busy = false; worker = null;
      try { resolve(computeHere(meas, target, opt)); } catch (err) { reject(err); }
    };
    w.postMessage({ id, meas, target, opt });
  });
}

async function run() {
  const token = ++runToken;
  save();
  if (!state.hp) { state.result = null; renderAll(); return; }
  try {
    setStatus(state.hp.kind === 'repo' && !csvCache.has(state.hp.path) ? tr('Loading {0}…', [state.hp.name]) : '');
    const meas = state.hp.kind === 'file' ? state.hp.data : await loadCsv(state.hp.path);
    const target = !state.target ? null : state.target.kind === 'file' ? state.target.data : await loadCsv(state.target.path);
    if (token !== runToken) return;
    const opt = effective(state.opt);
    const slow = setTimeout(() => token === runToken && setStatus(tr('Calculating…')), 200);
    const { an, fit } = await compute(meas, target, opt);
    clearTimeout(slow);
    if (token !== runToken) return;
    state.result = { an, fit, opt };
    state.filters = fit.filters.map(f => ({ ...f }));
    state.edited = false;
    if (state.pendingEdits) { applyEdits(state.pendingEdits, fit.slots); state.pendingEdits = null; }
    setStatus('');
  } catch (e) {
    if (token !== runToken) return;
    state.result = null;
    setStatus(e.message, true);
  }
  renderAll();
}

function applyEdits(edits, slots) {
  const label = id => {
    const s = slots.find(x => x.id === id);
    return s ? s.label : id.replace(/^R/, 'Band ').replace(/^F/, 'Filter ');
  };
  state.filters = edits.map(([id, type, f, gain, q, off]) => ({ id, label: label(id), type, f, gain, q, off: !!off, slow: false }));
  state.edited = true;
}

function recompute() {
  const R = state.result;
  if (!R) return;
  const { eq, perFilter } = C.evaluate(R.an, state.filters, R.opt);
  R.eq = eq; R.perFilter = perFilter;
  R.st = C.stats(R.an, eq);
}

function renderAll() {
  syncVisibility();
  const R = state.result;
  const name = state.hp ? state.hp.name : tr('Pick a headphone');
  $('title').textContent = name;
  if (!state.adiName && state.hp) state.adiName = presetName(state.hp.name);
  $('adiName').value = state.adiName;

  if (!R) {
    $('meta').textContent = state.hp ? '' : tr('Choose a measurement on the left, or upload your own.');
    for (const id of ['st-before', 'st-after', 'st-bands', 'st-boost']) $(id).textContent = '–';
    $('st-note').textContent = '';
    $('filters').tBodies[0].replaceChildren();
    for (const id of ['tm-text', 'table-text']) $(id).textContent = '';
    renderCharts();
    return;
  }
  const { an, opt } = R;
  const sign = v => `${v > 0 ? '+' : ''}${v}`;
  const src = state.hp.kind === 'repo' ? `oratory1990 · ${formName(state.hp.form)}` : tr('your measurement');
  const tgt = state.target ? state.target.name : tr('flat');
  const taste = [opt.bassDb ? tr('bass {0} dB', [sign(opt.bassDb)]) : '', opt.tiltDbOct ? tr('tilt {0} dB/oct', [sign(opt.tiltDbOct)]) : ''].filter(Boolean).join(', ');
  const range = opt.limitOn ? tr('corrected {0} – {1}', [fmtHzLong(opt.fLow), fmtHzLong(opt.limitHz)]) : tr('full-range correction');
  $('meta').textContent = [src, tr('target {0}', [tgt]) + (taste ? ` (${taste})` : ''), range, tr('level matched at {0}', [fmtHzLong(opt.refHz)]),
    opt.slowComp && opt.device !== 'totalmix' ? tr('Slow filter −{0} dB compensated', [opt.slowLossDb]) : ''].filter(Boolean).join(' · ');

  renderTable();
  refreshOutputs();
}

function refreshOutputs() {
  const R = state.result;
  if (!R) return;
  recompute();
  const { an, opt, st } = R;
  const active = state.filters.filter(f => !f.off);

  $('st-before').textContent = `${st.rmsBefore.toFixed(1)} dB`;
  $('st-after').textContent = `${st.rmsAfter.toFixed(1)} dB`;
  $('st-bands').textContent = `${active.length} / ${slotCount(opt)}`;
  $('st-boost').textContent = st.maxBoost >= 0.05 ? `+${st.maxBoost.toFixed(1)} dB` : tr('none');

  const notes = [tr('Deviation: RMS difference to target in the corrected range.')];
  let worst = 0, worstF = 0;
  for (let i = 0; i < an.grid.length; i++) {
    if (an.grid[i] < opt.fLow || an.grid[i] > an.fHigh) continue;
    const need = -an.errorSmoothed[i] - an.roll[i];
    if (need - opt.maxBoost > worst) { worst = need - opt.maxBoost; worstF = an.grid[i]; }
  }
  if (worst > 1) notes.push(tr('Boost limited to {0} dB ({1} needs {2} dB).', [opt.maxBoost, fmtHzLong(worstF), (opt.maxBoost + worst).toFixed(0)]));
  if (st.maxBoost > 0.5) notes.push(tr('Preamp: {0} dB.', [st.preamp.toFixed(1)]));
  if (state.edited) notes.push(tr('Edited bands.'));
  $('st-note').textContent = notes.join(' ');
  $('refit').hidden = !state.edited;

  const title = `${state.hp.name} → ${state.target ? state.target.name : 'flat'}`;
  $('tm-text').textContent = C.toTMREQ(state.filters, st.preamp);
  $('table-text').textContent = C.toTextTable(state.filters, title);

  renderCharts();
  save();
}

function renderTable() {
  const R = state.result, opt = R.opt;
  const slots = R.fit.slots;
  const steps = opt.device === 'adi2' ? { g: 0.5, q: 0.1 } : { g: 0.1, q: 0.1 };
  const rows = state.filters.map((f, idx) => {
    const slot = slots.find(s => s.id === f.id) || { fMin: 20, fMax: 20000, qMin: 0.1, qMax: 20, gMin: -24, gMax: 24 };
    const fitted = R.fit.filters.find(x => x.id === f.id);
    const row = el('tr', { class: [f.slow ? 'slow' : '', f.off ? 'off' : ''].join(' ').trim() });
    const on = el('input', { type: 'checkbox', 'aria-label': tr('{0} on', [bandName(f.label)]) });
    on.checked = !f.off;
    on.addEventListener('change', () => { f.off = !on.checked; state.edited = true; row.classList.toggle('off', f.off); refreshOutputs(); });
    const num = (key, min, max, step, digits) => {
      const inp = el('input', { type: 'number', min, max, step, 'aria-label': `${bandName(f.label)} ${key}` });
      inp.value = key === 'f' ? Math.round(f.f) : f[key].toFixed(digits);
      const mark = () => inp.classList.toggle('changed', !!fitted && Math.abs(fitted[key] - f[key]) > 1e-6);
      mark();
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!Number.isFinite(v) || (key !== 'gain' && v <= 0)) return;
        f[key] = Math.min(max, Math.max(min, v));
        state.edited = true; mark(); refreshOutputs();
      });
      inp.addEventListener('change', () => { inp.value = key === 'f' ? Math.round(f.f) : f[key].toFixed(digits); });
      return inp;
    };
    row.append(
      el('td', { class: 'on' }, on),
      el('td', {}, bandName(f.label)),
      el('td', { class: 'type' }, el('span', { class: 'long' }, TYPE_NAME[f.type]()), el('span', { class: 'short', title: TYPE_NAME[f.type]() }, TYPE_SHORT[f.type])),
      el('td', { class: 'num' }, num('f', slot.fMin, slot.fMax, 1, 0)),
      el('td', { class: 'num' }, num('gain', Math.max(slot.gMin, -24), Math.min(slot.gMax + 6, 24), steps.g, 1)),
      el('td', { class: 'num' }, num('q', slot.qMin, slot.qMax, steps.q, steps.q < 0.1 ? 2 : 1)),
    );
    return row;
  });
  if (!rows.length) rows.push(el('tr', { class: 'empty' }, el('td', { colspan: '6' }, tr('No band makes a meaningful difference with these settings.'))));
  $('filters').tBodies[0].replaceChildren(...rows);
  $('out-hint').textContent = opt.device === 'adi2'
    ? (opt.quantize ? tr('Unlisted bands: 0 dB.') : tr('Not rounded.'))
    : opt.device === 'totalmix' ? tr('Unlisted bands: 0 dB.')
    : '';
}

// Exports

function adiXml() {
  return C.toADI2(state.filters, { slot: state.adiSlot, name: $('adiName').value || 'EQ' });
}

function pngExport() {
  const R = state.result;
  if (!R) return;
  const keys = CHARTS.filter(k => state.show[k]);
  const withTable = $('png-table').checked;
  if (!keys.length && !withTable) { setStatus(tr('Switch on at least one chart or the table for the image.'), true); return; }
  const W = 1200, chartH = 300, margin = 24;
  const filters = state.filters.filter(f => !f.off);
  const tableH = withTable ? 30 + 24 * Math.max(1, filters.length) : 0;
  const H = 90 + keys.length * (chartH + 34) + tableH + 40;
  const canvas = el('canvas'); canvas.width = W * 2; canvas.height = H * 2;
  const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
  ctx.fillStyle = css('--surface'); ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = css('--ink'); ctx.font = '600 26px system-ui, sans-serif';
  ctx.fillText(state.hp.name, margin, 42);
  ctx.fillStyle = css('--muted'); ctx.font = '14px system-ui, sans-serif';
  ctx.fillText($('meta').textContent, margin, 66);
  const imgs = keys.map(k => {
    const d = drawChart(S[k](), W - 2 * margin, chartH);
    const xml = new XMLSerializer().serializeToString(d.svg);
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img); img.onerror = rej;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    });
  });
  Promise.all(imgs).then(list => {
    let y = 90;
    list.forEach((img, i) => {
      ctx.fillStyle = css('--ink'); ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillText(CHART_TITLES[keys[i]](), margin, y + 16);
      ctx.drawImage(img, margin, y + 26, W - 2 * margin, chartH);
      y += chartH + 34;
    });
    if (withTable) {
      ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
      const lines = C.toTextTable(filters).trimEnd().split('\n');
      lines.forEach((line, i) => {
        ctx.fillStyle = i < 2 ? css('--muted') : css('--ink');
        ctx.fillText(line, margin, y + 20 + i * 24);
      });
    }
    ctx.fillStyle = css('--muted'); ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('oratory1990 measurements via AutoEq · ADI-2-Pi Headphone EQ Generator', margin, H - 14);
    canvas.toBlob(b => download(`${safeName(state.hp.name)} EQ.png`, b), 'image/png');
  }).catch(() => setStatus(tr('Could not render the PNG in this browser.'), true));
}

// Wiring

let debounce;
function onSettingsChange() {
  readForm();
  // another equalizer: the previous result's bands don't fit its export, so show nothing until the new fit is in
  if (state.result && effective(state.opt).device !== state.result.opt.device) { state.result = null; renderAll(); }
  syncVisibility();
  clearTimeout(debounce);
  debounce = setTimeout(run, 400);
}

function wire() {
  document.addEventListener('change', syncToggles);
  document.querySelectorAll('.panel input, .panel select, #advanced input, #advanced select').forEach(inp => {
    if (inp.id === 'hp-search' || inp.type === 'file' || inp.name === 'form') return;
    inp.addEventListener(inp.type === 'number' ? 'input' : 'change', onSettingsChange);
  });
  $('hp-search').addEventListener('input', renderList);
  $('hp-search').addEventListener('keydown', e => {
    const first = $('hp-list').querySelector('li');
    if (e.key === 'Enter' && first) first.click();
    if (e.key === 'ArrowDown' && first) { e.preventDefault(); first.focus(); }
  });
  document.querySelectorAll('input[name="form"]').forEach(r => r.addEventListener('change', () => { state.form = r.value; renderList(); }));

  $('target').addEventListener('change', () => {
    const t = INDEX.targets.find(x => x.path === $('target').value);
    state.target = { kind: 'repo', ...t }; state.targetAuto = false;
    $('target-file').value = '';
    run();
  });

  const readFile = (input, cb) => input.addEventListener('change', async () => {
    const file = input.files[0]; if (!file) return;
    try { cb(file.name.replace(/\.[^.]+$/, ''), C.parseResponse(await file.text())); }
    catch (e) { setStatus(`${file.name}: ${e.message}`, true); }
  });
  readFile($('hp-file'), (name, data) => {
    state.hp = { kind: 'file', name, data, form: 'over-ear' }; state.adiName = '';
    if (state.targetAuto) autoTarget();
    renderList(); run();
  });
  readFile($('target-file'), (name, data) => {
    state.target = { kind: 'file', name, data }; state.targetAuto = false; run();
  });

  $('reset').addEventListener('click', () => {
    state.opt = { ...C.DEFAULTS }; state.targetAuto = true;
    if (state.hp) autoTarget();
    writeForm(); run();
  });
  $('refit').addEventListener('click', run);
  $('advanced').addEventListener('toggle', () => { try { localStorage.setItem('hpeq.adv', $('advanced').open ? '1' : ''); } catch {} });
  $('target').addEventListener('change', syncVisibility);

  for (const k of CHARTS) $('show-' + k).addEventListener('change', () => {
    state.show[k] = $('show-' + k).checked;
    renderOutputVisibility(); renderCharts(); save();
  });

  $('adiSlot').addEventListener('input', () => { state.adiSlot = Math.min(20, Math.max(1, Math.round(Number($('adiSlot').value) || 1))); save(); });
  $('adiName').addEventListener('input', () => { state.adiName = $('adiName').value; });
  const name = () => safeName(state.hp.name);
  $('dl-adi').addEventListener('click', () => state.result && download(`${safeName($('adiName').value || state.hp.name)}.adieqpr`, adiXml()));
  $('cp-adi').addEventListener('click', e => state.result && copyText(adiXml(), e.currentTarget));
  const tm = $('tm-text');
  $('cp-tm').addEventListener('click', e => copyText(tm.textContent, e.currentTarget, tm));
  $('dl-tm').addEventListener('click', () => state.result && download(`${name()} Room EQ.tmreq`, tm.textContent));
  $('cp-table').addEventListener('click', e => copyText($('table-text').textContent, e.currentTarget, $('table-text')));
  $('dl-csv').addEventListener('click', () => state.result && download(`${name()}.csv`, C.toCSV(state.result.an, state.result.eq), 'text/csv'));
  $('dl-png').addEventListener('click', pngExport);

  let rw;
  new ResizeObserver(() => { clearTimeout(rw); rw = setTimeout(() => charts.forEach(c => c.render()), 80); }).observe(document.querySelector('.charts'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderCharts);
  new MutationObserver(renderCharts).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

async function init() {
  const saved = readSaved();
  applySaved(saved);
  try { $('advanced').open = localStorage.getItem('hpeq.adv') === '1'; } catch {}
  writeForm();
  renderOutputVisibility();
  wire();
  try {
    INDEX = await loadIndex();
  } catch (e) {
    setStatus(e.message, true);
    return;
  }
  $('data-ref').textContent = tr('commit {0}, list updated {1}', [INDEX.ref.slice(0, 7), INDEX.generated]);
  renderTargets();
  applySavedRefs(saved);
  if (!state.hp) {
    const def = INDEX.headphones.find(h => h.name === 'Sennheiser HD 650') || INDEX.headphones[0];
    state.hp = { kind: 'repo', ...def };
  }
  if (state.targetAuto || !state.target) autoTarget(); else $('target').value = state.target.path;
  syncVisibility();
  renderList();
  const sel = $('hp-list').querySelector('[aria-selected="true"]');
  if (sel) $('hp-list').scrollTop = sel.offsetTop - 80;
  run();
}

// Send the EQ to an output of the unit through the bridge API.

const SEND_KEY = 'hpeq.sendOut';

/** The fitted (or edited) ADI-2 filters as bridge "set" items for one EQ side. */
function adiSetItems(filters, ch) {
  const get = id => filters.find(f => f.id === id && !f.off);
  const items = [];
  for (const side of ['L', 'R']) {
    const set = (id, value) => items.push({ ch, id, side, value });
    set('eqen', 1);
    for (let i = 1; i <= 5; i++) {
      const f = get('B' + i);
      set(`b${i}g`, f ? f.gain : 0);
      if (f) { set(`b${i}f`, f.f); set(`b${i}q`, f.q); }
    }
    const b1 = get('B1'), b5 = get('B5');
    set('b1type', b1 && b1.type === 'lowshelf' ? 1 : 0);
    set('b5type', b5 && b5.type === 'highshelf' ? 1 : 0);
    if (side === 'R') continue; // Bass/Treble live on the left EQ address only
    const bass = get('BB'), treble = get('BT');
    const useBT = !!(bass || treble);
    set('bten', useBT ? 1 : 0);
    if (useBT) {
      set('bass', bass ? bass.gain : 0);
      if (bass) { set('bassf', bass.f); set('bassq', bass.q); }
      set('treble', treble ? treble.gain : 0);
      if (treble) { set('trebf', treble.f); set('trebq', treble.q); }
    }
  }
  if (get('BB') || get('BT')) items.push({ ch, id: 'btload', side: 'L', value: 1 });
  return items;
}

/** ADI-2-Pi's tab bar (web/tabs.js), with the outputs of the connected model (null = not known yet). */
function renderSiteTabs(model) {
  const nav = $('site-tabs');
  if (!nav || typeof globalThis.ADI2_TABS !== 'function') return;
  const dac = model === 'dac';
  const tabs = [
    { id: 'overview', label: tr('Overview') },
    { id: 'line', label: 'Line Out' },
    { id: 'ph12', label: dac ? 'Phones' : 'Phones 1/2' },
    { id: 'ph34', label: dac ? 'IEM' : 'Phones 3/4' },
    ...(dac ? [] : [{ id: 'in', label: tr('Input') }]),
    ...globalThis.ADI2_TABS(tr),
  ];
  let debug = false;
  try { debug = JSON.parse(localStorage.getItem('adi2.debug')) === true; } catch {}
  if (debug) tabs.push({ id: 'debug', label: tr('Debug') });
  nav.replaceChildren(...tabs.map(t => el('a', { class: 'site-tab', href: t.href || `/#${t.id}`, ...(t.id === 'eq' ? { 'aria-current': 'page' } : {}) }, t.label)));
}
let siteModel = null;

/** Header: the ADI-2's connection and the setups, as on the main page. */
function setupHeader() {
  const dot = $('conn-dot'), txt = $('conn-text'), sel = $('setup-select');
  let setups = [], ready = null, noteUntil = 0;
  const fill = () => {
    sel.replaceChildren(el('option', { value: '' }, tr('Load setup…')),
      ...setups.map((n, i) => el('option', { value: String(i + 1) }, `${i + 1}${n ? ` · ${n}` : ''}`)));
    sel.value = '';
  };
  const poll = async () => {
    let info = null;
    try { const r = await fetch('/api/info', { cache: 'no-cache' }); if (r.ok) info = await r.json(); } catch {}
    const d = (info && info.device) || {};
    dot.className = 'site-dot';
    if (!info) { dot.classList.add('bad'); txt.textContent = tr('ADI-2-Pi offline – reconnecting…'); }
    else if (!d.connected) { dot.classList.add('bad'); txt.textContent = tr('No ADI-2'); }
    else if (!d.id) { dot.classList.add('warn'); txt.textContent = tr('ADI-2 found, waiting for an answer…'); }
    else if (d.answering === false) { dot.classList.add('bad'); txt.textContent = tr('{0} – not answering', [d.modelName]); }
    else if (!d.ready) { dot.classList.add('warn'); txt.textContent = tr('{0} – reading settings…', [d.modelName]); }
    else if (Date.now() >= noteUntil) { dot.classList.add('ok'); txt.textContent = d.modelName; }
    else dot.classList.add('ok');
    if (info && info.bridge && info.bridge.name) $('site-name').textContent = info.bridge.name;
    const isReady = !!(d.ready && d.answering !== false);
    if (isReady && ready !== true) {
      try { const r = await fetch('/api/state?view=named'); if (r.ok) { setups = (await r.json()).setups || []; fill(); } } catch {}
    }
    ready = isReady;
    sel.disabled = !isReady;
    if (info && (d.model || null) !== siteModel) { siteModel = d.model || null; renderSiteTabs(siteModel); }
    setTimeout(poll, info ? 4000 : 2000);
  };
  sel.addEventListener('change', async () => {
    const n = Number(sel.value);
    sel.value = '';
    if (!n) return;
    const r = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', n }) }).catch(() => null);
    if (r && r.ok) { txt.textContent = tr('Loading setup {0}{1}', [n, setups[n - 1] ? ` (${setups[n - 1]})` : '']); noteUntil = Date.now() + 3000; }
  });
  fill();
  poll();
}

/** The page's static texts (text, placeholders, labels) in the page language. */
function translatePage() {
  if (!globalThis.I18N || globalThis.I18N.lang === 'en') return;
  document.title = `${tr('Headphone EQ')} · ADI-2-Pi`;
  // names (headphones, targets, RME products), numbers and generated content stay as they are
  const keep = 'script, style, pre, code, svg, #site-tabs, #hp-list, #target, #filters tbody, #app, #site-name';
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT,
    { acceptNode: n => (n.parentElement && n.parentElement.closest(keep) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const key = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (!/[A-Za-z]/.test(key)) continue;
    const t = tr(key);
    if (t !== key) n.nodeValue = n.nodeValue.replace(/\S(?:[\s\S]*\S)?/, t);
  }
  for (const e of document.querySelectorAll('[placeholder], [aria-label], [title]')) {
    for (const a of ['placeholder', 'aria-label', 'title']) if (e.hasAttribute(a)) e.setAttribute(a, tr(e.getAttribute(a)));
  }
}

async function setupSend() {
  let info;
  try {
    const r = await fetch('/api/info');
    if (!r.ok) return;
    info = await r.json();
  } catch { return; } // not served by an ADI-2-Pi
  const dac = info.device && info.device.model === 'dac';
  const outs = [['line', 'Line Out'], ['ph12', dac ? 'Phones' : 'Phones 1/2'], ['ph34', dac ? 'IEM' : 'Phones 3/4']];
  const sel = $('sendOut');
  sel.replaceChildren(...outs.map(([v, t]) => el('option', { value: v }, t)));
  try { const s = localStorage.getItem(SEND_KEY); if (s) sel.value = s; } catch {}
  if (!sel.value) sel.value = 'ph12';
  sel.addEventListener('change', () => { try { localStorage.setItem(SEND_KEY, sel.value); } catch {} });
  $('send-adi').hidden = false;

  const msg = $('send-msg');
  const say = (t, cls) => { msg.textContent = t; msg.className = `hint send-msg ${cls || ''}`; };
  $('open-presets').addEventListener('click', () => {
    if (!state.filters.length) { say(tr('Nothing to hand over yet.'), 'err'); return; }
    const items = adiSetItems(state.filters, 'draft').filter(it => it.side === 'L').map(({ id, side, value }) => ({ id, side, value }));
    const name = ($('adiName').value || (state.hp && state.hp.name) || 'EQ').slice(0, 14); // the unit's own limit
    try { localStorage.setItem('adi2.eqDraft', JSON.stringify({ name, items })); } catch {}
    location.href = '/#eqpresets';
  });
  $('send-adi-btn').addEventListener('click', async () => {
    const name = sel.options[sel.selectedIndex].textContent;
    if (!state.filters.length) { say(tr('Nothing to send yet.'), 'err'); return; }
    if (!confirm(tr('Replace the EQ on {0} with this one?', [name]))) return;
    const btn = $('send-adi-btn');
    btn.disabled = true;
    say(tr('Applying…'));
    try {
      const r = await fetch('/api/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set: adiSetItems(state.filters, sel.value) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || tr('error {0}', [r.status]));
      say(tr('Applied to {0}.', [name]), 'ok');
      msg.append(' ', el('a', { href: `/#${sel.value}` }, tr('Open it in ADI-2-Pi')));
    } catch (e) {
      say(tr('Not applied: {0}', [e.message]), 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

// Headphone data is stored on the Pi; GitHub is contacted only when an update is requested.

function showDataSource() {
  const o = INDEX && INDEX.origin;
  if (!o) return;
  const v = [o.headphones, String(o.ref).slice(0, 7), o.generated];
  $('data-src').textContent = o.source === 'updated'
    ? tr('{0} headphones, AutoEq commit {1} from {2} (updated on this Pi).', v)
    : tr('{0} headphones, AutoEq commit {1} from {2} (shipped with ADI-2-Pi).', v);
  $('data-reset').hidden = o.source !== 'updated';
  $('data-update').hidden = !o.updates;
  $('data-ref').textContent = tr('commit {0}, list updated {1}', [String(INDEX.ref).slice(0, 7), INDEX.generated]);
}

async function reloadData() {
  INDEX = await loadIndex();
  csvCache.clear();
  renderTargets();
  renderList();
  showDataSource();
  run();
}

function setupData() {
  const msg = $('data-msg');
  const say = (t, cls) => { msg.textContent = t; msg.className = `data-msg ${cls || ''}`; };
  const btn = $('data-update');
  const poll = async () => {
    const s = await fetch('/api/eq/update').then(r => r.json()).catch(() => null);
    if (!s) { say(tr('Lost the connection to the ADI-2-Pi.'), 'err'); btn.disabled = false; return; }
    if (s.state === 'running') {
      say(s.total ? tr('{0} {1} of {2}', [s.step, s.done, s.total]) : s.step);
      setTimeout(poll, 700);
      return;
    }
    btn.disabled = false;
    if (s.state === 'error') { say(s.message, 'err'); return; }
    if (s.state === 'done') {
      say(s.added || s.changed
        ? tr('Updated: {0} new and {1} changed files. {2} headphones now.', [s.added, s.changed, s.total])
        : tr('Already up to date.'), 'ok');
      await reloadData().catch(e => say(e.message, 'err'));
    }
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    say(tr('Contacting GitHub…'));
    const r = await fetch('/api/eq/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .catch(() => null);
    if (!r || !r.ok) {
      const e = r ? await r.json().catch(() => ({})) : {};
      say(e.error || tr('Could not start the update.'), 'err');
      btn.disabled = false;
      return;
    }
    poll();
  });
  $('data-reset').addEventListener('click', async () => {
    if (!confirm(tr('Go back to the headphone data that shipped with ADI-2-Pi? Downloaded updates are deleted from the Pi.'))) return;
    await fetch('/api/eq/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
    say(tr('Back to the shipped data.'), 'ok');
    await reloadData().catch(e => say(e.message, 'err'));
  });
  // an update started from another browser may still be running
  fetch('/api/eq/update').then(r => r.json()).then(s => { if (s.state === 'running') { btn.disabled = true; poll(); } }).catch(() => {});
}

document.getElementById('theme-btn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('adi2.theme', JSON.stringify(next)); } catch {}
});

// start once the language is loaded, so every text appears in it from the first draw
(globalThis.I18N ? globalThis.I18N.ready : Promise.resolve()).catch(() => {}).then(() => {
  translatePage();
  renderSiteTabs(null);
  setupHeader();
  init().then(showDataSource);
  setupData();
  setupSend();
});
