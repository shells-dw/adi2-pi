'use strict';
/**
 * HTTP + WebSocket API and the web page.
 * One API for the web page, the Stream Deck plugin and other clients (docs/API.md).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WsServer } = require('./ws');
const cat = require('./catalog');
const { EqData } = require('./eq-data');
const { UsbAudio } = require('./usb-audio');
const { makeBackup } = require('./backup');

const API_VERSION = 1;
const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const MAX_BODY = 64 * 1024;
const MAX_RESTORE_BODY = 1024 * 1024;
const MAX_UPLOAD = 64 * 1024 * 1024; // release archive (Install from a file)
const KEY_FAILS = 10;          // wrong access keys from one address …
const KEY_LOCK_MS = 60000;     // … lock it out for a minute

const isLoopback = (addr) => /^(127\.|::1$|::ffff:127\.)/.test(String(addr || ''));

/** State as nested display values: { line: { vol: -20, … , eq: { L: {…}, R: {…} } }, device: {…} } */
function namedState(dev) {
  const out = {};
  for (const [k, v] of dev.state) {
    const e = cat.lookup(k);
    if (!e) continue;
    const disp = cat.toDisplay(e.param, v);
    if (e.ch === 'device') (out.device ||= {})[e.id] = disp;
    else if (e.side) (((out[e.ch] ||= {}).eq ||= {})[e.side] ||= {})[e.id] = disp;
    else (out[e.ch] ||= {})[e.id] = disp;
  }
  return out;
}

/**
 * Bluetooth as the page and apps see it: BlueZ's devices joined with their audio connections.
 * Devices listed: paired ones, plus audio devices found by the current search.
 */
function bluetoothView(bt, audio, settings) {
  if (!bt) return { available: false, reason: 'Bluetooth is switched off in this installation (--no-bluetooth)', devices: [] };
  const s = bt.state || {};
  const a = (audio && audio.status()) || { available: false };
  const byAddr = (list) => new Map((list || []).filter((x) => x.address).map((x) => [x.address, x]));
  const ins = byAddr(a.inputs), outs = byAddr(a.outputs);
  const devices = (s.devices || [])
    .filter((d) => d.paired || d.connected || (s.scanUntil && d.audio && (d.hasName || d.rssi !== null)))
    .map((d) => {
      const i = ins.get(d.address), o = outs.get(d.address);
      return {
        ...d,
        audioIn: i ? { codec: i.codec, state: i.state, linked: i.linked } : null,     // this device plays into the ADI-2
        audioOut: o ? { codec: o.codec, state: o.state, linked: o.linked, volume: o.volume, mute: o.mute } : null, // the ADI-2 plays to it
      };
    });
  return {
    available: !!s.available, reason: s.reason || null,
    adapter: s.adapter || null, pairingUntil: s.pairingUntil || null, scanUntil: s.scanUntil || null,
    devices,
    audio: { available: !!a.available, reason: a.reason || null, adi: a.adi || null },
    outSource: (settings.get().bluetooth || {}).outSource || 'line',
    gainDb: (settings.get().bluetooth || {}).gainDb ?? 6,
    loopback: a.loopback || null,
  };
}

