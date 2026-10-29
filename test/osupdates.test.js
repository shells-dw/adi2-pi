'use strict';
/** System updates: apt simulation parsing, the two root services through systemctl (faked), schedule. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OsUpdates, parseSimulation, newerKernelInstalled } = require('../lib/osupdates');
const { Settings } = require('../lib/settings');

const quiet = { info() {}, warn() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await sleep(5); } throw new Error('timed out'); }

const SIM = [
  'NOTE: This is only a simulation!',
  'Inst libc6 [2.41-12] (2.41-12+deb13u1 Debian:13.2/stable, Debian-Security:13/stable-security [arm64])',
  'Inst nodejs [24.10.0-1nodesource1] (24.11.1-1nodesource1 Node Source:nodistro [arm64])',
  'Inst linux-image-6.12.62+rpt-rpi-v8 (1:6.12.62-1+rpt1 Raspberry Pi Foundation:stable [arm64])',
  'Conf libc6 (2.41-12+deb13u1 Debian:13.2/stable [arm64])',
  'Remv old-thing [1.0]',
].join('\n');

test('apt-get -s output and kernel check', () => {
  const s = parseSimulation(SIM);
  assert.deepStrictEqual(s.updates.map((u) => [u.name, u.from, u.to, u.origin, u.security]), [
    ['libc6', '2.41-12', '2.41-12+deb13u1', 'Debian', true],
    ['nodejs', '24.10.0-1nodesource1', '24.11.1-1nodesource1', 'Node Source', false],
    ['linux-image-6.12.62+rpt-rpi-v8', null, '1:6.12.62-1+rpt1', 'Raspberry Pi Foundation', false],
  ]);
  assert.deepStrictEqual(s.removes, ['old-thing']);
  assert.strictEqual(newerKernelInstalled({ release: '6.12.47+rpt-rpi-v8', dirs: ['6.12.47+rpt-rpi-v8', '6.12.62+rpt-rpi-2712', '6.12.62+rpt-rpi-v8'] }), '6.12.62+rpt-rpi-v8');
  assert.strictEqual(newerKernelInstalled({ release: '6.12.62+rpt-rpi-v8', dirs: ['6.12.47+rpt-rpi-v8', '6.12.62+rpt-rpi-v8'] }), null);
  assert.strictEqual(newerKernelInstalled({ release: '6.1.0-28-arm64', dirs: ['6.1.0-28-arm64', '6.1.0-29-arm64'] }), '6.1.0-29-arm64');
});

/** systemctl and apt-get, faked: a started unit runs for `ms`, then ends with `result`. */
function fakeSystem({ ms = 40, result = 'success', node = process.version } = {}) {
  const f = { calls: [], running: null, upgraded: false, result, node };
  f.run = async (cmd, a) => {
    f.calls.push([cmd, ...a].join(' '));
    if (cmd === 'systemctl' && a[0] === 'start') { f.running = { unit: a[a.length - 1], until: Date.now() + ms }; if (/upgrade/.test(f.running.unit)) f.upgraded = true; return { code: 0, out: '' }; }
    if (cmd === 'systemctl' && a[0] === 'show') {
      if (a[2] === 'Result') return { code: 0, out: `${f.result}\n` };
      return { code: 0, out: f.running && f.running.unit === a[a.length - 1] && Date.now() < f.running.until ? 'activating\n' : 'inactive\n' };
    }
    if (cmd === 'systemctl' && a[0] === 'reboot') return { code: 0, out: '' };
    if (cmd === 'apt-get') return { code: 0, out: f.upgraded ? 'NOTE: This is only a simulation!\n' : SIM };
    return { code: 0, out: `${f.node}\n` }; // node --version
  };
  return f;
}

