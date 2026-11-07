#!/usr/bin/env node
'use strict';
/**
 * Screenshots of the web interface for the README, taken from a simulated ADI-2 Pro:
 *
 *   node tools/screenshots.js [model]      model: pro (default), se, se-ex, dac
 *
 * Writes docs/screenshots/*.webp (1× pixels, WebP made by Chromium itself; about 150 KB for all).
 * Needs Playwright with Chromium (`npm i -g playwright`, `npx playwright install chromium`). The
 * bridge runs with --mock on a free port and a temporary data folder; nothing touches a unit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'screenshots');
const model = process.argv[2] || 'pro';

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.error('needs Playwright: npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [file, tab or path, viewport]
// the two side by side in the README have the same size
const WIDE = { width: 1280, height: 800 };
const TALL = { width: 1280, height: 1100 };
const SHOTS = [
  ['overview', 'overview', WIDE],
  ['output', 'line', TALL],
  ['headphone-eq', '/eq/', TALL],
];
const QUALITY = 0.75;

(async () => {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'adi2-shots-'));
  // the host name shows on the System tab: a neutral one instead of this computer's
  const boot = `require('os').hostname = () => 'adi2-pi'; process.argv = process.argv.slice(0, 1).concat(${JSON.stringify([path.join(root, 'bin', 'adi2-pi.js'), '--mock', model, '--port', String(port), '--data', data])}); require(process.argv[1]);`;
  const bridge = spawn(process.execPath, ['-e', boot], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = `http://localhost:${port}`;
  let browser;
  try {
    for (let i = 0; i < 100; i++) { try { const r = await fetch(`${base}/api/info`); if (r.ok) break; } catch { /* starting */ } await sleep(100); }
    await sleep(2500); // the simulated unit answers, settings arrive
    // something to see on the EQ: Line Out with a curve (a typical headphone correction)
    const set = [['eqen', 1], ['b1type', 1], ['b1g', 4.5], ['b1f', 105], ['b1q', 0.7], ['b2g', -2.5], ['b2f', 220], ['b2q', 1.4],
      ['b3g', 2], ['b3f', 1800], ['b3q', 2.2], ['b4g', -3.5], ['b4f', 4800], ['b4q', 3], ['b5type', 1], ['b5g', 1.5], ['b5f', 10000], ['b5q', 0.7]];
    await fetch(`${base}/api/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set: set.map(([id, value]) => ({ ch: 'line', id, value })) }) });
    await sleep(1500);
    fs.mkdirSync(out, { recursive: true });
    browser = await chromium.launch();
    for (const [name, target, viewport] of SHOTS) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'dark' });
      await ctx.addInitScript(([tab]) => {
        localStorage.setItem('adi2.lang', JSON.stringify('en'));
        localStorage.setItem('adi2.theme', JSON.stringify('dark'));
        if (tab) localStorage.setItem('adi2.tab', JSON.stringify(tab));
      }, [target.startsWith('/') ? null : target]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(target.startsWith('/') ? base + target : `${base}/`);
      await sleep(2000);
      const png = await page.screenshot();
      // WebP from the PNG, encoded by the browser (no image tool needed)
      const webp = await page.evaluate(async ([b64, q]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/webp', q).split(',')[1];
      }, [png.toString('base64'), QUALITY]);
      const file = path.join(out, `${name}.webp`);
      fs.writeFileSync(file, Buffer.from(webp, 'base64'));
      if (errors.length) console.error(`${name}: ${errors.join('; ')}`);
      console.log(`${path.relative(root, file)} ${Math.round(fs.statSync(file).size / 1024)} KB`);
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((r) => { bridge.once('exit', r); bridge.kill(); });
    fs.rmSync(data, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
