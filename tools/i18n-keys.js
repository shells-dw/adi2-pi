#!/usr/bin/env node
'use strict';
/**
 * Lists the texts the web page can translate: every tr('…') in web/app.js and web/auth.js, the
 * static texts of web/index.html, and the labels, notes, group headings, channel and value names
 * of lib/schema.json. Writes web/lang/template.json ("text": "") and reports keys a language file
 * lacks or has in excess:   node tools/i18n-keys.js [lang-code …]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const keys = new Set();
const add = (k) => { if (k && /[A-Za-z]/.test(k)) keys.add(k); };

for (const f of ['web/app.js', 'web/auth.js']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const re = /\btr\('((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(src))) add(m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
}
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
for (const m of html.matchAll(/(?:aria-label|title)="([^"]+)"/g)) add(m[1]);
add('Connecting…');

const schema = JSON.parse(fs.readFileSync(path.join(root, 'lib/schema.json'), 'utf8'));
const names = (n) => { if (Array.isArray(n)) n.forEach(add); else if (n && typeof n === 'object') Object.values(n).forEach(names); };
for (const list of Object.values(schema.params)) for (const p of list) { add(p.label); add(p.note); add(p.phonesLabel); names(p.names); }
Object.values(schema.groups || {}).forEach(add);
for (const c of schema.channels) { add(c.name); add(c.dacName); }

const sorted = [...keys].sort((a, b) => a.localeCompare(b, 'en'));
const template = Object.fromEntries(sorted.map((k) => [k, '']));
fs.writeFileSync(path.join(root, 'web/lang/template.json'), JSON.stringify(template, null, 2) + '\n');
console.log(`${sorted.length} texts → web/lang/template.json`);

for (const code of process.argv.slice(2)) {
  const f = path.join(root, 'web/lang', `${code}.json`);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const missing = sorted.filter((k) => !d[k]);
  const extra = Object.keys(d).filter((k) => !keys.has(k));
  console.log(`${code}: ${Object.keys(d).length - extra.length} translated, ${missing.length} missing, ${extra.length} unused`);
  for (const k of missing) console.log(`  missing: ${k}`);
  for (const k of extra) console.log(`  unused: ${k}`);
}