test('check and install through the two services; result kept across a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osulog-'));
  const settings = new Settings(null, quiet);
  const f = fakeSystem();
  let restarted = 0;
  const make = () => new OsUpdates({ settings, dataDir: dir, log: quiet, run: f.run, installed: true, uptime: 9999, kernel: () => null, restartSelf: () => { restarted++; }, logDir, pollMs: 10 });
  const u = make();
  u.start();
  try {
    assert.strictEqual(u.status().mode, 'off');
    assert.strictEqual(u.status().nextAt, null, 'off: nothing scheduled');
    await u.check();
    assert.ok(f.calls.includes('systemctl start --no-block adi2-pi-os-check.service'));
    let s = u.status();
    assert.strictEqual(s.state, 'idle');
    assert.strictEqual(s.count, 3);
    assert.strictEqual(s.node.to, '24.11.1-1nodesource1');
    assert.ok(s.checkedAt);
    assert.throws(() => { u.state = 'checking'; u.assertReady(); }, /check is running/);
    u.state = 'idle';

    f.node = 'v24.11.1';
    await u.install();
    assert.ok(f.calls.includes('systemctl start --no-block adi2-pi-os-upgrade.service'));
    s = u.status();
    assert.strictEqual(s.count, 0, 'listed again after the install');
    assert.strictEqual(s.lastRun.kind, 'install');
    assert.strictEqual(s.lastRun.ok, true);
    assert.strictEqual(restarted, 1, 'Node.js replaced: ADI-2-Pi restarts');
    u.stop();

    // kept across a restart of the bridge
    const u2 = make();
    assert.strictEqual(u2.status().lastRun.kind, 'install');
    assert.ok(u2.status().checkedAt);

    // a failed run shows the end of its log
    fs.writeFileSync(path.join(logDir, 'os-upgrade.log'), 'Reading package lists...\nE: Could not get lock /var/lib/dpkg/lock-frontend\n');
    f.result = 'exit-code';
    await u2.install();
    s = u2.status();
    assert.strictEqual(s.lastRun.ok, false);
    assert.match(s.error, /Could not get lock/);
    assert.ok(s.lastRun.log.length >= 1);
    assert.throws(() => settings.update({ osUpdates: { mode: 'always' } }), /mode/);
  } finally { u.stop(); }
});

test('automatic: 5 minutes after the Pi started, then daily; the start shutdown waits for it', async () => {
  const settings = new Settings(null, quiet);
  settings.update({ osUpdates: { mode: 'install' } });
  const f = fakeSystem();
  // started together with the Pi, 299.9 s ago: due in about 100 ms
  const u = new OsUpdates({ settings, log: quiet, run: f.run, installed: true, uptime: 299.9, kernel: () => null, restartSelf: () => {}, pollMs: 10 });
  u.start();
  try {
    assert.ok(u.status().nextAt - Date.now() < 1100);
    assert.strictEqual(u.pendingAfterStart(), true, 'the trigger\'s start shutdown waits');
    await until(() => f.calls.includes('systemctl start --no-block adi2-pi-os-upgrade.service'), 3000);
    await until(() => u.status().state === 'idle' && u.status().lastRun);
    assert.strictEqual(u.pendingAfterStart(), false);
    assert.ok(Math.abs(u.status().nextAt - (Date.now() + 24 * 3600 * 1000)) < 5000, 'then every 24 h');
    settings.update({ osUpdates: { mode: 'off' } });
    assert.strictEqual(u.status().nextAt, null);
  } finally { u.stop(); }

  // the service restarted long after the start, checked an hour ago: next check 24 h after that one
  const f2 = fakeSystem();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osu-'));
  fs.writeFileSync(path.join(dir, 'os-updates.json'), JSON.stringify({ checkedAt: Date.now() - 3600 * 1000, updates: [], removes: [] }));
  settings.update({ osUpdates: { mode: 'notify' } });
  const u2 = new OsUpdates({ settings, dataDir: dir, log: quiet, run: f2.run, installed: true, uptime: 50000, kernel: () => null, pollMs: 10 });
  u2.start();
  try {
    assert.ok(Math.abs(u2.status().nextAt - (Date.now() + 23 * 3600 * 1000)) < 5000);
    assert.strictEqual(u2.pendingAfterStart(), false);
  } finally { u2.stop(); }

  // not set up (old installation): says so
  const u3 = new OsUpdates({ settings, log: quiet, run: f2.run, installed: false });
  assert.strictEqual(u3.status().available, false);
  await assert.rejects(u3.check(), /installer/);
});
