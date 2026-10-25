'use strict';
/**
 * Update check: asks GitHub for the latest release of ADI-2-Pi and reports whether it is newer
 * than this installation. Nothing is downloaded or installed; the release is installed by hand
 * (download from GitHub, run install.sh).
 *
 * settings.updates.check = false (default): no connection at all, except "check now" asked for
 * by a user. true: about one minute after start, then every 24 h.
 *
 * Request: GET https://api.github.com/repos/<REPO>/releases/latest (drafts and pre-releases are
 * not "latest"), no cookies, no data about this installation other than the User-Agent
 * "adi2-pi/<version>". Events: 'status'.
 */
const { EventEmitter } = require('events');

const REPO = 'shells-dw/adi2-pi';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_MS = 60 * 1000;
const EVERY_MS = 24 * 3600 * 1000;
const RETRY_MS = 3600 * 1000;      // after a failed check
const MANUAL_GAP_MS = 30 * 1000;   // "check now" at most this often
const TIMEOUT_MS = 15000;

/** "v1.2.3" / "1.2.3-beta.1" → [1, 2, 3, pre]; null if it isn't a version. */
function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || null] : null;
}

/** > 0 when a is newer than b. A pre-release is older than the same version without one. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

class Updates extends EventEmitter {
  constructor({ settings, version, log, fetch: fetchFn = globalThis.fetch } = {}) {
    super();
    this.settings = settings;
    this.version = version;
    this.log = log || console;
    this.fetch = fetchFn;
    this.timer = null;
    this.checking = false;
    this.lastCheck = null;     // time of the last finished check
    this.lastTry = 0;
    this.latest = null;        // { version, name, url, published }
    this.error = null;
    this.enabled = false;
  }

  start() {
    this._onSettings = (s) => this._apply(s);
    this.settings.on('change', this._onSettings);
    this._apply(this.settings.get(), true);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this._onSettings) this.settings.off('change', this._onSettings);
  }

  _apply(s, first = false) {
    const on = !!(s.updates && s.updates.check);
    if (on === this.enabled && !first) return;
    this.enabled = on;
    clearTimeout(this.timer);
    this.timer = null;
    if (on) this._schedule(first ? FIRST_MS : (this.lastCheck && Date.now() - this.lastCheck < EVERY_MS ? EVERY_MS - (Date.now() - this.lastCheck) : 0));
    if (!first) this._emit();
  }

  _schedule(ms) {
    clearTimeout(this.timer);
    if (!this.enabled) return;
    this.timer = setTimeout(() => this.check().catch(() => {}), ms);
    this.timer.unref?.();
  }

  /** Ask GitHub now. `manual`: asked for by a user (allowed while the daily check is off). */
  async check({ manual = false } = {}) {
    if (this.checking) return this.status();
    if (manual && Date.now() - this.lastTry < MANUAL_GAP_MS) {
      throw Object.assign(new Error('checked a moment ago – try again in half a minute'), { status: 429 });
    }
    if (typeof this.fetch !== 'function') throw Object.assign(new Error('this Node.js has no fetch (Node.js 18 or later needed)'), { status: 409 });
    this.checking = true;
    this.lastTry = Date.now();
    this._emit();
    let ok = false;
    try {
      const r = await this.fetch(API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `adi2-pi/${this.version}`, 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.status === 404) {
        this.latest = null;
        this.error = null;
        ok = true;
      } else if (!r.ok) {
        throw new Error(r.status === 403 || r.status === 429 ? `GitHub refused the request (HTTP ${r.status}, usually its rate limit)` : `GitHub answered HTTP ${r.status}`);
      } else {
        const j = await r.json();
        const v = parseVersion(j.tag_name);
        if (!v) throw new Error(`the latest release has no version tag ("${String(j.tag_name).slice(0, 40)}")`);
        const url = typeof j.html_url === 'string' && j.html_url.startsWith(`https://github.com/${REPO}/`) ? j.html_url : RELEASES_URL;
        this.latest = {
          version: String(j.tag_name).replace(/^v/i, ''),
          name: typeof j.name === 'string' ? j.name.replace(/[\u0000-\u001f]/g, '').slice(0, 100) : null,
          url,
          published: typeof j.published_at === 'string' ? j.published_at : null,
        };
        this.error = null;
        ok = true;
      }
      this.lastCheck = Date.now();
      if (this.available()) this.log.info(`updates: ADI-2-Pi ${this.latest.version} is available (${this.latest.url})`);
    } catch (e) {
      this.error = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'GitHub did not answer in time' : (e.cause && e.cause.code ? `${e.message} (${e.cause.code})` : e.message);
      this.log.warn(`updates: check failed: ${this.error}`);
    } finally {
      this.checking = false;
      this._schedule(ok ? EVERY_MS : RETRY_MS);
      this._emit();
    }
    return this.status();
  }

  available() {
    return !!(this.latest && compareVersions(this.latest.version, this.version) > 0);
  }

  status() {
    return {
      check: this.enabled,
      current: this.version,
      checking: this.checking,
      lastCheck: this.lastCheck,
      latest: this.latest,
      available: this.available(),
      error: this.error,
      releasesUrl: RELEASES_URL,
    };
  }

  _emit() { this.emit('status', this.status()); }
}

module.exports = { Updates, parseVersion, compareVersions, REPO, RELEASES_URL, API_URL };
