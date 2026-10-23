'use strict';
/**
 * Headphone data for the Headphone EQ Generator (web/eq).
 *
 * Works offline: all oratory1990 measurements and the target curves ship with ADI-2-Pi
 * (web/eq/data). The internet is only used when someone presses "Check for updated
 * headphone data": then the Pi asks GitHub (api.github.com) for the current AutoEq file
 * list, downloads new and changed files (raw.githubusercontent.com) and stores them in
 * the data folder (/var/lib/adi2-pi/eq). Lookups use the updated files first, then the
 * bundled ones.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'jaakkopasanen/AutoEq';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const HP_ROOT = 'measurements/oratory1990/data';
const TIMEOUT_MS = 20000;
const PARALLEL = 6;

/** git's blob id of some content, to compare local files with GitHub's without downloading. */
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

class EqData {
  /**
   * @param {object} o
   * @param {string} o.bundledDir  web/eq/data (index.json + files/)
   * @param {string} [o.dataDir]   writable folder for updates (null = updates disabled)
   * @param {function} [o.fetch]
   */
  constructor({ bundledDir, dataDir = null, fetch = globalThis.fetch, log = console }) {
    this.bundledDir = bundledDir;
    this.dataDir = dataDir;
    this.fetch = fetch;
    this.log = log;
    this.job = { state: 'idle' };
    this._loadIndex();
  }

  _loadIndex() {
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
    this.bundledIndex = read(path.join(this.bundledDir, 'index.json'));
    const upd = this.dataDir ? read(path.join(this.dataDir, 'index.json')) : null;
    this.index = upd || this.bundledIndex;
    this.updated = !!upd;
    this.allowed = new Set();
    if (this.index) for (const e of [...this.index.headphones, ...this.index.targets]) this.allowed.add(e.path);
  }

  info() {
    return {
      ref: this.index && this.index.ref,
      generated: this.index && this.index.generated,
      source: this.updated ? 'updated' : 'bundled',
      headphones: this.index ? this.index.headphones.length : 0,
      updates: !!this.dataDir,
    };
  }

  /** Index as the page expects it, plus where it came from. */
  getIndex() {
    if (!this.index) throw Object.assign(new Error('no headphone list'), { status: 500 });
    return { ...this.index, origin: this.info() };
  }

