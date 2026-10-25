// Renders the GitHub social preview (1280×640) from the mark: node make-social.js
const fs = require('fs');
const { chromium } = require('playwright');
const mark = Buffer.from(fs.readFileSync(`${__dirname}/adi2-pi-mark.svg`)).toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 640px; background: #121417; font-family: Inter, "Noto Sans", "Segoe UI", system-ui, sans-serif; color: #e6e8eb; overflow: hidden; }
  .wrap { position: relative; width: 1280px; height: 640px; }
  .grid { position: absolute; inset: 0; background-image: linear-gradient(#1b1e23 1px, transparent 1px), linear-gradient(90deg, #1b1e23 1px, transparent 1px); background-size: 40px 40px; opacity: .6; }
  .glow { position: absolute; left: 60px; top: 90px; width: 460px; height: 460px; border-radius: 50%; background: radial-gradient(closest-side, rgba(63,193,217,.18), transparent); }
  .mark { position: absolute; left: 110px; top: 140px; width: 360px; height: 360px; }
  .text { position: absolute; left: 560px; top: 182px; }
  .name { font-size: 96px; font-weight: 700; letter-spacing: -3px; line-height: 1; }
  .name span { color: #3fc1d9; }
  .sub { margin-top: 22px; font-size: 28px; color: #8b929b; font-weight: 500; }
  .tags { margin-top: 44px; display: flex; gap: 10px; flex-wrap: wrap; width: 640px; }
  .tag { font-size: 18px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #e6e8eb; border: 1.5px solid #3d444d; border-radius: 8px; padding: 7px 14px; }
  .tag.o { color: #f0a23b; border-color: #f0a23b; }
  .foot { position: absolute; left: 560px; bottom: 56px; font-size: 20px; color: #5c636c; }
</style></head><body><div class="wrap">
  <div class="grid"></div><div class="glow"></div>
  <img class="mark" src="data:image/svg+xml;base64,${mark}">
  <div class="text">
    <div class="name">ADI-2-<span>Pi</span></div>
    <div class="sub">Network remote and audio bridge for RME ADI-2</div>
    <div class="tags"><span class="tag o">Raspberry Pi</span><span class="tag">Web remote</span><span class="tag">Bluetooth</span><span class="tag">AirPlay</span><span class="tag">Spotify Connect</span><span class="tag">Headphone EQ</span><span class="tag">MQTT</span></div>
  </div>
  <div class="foot">github.com/shells-dw/adi2-pi · GPL-3.0</div>
</div></body></html>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 640 } });
  await p.setContent(html); await p.waitForTimeout(300);
  await p.screenshot({ path: `${__dirname}/social-preview.png` });
  await b.close();
})();
