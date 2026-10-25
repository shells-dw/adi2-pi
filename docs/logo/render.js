// Renders the logo SVGs to PNG (Chromium via Playwright): node render.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const render = async (svgFile, out, w, h) => {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const svg = fs.readFileSync(svgFile, 'utf8');
    await p.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${w}" height="${h}"></body></html>`);
    await p.screenshot({ path: out, omitBackground: true });
    await p.close();
  };
  const here = __dirname;
  const web = path.join(here, '..', '..', 'web');
  await render('adi2-pi-icon.svg', path.join(here, 'icon-512.png'), 512, 512);
  await render('adi2-pi-wordmark-dark.svg', path.join(here, 'wordmark-dark.png'), 1200, 280);
  await render('adi2-pi-wordmark-light.svg', path.join(here, 'wordmark-light.png'), 1200, 280);
  await render('adi2-pi-icon.svg', path.join(web, 'icon-512.png'), 512, 512);
  await render('adi2-pi-icon.svg', path.join(web, 'icon-192.png'), 192, 192);
  await render('adi2-pi-icon.svg', path.join(web, 'apple-touch-icon.png'), 180, 180);
  await render('adi2-pi-mark.svg', path.join(web, 'favicon-32.png'), 32, 32);
  await render('adi2-pi-maskable.svg', path.join(web, 'maskable-512.png'), 512, 512);
  fs.copyFileSync('adi2-pi-mark.svg', path.join(web, 'logo.svg'));
  fs.copyFileSync('adi2-pi-icon.svg', path.join(web, 'icon.svg'));
  await b.close();
})();
