/* ADI-2-Pi – page language. Loaded before app.js.
   Languages are files in lang/ (see lang/README.md): lang/index.json lists them, lang/<code>.json maps
   the English text to the translation. The language is chosen per browser (System → Language) and
   otherwise follows the browser's language; English needs no file. */
'use strict';
(() => {
  const K = 'adi2.lang';
  let dict = {};
  let lang = 'en';
  const languages = [{ code: 'en', name: 'English' }];
  const get = () => { try { return localStorage.getItem(K) || ''; } catch { return ''; } };

  /** Translation of `key` (the English text); {0}, {1} … or {name} are filled from `vars`. */
  function tr(key, vars) {
    let s = dict[key] || key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
    return s;
  }

  const ready = (async () => {
    try {
      const list = await fetch('lang/index.json').then((r) => (r.ok ? r.json() : []));
      for (const l of list) if (l && l.code && l.name && !languages.some((x) => x.code === l.code)) languages.push({ code: String(l.code), name: String(l.name) });
    } catch { /* no languages */ }
    const stored = get();
    let wanted = stored && languages.some((l) => l.code === stored) ? stored : '';
    if (!wanted) {
      // the browser's languages: exact code first, then the language part ("de" for "de-AT")
      for (const nl of navigator.languages || [navigator.language || 'en']) {
        const code = String(nl).toLowerCase();
        const hit = languages.find((l) => l.code === code) || languages.find((l) => l.code === code.split('-')[0]);
        if (hit) { wanted = hit.code; break; }
      }
    }
    if (wanted && wanted !== 'en') {
      try {
        const d = await fetch(`lang/${wanted}.json`).then((r) => (r.ok ? r.json() : null));
        if (d && typeof d === 'object') { dict = d; lang = wanted; }
      } catch { /* English */ }
    }
    document.documentElement.lang = lang;
  })();

  window.I18N = {
    tr, ready, languages,
    get lang() { return lang; },
    get stored() { return get(); },
    /** '' = follow the browser. Reloads the page. */
    set(code) { try { if (code) localStorage.setItem(K, code); else localStorage.removeItem(K); } catch { /* private mode */ } location.reload(); },
  };
})();