  _localFile(p) {
    for (const base of [this.dataDir, this.bundledDir]) {
      if (!base) continue;
      const f = path.join(base, 'files', p);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  /** Text of a listed file, from the Pi only (never the internet). */
  get(p) {
    const f = this.allowed.has(p) ? this._localFile(p) : null;
    if (!f) throw Object.assign(new Error('not in the headphone list'), { status: 404 });
    return fs.readFileSync(f, 'utf8');
  }

  // ------------------------------------------------------------------ update (on request only)

  status() { return { ...this.job, data: this.info() }; }

  startUpdate() {
    if (!this.dataDir) throw Object.assign(new Error('updates are not available here'), { status: 400 });
    if (this.job.state === 'running') return this.status();
    this.job = { state: 'running', step: 'Asking GitHub for the current list…', done: 0, total: 0, started: new Date().toISOString() };
    this._update().catch((e) => {
      this.log.warn(`eq update: ${e.message}`);
      this.job = { state: 'error', message: e.message };
    });
    return this.status();
  }

  async _get(url, as = 'json') {
    let r;
    try {
      r = await this.fetch(url, {
        headers: { 'User-Agent': 'ADI-2-Pi', Accept: as === 'json' ? 'application/vnd.github+json' : '*/*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error('Could not reach GitHub. Check that the Pi has internet access.');
    }
    if (r.status === 403 || r.status === 429) throw new Error('GitHub limits how often its file list can be read without an account. Please try again in an hour.');
    if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
    return as === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
  }

  async _subtree(rootSha, dirPath, recursive) {
    let sha = rootSha;
    for (const part of dirPath.split('/')) {
      const t = await this._get(`${API}/git/trees/${sha}`);
      const e = t.tree.find((x) => x.path === part && x.type === 'tree');
      if (!e) throw new Error(`GitHub's AutoEq repository has no folder ${dirPath} any more.`);
      sha = e.sha;
    }
    const t = await this._get(`${API}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
    if (t.truncated) throw new Error('GitHub returned an incomplete file list. Please try again later.');
    return t.tree.filter((x) => x.type === 'blob').map((x) => ({ path: `${dirPath}/${x.path}`, sha: x.sha }));
  }

  async _update() {
    const head = await this._get(`${API}/commits/HEAD`);
    const ref = head.sha;
    const rootTree = head.commit.tree.sha;
    const hp = (await this._subtree(rootTree, HP_ROOT, true)).filter((x) => /\.csv$/i.test(x.path) && x.path.split('/').length === 5);
    // targets: the same curves the page shipped with (the folder also holds many unrelated files)
    const wantTargets = new Set(this.bundledIndex.targets.map((t) => t.path));
    const tg = (await this._subtree(rootTree, 'targets', false)).filter((x) => wantTargets.has(x.path));
    const remote = [...hp, ...tg];

    // compare with what the Pi has; only download what is new or changed
    const plan = remote.map((x) => {
      const local = this._localFile(x.path);
      const same = local && blobSha(fs.readFileSync(local)) === x.sha;
      return { ...x, local, same };
    });
    const todo = plan.filter((x) => !x.same);
    this.job = { ...this.job, step: todo.length ? 'Downloading new and changed measurements…' : 'Checking…', done: 0, total: todo.length };

    const stage = `${this.dataDir}/eq.new`;
    const live = path.join(this.dataDir);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, 'files'), { recursive: true }); // exists even when nothing differs
    const put = (p, buf) => {
      const f = path.join(stage, 'files', p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf);
    };

    // download in small parallel batches
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const x = todo[i++];
        const buf = await this._get(`${RAW}/${ref}/${enc(x.path)}`, 'buffer');
        put(x.path, buf);
        this.job.done++;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));

    // keep earlier updates that are still current (they differ from the bundled copy)
    const prevDir = path.join(live, 'files');
    for (const x of plan) {
      if (!x.same || !x.local || !x.local.startsWith(prevDir)) continue;
      put(x.path, fs.readFileSync(x.local));
    }

    const name = (p) => p.split('/').pop().replace(/\.csv$/i, '');
    const index = {
      source: `https://github.com/${REPO}`,
      ref,
      generated: new Date().toISOString().slice(0, 10),
      headphones: hp.map((x) => ({ name: name(x.path), form: x.path.split('/')[3], path: x.path })).sort(byName),
      targets: tg.map((x) => ({ name: name(x.path), path: x.path })).sort(byName),
    };
    fs.writeFileSync(path.join(stage, 'index.json'), JSON.stringify(index) + '\n');

    // swap in: index.json + files/ of the data folder
    const old = path.join(this.dataDir, 'eq.old');
    fs.rmSync(old, { recursive: true, force: true });
    fs.mkdirSync(old, { recursive: true });
    for (const n of ['index.json', 'files']) {
      if (fs.existsSync(path.join(live, n))) fs.renameSync(path.join(live, n), path.join(old, n));
      fs.renameSync(path.join(stage, n), path.join(live, n));
    }
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });

    const before = new Set((this.index ? this.index.headphones : []).map((h) => h.path));
    const added = index.headphones.filter((h) => !before.has(h.path)).length;
    const changed = todo.length - added;
    this._loadIndex();
    this.job = { state: 'done', added, changed: Math.max(0, changed), total: index.headphones.length, ref: ref.slice(0, 7), finished: new Date().toISOString() };
    this.log.info(`eq update: ${added} new, ${Math.max(0, changed)} changed, commit ${ref.slice(0, 7)}`);
  }

  /** Go back to the data that shipped with ADI-2-Pi. */
  reset() {
    if (!this.dataDir) return this.status();
    for (const n of ['index.json', 'files', 'eq.new', 'eq.old']) fs.rmSync(path.join(this.dataDir, n), { recursive: true, force: true });
    this._loadIndex();
    this.job = { state: 'idle' };
    return this.status();
  }
}

module.exports = { EqData, blobSha };
