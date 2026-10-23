/* ADI-2-Pi – web remote. Plain JS, no build step, no external files. */
'use strict';
(() => {
  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (v, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
  const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '')}k` : String(Math.round(f)));
  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.append(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(`adi2.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`adi2.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ------------------------------------------------------------------ state
  const S = {
    schema: null,
    device: { connected: false },
    bridge: {},
    settings: { limits: {}, link: [] },
    p: new Map(),          // "addr.idx" → protocol integer
    setups: Array(9).fill(''),
    presets: [],           // the unit's 20 EQ presets [{n, name, empty, L, R}]
    status: null,
    tab: store.get('tab', 'overview'),
    eqSide: {},            // ch → 'L' | 'R'
    online: false,
    bt: null,              // Bluetooth: adapter, devices with their audio connections
    streaming: null,       // streaming receivers (AirPlay, Spotify, UPnP …)
    routing: null,         // what plays into the ADI-2, who is heard, the sample rate
    trigger: null,         // shut down with the ADI-2 (Trigger Out → GPIO3)
  };
  const subs = new Map();  // key → Set(fn)
  const touched = new Map(); // key → time of last local change (ignore stale echoes while dragging)
  const model = () => S.device.model || 'pro';
  const key = (a, i) => `${a}.${i}`;

  function sub(k, fn) {
    if (!subs.has(k)) subs.set(k, new Set());
    subs.get(k).add(fn);
    fn(S.p.get(k));
  }
  function notify(k) {
    const set = subs.get(k);
    if (set) for (const fn of set) fn(S.p.get(k));
  }
  function notifyAll() { for (const k of subs.keys()) notify(k); }

  // ------------------------------------------------------------------ schema access (mirrors lib/catalog.js)
  let SEC = {};
  let CH = {};
  function indexSchema() {
    SEC = {};
    for (const [s, list] of Object.entries(S.schema.params)) SEC[s] = Object.fromEntries(list.map((p) => [p.id, p]));
    CH = Object.fromEntries(S.schema.channels.map((c) => [c.key, c]));
    // "draft": an EQ that only lives in this page (EQ Presets editor). Never sent as such.
    CH.draft = { key: 'draft', name: 'EQ preset', kind: 'output', addr: 'dX', eq: 'dL', eqR: 'dR', draft: true };
  }
  const available = (e) => !((e.only && !e.only.includes(model())) || (e.not && e.not.includes(model())));
  function resolve(ch, id, side = 'L') {
    if (!ch || ch === 'device') { const p = SEC.device[id]; return p && { addr: 12, idx: p.idx, param: p }; }
    const c = CH[ch];
    if (c && c.draft && !SEC.eq[id]) { const p = SEC.output[id]; return p && { addr: c.addr, idx: p.idx, param: p, channel: c }; }
    if (SEC.eq[id]) return { addr: side === 'R' ? c.eqR : c.eq, idx: SEC.eq[id].idx, param: SEC.eq[id], channel: c };
    const p = (c.kind === 'input' ? SEC.input : SEC.output)[id];
    return p && { addr: c.addr, idx: p.idx, param: p, channel: c };
  }
  const toDisp = (param, v) => (v === undefined ? undefined : param.type === 'level' ? v * (param.scale ?? 1) : v);
  function fromDisp(param, v) {
    if (param.type === 'toggle') return v ? 1 : 0;
    if (param.type === 'select') return Math.round(v);
    v = clamp(v, param.min, param.max);
    if (param.unit === 'Hz' && v > 2047) return Math.round(v / 10) * 10; // unit stores these in 10 Hz steps
    return Math.round(v / (param.scale ?? 1));
  }
  function names(param, channel) {
    let n = param.names;
    if (!n) return null;
    if (!Array.isArray(n) && (n.line || n.phones)) n = channel && channel.line ? n.line : n.phones;
    if (!Array.isArray(n)) n = n[model()] || n.pro || Object.values(n)[0];
    return n;
  }
  // keys the schema knows ("addr.idx"), and a log of changes to the ones it doesn't
  let KNOWN = null;
  function knownKeys() {
    if (KNOWN) return KNOWN;
    KNOWN = new Set();
    for (const c of S.schema.channels) {
      for (const p of Object.values(c.kind === 'input' ? SEC.input : SEC.output)) KNOWN.add(key(c.addr, p.idx));
      for (const p of Object.values(SEC.eq)) { KNOWN.add(key(c.eq, p.idx)); KNOWN.add(key(c.eqR, p.idx)); }
    }
    for (const p of Object.values(SEC.device)) KNOWN.add(key(12, p.idx));
    return KNOWN;
  }
  const unknownLog = [];
  const unknownSubs = new Set();
  function logUnknown(k, from, to) {
    unknownLog.unshift({ at: new Date(), k, from, to });
    if (unknownLog.length > 40) unknownLog.pop();
    for (const fn of unknownSubs) fn();
  }
  const chName = (c) => (model() === 'dac' && c.dacName ? c.dacName : c.name);
  const isDraft = (ch) => ch === 'draft';
  const getDisp = (ch, id, side) => { const r = resolve(ch, id, side); return r && toDisp(r.param, S.p.get(key(r.addr, r.idx))); };

  // ------------------------------------------------------------------ connection
  let ws = null;
  let retry = 500;
  let rid = 0;
  const waiting = new Map();

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; S.online = true; renderConn(); };
    ws.onclose = () => {
      S.online = false;
      renderConn();
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 5000);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) { toast('ADI-2-Pi is offline'); return Promise.reject(new Error('offline')); }
    const id = ++rid;
    ws.send(JSON.stringify({ ...obj, rid: id }));
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      setTimeout(() => { if (waiting.delete(id)) reject(new Error('timeout')); }, 5000);
    });
  }

  function onMessage(m) {
    if (m.rid && waiting.has(m.rid)) {
      const w = waiting.get(m.rid);
      waiting.delete(m.rid);
      if (m.t === 'err') { toast(m.error); w.reject(new Error(m.error)); } else w.resolve(m);
      if (m.t === 'ok' || m.t === 'err') return;
    } else if (m.t === 'err') toast(m.error);

    switch (m.t) {
      case 'hello':
        S.bridge = m.bridge;
        setDevice(m.device);
        $('#bridgeName').textContent = m.bridge.name;
        document.title = m.bridge.name;
        break;
      case 'state':
        S.p = new Map([...Object.entries(m.p), ...[...S.p].filter(([k]) => /^d[LRX]\./.test(k))]);
        S.setups = m.setups;
        S.presets = m.eqPresets || [];
        S.status = m.status;
        S.statusInfo = m.statusInfo || null;
        S.silences = m.silences || [];
        if (m.bluetooth) S.bt = m.bluetooth;
        if (m.streaming) S.streaming = m.streaming;
        if (m.routing) S.routing = m.routing;
        if (m.trigger) { S.trigger = m.trigger; for (const fn of trSubs) fn(); }
        for (const fn of rtSubs) fn();
        for (const fn of rxSubs) fn();
        setDevice(m.device);
        for (const fn of btSubs) fn();
        notifyAll();
        for (const fn of presetSubs) fn();
        renderSetupSelect();
        break;
      case 'p': {
        const now = performance.now();
        for (const [k, v] of Object.entries(m.p)) {
          if (m.origin === 'device' && S.tab === 'debug' && !knownKeys().has(k) && S.p.get(k) !== v) logUnknown(k, S.p.get(k), v);
          // while dragging, our own newer value wins over echoes and read-backs for a moment
          const age = now - (touched.get(k) || -1e9);
          if (age < (m.origin === 'device' ? 1800 : 400) || pendingSet.has(k)) continue;
          S.p.set(k, v);
          notify(k);
        }
        break;
      }
      case 'device': setDevice(m.device); break;
      case 'setups': S.setups = m.setups; renderSetupSelect(); renderIfTab('device'); break;
      case 'eqpresets': S.presets = m.eqPresets; for (const fn of presetSubs) fn(); break;
      case 'settings':
        S.settings = m.settings;
        $('#bridgeName').textContent = m.settings.name;
        document.title = m.settings.name;
        for (const fn of settingsSubs) fn();
        if (S.tab === 'bridge' && !$('#main').contains(document.activeElement)) render();
        break;
      case 'status':
        S.status = m.status;
        S.statusInfo = m.info || null;
        for (const fn of statusSubs) fn();
        break;
      case 'silences': S.silences = m.silences || []; for (const fn of statusSubs) fn(); break;
      case 'bluetooth': S.bt = m.bluetooth; for (const fn of btSubs) fn(); break;
      case 'streaming': S.streaming = m.streaming; for (const fn of rxSubs) fn(); break;
      case 'routing': S.routing = m.routing; for (const fn of rtSubs) fn(); break;
      case 'trigger': S.trigger = m.trigger; for (const fn of trSubs) fn(); break;
      case 'midi': monitorLine(m); break;
      default: break;
    }
  }

  let lastModel = null;
  let lastReady = null;
  let lastAnswering = true;
  function setDevice(d) {
    S.device = d || { connected: false };
    renderConn();
    const sel = $('#setupSelect');
    if (sel) sel.disabled = !S.device.ready;
    const answering = S.device.answering !== false;
    if (answering !== lastAnswering) {
      lastAnswering = answering;
      if (S.device.connected) toast(answering ? 'The ADI-2 answers again' : 'The ADI-2 stopped answering');
      for (const fn of statusSubs) fn();
    }
    if (S.device.model !== lastModel || S.device.ready !== lastReady) {
      lastModel = S.device.model;
      lastReady = S.device.ready;
      renderTabs();
      render();
    }
  }

  function renderConn() {
    const dot = $('#connDot');
    const txt = $('#connText');
    const b = $('#banner');
    dot.className = 'dot';
    let banner = '';
    if (!S.online) { dot.classList.add('bad'); txt.textContent = 'ADI-2-Pi offline – reconnecting…'; }
    else if (!S.device.connected) {
      dot.classList.add('bad');
      txt.textContent = 'No ADI-2';
      banner = S.device.problem?.text || 'Waiting for the ADI-2 on USB…';
    } else if (!S.device.id) {
      dot.classList.add('warn');
      txt.textContent = 'ADI-2 found, waiting for an answer…';
      if (S.device.problem) banner = S.device.problem.text;
    } else if (S.device.answering === false) {
      dot.classList.add('bad');
      txt.textContent = `${S.device.modelName} – not answering`;
      banner = S.device.problem?.text || 'The ADI-2 is not answering.';
    } else if (!S.device.ready) { dot.classList.add('warn'); txt.textContent = `${S.device.modelName} – reading settings…`; }
    else { dot.classList.add('ok'); txt.textContent = S.device.modelName; }
    b.hidden = !banner;
    b.textContent = banner;
    // controls can't reach the unit: show it instead of letting clicks go nowhere
    $('#main').classList.toggle('silent', !!(S.online && S.device.connected && S.device.answering === false && !['bridge', 'state', 'bluetooth', 'streaming', 'routing', 'debug'].includes(S.tab)));
  }

  // ------------------------------------------------------------------ sending values (throttled per key)
  const pendingSet = new Map(); // key → {ch,id,side,value}
  let flushTimer = null;
  function setValue(ch, id, side, disp) {
    const r = resolve(ch, id, side);
    if (!r) return;
    const k = key(r.addr, r.idx);
    let raw = fromDisp(r.param, disp);
    if (isDraft(ch)) {
      if (S.p.get(k) !== raw) { S.p.set(k, raw); notify(k); draftEdited(); }
      return;
    }
    // show the clamp the bridge will apply, without waiting for it
    if (id === 'vol' && S.settings.limits && S.settings.limits[ch] !== null && S.settings.limits[ch] !== undefined) raw = Math.min(raw, Math.round(S.settings.limits[ch] * 10));
    S.p.set(k, raw);
    touched.set(k, performance.now());
    notify(k);
    pendingSet.set(k, { ch: ch || 'device', id, side, value: toDisp(r.param, raw) });
    if (!flushTimer) flushTimer = setTimeout(flushSets, 35);
  }
  function flushSets() {
    flushTimer = null;
    if (!pendingSet.size) return;
    const set = [...pendingSet.values()];
    pendingSet.clear();
    send({ t: 'set', set }).catch(() => {});
  }

  // ------------------------------------------------------------------ generic controls
  function toggleBtn(ch, id, side) {
    const r = resolve(ch, id, side);
    const b = h('button', { class: 'sw', role: 'switch', 'aria-label': r.param.label, onclick: () => setValue(ch, id, side, S.p.get(key(r.addr, r.idx)) ? 0 : 1) });
    sub(key(r.addr, r.idx), (v) => b.setAttribute('aria-checked', v ? 'true' : 'false'));
    return b;
  }

  /** Label for EQ preset select value v (0 Manual, 1 Temp, 2–21 = preset 1–20). */
  function presetLabel(v, fallback) {
    if (v < 2 || v > 21) return fallback;
    const p = S.presets[v - 2];
    if (!p) return fallback;
    if (p.name) return `${v - 1} · ${p.name}`;
    return p.empty ? `${v - 1} · (empty)` : `Preset ${v - 1}`;
  }

  function selectBox(ch, id, side) {
    const r = resolve(ch, id, side);
    const list = names(r.param, r.channel) || [];
    const isPreset = id === 'eqpreset';
    const s = h('select', { 'aria-label': r.param.label, onchange: () => setValue(ch, id, side, Number(s.value)) },
      list.map((n, i) => (r.param.hide && r.param.hide.includes(i) ? null : h('option', { value: i, text: isPreset ? presetLabel(i, n) : n }))));
    if (isPreset) presetSubs.add(() => { for (const o of s.options) o.textContent = presetLabel(Number(o.value), list[Number(o.value)] || o.textContent); });
    sub(key(r.addr, r.idx), (v) => {
      if (v === undefined) return;
      if (![...s.options].some((o) => Number(o.value) === v)) s.append(h('option', { value: v, text: `#${v}` }));
      s.value = String(v);
    });
    return s;
  }

  /** Range slider + editable value. Frequencies use a log scale. */
  function levelCtl(ch, id, side) {
    const r = resolve(ch, id, side);
    const p = r.param;
    const k = key(r.addr, r.idx);
    const isLog = !!p.log;
    const STEPS = 1000;
    const toPos = (d) => (isLog ? (Math.log(d / p.min) / Math.log(p.max / p.min)) * STEPS : ((d - p.min) / (p.max - p.min)) * STEPS);
    const fromPos = (x) => {
      let d = isLog ? p.min * Math.pow(p.max / p.min, x / STEPS) : p.min + (x / STEPS) * (p.max - p.min);
      d = Math.round(d / p.step) * p.step;
      return isLog ? Math.round(d) : d;
    };
    const range = h('input', { type: 'range', min: 0, max: STEPS, step: 1, 'aria-label': p.label });
    const num = h('input', { type: 'number', min: p.min, max: p.max, step: p.step, 'aria-label': `${p.label} value` });
    range.addEventListener('input', () => setValue(ch, id, side, fromPos(Number(range.value))));
    num.addEventListener('change', () => { const v = Number(num.value); if (Number.isFinite(v)) setValue(ch, id, side, v); });
    range.addEventListener('dblclick', () => { if (p.min < 0 && p.max > 0) setValue(ch, id, side, 0); });
    sub(k, (v) => {
      const d = toDisp(p, v);
      if (d === undefined) return;
      const pos = clamp(toPos(d), 0, STEPS);
      if (document.activeElement !== range) range.value = String(pos);
      range.style.setProperty('--fill', `${(pos / STEPS) * 100}%`);
      if (document.activeElement !== num) num.value = p.decimals ? d.toFixed(p.decimals) : String(Math.round(d));
    });
    const unit = p.unit ? h('span', { class: 'hint', style: { margin: 0, minWidth: '22px' }, text: p.unit }) : null;
    return [range, num, unit];
  }

  /** The unit has read out its settings and this one isn't among them (e.g. Phones 1/2 Mute on the Pro EX). */
  const notOnUnit = (ch, r) => !!r && !isDraft(ch) && S.device.ready && S.p.size > 20 && !S.p.has(key(r.addr, r.idx));

  function paramRow(ch, id, side) {
    const r = resolve(ch, id, side);
    if (!r || !available(r.param) || notOnUnit(ch, r)) return null;
    if (r.param.lineOnly && !(r.channel && r.channel.line)) return null;
    const p = r.param;
    const label = p.id === 'ref' && r.channel && !r.channel.line ? (p.phonesLabel || p.label) : p.label;
    let ctl;
    if (p.readonly) {
      ctl = h('span', { class: 'num' });
      sub(key(r.addr, r.idx), (v) => { ctl.textContent = v === undefined ? '–' : ((names(p, r.channel) || [])[v] ?? `value ${v}`); });
    } else if (p.type === 'toggle') ctl = toggleBtn(ch, id, side);
    else if (p.type === 'select') ctl = selectBox(ch, id, side);
    else ctl = levelCtl(ch, id, side);
    return h('div', { class: `row${p.type === 'level' ? ' level' : ''}` },
      h('div', { class: 'lab' }, label, p.note ? h('small', null, p.note) : null), h('div', { class: 'ctl' }, ctl));
  }

  /**
   * Copy text. The clipboard API only works on https or localhost – this page usually runs on
   * plain http, so fall back to the classic copy command, and if even that fails, show the text
   * in a box that stays until it's closed.
   */
  async function copyText(text, what = 'Report') {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); toast(`${what} copied`); return; }
    } catch { /* fall through */ }
    const ta = h('textarea', { readonly: true, style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) { toast(`${what} copied`); return; }
    const box = h('textarea', { class: 'copy-text', readonly: true });
    box.value = text;
    const close = () => dlg.remove();
    const dlg = h('div', { class: 'copy-dlg', role: 'dialog', 'aria-label': `${what} to copy`, onclick: (e) => { if (e.target === dlg) close(); } },
      h('div', { class: 'card' }, h('h2', null, `${what} – select and copy`), box,
        h('div', { class: 'inline', style: { justifyContent: 'flex-end', marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: close }, 'Close'))));
    document.body.append(dlg);
    box.focus(); box.select();
  }

  const card = (title, ...kids) => h('section', { class: 'card' }, h('h2', null, title), ...kids);

  function groupCard(ch, section, group, title, side, exclude = []) {
    const rows = S.schema.params[section].filter((p) => p.group === group && !exclude.includes(p.id) && available(p)).map((p) => paramRow(ch, p.id, side)).filter(Boolean);
    return rows.length ? card(title || S.schema.groups[group], ...rows) : null;
  }

  // ------------------------------------------------------------------ volume knob
  const VMIN = -114.5, VMAX = 6;
  const posFromDb = (db) => 1 - Math.sqrt(clamp((VMAX - db) / (VMAX - VMIN), 0, 1));
  const dbFromPos = (p) => VMAX - (VMAX - VMIN) * Math.pow(1 - clamp(p, 0, 1), 2);
  const A0 = -135, A1 = 135;
  function arc(r, a0, a1) {
    const pt = (a) => { const t = ((a - 90) * Math.PI) / 180; return [60 + r * Math.cos(t), 60 + r * Math.sin(t)]; };
    if (a1 - a0 < 0.5) return '';
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  function volumeKnob(ch, { small = false } = {}) {
    const node = $('#tplKnob').content.firstElementChild.cloneNode(true);
    const knob = $('.knob', node);
    if (small) knob.classList.add('small');
    const c = CH[ch];
    knob.setAttribute('aria-label', `${chName(c)} volume`);
    $('.knob-track', node).setAttribute('d', arc(48, A0, A1));
    const vArc = $('.knob-value', node), lArc = $('.knob-limit', node), tick = $('.knob-tick', node), num = $('.knob-num', node);
    const rv = resolve(ch, 'vol'), rm = resolve(ch, 'mute'), rl = resolve(ch, 'lockvol');
    const kv = key(rv.addr, rv.idx);
    const cur = () => toDisp(rv.param, S.p.get(kv));
    const set = (db) => setValue(ch, 'vol', 'L', Math.round(clamp(db, VMIN, VMAX) * 2) / 2);
    const drawLimit = () => {
      const lim = S.settings.limits && S.settings.limits[ch];
      lArc.setAttribute('d', lim === null || lim === undefined ? '' : arc(56, A0 + posFromDb(lim) * (A1 - A0), A1));
    };
    sub(kv, (v) => {
      const db = toDisp(rv.param, v);
      if (db === undefined) { num.textContent = '–'; return; }
      const a = A0 + posFromDb(db) * (A1 - A0);
      vArc.setAttribute('d', arc(48, A0, a));
      tick.setAttribute('transform', `rotate(${a} 60 60)`);
      num.textContent = db.toFixed(1);
      knob.setAttribute('aria-valuenow', db);
      knob.setAttribute('aria-valuetext', `${db.toFixed(1)} dB`);
    });
    sub(key(rm.addr, rm.idx), (v) => knob.classList.toggle('muted', !!v));
    sub(key(rl.addr, rl.idx), (v) => knob.classList.toggle('locked', !!v));
    settingsSubs.add(drawLimit);
    drawLimit();

    // drag vertically (or around), fine with Shift
    let drag = null;
    knob.addEventListener('pointerdown', (e) => {
      if (cur() === undefined) return;
      knob.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, pos: posFromDb(cur()) };
      e.preventDefault();
    });
    knob.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = e.shiftKey ? 0.0006 : 0.0035;
      set(dbFromPos(drag.pos + (drag.y - e.clientY) * k));
    });
    const end = () => { drag = null; };
    knob.addEventListener('pointerup', end);
    knob.addEventListener('pointercancel', end);
    knob.addEventListener('wheel', (e) => {
      if (cur() === undefined) return;
      e.preventDefault();
      set(cur() + (e.deltaY < 0 ? 0.5 : -0.5) * (e.shiftKey ? 1 : 1));
    }, { passive: false });
    knob.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
      if (d && cur() !== undefined) { e.preventDefault(); set(cur() + d); }
    });
    knob.addEventListener('dblclick', () => { if (!notOnUnit(ch, rm)) setValue(ch, 'mute', 'L', S.p.get(key(rm.addr, rm.idx)) ? 0 : 1); });
    // step buttons with auto-repeat
    for (const b of node.querySelectorAll('.step')) {
      let t1, t2;
      const step = () => { if (cur() !== undefined) set(cur() + Number(b.dataset.step) * 0.5); };
      const stop = () => { clearTimeout(t1); clearInterval(t2); };
      b.addEventListener('pointerdown', () => { step(); t1 = setTimeout(() => { t2 = setInterval(step, 70); }, 380); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
    }
    return node;
  }

  function latchKey(ch, id, label, cls) {
    const r = resolve(ch, id);
    if (notOnUnit(ch, r)) return null;
    const b = h('button', { class: `key ${cls || ''}`, onclick: () => setValue(ch, id, 'L', S.p.get(key(r.addr, r.idx)) ? 0 : 1) }, label);
    sub(key(r.addr, r.idx), (v) => b.setAttribute('aria-pressed', v ? 'true' : 'false'));
    return b;
  }

  // ------------------------------------------------------------------ EQ curve
  const FS = 48000;
  const BAND_COLORS = ['#f2994a', '#e2c044', '#5ccf8a', '#58a6ff', '#c084fc'];
  function biquad(type, f0, gainDb, q) {
    const w0 = (2 * Math.PI * clamp(f0, 10, FS * 0.49)) / FS;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    const al = sw / (2 * Math.max(q, 0.1));
    const sA = 2 * Math.sqrt(A) * al;
    switch (type) {
      case 'peak': return [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
      case 'lowshelf': return [A * ((A + 1) - (A - 1) * cw + sA), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sA), (A + 1) + (A - 1) * cw + sA, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sA];
      case 'highshelf': return [A * ((A + 1) + (A - 1) * cw + sA), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sA), (A + 1) - (A - 1) * cw + sA, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sA];
      case 'lowpass': return [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al];
      case 'highpass': return [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al];
      default: return [1, 0, 0, 1, 0, 0];
    }
  }
  function magDb(c, f) {
    const w = (2 * Math.PI * f) / FS;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
    const dr = c[3] + c[4] * c1 + c[5] * c2, di = -(c[4] * s1 + c[5] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  function bandType(band, typeVal) {
    if (band === 1) return ['peak', 'lowshelf', 'highpass', 'lowpass'][typeVal || 0] || 'peak'; // Peak, Shelf, High Pass, High Cut
    if (band === 5) return ['peak', 'highshelf', 'lowpass'][typeVal || 0] || 'peak';
    return 'peak';
  }
  const hasGain = (t) => t === 'peak' || t === 'lowshelf' || t === 'highshelf';

  function eqCard(ch, dualId, { title = 'Parametric EQ', presetSelect = true } = {}) {
    const c = CH[ch];
    const side = () => (S.p.get(key(c.addr, (c.kind === 'input' ? SEC.input : SEC.output)[dualId].idx)) ? (S.eqSide[ch] || 'L') : 'L');
    const g = (id) => getDisp(ch, id, side());
    const bands = [1, 2, 3, 4, 5];

    const wrap = h('div', { class: 'curve' });
    const canvas = h('canvas');
    wrap.append(canvas);
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1;
    const F0 = 20, F1 = 20000, GMAX = 15;
    const xOf = (f) => (Math.log(f / F0) / Math.log(F1 / F0)) * W;
    const fOf = (x) => F0 * Math.pow(F1 / F0, clamp(x / W, 0, 1));
    const yOf = (db) => H / 2 - (db / GMAX) * (H / 2 - 12);
    const dbOf = (y) => ((H / 2 - y) / (H / 2 - 12)) * GMAX;

    function filters(s) {
      const list = [];
      for (const b of bands) {
        const type = bandType(b, getDisp(ch, b === 1 ? 'b1type' : b === 5 ? 'b5type' : null, s));
        const f = getDisp(ch, `b${b}f`, s), gn = getDisp(ch, `b${b}g`, s), q = getDisp(ch, `b${b}q`, s);
        if (f === undefined) continue;
        list.push({ band: b, type, f, g: gn || 0, q: q || 1, c: biquad(type, f, gn || 0, q || 1) });
      }
      return list;
    }
    function draw() {
      if (!W) return;
      const css = getComputedStyle(document.documentElement);
      const col = (n) => css.getPropertyValue(n).trim();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.font = '11px system-ui, sans-serif';
      ctx.lineWidth = 1;
      ctx.strokeStyle = col('--curve-grid');
      ctx.fillStyle = col('--muted');
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = Math.round(xOf(f)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.fillText(fmtHz(f), x + 3, H - 5);
      }
      for (const db of [-12, -6, 6, 12]) {
        const y = Math.round(yOf(db)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillText(`${db > 0 ? '+' : ''}${db}`, 4, y - 3);
      }
      ctx.strokeStyle = col('--curve-zero');
      ctx.beginPath(); ctx.moveTo(0, Math.round(yOf(0)) + 0.5); ctx.lineTo(W, Math.round(yOf(0)) + 0.5); ctx.stroke();

      const s = side();
      const on = c.draft ? true : !!g('eqen'); // presets have no on/off; outputs do
      const fl = filters(s);
      const bt = [];
      if (c.draft || g('bten')) { // a preset carries B/T values, not the on/off switch
        const bf = g('bassf'), tf = g('trebf');
        if (bf) bt.push(biquad('lowshelf', bf, g('bass') || 0, g('bassq') || 0.9));
        if (tf) bt.push(biquad('highshelf', tf, g('treble') || 0, g('trebq') || 0.9));
      }
      wrap.classList.toggle('off', !on && !bt.length);
      // individual bands
      for (const b of fl) {
        ctx.strokeStyle = BAND_COLORS[b.band - 1];
        ctx.globalAlpha = on ? 0.35 : 0.2;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 2) { const y = yOf(clamp(magDb(b.c, fOf(x)), -GMAX - 3, GMAX + 3)); x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // total
      const all = [...(on ? fl.map((b) => b.c) : []), ...bt];
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 1.5) {
        const f = fOf(x);
        let db = 0;
        for (const c of all) db += magDb(c, f);
        const y = yOf(clamp(db, -GMAX - 3, GMAX + 3));
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      // handles
      for (const b of fl) {
        const x = xOf(b.f), y = yOf(hasGain(b.type) ? b.g : 0);
        ctx.fillStyle = BAND_COLORS[b.band - 1];
        ctx.globalAlpha = on ? 1 : 0.5;
        ctx.beginPath(); ctx.arc(x, y, active && active.band === b.band ? 9 : 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#111';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.fillText(String(b.band), x - 3, y + 3.5);
      }
      ctx.globalAlpha = 1;
    }
    let queued = false;
    const redraw = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
    new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      draw();
    }).observe(wrap);

    // dragging band handles
    let active = null;
    const hit = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 26;
      for (const b of filters(side())) {
        const d = Math.hypot(xOf(b.f) - x, yOf(hasGain(b.type) ? b.g : 0) - y);
        if (d < bd) { bd = d; best = b; }
      }
      return { best, x, y };
    };
    canvas.addEventListener('pointerdown', (e) => {
      const { best } = hit(e);
      if (!best) return;
      active = best;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      redraw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!active) { canvas.style.cursor = hit(e).best ? 'grab' : 'default'; return; }
      const r = canvas.getBoundingClientRect();
      const s = side();
      const fp = SEC.eq[`b${active.band}f`];
      let f = Math.round(fOf(e.clientX - r.left));
      f = clamp(f, fp.min, fp.max);
      setValue(ch, `b${active.band}f`, s, f);
      if (hasGain(active.type)) setValue(ch, `b${active.band}g`, s, Math.round(clamp(dbOf(e.clientY - r.top), -12, 12) * 2) / 2);
    });
    const up = () => { active = null; redraw(); };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => {
      const { best } = hit(e);
      if (!best) return;
      e.preventDefault();
      const qp = SEC.eq[`b${best.band}q`];
      setValue(ch, `b${best.band}q`, side(), Math.round(clamp(best.q + (e.deltaY < 0 ? 0.1 : -0.1), qp.min, qp.max) * 10) / 10);
    }, { passive: false });
    canvas.addEventListener('dblclick', (e) => {
      const { best } = hit(e);
      if (best && hasGain(best.type)) setValue(ch, `b${best.band}g`, side(), 0);
    });

    // band editors (rebuilt when the L/R side changes)
    const bandsEl = h('div', { class: 'bands' });
    const btEl = h('div');
    const presetEl = h('div', { class: 'rightside' });
    function numField(id, s) {
      const r = resolve(ch, id, s);
      const p = r.param;
      const inp = h('input', { type: 'number', min: p.min, max: p.max, step: p.step, 'aria-label': p.label });
      inp.addEventListener('change', () => { const v = Number(inp.value); if (Number.isFinite(v)) setValue(ch, id, s, v); });
      sub(key(r.addr, r.idx), (v) => {
        const d = toDisp(p, v);
        if (d !== undefined && document.activeElement !== inp) inp.value = p.decimals ? d.toFixed(p.decimals) : String(Math.round(d));
      });
      return inp;
    }
    function buildBands() {
      const s = side();
      bandsEl.replaceChildren(...bands.map((b) => h('div', { class: 'band' },
        h('div', { class: 'bh' }, h('span', null, `Band ${b}`), h('i', { style: { background: BAND_COLORS[b - 1] } })),
        b === 1 || b === 5 ? selectBox(ch, `b${b}type`, s) : h('select', { disabled: true }, h('option', { text: 'Peak' })),
        h('label', null, 'Gain', numField(`b${b}g`, s)),
        h('label', null, 'Hz', numField(`b${b}f`, s)),
        h('label', null, 'Q', numField(`b${b}q`, s)),
      )));
      // B/T on/off and "Load B/T with preset" belong to the output, not to a preset
      const btIds = isDraft(ch) ? ['bass', 'bassf', 'bassq', 'treble', 'trebf', 'trebq'] : ['bten', 'bass', 'bassf', 'bassq', 'treble', 'trebf', 'trebq', 'btload'];
      btEl.replaceChildren(...btIds.map((id) => paramRow(ch, id, s)));
      if (presetSelect) presetEl.replaceChildren(h('span', { class: 'hint', style: { margin: 0 }, text: 'Preset' }), selectBox(ch, 'eqpreset', s));
      // keep curve in sync with every EQ value on this side
      for (const p of S.schema.params.eq) { const r = resolve(ch, p.id, s); sub(key(r.addr, r.idx), redraw); }
      redraw();
    }

    const sideSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Channel' });
    const segBtns = ['L', 'R'].map((sd) => h('button', { onclick: () => { S.eqSide[ch] = sd; refreshSide(); } }, sd === 'L' ? 'Left' : 'Right'));
    sideSeg.append(...segBtns);
    let shownSide = null;
    function refreshSide() {
      const dual = !!S.p.get(key(c.addr, (c.kind === 'input' ? SEC.input : SEC.output)[dualId].idx));
      sideSeg.hidden = !dual;
      const s = side();
      segBtns.forEach((b, i) => b.setAttribute('aria-pressed', (i === 0 ? 'L' : 'R') === s ? 'true' : 'false'));
      if (s !== shownSide) { shownSide = s; enRow.replaceChildren(...(c.draft ? [] : [toggleLabel()])); buildBands(); }
    }
    const enRow = h('div', { class: 'left' });
    const toggleLabel = () => h('span', { class: 'inline' }, toggleBtn(ch, 'eqen', side()), h('span', { text: 'EQ' }));
    const dualCtl = h('span', { class: 'inline' }, toggleBtn(ch, dualId, 'L'), h('span', { class: 'hint', style: { margin: 0 }, text: 'Separate left / right' }));
    sub(key(c.addr, (c.kind === 'input' ? SEC.input : SEC.output)[dualId].idx), refreshSide);

    return h('section', { class: 'card' },
      h('h2', null, title, h('span', { class: 'right hint eq-tip', style: { margin: 0 }, text: 'drag points · wheel = Q · double-click = 0 dB' })),
      h('div', { class: 'eq-head' }, enRow, h('div', { class: 'rightside' }, dualCtl, sideSeg), presetEl),
      wrap, bandsEl,
      c.kind === 'output' && !c.draft ? h('p', { class: 'hint' }, h('a', { href: '/#eqpresets' }, 'EQ presets'), ' · ', h('a', { href: '/eq/' }, 'Find an EQ for your headphones ›')) : null,
      h('h3', { style: { marginTop: '16px' } }, 'Bass / Treble'), btEl);
  }

  // ------------------------------------------------------------------ pages
  const settingsSubs = new Set();
  const presetSubs = new Set();
  const statusSubs = new Set();
  const btSubs = new Set();
  const rxSubs = new Set();
  const rtSubs = new Set();
  const trSubs = new Set();

  // ---- State: like ADI-2 Remote's status window
  /** Output level at 0 dBFS in dBu, where RME's manuals give it (Line: Ref Level; Pro phones). */
  function refDbu(c) {
    const ref = S.p.get(key(c.addr, SEC.output.ref.idx));
    if (ref === undefined) return null;
    if (c.line) {
      const n = (names(SEC.output.ref, c) || [])[ref];
      const m = n && n.match(/([+-]?\d+)\s*dBu/);
      return m ? Number(m[1]) : null;
    }
    if (model() !== 'pro') return null;
    const balanced = S.statusInfo && S.statusInfo.balanced;
    return (ref ? 22 : 7) + (balanced ? 6 : 0); // ADI-2 Pro EX manual: Lo-Power +7 dBu, Hi-Power +22 dBu, balanced +6 dB
  }

  function pageState() {
    const v = (ch, id) => getDisp(ch, id);
    const nm = (ch, id) => {
      const r = resolve(ch, id);
      const val = S.p.get(key(r.addr, r.idx));
      return val === undefined ? '–' : ((names(r.param, r.channel) || [])[val] ?? `value ${val}`);
    };
    const kv = (label, valueFn, hint) => {
      const el = h('div', { class: 'ctl num' });
      const upd = () => { el.textContent = valueFn(); };
      upd();
      statusSubs.add(upd);
      settingsSubs.add(upd);
      return [h('div', { class: 'row' }, h('div', { class: 'lab' }, label, hint ? h('small', null, hint) : null), el), upd];
    };
    const rowsDev = [];
    const addDev = (label, fn, hint, keys = []) => {
      const [row, upd] = kv(label, fn, hint);
      for (const k of keys) sub(k, upd);
      rowsDev.push(row);
    };
    const dk = (id) => key(12, SEC.device[id].idx);
    addDev('Unit', () => `${S.device.modelName || '–'}${S.statusInfo ? ` · revision ${S.statusInfo.revision}` : ''}`);
    if (available(SEC.device.basic)) addDev('Basic Mode', () => nm('device', 'basic'), null, [dk('basic')]);
    addDev('Clock Source', () => nm('device', 'clock'), null, [dk('clock')]);
    addDev('Sample rate', () => nm('device', 'srate'), null, [dk('srate')]);
    addDev('Balanced phones', () => (S.statusInfo ? (S.statusInfo.balanced ? 'yes' : 'no') : '–'));
    addDev('DSD decode', () => (S.statusInfo ? (S.statusInfo.dsd ? `on (${S.statusInfo.dsd})` : 'off') : '–'));

    // outputs
    const tbody = h('tbody');
    const outRow = (c) => {
      const cells = {};
      for (const k of ['state', 'src', 'ref', 'vol', 'dbu', 'fx']) cells[k] = h('td', { class: k === 'vol' || k === 'dbu' ? 'v' : '' });
      const tr = h('tr', null, h('th', null, chName(c)), cells.state, cells.src, cells.ref, cells.vol, cells.dbu, cells.fx);
      const upd = () => {
        const muted = v(c.key, 'mute'), dim = v(c.key, 'dim');
        const st = [];
        if (muted) st.push('muted');
        if (dim) st.push('dim');
        // only what the unit reports: the Pro EX sends no Mute/Dim/Source for Phones 1/2
        cells.state.textContent = st.join(', ') || (muted === undefined && dim === undefined ? '–' : 'not muted');
        cells.state.className = muted ? 'bad' : '';
        const rs = resolve(c.key, 'src');
        cells.src.textContent = rs && notOnUnit(c.key, rs) ? 'as Line Out' : nm(c.key, 'src');
        cells.ref.textContent = nm(c.key, 'ref');
        const vol = v(c.key, 'vol');
        cells.vol.textContent = vol === undefined ? '–' : `${vol.toFixed(1)} dB`;
        const ref = refDbu(c);
        cells.dbu.textContent = vol === undefined || ref === null ? '–' : `${(ref + vol).toFixed(1)} dBu`;
        const fx = [];
        if (v(c.key, 'eqen')) fx.push('EQ');
        if (v(c.key, 'bten')) fx.push('B/T');
        if (v(c.key, 'loud')) fx.push('LD');
        if (v(c.key, 'xfeed')) fx.push(`CF ${v(c.key, 'xfeed')}`);
        cells.fx.replaceChildren(...(fx.length ? fx.map((f) => h('span', { class: 'chip on' }, f)) : ['–']));
      };
      for (const id of ['mute', 'dim', 'src', 'ref', 'vol', 'eqen', 'bten', 'loud', 'xfeed']) { const r = resolve(c.key, id); if (r) sub(key(r.addr, r.idx), upd); }
      statusSubs.add(upd);
      upd();
      return tr;
    };
    tbody.append(...outputs().map(outRow));
    if (available(SEC.device.digout)) {
      const cell = h('td', { colspan: 6 });
      const upd = () => { cell.textContent = S.p.get(dk('digout')) ? 'mirrors Line Out (Digital Out Source = Main Out)' : '0 dB, no DSP'; };
      sub(dk('digout'), upd);
      tbody.append(h('tr', null, h('th', null, 'Digital Out'), cell));
    }
    const outCard = card('Outputs',
      h('div', { class: 'scroll plain' }, h('table', { class: 'tbl state' },
        h('thead', null, h('tr', null, ...['', 'Mute / Dim', 'Source', 'Reference', 'Volume', 'at 0 dBFS', 'DSP'].map((t) => h('th', null, t)))), tbody)),
      h('p', { class: 'hint' }, 'dBu = output level for a full-scale signal, from Ref Level / Hi-Power and the manual\'s figures.'));

    return h('div', { class: 'stack' },
      h('div', { class: 'grid' }, card('Device', ...rowsDev)),
      outCard);
  }

  const hhmm = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' }) : '–');
  /** When the unit stopped answering, and what ADI-2-Pi had sent just before. */
  function silenceCard() {
    const body = h('div');
    const draw = () => {
      const list = S.silences || [];
      if (!list.length) { body.replaceChildren(h('p', { class: 'hint', style: { marginTop: 0 } }, 'The ADI-2 has answered without a break since ADI-2-Pi started.')); return; }
      body.replaceChildren(...list.slice().reverse().map((x) => h('div', { class: 'silence' },
        h('div', { class: 'row' }, h('div', { class: 'lab' }, `Stopped answering ${hhmm(x.lastRx)}`), h('div', { class: `ctl ${x.back ? '' : 'bad'}` }, x.back ? `back ${hhmm(x.back)}` : 'still not answering')),
        x.sent.length
          ? h('ol', { class: 'snaps' }, x.sent.map((m) => h('li', null, h('b', null, new Date(m.at).toLocaleTimeString()), ' ', m.what, ' ', h('code', null, m.hex))))
          : h('p', { class: 'hint' }, 'Before that, ADI-2-Pi had only sent its routine re-reads.'))));
    };
    statusSubs.add(draw);
    draw();
    return card('Connection', body,
      h('p', { class: 'hint' }, 'If MIDI Control switches itself off, this shows what ADI-2-Pi had sent to the unit in the 20 seconds before. Copy report (below) includes it.'));
  }
  const silenceText = () => (S.silences || []).map((x) => [`not answering from ${x.lastRx}${x.back ? ` until ${x.back}` : ' (still)'}`,
    ...(x.sent.length ? x.sent.map((m) => `   ${m.at} ${m.what} [${m.hex}]`) : ['   (only routine re-reads before)'])].join('\n'));

  /** Shows the undocumented status words bit by bit and records labelled snapshots. */
  function statusRecorder() {
    const snaps = store.get('statusSnaps', []);
    const grid = h('div', { class: 'bits' });
    const label = h('input', { type: 'text', class: 'plain', placeholder: 'What is the situation? e.g. "SPDIF coax unplugged"', 'aria-label': 'Snapshot label' });
    const list = h('ol', { class: 'snaps' });
    let last = null;
    const bitsRow = (name, value, width, prev) => {
      const cells = [];
      for (let b = width - 1; b >= 0; b--) {
        const on = (value >> b) & 1;
        const changed = prev !== undefined && (((prev >> b) & 1) !== on);
        cells.push(h('i', { class: `${on ? 'on' : ''}${changed ? ' chg' : ''}`, title: `bit ${b}` }));
      }
      return h('div', { class: 'bitrow' }, h('b', null, name), h('span', { class: 'cells' }, cells), h('code', null, `0x${value.toString(16).padStart(Math.ceil(width / 4), '0')}`));
    };
    const draw = () => {
      const s = S.statusInfo;
      if (!s) { grid.replaceChildren(h('p', { class: 'hint' }, 'Waiting for the status message…')); return; }
      const ref = snaps.length ? snaps[snaps.length - 1].info : null;
      const raw = (x) => parseInt(x.split(' ')[0], 16);
      grid.replaceChildren(
        bitsRow('Byte 6', raw(s.hex), 7, ref ? raw(ref.hex) : undefined),
        bitsRow('IOStatus1', s.io1, 28, ref ? ref.io1 : undefined),
        bitsRow('IOStatus2', s.io2, 28, ref ? ref.io2 : undefined),
        bitsRow('Byte 15', parseInt(s.hex.split(' ')[9], 16), 7, ref ? parseInt(ref.hex.split(' ')[9], 16) : undefined),
        h('p', { class: 'hint' }, 'Raw: ', h('code', null, s.hex), ref ? ' · highlighted bits differ from the last snapshot' : ''));
      last = s;
    };
    const drawList = () => {
      list.replaceChildren(...snaps.map((x) => h('li', null, h('b', null, x.label), ' ', h('code', null, x.info.hex))));
    };
    statusSubs.add(draw);
    draw();
    drawList();
    const settingsText = () => ['basic', 'clock', 'srate', 'spdifin', 'srcmode', 'optout', 'digout', 'dualph', 'balph']
      .filter((id) => SEC.device[id] && available(SEC.device[id]))
      .map((id) => `${id}=${S.p.get(key(12, SEC.device[id].idx)) ?? '–'}`).join(' ') + (usbRate ? ` usbRate=${usbRate}` : '');
    let usbRate = null;
    send({ t: 'usb' }).then((m) => { const u = m.usb; usbRate = u && (u.open ? u.rate : u.lastSet && u.lastSet.rate); }).catch(() => {});
    const report = () => [
      `ADI-2-Pi status report · ${S.device.modelName} (ID 0x${(S.device.id || 0).toString(16)}) · ADI-2-Pi ${S.bridge.version || ''}`,
      ...snaps.map((x, i) => `${i + 1}. ${x.label} (${x.at || ''})\n   status: ${x.info.hex}\n   settings: ${x.settings}\n   outputs: ${x.outputs}`),
      ...((S.silences || []).length ? ['Connection:', ...silenceText()] : []),
    ].join('\n');
    const val = (k) => { const x = S.p.get(k); return x === undefined ? '–' : x; };
    const outputsText = () => outputs().map((c) => `${c.key}: src=${val(key(c.addr, SEC.output.src.idx))} vol=${val(key(c.addr, SEC.output.vol.idx))} mute=${val(key(c.addr, SEC.output.mute.idx))}`).join(' · ');
    return card('Status recorder',
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'Help decode the digital input status: change one thing on the unit (unplug an input, switch the clock source, play a different sample rate), give it a name and take a snapshot. Copy report puts all snapshots in a text, e.g. for an issue report.'),
      grid,
      h('div', { class: 'inline', style: { marginTop: '10px' } }, label,
        h('button', { class: 'btn primary', onclick: () => {
          if (!S.statusInfo) return toast('No status message yet.');
          if (S.device.answering === false) return toast('The ADI-2 is not answering – a snapshot would only repeat old values.');
          snaps.push({ label: label.value.trim() || `snapshot ${snaps.length + 1}`, info: S.statusInfo, settings: settingsText(), outputs: outputsText(), at: new Date().toISOString() });
          store.set('statusSnaps', snaps);
          label.value = '';
          drawList(); draw();
        } }, 'Snapshot'),
        h('button', { class: 'btn', onclick: async () => {
          copyText(report());
        } }, 'Copy report'),
        h('button', { class: 'btn danger', onclick: () => { if (confirm('Delete all snapshots?')) { snaps.length = 0; store.set('statusSnaps', snaps); drawList(); draw(); } } }, 'Clear')),
      list);
  }

  // ---- EQ presets: the unit's 20 slots, shared by all outputs (like ADI-2 Remote's EQ Presets page)
  const EQ_IDS = () => S.schema.params.eq.map((p) => p.id).filter((id) => id !== 'eqpreset');
  S.draft = store.get('draftMeta', null) || { slot: null, name: '', dirty: false, from: null };
  function saveDraftMeta() { store.set('draftMeta', S.draft); }
  function draftEdited() {
    if (!S.draft.eqDirty) { S.draft.eqDirty = true; S.draft.dirty = true; saveDraftMeta(); for (const fn of draftSubs) fn(); }
    persistDraft();
  }
  const draftSubs = new Set();
  let persistTimer = null;
  function persistDraft() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => store.set('draftValues', [...S.p].filter(([k]) => /^d[LRX]\./.test(k))), 300);
  }
  function restoreDraft() {
    for (const [k, v] of store.get('draftValues', [])) S.p.set(k, v);
  }
  /** Replace the draft. values: { L: {eqIdx: raw}, R: {…}, dual } */
  function setDraft(values, meta) {
    for (const k of [...S.p.keys()]) if (/^d[LRX]\./.test(k)) S.p.delete(k);
    for (const side of ['L', 'R']) for (const [i, v] of Object.entries(values[side] || {})) S.p.set(`d${side}.${i}`, v);
    S.p.set(`dX.${SEC.output.dualeq.idx}`, values.dual ? 1 : 0);
    S.draft = { slot: null, name: '', dirty: false, eqDirty: false, nameDirty: false, from: null, ...meta };
    saveDraftMeta();
    persistDraft();
    for (const k of S.p.keys()) if (/^d[LRX]\./.test(k)) notify(k);
    for (const fn of draftSubs) fn();
  }
  function draftFromPreset(n) {
    const p = S.presets[n - 1];
    if (!p) return;
    const dual = !!p.dual; // the unit's own Dual EQ flag for this preset
    setDraft({ L: p.L, R: dual && Object.keys(p.R).length ? p.R : p.L, dual }, { slot: n, name: p.name, from: `preset ${n}` });
  }
  function draftFromOutput(ch) {
    const c = CH[ch];
    const vals = { L: {}, R: {}, dual: !!S.p.get(key(c.addr, SEC.output.dualeq.idx)) };
    for (const id of EQ_IDS()) {
      const i = SEC.eq[id].idx;
      vals.L[i] = S.p.get(key(c.eq, i));
      vals.R[i] = S.p.get(key(c.eqR, i));
    }
    setDraft(vals, { name: '', from: chName(c) });
  }
  /** Draft handed over by the Headphone EQ Generator: [{id, side, value}] in display units. */
  function draftFromItems(d) {
    const def = S.schema.eqDefaults.values;
    const vals = { L: { ...def }, R: Object.fromEntries(Object.entries(def).filter(([i]) => Number(i) <= 19)), dual: false };
    for (const it of d.items || []) {
      const p = SEC.eq[it.id];
      if (p) vals[it.side === 'R' ? 'R' : 'L'][p.idx] = fromDisp(p, it.value);
    }
    setDraft(vals, { name: d.name || '', from: 'Headphone EQ generator' });
    S.draft.dirty = true;
    S.draft.eqDirty = true;
    saveDraftMeta();
  }
  /** Write the draft into an output's live EQ (both channels). */
  function applyDraft(ch) {
    const c = CH[ch];
    const dual = !!S.p.get(`dX.${SEC.output.dualeq.idx}`);
    const set = [{ ch, id: 'dualeq', value: dual ? 1 : 0 }];
    for (const id of EQ_IDS()) {
      const p = SEC.eq[id];
      for (const side of ['L', 'R']) {
        const v = S.p.get(`d${dual ? side : 'L'}.${p.idx}`);
        const k = key(side === 'R' ? c.eqR : c.eq, p.idx);
        if (v !== undefined && S.p.has(k)) set.push({ key: k, value: v }); // only what this unit has
      }
    }
    return send({ t: 'set', set });
  }
  function usedBy(n) {
    return outputs().filter((c) => S.p.get(key(c.eq, SEC.eq.eqpreset.idx)) === n + 1);
  }

  function pagePresets() {
    // pending hand-over from the generator
    const handed = store.get('eqDraft', null);
    if (handed) { draftFromItems(handed); store.set('eqDraft', null); }
    else restoreDraft();

    const list = h('div', { class: 'preset-list', role: 'listbox', 'aria-label': 'EQ presets on the ADI-2' });
    const renderList = () => {
      list.replaceChildren(...Array.from({ length: 20 }, (_, i) => {
        const n = i + 1;
        const p = S.presets[i] || { name: '', empty: null };
        const users = usedBy(n);
        const sel = S.draft.slot === n;
        return h('button', { class: `preset${sel ? ' sel' : ''}${p.empty ? ' empty' : ''}`, role: 'option', 'aria-selected': sel ? 'true' : 'false',
          onclick: () => {
            if (S.draft.dirty && !confirm('Discard the changes in the editor?')) return;
            draftFromPreset(n);
          } },
          h('span', { class: 'pn' }, String(n)),
          h('span', { class: 'pname' }, p.name || (p.empty ? 'empty' : (p.empty === null ? '…' : `Preset ${n}`))),
          h('span', { class: 'puse' }, users.map((c) => h('i', { title: `used by ${chName(c)}` }, c.short))));
      }));
    };
    renderList();
    presetSubs.add(renderList);
    draftSubs.add(renderList);
    for (const c of outputs()) sub(key(c.eq, SEC.eq.eqpreset.idx), renderList);

    const left = h('section', { class: 'card' },
      h('h2', null, 'Presets on the ADI-2', h('span', { class: 'right hint', style: { margin: 0 } }, 'shared by all outputs')),
      list,
      h('h3', { style: { marginTop: '14px' } }, 'Start from'),
      h('div', { class: 'inline' },
        outputs().map((c) => h('button', { class: 'btn', onclick: () => {
          if (S.draft.dirty && !confirm('Discard the changes in the editor?')) return;
          draftFromOutput(c.key);
        } }, `${chName(c)} EQ`)),
        h('a', { class: 'btn', href: '/eq/' }, 'Headphone EQ generator')),
      h('p', { class: 'hint' }, 'The editor is a scratch pad: nothing reaches the unit until you apply or store it.'));

    // editor
    const head = h('div', { class: 'draft-head' });
    const nameIn = h('input', { type: 'text', maxlength: 14, placeholder: 'Name (max. 14)', 'aria-label': 'Preset name',
      oninput: () => { S.draft.name = nameIn.value; S.draft.nameDirty = true; S.draft.dirty = true; saveDraftMeta(); renderHead(); } });
    const renderHead = () => {
      nameIn.value = S.draft.name || '';
      const d = S.draft;
      head.replaceChildren(...[
        h('b', null, d.slot ? `Preset ${d.slot}` : 'New EQ'),
        d.from ? h('span', { class: 'hint', style: { margin: 0 } }, d.slot ? ' · read from the unit' : ` · from ${d.from}`) : null,
        d.dirty ? h('span', { class: 'badge' }, 'changed') : null].filter(Boolean));
    };
    renderHead();
    draftSubs.add(renderHead);
    const hasDraft = () => [...S.p.keys()].some((k) => k.startsWith('dL.'));
    const renameBtn = h('button', { class: 'btn', onclick: () => {
      const n = S.draft.slot;
      const name = (nameIn.value || '').trim();
      if (!name) return toast('Enter a name first.');
      send({ t: 'renamePreset', n, name }).then(() => {
        S.draft.name = name;
        S.draft.nameDirty = false;
        S.draft.dirty = !!S.draft.eqDirty;
        saveDraftMeta();
        for (const fn of draftSubs) fn();
        toast(`Preset ${n} is now “${name}”`);
      }).catch(() => {});
    } }, 'Rename');
    const refreshRename = () => {
      const p = S.draft.slot && S.presets[S.draft.slot - 1];
      renameBtn.hidden = !(p && p.empty === false);
      renameBtn.textContent = 'Rename';
    };
    refreshRename();
    draftSubs.add(refreshRename);
    presetSubs.add(refreshRename);

    const applyBtns = outputs().map((c) => h('button', { class: 'btn', onclick: () => {
      if (!hasDraft()) return toast('Pick a preset or start from an EQ first.');
      if (!confirm(`Replace the EQ on ${chName(c)} with this one?`)) return;
      applyDraft(c.key).then(() => toast(`Applied to ${chName(c)}`)).catch(() => {});
    } }, chName(c)));
    const selectBtns = outputs().map((c) => h('button', { class: 'btn', onclick: () => {
      const n = S.draft.slot;
      setValue(c.key, 'eqpreset', 'L', n + 1);
      toast(`${chName(c)} uses preset ${n}`);
    } }, chName(c)));
    const selectRow = h('div', { class: 'row level' }, h('div', { class: 'lab' }, 'Load this preset on', h('small', null, 'the unit loads its stored copy')), h('div', { class: 'ctl', style: { flexWrap: 'wrap' } }, selectBtns));
    const slotSel = h('select', { 'aria-label': 'Preset slot' });
    const renderSlots = () => {
      const cur = slotSel.value || String(S.draft.slot || 1);
      slotSel.replaceChildren(...Array.from({ length: 20 }, (_, i) => h('option', { value: i + 1, text: presetLabel(i + 2, `Preset ${i + 1}`) })));
      slotSel.value = cur;
    };
    renderSlots();
    presetSubs.add(renderSlots);
    const storeBtn = h('button', { class: 'btn primary', onclick: () => {
      if (!hasDraft()) return toast('Pick a preset or start from an EQ first.');
      const n = Number(slotSel.value);
      const cur = S.presets[n - 1];
      if (cur && !cur.empty && n !== S.draft.slot && !confirm(`Overwrite preset ${n}${cur.name ? ` (${cur.name})` : ''} on the ADI-2?`)) return;
      const dual = !!S.p.get(`dX.${SEC.output.dualeq.idx}`);
      const take = (side) => Object.fromEntries([...S.p].filter(([k]) => k.startsWith(`d${side}.`)).map(([k, v]) => [k.slice(3), v]));
      const name = (nameIn.value || '').trim() || `EQ ${n}`;
      send({ t: 'storePreset', n, name, L: take('L'), R: dual ? take('R') : take('L'), dual })
        .then(() => {
          S.draft = { ...S.draft, slot: n, name, dirty: false, eqDirty: false, nameDirty: false, from: `preset ${n}` };
          saveDraftMeta();
          for (const fn of draftSubs) fn();
          toast(`Stored as preset ${n} · ${name}`);
        }).catch(() => {});
    } }, 'Store');
    const refreshUse = () => {
      selectRow.hidden = !(S.draft.slot && !S.draft.dirty && S.presets[S.draft.slot - 1] && !S.presets[S.draft.slot - 1].empty);
      if (S.draft.slot) slotSel.value = String(S.draft.slot);
    };
    refreshUse();
    draftSubs.add(refreshUse);

    const right = h('div', { class: 'stack' },
      h('section', { class: 'card' },
        h('h2', null, 'Editor'),
        h('div', { class: 'row level' }, head, h('div', { class: 'ctl' }, nameIn, renameBtn))),
      eqCard('draft', 'dualeq', { title: 'EQ', presetSelect: false }),
      h('section', { class: 'card' },
        h('h2', null, 'Use it'),
        selectRow,
        h('div', { class: 'row level' }, h('div', { class: 'lab' }, 'Apply to output', h('small', null, 'writes this EQ into the output now')), h('div', { class: 'ctl', style: { flexWrap: 'wrap' } }, applyBtns)),
        h('div', { class: 'row level' }, h('div', { class: 'lab' }, 'Store on the ADI-2', h('small', null, 'as a preset all outputs can load')), h('div', { class: 'ctl' }, slotSel, storeBtn)),
        h('p', { class: 'hint' }, 'Stored presets live in the unit: every output can load them, from here, the unit\'s menu or ADI-2 Remote.')));
    return h('div', { class: 'grid-2 presets-page' }, left, right);
  }

  function outputs() { return S.schema.channels.filter((c) => c.kind === 'output'); }

  function pageOverview() {
    const cards = outputs().map((c) => {
      const chips = h('div', { class: 'chips' });
      const chip = (label, ch, id, side) => {
        const r = resolve(ch, id, side);
        const el = h('button', { class: 'chip', onclick: () => setValue(ch, id, side, S.p.get(key(r.addr, r.idx)) ? 0 : 1) }, label);
        sub(key(r.addr, r.idx), (v) => el.classList.toggle('on', !!v));
        return el;
      };
      chips.append(chip('EQ', c.key, 'eqen', 'L'), chip('Bass/Treble', c.key, 'bten', 'L'), chip('Loudness', c.key, 'loud'), chip('Crossfeed', c.key, 'xfeed'));
      // Source: only where the unit has one (on the Pro, Phones 1/2 plays what Line Out plays)
      const srcRow = paramRow(c.key, 'src');
      if (srcRow) {
        srcRow.classList.add('ov-src');
        const r = resolve(c.key, 'src');
        sub(key(r.addr, r.idx), (v) => { srcRow.hidden = v === undefined; });
      }
      return h('section', { class: 'card out-card' },
        h('h2', null, chName(c), h('button', { class: 'chip', onclick: () => go(c.key) }, 'Details ›')),
        volumeKnob(c.key, { small: false }),
        h('div', { class: 'keys' }, latchKey(c.key, 'mute', 'Mute', 'mute'), latchKey(c.key, 'dim', 'Dim', 'dim')),
        srcRow,
        chips);
    });
    return h('div', { class: 'grid' }, cards);
  }

  function pageOutput(ch) {
    const left = h('div', { class: 'stack' },
      h('section', { class: 'card out-card' },
        h('h2', null, 'Level'),
        volumeKnob(ch),
        h('div', { class: 'keys' }, latchKey(ch, 'mute', 'Mute', 'mute'), latchKey(ch, 'dim', 'Dim', 'dim'), latchKey(ch, 'lockvol', 'Lock')),
        h('div', { style: { alignSelf: 'stretch' } }, paramRow(ch, 'bal'), paramRow(ch, 'width'))),
      groupCard(ch, 'output', 'loudness'));
    const right = h('div', { class: 'stack' },
      eqCard(ch, 'dualeq'),
      groupCard(ch, 'output', 'settings', 'Settings'));
    return h('div', { class: 'grid-2' }, left, right);
  }

  function pageInput() {
    const left = h('div', { class: 'stack' }, groupCard('in', 'input', 'input', 'Input', 'L', []));
    const right = h('div', { class: 'stack' }, eqCard('in', 'indualeq'));
    return h('div', { class: 'grid-2' }, left, right);
  }

  function setupsCard() {
    const grid = h('div', { class: 'setups' });
    for (let n = 1; n <= 9; n++) {
      const name = S.setups[n - 1] || '';
      grid.append(h('div', { class: 'setup' },
        h('b', null, `Setup ${n}`), h('span', { title: name, text: name || '—' }),
        h('div', { class: 'inline' },
          h('button', { class: 'btn', onclick: () => send({ t: 'setup', action: 'load', n }).then(() => toast(`Loading setup ${n}`)).catch(() => {}) }, 'Load'),
          h('button', { class: 'btn', onclick: () => {
            const nm = askSetupName(`Save the current state to setup ${n}? This overwrites it on the unit.\n\nName (up to 14 characters):`, name || `Setup ${n}`);
            if (nm !== null) send({ t: 'setup', action: 'save', n, name: nm }).then(() => toast(`Saved to setup ${n} as “${nm}”`)).catch(() => {});
          } }, 'Save'),
          h('button', { class: 'btn', onclick: () => {
            const nm = askSetupName(`New name for setup ${n} (up to 14 characters):`, name);
            if (nm !== null && nm !== name) send({ t: 'setup', action: 'rename', n, name: nm }).then(() => toast(`Setup ${n} renamed`)).catch(() => {});
          } }, 'Rename'))));
    }
    return card('Setups', paramRow('device', 'loadvol'), grid,
      h('div', { class: 'inline', style: { marginTop: '12px' } },
        h('button', { class: 'btn danger', onclick: () => { if (confirm('Load factory defaults on the ADI-2? All current settings on the unit are replaced.')) send({ t: 'setup', action: 'factory' }).then(() => toast('Factory defaults loaded')).catch(() => {}); } }, 'Load factory defaults')),
      h('p', { class: 'hint' }, 'Rename changes only the name; Save stores the current state of the unit under a name.'));
  }
  /** null = cancelled */
  function askSetupName(text, current) {
    const v = prompt(text, current || '');
    if (v === null) return null;
    const clean = v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 14);
    if (!clean) { toast('The name must not be empty (letters, digits and simple punctuation).'); return null; }
    return clean;
  }

  const RATES = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000];
  const kHz = (r) => `${(r / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} kHz`;
  function usbRateCard() {
    const sel = h('select', { 'aria-label': 'Sample rate' },
      h('option', { value: '', text: 'Choose…' }), ...RATES.map((r) => h('option', { value: r, text: kHz(r) })));
    const btn = h('button', { class: 'btn primary' }, 'Set');
    const now = h('div', { class: 'ctl num' }, '–');
    const note = h('p', { class: 'hint' });
    const show = (u) => {
      if (!u || !u.available) {
        now.textContent = '–';
        note.textContent = u && u.reason ? u.reason : 'The ADI-2\'s USB audio device was not found on the Pi.';
        sel.disabled = btn.disabled = true;
        return;
      }
      sel.disabled = btn.disabled = !!u.open;
      if (u.open) {
        now.textContent = `${kHz(u.rate)} · playing`;
        note.textContent = `${u.owner || 'A program'} is playing to the ADI-2 and sets the rate while it plays.`;
      } else {
        const sr = S.p.get(key(12, SEC.device.srate.idx));
        now.textContent = sr !== undefined && RATES[sr] ? kHz(RATES[sr]) : (u.lastSet ? kHz(u.lastSet.rate) : '–');
        note.textContent = 'On USB the Pi sets the ADI-2\'s sample rate, as a computer would; the unit\'s own Sample Rate menu is not available then. Players that start later set their own rate. Up to 768 kHz in USB stereo mode, 192 kHz in multi-channel mode.';
      }
    };
    let lastU = null;
    const load = () => send({ t: 'usb' }).then((m) => { lastU = m.usb; show(m.usb); }).catch(() => {});
    sub(key(12, SEC.device.srate.idx), () => { if (lastU) show(lastU); });
    btn.onclick = () => {
      if (!sel.value) return;
      btn.disabled = true;
      send({ t: 'usbRate', rate: Number(sel.value) }).then((m) => { lastU = m.usb; show(m.usb); toast(`Sample rate set to ${kHz(Number(sel.value))}`); }).catch(() => load());
    };
    load();
    return card('Sample rate (USB)',
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Now'), now),
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Set to'), h('div', { class: 'ctl' }, sel, btn)),
      note);
  }

  function pageDevice() {
    return h('div', { class: 'grid' },
      ['mode', 'phones', 'dsd', 'display', 'power'].map((g) => groupCard('device', 'device', g)),
      S.routing && S.routing.available ? null : usbRateCard(), // with the audio service: Routing tab
      setupsCard());
  }

  // ---- Bluetooth: phones play into the ADI-2, the ADI-2 plays to headphones/speakers
  const CODECS = { sbc: 'SBC', sbc_xq: 'SBC-XQ', aac: 'AAC', aptx: 'aptX', aptx_hd: 'aptX HD', aptx_ll: 'aptX LL', aptx_ll_duplex: 'aptX LL', ldac: 'LDAC', faststream: 'FastStream', faststream_duplex: 'FastStream', opus_05: 'Opus', opus_g: 'Opus', lc3: 'LC3', lc3plus_h3: 'LC3plus' };
  const codecName = (c) => (c ? CODECS[c] || c.toUpperCase() : null);
  const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  function btAct(action, extra = {}, okText) {
    return send({ t: 'bt', action, ...extra }).then((m) => { if (m.bluetooth) { S.bt = m.bluetooth; for (const fn of btSubs) fn(); } if (okText) toast(okText); }).catch(() => {});
  }

  function pageBluetooth() {
    const busy = new Set(); // addresses with an action under way
    const sliders = new Map();
    const wrap = h('div', { class: 'grid bt-page' });
    let tick = null;

    // which outputs play USB (and so what a phone sends)
    const usbOutputs = () => outputs().filter((c) => {
      const r = resolve(c.key, 'src');
      if (!r) return c.key === 'ph12'; // Pro: Phones 1/2 follows Line Out
      const v = S.p.get(key(r.addr, r.idx));
      if (v === undefined) return false;
      const nm = (names(r.param, r.channel) || [])[v] || '';
      return v === 0 || /USB/.test(nm);
    });

    const devButtons = (d, kind) => {
      const b = [];
      const act = (action, label, cls = 'btn', ok) => h('button', { class: cls, disabled: busy.has(d.address), onclick: () => {
        busy.add(d.address); draw();
        btAct(action, { address: d.address }, ok).finally(() => { busy.delete(d.address); draw(); });
      } }, label);
      if (!d.paired) b.push(act('pair', busy.has(d.address) ? 'Pairing…' : 'Pair', 'btn primary', `Paired with ${d.name}`));
      else if (d.connected) b.push(act('disconnect', 'Disconnect'));
      else b.push(act('connect', busy.has(d.address) ? 'Connecting…' : 'Connect', 'btn primary'));
      if (d.paired) b.push(h('button', { class: 'btn', disabled: busy.has(d.address), onclick: () => {
        if (confirm(`Forget ${d.name}? It has to be paired again to use it.`)) btAct('forget', { address: d.address }, `${d.name} forgotten`);
      } }, 'Forget'));
      return h('div', { class: 'inline bt-btns' }, b);
    };

    const devRow = (d, kind) => {
      const a = kind === 'in' ? d.audioIn : d.audioOut;
      const facts = [];
      if (d.connected) {
        if (a && a.codec) facts.push(h('span', { class: 'chip on' }, codecName(a.codec)));
        if (kind === 'in') facts.push(h('span', { class: 'hint inl' }, a ? (a.state === 'running' ? 'playing into the ADI-2' : 'connected') : 'connected, no audio yet'));
        else facts.push(h('span', { class: 'hint inl' }, a ? (a.linked ? 'gets the ADI-2\'s sound' : 'connected – nothing to play (source Off)') : 'connected, no audio yet'));
      } else if (d.paired) facts.push(h('span', { class: 'hint inl' }, 'not connected'));
      else facts.push(h('span', { class: 'hint inl' }, d.rssi !== null && d.rssi !== undefined ? `found · signal ${d.rssi > -60 ? 'strong' : d.rssi > -75 ? 'good' : 'weak'}` : 'found'));
      if (d.battery !== null && d.battery !== undefined) facts.push(h('span', { class: 'hint inl' }, `battery ${d.battery} %`));
      let vol = null;
      if (kind === 'out' && d.connected && a && a.volume !== null && a.volume !== undefined) {
        let el = sliders.get(d.address);
        if (!el) {
          el = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': `${d.name} volume` });
          let t = null;
          el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => btAct('volume', { address: d.address, value: Number(el.value) }), 120); });
          sliders.set(d.address, el);
        }
        if (document.activeElement !== el) el.value = a.volume;
        vol = h('label', { class: 'bt-vol' }, h('span', null, 'Volume'), el);
      }
      return h('li', { class: `bt-dev${d.connected ? ' on' : ''}` },
        h('div', { class: 'bt-name' }, h('b', null, d.name), h('small', null, d.address)),
        h('div', { class: 'bt-facts' }, facts),
        vol,
        devButtons(d, kind));
    };

    function draw() {
      const bt = S.bt;
      if (!bt) { wrap.replaceChildren(h('div', { class: 'empty' }, h('p', null, 'Waiting for ADI-2-Pi…'))); return; }
      if (!bt.available) {
        wrap.replaceChildren(card('Bluetooth', h('p', { class: 'hint', style: { marginTop: 0 } }, bt.reason || 'Bluetooth is not available.')));
        return;
      }
      const now = Date.now();
      const devs = bt.devices || [];
      const senders = devs.filter((d) => d.canSend && d.paired);
      const receivers = devs.filter((d) => d.canReceive && d.paired);
      const found = devs.filter((d) => !d.paired && !d.canSend);
      const foundPhones = devs.filter((d) => !d.paired && d.canSend);
      const visible = bt.pairingUntil && bt.pairingUntil > now;
      const scanning = bt.scanUntil && bt.scanUntil > now;

      // ---- phones → ADI-2
      const plays = usbOutputs();
      const inCard = card('Play from your phone',
        h('p', { class: 'hint', style: { marginTop: 0 } }, 'Phones, tablets and computers stream to “', h('b', null, bt.adapter ? bt.adapter.name : 'ADI-2-Pi'), '” and play through the ADI-2.'),
        h('div', { class: 'row' },
          h('div', { class: 'lab' }, visible ? `Visible for ${mmss(bt.pairingUntil - now)}` : 'Pair a new phone', h('small', null, visible ? 'Now choose it in your phone\'s Bluetooth settings.' : 'Makes the Pi visible for 2 minutes.')),
          h('div', { class: 'ctl' }, visible
            ? h('button', { class: 'btn', onclick: () => btAct('pairing', { seconds: 0 }) }, 'Stop')
            : h('button', { class: 'btn primary', onclick: () => btAct('pairing', { seconds: 120 }) }, 'Make visible'))),
        senders.length ? h('ul', { class: 'bt-list' }, senders.map((d) => devRow(d, 'in'))) : h('p', { class: 'hint' }, 'No phone paired yet.'),
        h('div', { class: 'row' },
          h('div', { class: 'lab' }, scanning ? 'Searching…' : 'Phone doesn\'t see the Pi?', h('small', null, 'Keep your phone\'s Bluetooth settings open, then let the Pi search for it.')),
          h('div', { class: 'ctl' }, scanning
            ? h('button', { class: 'btn', onclick: () => btAct('scan', { seconds: 0 }) }, 'Stop')
            : h('button', { class: 'btn', onclick: () => btAct('scan', { seconds: 30 }) }, 'Search'))),
        foundPhones.length ? h('ul', { class: 'bt-list' }, foundPhones.map((d) => devRow(d, 'in'))) : null,
        S.device.connected && !plays.length ? h('p', { class: 'warn-note' }, 'None of the ADI-2\'s outputs plays USB right now: set an output\'s Source to Auto or USB to hear Bluetooth.') : null,
        S.device.connected && plays.length ? h('p', { class: 'hint' }, `Heard on: ${plays.map(chName).join(', ')}.`) : null);

      // ---- ADI-2 → headphones/speakers
      const srcSel = h('select', { 'aria-label': 'What Bluetooth headphones play' },
        [['line', 'Line Out, after its EQ'], ['ph34', 'Phones 3/4, after its EQ'], ['analog', 'Analog input'], ['off', 'Nothing']].map(([v, t]) => h('option', { value: v, text: t, selected: bt.outSource === v })));
      srcSel.addEventListener('change', () => btAct('outSource', { value: srcSel.value }));
      const srcHint = bt.outSource === 'line' || bt.outSource === 'ph34'
        ? `While Bluetooth headphones are connected, ADI-2-Pi sets ${bt.outSource === 'line' ? 'Line Out' : 'Phones 3/4'}'s Loopback to “post FX −6 dB”: they hear its EQ, bass/treble and crossfeed, but not its volume – use the slider below. The setting goes back when they disconnect.`
        : bt.outSource === 'analog' ? 'They hear the ADI-2\'s analog input.' : 'Connected headphones and speakers get no sound.';
      const gainSel = h('select', { 'aria-label': 'Level to Bluetooth' },
        [0, 3, 6, 9, 12, 15, 18, 20].map((g) => h('option', { value: g, text: g ? `+${g} dB` : '0 dB', selected: Number(bt.gainDb ?? 6) === g })));
      gainSel.addEventListener('change', () => btAct('gain', { value: Number(gainSel.value) }));
      const outCard = card('Listen on Bluetooth headphones',
        h('div', { class: 'row' }, h('div', { class: 'lab' }, 'They play'), h('div', { class: 'ctl' }, srcSel)),
        h('p', { class: 'hint' }, srcHint),
        bt.outSource !== 'off' ? h('div', { class: 'row' },
          h('div', { class: 'lab' }, 'Level', h('small', null, bt.outSource === 'analog' ? 'Raise it if the analog source is quiet.' : '+6 dB makes up for the unit\'s −6 dB headroom. Raise it if the source itself is quiet.')),
          h('div', { class: 'ctl' }, gainSel)) : null,
        receivers.length ? h('ul', { class: 'bt-list' }, receivers.map((d) => devRow(d, 'out'))) : h('p', { class: 'hint' }, 'No headphones or speakers paired yet.'),
        h('div', { class: 'row' },
          h('div', { class: 'lab' }, scanning ? 'Searching…' : 'Add headphones or speakers', h('small', null, 'Put them in pairing mode first.')),
          h('div', { class: 'ctl' }, scanning
            ? h('button', { class: 'btn', onclick: () => btAct('scan', { seconds: 0 }) }, 'Stop')
            : h('button', { class: 'btn primary', onclick: () => btAct('scan', { seconds: 30 }) }, 'Search'))),
        found.length ? h('ul', { class: 'bt-list' }, found.map((d) => devRow(d, 'out'))) : (scanning ? h('p', { class: 'hint' }, 'Nothing found yet…') : null));

      const audioOk = bt.audio && bt.audio.available && !bt.audio.reason;
      const info = card('Good to know',
        !audioOk ? h('p', { class: 'warn-note', style: { marginTop: 0 } }, `Audio: ${(bt.audio && bt.audio.reason) || 'the audio service is not running'}.`) : null,
        h('p', { class: 'hint', style: { marginTop: audioOk ? 0 : null } }, 'The best codec both sides support is used: LDAC, aptX HD, aptX, SBC-XQ or SBC to headphones; aptX HD, aptX, SBC-XQ or SBC from phones (iPhones use SBC – AAC isn\'t available on Raspberry Pi OS).'),
        h('p', { class: 'hint' }, 'The Pi\'s Bluetooth shares its antenna with Wi-Fi on 2.4 GHz. For dropout-free LDAC, connect the Pi by Ethernet or use 5 GHz Wi-Fi.'),
        h('p', { class: 'hint' }, 'Bluetooth runs at 44.1 or 48 kHz; the ADI-2 follows that over USB.'));

      wrap.replaceChildren(inCard, outCard, info);
      clearTimeout(tick);
      if (visible || scanning) tick = setTimeout(() => { if (wrap.isConnected) draw(); }, 1000);
    }
    btSubs.add(draw);
    for (const c of outputs()) { const r = resolve(c.key, 'src'); if (r) sub(key(r.addr, r.idx), () => { if (wrap.isConnected) draw(); }); }
    draw();
    return wrap;
  }

  // ---- Routing: what plays into the ADI-2, who is heard, sample rate, which outputs play it
  const KIND = { bluetooth: 'Bluetooth', receiver: 'Network', app: 'Program' };
  function pageRouting() {
    const wrap = h('div', { class: 'stack rt-page' });
    const act = (msg) => send({ t: 'routing', ...msg }).then((m) => { S.routing = m.routing; for (const fn of rtSubs) fn(); }).catch(() => {});
    function draw() {
      const rt = S.routing;
      if (!rt) { wrap.replaceChildren(h('div', { class: 'empty' }, h('p', null, 'Waiting for ADI-2-Pi…'))); return; }
      if (!rt.available) { wrap.replaceChildren(card('Pi playback', h('p', { class: 'hint', style: { marginTop: 0 } }, rt.reason || 'The audio service is not running.'))); return; }
      // ---- now playing
      const playing = (rt.sources || []).filter((x) => x.playing);
      const list = playing.length
        ? h('ul', { class: 'bt-list' }, playing.map((x) => h('li', { class: `bt-dev${x.active ? ' on' : ''}` },
          h('div', { class: 'bt-name' }, h('b', null, x.label), h('small', null, `${KIND[x.kind] || ''}${x.rate ? ` · ${kHz(x.rate)}` : ''}`)),
          h('div', { class: 'bt-facts' }, x.active
            ? h('span', { class: 'chip on' }, 'heard')
            : h('span', { class: 'hint inl' }, 'muted – a newer source plays')),
          !x.active && rt.mode === 'newest' ? h('div', { class: 'inline bt-btns' }, h('button', { class: 'btn primary', onclick: () => act({ action: 'switch', key: x.key }) }, 'Switch to this')) : null)))
        : h('p', { class: 'hint' }, 'Nothing is playing into the ADI-2 right now.');
      const modeSel = h('select', { 'aria-label': 'When a second source starts' },
        [['newest', 'The newest is heard'], ['mix', 'Mix them all']].map(([v, t]) => h('option', { value: v, text: t, selected: rt.mode === v })));
      modeSel.addEventListener('change', () => act({ action: 'mode', value: modeSel.value }));
      const now = card('Now playing', list,
        h('div', { class: 'row' }, h('div', { class: 'lab' }, 'When a second source starts', h('small', null, rt.mode === 'newest' ? 'The others are muted until it stops; then the one before is heard again.' : 'Everything that plays is heard at once.')), h('div', { class: 'ctl' }, modeSel)));

      // ---- sample rate
      const rateSel = h('select', { 'aria-label': 'Sample rate' },
        [[0, 'Follow what plays'], ...[44100, 48000, 88200, 96000, 176400, 192000].map((r) => [r, `Always ${kHz(r)}`])].map(([v, t]) => h('option', { value: v, text: t, selected: rt.rate === v })));
      rateSel.addEventListener('change', () => act({ action: 'rate', value: Number(rateSel.value) }));
      const sr = S.p.get(key(12, SEC.device.srate.idx));
      const unitRate = sr !== undefined && RATES[sr] ? RATES[sr] : null;
      const rateCard = card('Sample rate',
        h('div', { class: 'row' }, h('div', { class: 'lab' }, 'The ADI-2 runs at'), h('div', { class: 'ctl' }, rateSel)),
        h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Now'), h('div', { class: 'ctl num' }, rt.current ? kHz(rt.current) : unitRate ? kHz(unitRate) : '–')),
        h('p', { class: 'hint' }, rt.rate
          ? 'Everything is converted to this rate, so the ADI-2 never has to switch (it mutes briefly when it does).'
          : 'The ADI-2 switches to the rate of what plays – 44.1 kHz for AirPlay and Bluetooth, up to 192 kHz from UPnP, Squeezelite or Roon. It mutes briefly when it switches.'));

      // ---- outputs: their Source, and switching it to USB while the Pi plays
      const au = rt.auto;
      const outRows = outputs().map((c) => {
        const r = resolve(c.key, 'src');
        if (!r || notOnUnit(c.key, r)) return h('div', { class: 'row' }, h('div', { class: 'lab' }, chName(c), h('small', null, 'plays what Line Out plays')), h('div', { class: 'ctl' }));
        const rows = [h('div', { class: 'row' }, h('div', { class: 'lab' }, chName(c), h('small', null, 'Source')), h('div', { class: 'ctl' }, selectBox(c.key, 'src')))];
        if (au && au.usb[c.key] !== undefined) {
          const on = au.usb[c.key];
          const held = au.held[c.key];
          const was = held !== null ? (names(r.param, c) || [])[held] : null;
          rows.push(h('div', { class: 'row' },
            h('div', { class: 'lab' }, 'USB while the Pi plays', h('small', null, was ? `switched – goes back to ${was} when it stops` : on ? 'switches to USB 1/2, back afterwards' : 'off – the Source stays as set')),
            h('div', { class: 'ctl' }, h('button', { class: 'sw', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': `${chName(c)}: USB while the Pi plays`, onclick: () => act({ action: 'usb', value: { [c.key]: !on } }) }))));
        }
        return rows;
      }).flat();
      const outCard = card('ADI-2 outputs', h('p', { class: 'hint', style: { marginTop: 0 } }, 'When something starts playing on the Pi, these outputs switch to USB 1/2; about 10 s after it stops, they go back to the source they had. Pick another source while it plays and that output is left alone.'), ...outRows);

      // ---- Bluetooth headphones
      const b = S.bt;
      const srcName = { line: 'Line Out, after its EQ', ph34: 'Phones 3/4, after its EQ', analog: 'the analog input', off: 'nothing' };
      const btCard = b && b.available ? card('Bluetooth headphones',
        h('div', { class: 'row' }, h('div', { class: 'lab' }, 'They hear'), h('div', { class: 'ctl' }, `${srcName[b.outSource] || b.outSource}${b.outSource !== 'off' ? ` (+${b.gainDb ?? 6} dB)` : ''}`)),
        h('div', { class: 'inline', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn', onclick: () => go('bluetooth') }, 'Change on the Bluetooth tab'))) : null;

      const intro = h('p', { class: 'hint', style: { margin: '0 0 4px' } }, 'What the Pi plays into the ADI-2 over USB – phones over Bluetooth and the network receivers on the Streaming tab. The ADI-2’s own settings (inputs, loopback, EQ) stay on the other tabs.');
      wrap.replaceChildren(intro, h('div', { class: 'grid' }, now, rateCard, outCard, btCard));
    }
    rtSubs.add(draw);
    btSubs.add(draw);
    draw();
    return wrap;
  }

  // ---- Streaming: network receivers playing into the ADI-2
  const INSTALL_HINT = { airplay: 'sudo ./install.sh', spotify: 'sudo ./install.sh --with-spotify', upnp: 'sudo ./install.sh', squeezelite: 'sudo ./install.sh', snapcast: 'sudo ./install.sh', roon: 'sudo ./install.sh --with-roon' };
  function pageStreaming() {
    const wrap = h('div', { class: 'stack rx-page' });
    const servers = new Map(); // keep typed server names across redraws
    function row(r) {
      let state, cls = '';
      if (!r.installed) state = 'Not installed';
      else if (r.error) { state = r.error; cls = 'bad'; }
      else if (!r.enabled) state = 'Off';
      else if (r.playing) { state = `Playing${r.rate ? ` · ${kHz(r.rate)}` : ''}`; cls = 'ok'; }
      else if (r.running) state = 'Ready';
      else state = 'Starting…';
      const sw = r.external || !r.installed ? null : h('button', { class: 'sw', role: 'switch', 'aria-checked': r.enabled ? 'true' : 'false', 'aria-label': r.label, onclick: () => {
        send({ t: 'receiver', id: r.id, enabled: !r.enabled }).then((m) => { S.streaming = m.streaming; for (const fn of rxSubs) fn(); }).catch(() => {});
      } });
      let srv = null;
      if (r.hasServer && r.installed) {
        const inp = servers.get(r.id) || h('input', { type: 'text', placeholder: 'find automatically', 'aria-label': `${r.label} server`, value: r.server || '' });
        servers.set(r.id, inp);
        if (document.activeElement !== inp && inp.dataset.dirty !== '1') inp.value = r.server || '';
        inp.oninput = () => { inp.dataset.dirty = '1'; };
        const save = h('button', { class: 'btn', onclick: () => {
          send({ t: 'receiver', id: r.id, server: inp.value.trim() }).then((m) => { inp.dataset.dirty = ''; S.streaming = m.streaming; for (const fn of rxSubs) fn(); toast('Saved'); }).catch(() => {});
        } }, 'Save');
        srv = h('div', { class: 'rx-server' }, h('label', null, r.id === 'squeezelite' ? 'Lyrion Music Server' : 'Snapcast server', h('small', null, ' – empty finds it on the network')), h('div', { class: 'rx-srv-row' }, inp, save));
      }
      const hint = !r.installed
        ? h('p', { class: 'hint' }, 'Install with ', h('code', null, INSTALL_HINT[r.id] || 'sudo ./install.sh'), '.')
        : r.external ? h('p', { class: 'hint' }, r.enabled ? 'Runs as Roon\'s own service. In Roon, enable “System Output” on this Pi – that plays through ADI-2-Pi.' : 'Installed, but its service is not running: sudo systemctl start roonbridge') : null;
      return h('section', { class: 'card rx' },
        h('div', { class: 'rx-head' },
          h('div', { class: 'rx-title' }, h('h3', null, r.label, r.variant ? h('span', { class: 'chip' }, r.variant) : null), h('small', null, r.about)),
          sw),
        h('div', { class: `rx-state ${cls}` }, state),
        srv, hint);
    }
    function draw() {
      const st = S.streaming;
      if (!st) { wrap.replaceChildren(h('div', { class: 'empty' }, h('p', null, 'Waiting for ADI-2-Pi…'))); return; }
      const intro = card('Streaming',
        h('p', { class: 'hint', style: { marginTop: 0 } }, 'Apps and servers on your network find this Pi as “', h('b', null, st.name || 'ADI-2-Pi'), '” and play through the ADI-2 over USB – the sample rate follows what plays.'),
        !st.audio ? h('p', { class: 'warn-note' }, st.reason || 'The audio service (adi2-pi-audio) is not running, so the receivers wait for it.') : null,
        h('p', { class: 'hint' }, 'If several play at once, the newest is heard – see the Pi Playback tab.'));
      wrap.replaceChildren(intro, h('div', { class: 'grid' }, (st.receivers || []).map(row)));
    }
    rxSubs.add(draw);
    draw();
    return wrap;
  }

  // ---- bridge page
  let monitorEl = null;
  let monitoring = false;
  function monitorLine(m) {
    if (!monitorEl || !monitorEl.isConnected) return;
    const t = new Date();
    const line = h('div', { class: m.dir }, `${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, '0')} ${m.dir === 'tx' ? '→' : '←'} ${m.hex}`);
    monitorEl.append(line);
    while (monitorEl.childElementCount > 400) monitorEl.firstElementChild.remove();
    monitorEl.scrollTop = monitorEl.scrollHeight;
  }

  function pageBridge() {
    const st = S.settings;
    // name
    const nameIn = h('input', { type: 'text', value: st.name, maxlength: 40, 'aria-label': 'Name' });
    const bridgeCard = card('ADI-2-Pi',
      h('div', { class: 'row level' }, h('div', { class: 'lab' }, 'Name'), h('div', { class: 'ctl' }, nameIn,
        h('button', { class: 'btn', onclick: () => send({ t: 'settings', patch: { name: nameIn.value } }).then(() => toast('Saved')).catch(() => {}) }, 'Save'))),
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Version'), h('div', { class: 'ctl num' }, S.bridge.version || '–')),
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Host'), h('div', { class: 'ctl' }, `${S.bridge.host || location.hostname}.local`)),
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'ADI-2'), h('div', { class: 'ctl' }, S.device.connected ? `${S.device.modelName || '…'}${S.device.id ? ` · ID 0x${S.device.id.toString(16)}` : ''}` : 'not connected')),
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'API', h('small', null, 'for the Stream Deck plugin and apps')), h('div', { class: 'ctl' }, h('code', null, `ws://${location.host}/ws`))),
      h('p', { class: 'hint' }, 'Settings are read from the unit and only written to it when you change something. The bridge keeps nothing about the unit on disk.'));

    // safety
    const lim = {};
    const limRows = outputs().map((c) => {
      const v = st.limits?.[c.key];
      const inp = h('input', { type: 'number', min: -114.5, max: 6, step: 0.5, placeholder: 'none', value: v === null || v === undefined ? '' : v, 'aria-label': `${chName(c)} limit` });
      lim[c.key] = inp;
      return h('div', { class: 'row' }, h('div', { class: 'lab' }, chName(c)), h('div', { class: 'ctl' }, inp, h('span', { class: 'hint', style: { margin: 0 } }, 'dB')));
    });
    const rise = h('input', { type: 'number', min: 0, max: 200, step: 1, value: st.riseDbPerSec || 0, 'aria-label': 'Rise speed' });
    const linkBoxes = outputs().map((c) => {
      const cb = h('input', { type: 'checkbox', value: c.key, checked: (st.link || []).includes(c.key) });
      return h('label', { class: 'inline', style: { gap: '6px' } }, cb, chName(c));
    });
    const safety = card('Volume safety',
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'Highest volume the bridge will set. Applies to this page, the Stream Deck plugin and apps – not to the knob on the unit.'),
      ...limRows,
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Limit rise speed', h('small', null, 'dB per second, 0 = off')), h('div', { class: 'ctl' }, rise)),
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Link volumes', h('small', null, 'move together when changed here')), h('div', { class: 'ctl', style: { flexWrap: 'wrap', justifyContent: 'flex-end' } }, linkBoxes)),
      h('div', { class: 'inline', style: { marginTop: '10px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn primary', onclick: () => {
          const limits = Object.fromEntries(Object.entries(lim).map(([k, i]) => [k, i.value === '' ? null : Number(i.value)]));
          const link = linkBoxes.map((l) => l.firstChild).filter((cb) => cb.checked).map((cb) => cb.value);
          send({ t: 'settings', patch: { limits, riseDbPerSec: Number(rise.value) || 0, link } }).then(() => toast('Saved')).catch(() => {});
        } }, 'Save')));

    // debug tools: off by default, switched on here (per browser)
    const dbg = h('button', { class: 'sw', role: 'switch', 'aria-checked': debugOn() ? 'true' : 'false', 'aria-label': 'Debug tab', onclick: () => {
      store.set('debug', !debugOn());
      dbg.setAttribute('aria-checked', debugOn() ? 'true' : 'false');
      renderTabs();
    } });
    const debugCard = card('Troubleshooting',
      h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Show the Debug tab', h('small', null, 'parameter table, MIDI monitor, what was sent to the unit, settings ADI-2-Pi can’t name, status recorder')), h('div', { class: 'ctl' }, dbg)),
      h('p', { class: 'hint' }, 'Only for this browser. The tools only run while the Debug tab is open.'));
    return h('div', { class: 'grid' }, bridgeCard, safety, triggerCard(), debugCard);
  }

  /** Shut the Pi down when the ADI-2 goes to standby (its Trigger Out wired to GPIO3). */
  function triggerCard() {
    const body = h('div');
    const act = (msg) => send({ t: 'trigger', ...msg }).then((m) => { S.trigger = m.trigger; draw(); }).catch(() => {});
    let tick = null;
    function draw() {
      const t = S.trigger;
      if (!t) { body.replaceChildren(h('p', { class: 'hint' }, 'Waiting for ADI-2-Pi…')); return; }
      const sw = h('button', { class: 'sw', role: 'switch', 'aria-checked': t.enabled ? 'true' : 'false', 'aria-label': 'Shut down with the ADI-2', onclick: () => act({ enabled: !t.enabled }) });
      const delay = h('select', { 'aria-label': 'Delay', disabled: !t.enabled, onchange: () => act({ delaySec: Number(delay.value) }) },
        [[10, '10 s'], [30, '30 s'], [60, '1 min'], [300, '5 min']].map(([v, l]) => h('option', { value: v, text: l, selected: t.delaySec === v })));
      let state = null;
      if (t.enabled) {
        let text, cls = '';
        if (!t.available) { text = t.reason; cls = 'bad'; }
        else if (t.shuttingDown) text = 'Shutting down…';
        else if (t.shutdownAt) text = `ADI-2 in standby – the Pi shuts down in ${Math.max(0, Math.ceil((t.shutdownAt - Date.now()) / 1000))} s`;
        else if (t.adiOn === true) { text = 'ADI-2 on (trigger on)'; cls = 'ok'; }
        else if (t.adiOn === false) text = t.armed ? 'ADI-2 in standby' : 'ADI-2 in standby – the Pi stays on until the ADI-2 has been on once';
        else text = 'Reading GPIO3…';
        state = h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Now'), h('div', { class: `ctl ${cls}`, style: { textAlign: 'right' } }, text,
          t.shutdownAt && !t.shuttingDown ? h('button', { class: 'btn', style: { marginLeft: '8px' }, onclick: () => act({ cancel: true }) }, 'Cancel') : null));
      }
      body.replaceChildren(
        h('div', { class: 'row' }, h('div', { class: 'lab' }, 'Shut down with the ADI-2', h('small', null, 'when the ADI-2 goes to standby')), h('div', { class: 'ctl' }, sw)),
        h('div', { class: 'row' }, h('div', { class: 'lab' }, 'After'), h('div', { class: 'ctl' }, delay)),
        state,
        h('p', { class: 'hint' }, 'Needs a small circuit: the ADI-2’s Trigger Out through an optocoupler to GPIO3 (pin 5) and GND – see the README. ',
          t.canWake ? 'Switching the ADI-2 on starts the Pi again.' : 'This Pi can’t be started by the trigger – only shut down.'),
        h('p', { class: 'hint' }, h('b', null, 'Starting the Pi while the ADI-2 is in standby: '), 'the Pi stays on. It only shuts down after it has seen the ADI-2 switched on and then go to standby.'),
        h('p', { class: 'hint' }, 'This doesn’t help with power cuts – the ADI-2 and the Pi lose power at the same moment. With Auto Standby on the ADI-2, the Pi shuts down with it.'));
      clearTimeout(tick);
      if (t.enabled && t.shutdownAt) tick = setTimeout(() => { if (body.isConnected) draw(); }, 1000); // countdown
    }
    trSubs.add(draw);
    draw();
    return card('Trigger', body);
  }

  const debugOn = () => !!store.get('debug', false);

  /** Developer and troubleshooting tools – only shown with the switch on the System tab. */
  function pageDebug() {
    // parameter table
    const filter = h('input', { type: 'text', placeholder: 'Filter…', 'aria-label': 'Filter parameters' });
    const tbody = h('tbody');
    const rows = [];
    for (const c of S.schema.channels) {
      if (!available(c)) continue;
      const list = c.kind === 'input' ? S.schema.params.input : S.schema.params.output;
      for (const p of list) if (available(p)) rows.push({ ch: c, p, side: null });
      for (const p of S.schema.params.eq) { rows.push({ ch: c, p, side: 'L' }); rows.push({ ch: c, p, side: 'R' }); }
    }
    for (const p of S.schema.params.device) if (available(p)) rows.push({ ch: null, p, side: null });
    for (const r of rows) {
      const res = resolve(r.ch ? r.ch.key : 'device', r.p.id, r.side || 'L');
      const k = key(res.addr, res.idx);
      const vCell = h('td', { class: 'v' });
      const dCell = h('td');
      const tr = h('tr', null, h('td', { class: 'k' }, k), h('td', null, `${r.ch ? chName(r.ch) : 'Device'}${r.side ? ` EQ ${r.side}` : ''} · ${r.p.label}`), vCell, dCell);
      tr.dataset.s = `${k} ${tr.textContent}`.toLowerCase();
      sub(k, (v) => {
        vCell.textContent = v === undefined ? '–' : String(v);
        if (v === undefined) { dCell.textContent = ''; return; }
        if (r.p.type === 'select') dCell.textContent = (names(r.p, r.ch) || [])[v] ?? `#${v}`;
        else if (r.p.type === 'toggle') dCell.textContent = v ? 'on' : 'off';
        else dCell.textContent = `${fmt(toDisp(r.p, v), r.p.decimals || 0)} ${r.p.unit || ''}`;
      });
      tbody.append(tr);
    }
    filter.addEventListener('input', () => { const q = filter.value.toLowerCase(); for (const tr of tbody.children) tr.hidden = q && !tr.dataset.s.includes(q); });
    const table = card('Parameters', h('div', { class: 'inline', style: { marginBottom: '10px' } }, filter,
      h('button', { class: 'btn', onclick: () => send({ t: 'refresh' }).then(() => toast('Re-reading from the unit')).catch(() => {}) }, 'Re-read')),
      h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Parameter'), h('th', null, 'Raw'), h('th', null, 'Value'))), tbody)));

    // monitor
    monitorEl = h('div', { class: 'mon', 'aria-live': 'off' });
    const monBtn = h('button', { class: 'btn', onclick: () => { monitoring = !monitoring; monBtn.textContent = monitoring ? 'Stop' : 'Start'; send({ t: 'monitor', on: monitoring }).catch(() => {}); } }, 'Start');
    const raw = h('input', { type: 'text', placeholder: 'F0 00 20 0D 72 03 09 F7', 'aria-label': 'Raw SysEx' });
    const mon = card('MIDI monitor',
      h('div', { class: 'inline', style: { marginBottom: '10px' } }, monBtn, h('button', { class: 'btn', onclick: () => monitorEl.replaceChildren() }, 'Clear'),
        h('span', { class: 'hint', style: { margin: 0 } }, S.status ? `Status: ${S.status}` : '')),
      monitorEl,
      h('div', { class: 'inline', style: { marginTop: '10px' } }, raw, h('button', { class: 'btn', onclick: () => send({ t: 'raw', hex: raw.value }).then(() => toast('Sent')).catch(() => {}) }, 'Send')),
      h('p', { class: 'hint' }, 'Developer tool: shows the SysEx traffic between the bridge and the unit.'));

    const wide = (x) => h('div', { style: { gridColumn: '1 / -1' } }, x);
    return h('div', { class: 'grid' }, wide(sentCard()), wide(unknownCard()), mon, silenceCard(), wide(table), wide(statusRecorder()));
  }

  /** Every change ADI-2-Pi sent to the unit, and who asked for it. */
  function sentCard() {
    const list = h('div');
    const tm = (t) => new Date(t).toTimeString().slice(0, 8);
    let last = '';
    function load() {
      if (!document.body.contains(list) && last) { clearInterval(timer); return; }
      send({ t: 'sentlog' }).then((m) => {
        const j = JSON.stringify(m.sent);
        if (j === last) return;
        last = j;
        const rows = [...m.sent].reverse().slice(0, 40);
        list.replaceChildren(rows.length
          ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'From'), h('th', null, 'What'))),
            h('tbody', null, rows.map((e) => h('tr', null, h('td', { class: 'k' }, tm(e.at)), h('td', null, e.by), h('td', null, e.what))))))
          : h('p', { class: 'hint' }, 'Nothing sent since ADI-2-Pi started – it only reads the unit.'));
      }).catch(() => {});
    }
    const timer = setInterval(load, 3000);
    load();
    return card('Sent to the unit', h('p', { class: 'hint', style: { marginTop: 0 } }, 'Every change ADI-2-Pi sent to the ADI-2 since it started, and where it came from. Reading the unit’s settings isn’t listed.'), list);
  }

  /**
   * What the unit reports that ADI-2-Pi can't name: parameters missing from RME's table,
   * values beyond a list's end, and table entries this unit never sends. Changing a setting on
   * the unit shows up in the log with the parameter it belongs to.
   */
  function unknownCard() {
    const ADDR = { 0: 'Input', 1: 'Input EQ L', 2: 'Input EQ R', 3: 'Line Out', 4: 'Line EQ L', 5: 'Line EQ R', 6: 'Phones 1/2', 7: 'PH 1/2 EQ L', 8: 'PH 1/2 EQ R', 9: 'Phones 3/4', 10: 'PH 3/4 EQ L', 11: 'PH 3/4 EQ R', 12: 'Device' };
    const where = (k) => { const [a, i] = k.split('.').map(Number); return `${ADDR[a] ?? `address ${a}`} · index ${i}`; };
    const body = h('div');
    const tm = (d) => d.toTimeString().slice(0, 8);
    function collect() {
      const known = knownKeys();
      const unknown = [...S.p].filter(([k]) => /^\d+\.\d+$/.test(k) && !known.has(k)).sort(([a], [b]) => { const [x, y] = a.split('.').map(Number), [u, w] = b.split('.').map(Number); return x - u || y - w; });
      const beyond = [];
      const never = [];
      const check = (ch, p, addr) => {
        if (!available(p)) return;
        const k = key(addr, p.idx);
        const v = S.p.get(k);
        if (v === undefined) { never.push(`${ch ? chName(ch) : 'Device'} · ${p.label} (${k})`); return; }
        const n = p.type === 'select' ? names(p, ch) : null;
        if (n && (v < 0 || v >= n.length)) beyond.push(`${ch ? chName(ch) : 'Device'} · ${p.label} (${k}) = ${v}; RME's table lists ${n.length} values (0–${n.length - 1}: ${n.join(', ')})`);
      };
      for (const c of S.schema.channels) {
        if (!available(c)) continue;
        for (const p of Object.values(c.kind === 'input' ? SEC.input : SEC.output)) check(c, p, c.addr);
        for (const p of Object.values(SEC.eq)) check(c, p, c.eq);
      }
      for (const p of Object.values(SEC.device)) check(null, p, 12);
      return { unknown, beyond, never };
    }
    function report() {
      const { unknown, beyond, never } = collect();
      return [
        `ADI-2-Pi ${S.bridge.version || ''} · ${S.device.modelName || 'unit'}${S.statusInfo ? ` revision ${S.statusInfo.revision}` : ''} · ${new Date().toISOString()}`,
        '', `Not in RME's table (${unknown.length}):`, ...unknown.map(([k, v]) => `  ${k}  ${where(k)}  = ${v}`),
        '', `Values beyond the table's list (${beyond.length}):`, ...beyond.map((x) => `  ${x}`),
        '', `In the table, not on this unit (${never.length}; hidden on the page):`, ...never.map((x) => `  ${x}`),
        '', 'Changes seen (newest first):', ...unknownLog.map((e) => `  ${tm(e.at)}  ${e.k}  ${where(e.k)}  ${e.from ?? '–'} → ${e.to}`),
      ].join('\n');
    }
    function draw() {
      if (!S.schema || !S.device.ready) { body.replaceChildren(h('p', { class: 'hint' }, 'Waiting for the unit…')); return; }
      const { unknown, beyond } = collect();
      const tbody = h('tbody', null, unknown.map(([k, v]) => {
        const last = unknownLog.find((e) => e.k === k);
        return h('tr', { class: last && Date.now() - last.at < 15000 ? 'hot' : '' }, h('td', { class: 'k' }, k), h('td', null, where(k)), h('td', { class: 'v' }, String(v)), h('td', null, last ? `${last.from ?? '–'} → ${last.to} at ${tm(last.at)}` : ''));
      }));
      body.replaceChildren(...[
        unknown.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Key'), h('th', null, 'Where'), h('th', null, 'Raw'), h('th', null, 'Last change'))), tbody))
          : h('p', { class: 'hint' }, 'The unit reports nothing beyond RME’s table.'),
        beyond.length ? h('p', { class: 'hint' }, `${beyond.length} known setting${beyond.length > 1 ? 's report' : ' reports'} a value beyond the table’s list – see the report.`) : null,
        unknownLog.length ? h('ul', { class: 'unk-log' }, unknownLog.slice(0, 8).map((e) => h('li', null, `${tm(e.at)}  ${e.k}  ${where(e.k)}: ${e.from ?? '–'} → ${e.to}`))) : null].filter(Boolean));
    }
    unknownSubs.add(draw);
    draw();
    // redraw now and then: values arrive with each re-read, and the "lit" rows fade
    const timer = setInterval(() => { if (!document.body.contains(body)) { clearInterval(timer); unknownSubs.delete(draw); } else draw(); }, 3000);
    return card('Settings ADI-2-Pi can’t name yet',
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'The unit sends all its settings; these aren’t in RME’s MIDI table (v0.2). To find out what one is, change a setting on the unit that ADI-2-Pi doesn’t show – the line that belongs to it lights up here. Copy report puts the list in a text, e.g. for an issue report.'),
      body,
      h('div', { class: 'inline', style: { marginTop: '10px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn', onclick: () => send({ t: 'refresh' }).then(() => toast('Re-reading from the unit')).catch(() => {}) }, 'Re-read'),
        h('button', { class: 'btn primary', onclick: async () => {
          const text = report();
          copyText(text);
        } }, 'Copy report')));
  }

  // ------------------------------------------------------------------ tabs / render
  function tabList() {
    const t = [{ id: 'overview', label: 'Overview' }];
    for (const c of outputs()) t.push({ id: c.key, label: chName(c) });
    if (available(CH.in)) t.push({ id: 'in', label: 'Input' });
    t.push({ id: 'eqpresets', label: 'EQ Presets' }, { id: 'device', label: 'Device' }, { id: 'routing', label: 'Pi Playback' }, { id: 'bluetooth', label: 'Bluetooth' }, { id: 'streaming', label: 'Streaming' }, { id: 'state', label: 'State' }, { id: 'eq', label: 'Headphone EQ', href: '/eq/' }, { id: 'bridge', label: 'System' });
    if (debugOn()) t.push({ id: 'debug', label: 'Debug' });
    return t;
  }
  function renderTabs() {
    if (!S.schema) return;
    const tabs = tabList();
    if (!tabs.some((t) => t.id === S.tab && !t.href)) S.tab = 'overview';
    $('#tabs').replaceChildren(...tabs.map((t) => (t.href
      ? h('a', { class: 'tab', href: t.href }, t.label)
      : h('button', { class: 'tab', role: 'tab', 'aria-selected': t.id === S.tab ? 'true' : 'false', onclick: () => go(t.id) }, t.label))));
  }
  function go(tab) {
    S.tab = tab;
    store.set('tab', tab);
    renderTabs();
    render();
    window.scrollTo({ top: 0 });
  }
  function renderIfTab(t) { if (S.tab === t) render(); }

  function render() {
    if (!S.schema) return;
    subs.clear();
    settingsSubs.clear();
    presetSubs.clear();
    draftSubs.clear();
    statusSubs.clear();
    btSubs.clear();
    rxSubs.clear();
    rtSubs.clear();
    trSubs.clear();
    if (monitoring) { monitoring = false; send({ t: 'monitor', on: false }).catch(() => {}); }
    monitorEl = null;
    const main = $('#main');
    let page;
    if (!S.device.connected && !['bridge', 'bluetooth', 'streaming', 'routing', 'debug'].includes(S.tab)) {
      page = h('div', { class: 'empty' }, h('p', null, 'No ADI-2 connected.'), h('p', { class: 'hint' }, 'Connect the unit by USB and make sure MIDI Control is ON (Device Mode menu). This page updates by itself.'));
    } else if (S.tab === 'overview') page = pageOverview();
    else if (CH[S.tab] && CH[S.tab].kind === 'output') page = pageOutput(S.tab);
    else if (S.tab === 'in') page = pageInput();
    else if (S.tab === 'device') page = pageDevice();
    else if (S.tab === 'eqpresets') page = pagePresets();
    else if (S.tab === 'state') page = pageState();
    else if (S.tab === 'bluetooth') page = pageBluetooth();
    else if (S.tab === 'streaming') page = pageStreaming();
    else if (S.tab === 'routing') page = pageRouting();
    else if (S.tab === 'debug') page = pageDebug();
    else page = pageBridge();
    main.replaceChildren(page);
    renderConn();
  }

  function renderSetupSelect() {
    const sel = $('#setupSelect');
    sel.replaceChildren(h('option', { value: '', text: 'Load setup…' }),
      ...S.setups.map((n, i) => h('option', { value: i + 1, text: `${i + 1}${n ? ` · ${n}` : ''}` })));
    sel.value = '';
    sel.disabled = !S.device.ready;
  }
  $('#setupSelect').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    e.target.value = '';
    if (n) send({ t: 'setup', action: 'load', n }).then(() => toast(`Loading setup ${n}${S.setups[n - 1] ? ` (${S.setups[n - 1]})` : ''}`)).catch(() => {});
  });

  // theme
  function applyTheme() {
    const t = store.get('theme', null);
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    $('meta[name="theme-color"]').content = dark ? '#16191d' : '#eef1f4';
  }
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    store.set('theme', dark ? 'light' : 'dark');
    applyTheme();
    render();
  });
  applyTheme();

  // ------------------------------------------------------------------ start
  const fromHash = location.hash.slice(1);
  if (fromHash) {
    S.tab = fromHash;
    store.set('tab', fromHash);
    history.replaceState(null, '', location.pathname);
  }
  fetch('/api/schema').then((r) => r.json()).then((schema) => {
    S.schema = schema;
    indexSchema();
    renderTabs();
    renderSetupSelect();
    render();
    connect();
  }).catch(() => { $('#main').replaceChildren(h('div', { class: 'empty' }, 'Cannot reach the bridge.')); });
})();