function createServer({ dev, settings, version, log, webDir = WEB_DIR, allowOrigins = [], eqData, dataDir = null, usbAudio, bt = null, audio = null, receivers = null, autoSource = null, trigger = null, automation = null, streamVolume = null, restore = null, mqtt = null, ups = null, updates = null, osUpdates = null, selfUpdate = null, nowPlaying = null, inputPriority = null, trustLoopback = true }) {
  const usb = usbAudio || new UsbAudio({ getCard: () => dev.card, log });
  const btView = () => bluetoothView(bt, audio, settings);
  const routingView = () => {
    const a = (audio && audio.status()) || { available: false };
    const r = settings.get().routing || {};
    return {
      available: !!a.available, reason: audio ? (a.reason || null) : 'no audio service in this installation (--no-audio)',
      mode: r.mode || 'newest', rate: Number(r.rate) || 0,
      forceRate: a.forceRate || 0, current: a.rate || null,
      sources: a.sources || [],
      auto: autoSource ? autoSource.view() : null,
    };
  };
  const triggerView = () => (trigger ? trigger.status() : { enabled: false, available: false, reason: 'not available in this installation' });
  const inputPriorityView = () => (inputPriority ? inputPriority.view() : { ...settings.get().inputPriority, available: false, reason: 'not available in this installation' });
  const rxView = () => (receivers ? receivers.status() : { audio: false, reason: 'Streaming is switched off in this installation (--no-audio)', receivers: [] });
  const eq = eqData || new EqData({ bundledDir: path.join(webDir, 'eq', 'data'), dataDir: dataDir && path.join(dataDir, 'eq'), log });
  const bridgeInfo = () => ({ name: settings.get().name, version, host: os.hostname(), auth: settings.keyRequired, viewOpen: settings.viewOpen });
  const automationView = () => (automation ? automation.view() : { sleep: null, fired: [], waiting: [] });
  const mqttView = () => (mqtt ? mqtt.status() : { enabled: false, connected: false, error: null });
  const selfUpdateView = () => (selfUpdate ? selfUpdate.status() : { available: false, reason: 'not available in this installation', current: version, state: 'idle', staged: null, lastRun: null });
  const osUpdatesView = () => (osUpdates ? osUpdates.status() : { mode: 'off', available: false, reason: 'not available in this installation', state: 'idle', checkedAt: null, count: 0, updates: [], removes: [], node: null, restart: null, lastRun: null, error: null, nextAt: null });
  const updatesView = () => (updates ? updates.status() : { check: false, current: version, checking: false, lastCheck: null, latest: null, available: false, error: 'not available in this installation', releasesUrl: 'https://github.com/shells-dw/adi2-pi/releases' });
  const nowPlayingView = () => (nowPlaying ? nowPlaying.status() : { current: null, sources: {} });
  const upsView = () => (ups ? ups.status() : { present: false, available: false, reason: 'not available in this installation' });

  // ---------------------------------------------------------------- access key
  const keyFails = new Map(); // address → { n, first, until }
  function keyOf(req, url) {
    const a = req.headers.authorization;
    if (a && /^Bearer\s+/i.test(a)) return a.replace(/^Bearer\s+/i, '').trim();
    if (req.headers['x-adi2pi-key']) return String(req.headers['x-adi2pi-key']);
    return url ? url.searchParams.get('key') : null;
  }
  /**
   * null when allowed, else { status, error }. `write`: the request changes something; with
   * access.viewOpen, reads go without the key and only writes need it.
   */
  function accessDenied(req, url, write = true) {
    if (!settings.keyRequired) return null;
    const addr = String(req.socket?.remoteAddress || '');
    if (trustLoopback && isLoopback(addr)) return null; // programs on the Pi itself (receivers' volume hook)
    if (!write && settings.viewOpen) return null;
    for (const [a, x] of keyFails) if (Date.now() - x.first > KEY_LOCK_MS && x.until < Date.now()) keyFails.delete(a);
    const f = keyFails.get(addr);
    if (f && f.until > Date.now()) return { status: 429, error: 'too many wrong access keys – wait a minute' };
    const key = keyOf(req, url);
    if (settings.checkKey(key)) { keyFails.delete(addr); return null; }
    if (key) {
      const fresh = f && Date.now() - f.first < KEY_LOCK_MS; // count within one minute
      const n = (fresh ? f.n : 0) + 1;
      keyFails.set(addr, { n, first: fresh ? f.first : Date.now(), until: n >= KEY_FAILS ? Date.now() + KEY_LOCK_MS : 0 });
    }
    return { status: 401, error: key ? 'wrong access key' : 'access key required' };
  }

  /** A duration from a client: whole seconds 1…max, or the default. */
  const seconds = (v, dflt, max) => {
    if (v === undefined || v === null) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`seconds must be 1…${max}`);
    return n;
  };

  /** Same-host browsers, native clients (no Origin) and configured origins only. */
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return true;
    try {
      const o = new URL(origin);
      if (o.host === req.headers.host) return true;
      return allowOrigins.includes(origin);
    } catch { return false; }
  }

  function send(res, code, body, headers = {}) {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    const data = isObj ? JSON.stringify(body) : body;
    res.writeHead(code, {
      'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(data);
  }

  /** The request body as a Buffer, at most `max` bytes. */
  function readRaw(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max) { reject(Object.assign(new Error(`body larger than ${max} bytes`), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function readJson(req, max = MAX_BODY) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > max) { if (!tooBig) { tooBig = true; reject(Object.assign(new Error(`body larger than ${max} bytes`), { status: 413 })); } return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        if (!size) return resolve({});
        let v;
        try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(Object.assign(new Error('body must be a JSON object'), { status: 400 }));
        resolve(v);
      });
      req.on('error', reject);
    });
  }

  /** Normalise the different "set" shapes into a list for dev.set(). */
  /** WebSocket commands that change nothing (allowed without the key when access.viewOpen). */
  const READ_COMMANDS = new Set(['get', 'ping', 'usb', 'sentlog', 'monitor']);

  function setItems(msg) {
    if (msg.p && typeof msg.p === 'object' && !Array.isArray(msg.p)) return Object.entries(msg.p).map(([key, value]) => ({ key, value }));
    if (Array.isArray(msg.set)) return msg.set;
    if (msg.id) return [{ ch: msg.ch, id: msg.id, side: msg.side, value: msg.value, delta: msg.delta, ramp: msg.ramp }];
    throw Object.assign(new Error('set needs p, set or ch/id'), { status: 400 });
  }

  function fullState() {
    return { device: dev.info(), p: dev.snapshot(), setups: dev.setups, eqPresets: dev.presets(), unitStatus: dev.lastStatus, statusInfo: dev.statusInfo, silences: dev.silences, bluetooth: btView(), streaming: rxView(), routing: routingView(), trigger: triggerView(), inputPriority: inputPriorityView(), automation: automationView(), mqtt: mqttView(), ups: upsView(), updates: updatesView(), osUpdates: osUpdatesView(), selfUpdate: selfUpdateView(), nowplaying: nowPlayingView() };
  }

  async function setUsbRate(rate) {
    const r = await usb.setRate(rate);
    setTimeout(() => dev.refresh(), 800); // the unit's sample rate display follows
    return r;
  }

  async function btCommand(msg) {
    if (!bt) throw Object.assign(new Error('Bluetooth is switched off in this installation'), { status: 409 });
    const addr = msg.address;
    switch (msg.action) {
      case 'pairing': await bt.cmd('pairing', { seconds: seconds(msg.seconds, 120, 600) }); break;
      case 'scan': await bt.cmd('scan', { seconds: seconds(msg.seconds, 30, 300) }); break;
      case 'pair': await bt.cmd('pair', { address: addr }); break;
      case 'connect': await bt.cmd('connect', { address: addr }); break;
      case 'disconnect': await bt.cmd('disconnect', { address: addr }); break;
      case 'forget': await bt.cmd('forget', { address: addr }); break;
      case 'volume':
        if (!audio) throw Object.assign(new Error('no audio service'), { status: 409 });
        await audio.setVolume(addr, msg.value);
        break;
      case 'outSource':
        settings.update({ bluetooth: { outSource: msg.value } });
        break;
      case 'gain':
        settings.update({ bluetooth: { gainDb: msg.value } });
        break;
      default:
        throw Object.assign(new Error('action must be pairing, scan, pair, connect, disconnect, forget, volume, outSource or gain'), { status: 400 });
    }
    if (audio) audio.refresh();
    return { t: 'bluetooth', bluetooth: btView() };
  }

  /** Who sent a request, for the log of changes sent to the unit. */
  function who(req) {
    if (!req) return 'unknown';
    const addr = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const ua = String(req.headers['user-agent'] || '');
    const kind = req.headers.origin && originAllowed(req) && /Mozilla/.test(ua) ? 'web page'
      : /stream ?deck|elgato/i.test(ua) || /^node|undici/i.test(ua) || !ua ? 'app (Stream Deck or other)' : 'app';
    return `${kind}, ${addr === '127.0.0.1' || addr === '::1' ? 'this Pi' : addr}`;
  }

  /** Commands shared by REST and WebSocket. Returns a reply object (or a promise of one) or throws. */
  function command(msg, client, req) {
    dev.by = who(req || (client && client.req));
    try { return command2(msg, client); } finally { dev.by = null; }
  }
  function command2(msg, client) {
    switch (msg.t) {
      case 'set': {
        const items = setItems(msg);
        if (!items.length) throw Object.assign(new Error('nothing to set'), { status: 400 });
        const r = dev.set(items);
        if (r.errors.length && !Object.keys(r.applied).length) throw Object.assign(new Error(r.errors.join('; ')), { status: r.status || 400 });
        return { t: 'ok', applied: r.applied, errors: r.errors.length ? r.errors : undefined };
      }
      case 'setup': {
        if (msg.action === 'load') dev.loadSetup(msg.n);
        else if (msg.action === 'save') dev.saveSetup(msg.n, msg.name);
        else if (msg.action === 'rename') dev.renameSetup(msg.n, msg.name);
        else if (msg.action === 'factory') dev.loadFactory();
        else throw new Error('action must be load, save, rename or factory');
        return { t: 'ok' };
      }
      case 'refresh':
        dev.refresh();
        return { t: 'ok' };
      case 'storePreset':
        return { t: 'ok', preset: dev.storeEqPreset(msg.n, { L: msg.L, R: msg.R, dual: msg.dual }, msg.name) };
      case 'renamePreset':
        dev.renameEqPreset(msg.n, msg.name);
        return { t: 'ok' };
      case 'get':
        return { t: 'state', ...fullState() };
      case 'usb':
        return { t: 'usb', usb: usb.status() };
      case 'bt':
        return btCommand(msg);
      case 'routing': {
        if (!audio) throw Object.assign(new Error('no audio service in this installation'), { status: 409 });
        if (msg.action === 'switch') audio.switchTo(msg.key);
        else if (msg.action === 'mode') settings.update({ routing: { mode: msg.value } });
        else if (msg.action === 'rate') settings.update({ routing: { rate: msg.value } });
        else if (msg.action === 'usb') settings.update({ routing: { usb: msg.value || {} } });
        else throw Object.assign(new Error('action must be switch, mode, rate or usb'), { status: 400 });
        audio.refresh();
        return { t: 'routing', routing: routingView() };
      }
      case 'receiver': {
        if (!receivers) throw Object.assign(new Error('Streaming is switched off in this installation'), { status: 409 });
        return { t: 'streaming', streaming: receivers.set(msg.id, { enabled: msg.enabled, server: msg.server }) };
      }
      case 'inputPriority': {
        const patch = {};
        for (const k of ['enabled', 'order', 'outputs', 'delaySec']) if (msg[k] !== undefined) patch[k] = msg[k];
        if (Object.keys(patch).length) settings.update({ inputPriority: patch });
        return { t: 'inputPriority', inputPriority: inputPriorityView() };
      }
      case 'trigger': {
        if (!trigger) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        if (msg.cancel) trigger.cancel();
        const patch = {};
        if (msg.enabled !== undefined) patch.enabled = msg.enabled;
        if (msg.delaySec !== undefined) patch.delaySec = msg.delaySec;
        if (msg.source !== undefined) patch.source = msg.source;
        if (msg.pin !== undefined) patch.pin = msg.pin;
        if (msg.atStartSec !== undefined) patch.atStartSec = msg.atStartSec;
        if (Object.keys(patch).length) settings.update({ trigger: patch });
        trigger.apply();
        return { t: 'trigger', trigger: triggerView() };
      }
      case 'usbRate':
        return setUsbRate(msg.rate).then(() => ({ t: 'usb', usb: usb.status() }));
      case 'settings':
        if (msg.patch) settings.update(msg.patch);
        return { t: 'settings', settings: settings.publicView() };
      case 'scene': {
        if (!automation) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        if (msg.action === 'apply') { const r = automation.applyScene(msg.id); return { t: 'ok', applied: r.applied, errors: r.errors.length ? r.errors : undefined }; }
        if (msg.action === 'save') return { t: 'scene', scene: automation.saveScene({ id: msg.id, name: msg.name, items: msg.items, params: msg.params }) };
        if (msg.action === 'delete') { automation.deleteScene(msg.id); return { t: 'ok' }; }
        throw Object.assign(new Error('action must be apply, save or delete'), { status: 400 });
      }
      case 'profile': {
        if (!automation) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        if (msg.action === 'apply') { const r = automation.applyProfile(msg.id, msg.ch); return { t: 'ok', applied: r.applied, errors: r.errors.length ? r.errors : undefined }; }
        if (msg.action === 'save') return { t: 'profile', profile: automation.saveProfile({ id: msg.id, name: msg.name, items: msg.items, from: msg.from, groups: msg.groups, limit: msg.limit }) };
        if (msg.action === 'delete') { automation.deleteProfile(msg.id); return { t: 'ok' }; }
        if (msg.action === 'clear') { settings.update({ activeProfile: { [msg.ch]: null } }); return { t: 'ok' }; }
        throw Object.assign(new Error('action must be apply, save, delete or clear'), { status: 400 });
      }
      case 'sleep': {
        if (!automation) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        if (msg.cancel) automation.cancelSleep();
        else if (msg.minutes !== undefined) automation.startSleep(msg.minutes);
        return { t: 'sleep', sleep: automation.sleepStatus() };
      }
      case 'ups': {
        if (!ups) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        if (msg.cancel) ups.cancel();
        const patch = {};
        for (const k of ['shutdown', 'delaySec', 'lowPct']) if (msg[k] !== undefined) patch[k] = msg[k];
        if (Object.keys(patch).length) settings.update({ ups: patch });
        return { t: 'ups', ups: upsView() };
      }
      case 'updates': {
        // { check: true|false } switches the daily check; { now: true } checks once (answer comes as broadcast)
        if (!updates) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        if (msg.check !== undefined) settings.update({ updates: { check: !!msg.check } });
        if (msg.now) {
          const p = updates.check({ manual: true });
          return p.then((u) => ({ t: 'updates', updates: u }));
        }
        return { t: 'updates', updates: updatesView() };
      }
      case 'selfUpdate': {
        // { action: 'install' | 'discard' } for a release uploaded with POST /api/selfupdate/upload
        if (!selfUpdate) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        if (msg.action === 'install') return selfUpdate.install().then((u) => ({ t: 'selfUpdate', selfUpdate: u }));
        if (msg.action === 'discard') return { t: 'selfUpdate', selfUpdate: selfUpdate.discard() };
        if (msg.action !== undefined) throw Object.assign(new Error('action must be install or discard'), { status: 400 });
        return { t: 'selfUpdate', selfUpdate: selfUpdateView() };
      }
      case 'osUpdates': {
        // { mode } off | notify | install; { action: 'check' | 'install' } starts it (progress comes as
        // broadcasts); { action: 'reboot' } restarts the Pi
        if (!osUpdates) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        if (msg.mode !== undefined) settings.update({ osUpdates: { mode: msg.mode } });
        if (msg.action !== undefined) {
          if (!['check', 'install', 'reboot'].includes(msg.action)) throw Object.assign(new Error('action must be check, install or reboot'), { status: 400 });
          if (msg.action === 'reboot') return osUpdates.reboot().then((u) => ({ t: 'osUpdates', osUpdates: u }));
          osUpdates.assertReady();
          osUpdates[msg.action]().catch((e) => log.warn(`os updates: ${e.message}`));
        }
        return { t: 'osUpdates', osUpdates: osUpdatesView() };
      }
      case 'backup':
        return { t: 'backup', backup: makeBackup({ dev, settings, version }) };
      case 'restore':
        if (!restore) throw Object.assign(new Error('not available in this installation'), { status: 409 });
        return { t: 'restore', restore: restore.start(msg.backup, msg.parts || {}) };
      case 'raw':
        dev.raw(msg.hex);
        return { t: 'ok' };
      case 'monitor':
        if (!client) throw new Error('monitor is WebSocket only');
        client.monitor = !!msg.on;
        return { t: 'ok' };
      case 'ping':
        return { t: 'pong' };
      case 'sentlog':
        return { t: 'sentlog', sent: dev.sentLog };
      default:
        throw Object.assign(new Error(`unknown command ${msg.t === undefined ? '(no "t")' : msg.t}`), { status: 400 });
    }
  }

  // ---------------------------------------------------------------- HTTP

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route !== 'GET /api/info') {
      // GET reads, except the backup (it holds the bridge settings)
      const denied = accessDenied(req, url, req.method !== 'GET' || route === 'GET /api/backup');
      if (denied) return send(res, denied.status, { error: denied.error }, denied.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="ADI-2-Pi"' } : {});
    }
    if (req.method === 'POST') {
      if (!originAllowed(req)) return send(res, 403, { error: 'origin not allowed' });
      const ct = req.headers['content-type'] || '';
      // (both need a CORS preflight, so other sites can't post them from a browser)
      const binary = route === 'POST /api/selfupdate/upload';
      if (binary ? !ct.startsWith('application/octet-stream') : !ct.startsWith('application/json')) return send(res, 415, { error: `use Content-Type: application/${binary ? 'octet-stream' : 'json'}` });
    }
    try {
      switch (route) {
        case 'GET /api/info':
          return send(res, 200, { api: API_VERSION, bridge: bridgeInfo(), device: dev.info() });
        case 'GET /api/schema':
          return send(res, 200, cat.schema);
        case 'GET /api/state':
          if (url.searchParams.get('view') === 'named') return send(res, 200, { device: dev.info(), state: namedState(dev), setups: dev.setups });
          return send(res, 200, fullState());
        case 'GET /api/eqpresets':
          return send(res, 200, dev.presets());
        case 'POST /api/eqpresets/store':
          return send(res, 200, command({ ...(await readJson(req)), t: 'storePreset' }, null, req));
        case 'POST /api/eqpresets/rename':
          return send(res, 200, command({ ...(await readJson(req)), t: 'renamePreset' }, null, req));
        case 'GET /api/status':
          return send(res, 200, { unitStatus: dev.lastStatus, info: dev.statusInfo, answering: dev.answering, silences: dev.silences });
        case 'GET /api/bluetooth':
          return send(res, 200, btView());
        case 'POST /api/bluetooth':
          return send(res, 200, (await btCommand(await readJson(req))).bluetooth);
        case 'GET /api/sent':
          return send(res, 200, dev.sentLog);
        case 'GET /api/routing':
          return send(res, 200, routingView());
        case 'POST /api/routing':
          return send(res, 200, command({ ...(await readJson(req)), t: 'routing' }, null, req).routing);
        case 'GET /api/streaming':
          return send(res, 200, rxView());
        case 'POST /api/streaming':
          return send(res, 200, command({ ...(await readJson(req)), t: 'receiver' }, null, req).streaming);
        case 'GET /api/inputpriority':
          return send(res, 200, inputPriorityView());
        case 'POST /api/inputpriority':
          return send(res, 200, command({ ...(await readJson(req)), t: 'inputPriority' }, null, req).inputPriority);
        case 'GET /api/trigger':
          return send(res, 200, triggerView());
        case 'POST /api/trigger':
          return send(res, 200, command({ ...(await readJson(req)), t: 'trigger' }, null, req).trigger);
        case 'GET /api/usb':
          return send(res, 200, usb.status());
        case 'POST /api/usb/rate':
          await setUsbRate((await readJson(req)).rate);
          return send(res, 200, usb.status());
        case 'GET /api/settings':
          return send(res, 200, settings.publicView());
        case 'POST /api/settings':
          settings.update(await readJson(req));
          return send(res, 200, settings.publicView());
        case 'GET /api/scenes':
          return send(res, 200, settings.get().scenes || []);
        case 'POST /api/scene':
          return send(res, 200, command({ ...(await readJson(req)), t: 'scene' }, null, req));
        case 'GET /api/profiles':
          return send(res, 200, { profiles: settings.get().profiles || [], active: settings.get().activeProfile });
        case 'POST /api/profile':
          return send(res, 200, command({ ...(await readJson(req)), t: 'profile' }, null, req));
        case 'GET /api/sleep':
          return send(res, 200, automationView().sleep);
        case 'POST /api/sleep':
          return send(res, 200, command({ ...(await readJson(req)), t: 'sleep' }, null, req).sleep);
        case 'GET /api/automation':
          return send(res, 200, automationView());
        case 'GET /api/backup': {
          const b = makeBackup({ dev, settings, version });
          const stamp = b.created.slice(0, 16).replace(/[:T]/g, '-');
          return send(res, 200, b, { 'Content-Disposition': `attachment; filename="adi2-pi-backup-${stamp}.json"` });
        }
        case 'POST /api/restore': {
          const body = await readJson(req, MAX_RESTORE_BODY);
          return send(res, 202, command({ t: 'restore', backup: body.backup || body, parts: body.parts }, null, req).restore);
        }
        case 'GET /api/restore':
          return send(res, 200, restore ? restore.status() : { state: 'idle' });
        case 'POST /api/hook': {
          // the receivers' hook (bin/adi2-pi-hook.js): volume changes and track events, from this Pi only
          if (!isLoopback(req.socket?.remoteAddress)) return send(res, 403, { error: 'only from the Pi itself' });
          const b = await readJson(req);
          if (b.event !== undefined) return send(res, 200, nowPlaying ? nowPlaying.handleHook(b) : { ignored: 'not available in this installation' });
          if (!streamVolume) return send(res, 409, { error: 'not available in this installation' });
          return send(res, 200, streamVolume.handle(String(b.receiver || ''), b.value));
        }
        case 'GET /api/nowplaying':
          return send(res, 200, nowPlayingView());
        case 'GET /api/nowplaying/cover': {
          const c = nowPlaying && nowPlaying.cover(url.searchParams.get('source') || 'airplay');
          if (!c) return send(res, 404, { error: 'no cover' });
          res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'private, max-age=3600', 'Content-Length': c.data.length });
          return res.end(c.data);
        }
        case 'GET /api/selfupdate':
          return send(res, 200, selfUpdateView());
        case 'POST /api/selfupdate/upload': {
          // body: the release archive; header X-ADI2PI-Signature: the signature (base64)
          if (!selfUpdate) return send(res, 409, { error: 'not available in this installation' });
          const archive = await readRaw(req, MAX_UPLOAD);
          return send(res, 200, selfUpdate.stage(archive, String(req.headers['x-adi2pi-signature'] || '')));
        }
        case 'POST /api/selfupdate':
          return send(res, 200, (await command({ ...(await readJson(req)), t: 'selfUpdate' }, null, req)).selfUpdate);
        case 'GET /api/osupdates':
          return send(res, 200, osUpdatesView());
        case 'POST /api/osupdates':
          return send(res, 200, (await command({ ...(await readJson(req)), t: 'osUpdates' }, null, req)).osUpdates);
        case 'GET /api/updates':
          return send(res, 200, updatesView());
        case 'POST /api/updates':
          return send(res, 200, (await command({ ...(await readJson(req)), t: 'updates' }, null, req)).updates);
        case 'GET /api/ups':
          return send(res, 200, upsView());
        case 'POST /api/ups':
          return send(res, 200, command({ ...(await readJson(req)), t: 'ups' }, null, req).ups);
        case 'GET /api/mqtt':
          return send(res, 200, mqttView());
        case 'POST /api/set':
          return send(res, 200, command({ ...(await readJson(req)), t: 'set' }, null, req));
        case 'POST /api/setup':
          return send(res, 200, command({ ...(await readJson(req)), t: 'setup' }, null, req));
        case 'POST /api/refresh':
          return send(res, 200, command({ t: 'refresh' }, null, req));
        // Headphone EQ Generator data: served from the Pi; GitHub only on POST /api/eq/update
        case 'GET /api/eq/index':
          return send(res, 200, eq.getIndex());
        case 'GET /api/eq/file':
          try {
            return send(res, 200, eq.get(url.searchParams.get('path') || ''), { 'Content-Type': 'text/csv; charset=utf-8' });
          } catch (e) {
            return send(res, e.status || 500, { error: e.message });
          }
        case 'GET /api/eq/update':
          return send(res, 200, eq.status());
        case 'POST /api/eq/update':
          return send(res, 202, eq.startUpdate());
        case 'POST /api/eq/reset':
          return send(res, 200, eq.reset());
        default:
          return send(res, 404, { error: `no route ${route}` });
      }
    } catch (e) {
      return send(res, e.status || 400, { error: e.message });
    }
  }

  function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'bad path'); }
    if (p.includes('\0')) return send(res, 400, 'bad path');
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(webDir, p));
    if (!file.startsWith(webDir + path.sep)) return send(res, 403, 'forbidden');
    // folder without trailing slash (/eq): redirect so relative paths in its page work
    if (!path.extname(file)) {
      try {
        if (fs.statSync(file).isDirectory()) { res.writeHead(301, { Location: `${url.pathname}/${url.search}` }); return res.end(); }
      } catch { /* not found below */ }
    }
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'bad url'); }
    if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
    else handleStatic(req, res, url);
  });

  // ---------------------------------------------------------------- WebSocket

  const wss = new WsServer(server, '/ws');
  wss.on('connection', (c) => {
    if (!originAllowed(c.req)) return c.close(1008, 'origin not allowed');
    const wsUrl = new URL(c.req.url, 'http://x');
    const denied = accessDenied(c.req, wsUrl, false);
    if (denied) {
      c.send({ t: 'err', status: denied.status, error: denied.error });
      return c.close(4000 + denied.status, denied.error);
    }
    // with access.viewOpen a connection without the key may read; its commands are checked below
    c.readOnly = !!accessDenied(c.req, wsUrl, true);
    c.monitor = false;
    c.send({ t: 'hello', api: API_VERSION, access: c.readOnly ? 'read' : 'full', bridge: bridgeInfo(), device: dev.info() });
    c.send({ t: 'state', ...fullState() });
    c.send({ t: 'settings', settings: settings.publicView() });
    c.on('message', async (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return c.send({ t: 'err', status: 400, error: 'invalid JSON' }); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return c.send({ t: 'err', status: 400, error: 'a message must be a JSON object with "t"' });
      if (c.readOnly && !READ_COMMANDS.has(msg.t)) {
        const d = accessDenied(c.req, wsUrl, true) || { status: 401, error: 'access key required' };
        return c.send({ t: 'err', rid: msg.rid, status: d.status, error: d.error });
      }
      try {
        const reply = await command(msg, c);
        if (msg.rid !== undefined || reply.t !== 'ok') c.send({ ...reply, rid: msg.rid });
      } catch (e) {
        c.send({ t: 'err', rid: msg.rid, status: e.status || 400, error: e.message });
      }
    });
  });

  dev.on('params', (p, origin) => wss.broadcast({ t: 'p', p, origin }));
  dev.on('device', (d) => wss.broadcast({ t: 'device', device: d }));
  dev.on('setups', (s) => wss.broadcast({ t: 'setups', setups: s }));
  dev.on('eqpresets', (list) => wss.broadcast({ t: 'eqpresets', eqPresets: list }));
  dev.on('status', (h, info) => wss.broadcast({ t: 'status', unitStatus: h, info }));
  dev.on('silence', (list) => wss.broadcast({ t: 'silences', silences: list }));
  // Bluetooth: one broadcast for BlueZ and audio changes together
  let btTimer = null;
  let btLast = '';
  const btChanged = () => {
    clearTimeout(btTimer);
    btTimer = setTimeout(() => {
      const v = btView();
      const j = JSON.stringify(v);
      if (j === btLast) return;
      btLast = j;
      wss.broadcast({ t: 'bluetooth', bluetooth: v });
    }, 120);
  };
  if (bt) bt.on('state', () => { btChanged(); if (audio) audio.refresh(); });
  if (audio) audio.on('status', btChanged);
  settings.on('change', btChanged);
  // streaming receivers: their own state, plus "playing" from the audio status
  let rxTimer = null;
  let rxLast = '';
  const rxChanged = () => {
    clearTimeout(rxTimer);
    rxTimer = setTimeout(() => {
      const v = rxView();
      const j = JSON.stringify(v);
      if (j === rxLast) return;
      rxLast = j;
      wss.broadcast({ t: 'streaming', streaming: v });
    }, 150);
  };
  // routing: what plays, who is heard, the sample rate
  let rtTimer = null;
  let rtLast = '';
  const rtChanged = () => {
    clearTimeout(rtTimer);
    rtTimer = setTimeout(() => {
      const v = routingView();
      const j = JSON.stringify(v);
      if (j === rtLast) return;
      rtLast = j;
      wss.broadcast({ t: 'routing', routing: v });
    }, 120);
  };
  if (audio) audio.on('status', rtChanged);
  settings.on('change', rtChanged);
  if (receivers) {
    receivers.on('status', rxChanged);
    if (audio) audio.on('status', rxChanged);
    let lastName = settings.get().name;
    settings.on('change', (st) => { if (st.name !== lastName) { lastName = st.name; receivers.rename(); } rxChanged(); });
  }
  if (trigger) trigger.on('status', (s) => wss.broadcast({ t: 'trigger', trigger: s }));
  if (inputPriority) inputPriority.on('status', (s) => wss.broadcast({ t: 'inputPriority', inputPriority: s }));
  // the name other devices see follows the bridge name
  if (bt) settings.on('change', (st) => { if (st.name !== bt.alias) bt.setAlias(st.name); });
  dev.on('midi', (m) => wss.broadcast({ t: 'midi', ...m }, (c) => c.monitor));
  settings.on('change', () => wss.broadcast({ t: 'settings', settings: settings.publicView() }));
  if (automation) {
    automation.on('sleep', (sl) => wss.broadcast({ t: 'sleep', sleep: sl }));
    automation.on('fired', () => wss.broadcast({ t: 'automation', automation: automationView() }));
    automation.on('pending', () => wss.broadcast({ t: 'automation', automation: automationView() }));
  }
  if (restore) restore.on('progress', (r) => wss.broadcast({ t: 'restore', restore: r }));
  if (mqtt) mqtt.on('status', () => wss.broadcast({ t: 'mqtt', mqtt: mqttView() }));
  if (updates) updates.on('status', (u) => wss.broadcast({ t: 'updates', updates: u }));
  if (osUpdates) osUpdates.on('status', (u) => wss.broadcast({ t: 'osUpdates', osUpdates: u }));
  if (selfUpdate) selfUpdate.on('status', (u) => wss.broadcast({ t: 'selfUpdate', selfUpdate: u }));
  if (nowPlaying) nowPlaying.on('change', (n) => wss.broadcast({ t: 'nowplaying', nowplaying: n }));
  if (ups) {
    ups.on('status', (u) => wss.broadcast({ t: 'ups', ups: u }));
    settings.on('change', () => wss.broadcast({ t: 'ups', ups: upsView() }));
  }
  // a new access key: connections opened with the old one (other than this Pi's) are closed
  let keyHash = settings.get().access.hash;
  let viewOpen = settings.viewOpen;
  settings.on('change', (st) => {
    if (st.access.hash === keyHash && settings.viewOpen === viewOpen) return;
    keyHash = st.access.hash;
    viewOpen = settings.viewOpen;
    const setAccess = (c, readOnly) => {
      if (c.readOnly === readOnly) return;
      c.readOnly = readOnly;
      c.send({ t: 'access', access: readOnly ? 'read' : 'full' });
    };
    if (!keyHash) { for (const c of wss.clients || []) setAccess(c, false); return; }
    for (const c of wss.clients || []) {
      const u = new URL(c.req.url, 'http://x');
      if (!accessDenied(c.req, u, true)) { setAccess(c, false); continue; }
      if (accessDenied(c.req, u, false)) c.close(4401, 'access key changed');
      else setAccess(c, true);
    }
  });

  return { server, wss, namedState };
}

module.exports = { createServer, namedState, bluetoothView, API_VERSION };
