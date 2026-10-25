/* ADI-2-Pi – access key for the API (System → Access key). Loaded before the page scripts:
   adds the stored key to /api/ requests and offers a prompt when the bridge asks for one. */
'use strict';
(() => {
  const K = 'adi2.key';
  const get = () => { try { return JSON.parse(localStorage.getItem(K) || 'null') || ''; } catch { return ''; } };
  const set = (v) => { try { if (v) localStorage.setItem(K, JSON.stringify(v)); else localStorage.removeItem(K); } catch { /* private mode */ } };

  const orig = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    const k = get();
    if (k && /^\/api\//.test(String(url))) opts = { ...opts, headers: { ...(opts.headers || {}), 'X-ADI2PI-Key': k } };
    return orig(url, opts).then((r) => {
      if (r.status === 401) ask(get() ? (window.I18N ? window.I18N.tr('Wrong access key.') : 'Wrong access key.') : null);
      return r;
    });
  };

  let open = false;
  /** Dialog asking for the key; reloads the page with it. */
  function ask(note) {
    if (open) return;
    open = true;
    const tr = (k) => (window.I18N ? window.I18N.tr(k) : k);
    const d = document.createElement('dialog');
    d.className = 'keydlg';
    d.innerHTML = `<form method="dialog"><h2>${tr('Access key')}</h2><p class="hint">${tr('This ADI-2-Pi needs an access key (System → Access key).')}</p>`
      + `<p class="hint bad" hidden></p><input type="password" autocomplete="current-password" aria-label="${tr('Access key')}" required>`
      + `<div class="inline" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" value="ok">${tr('Continue')}</button></div></form>`;
    const msg = d.querySelector('.bad');
    if (note) { msg.textContent = note; msg.hidden = false; }
    d.addEventListener('close', () => {
      const v = d.querySelector('input').value.trim();
      if (v) { set(v); location.reload(); } else { open = false; d.remove(); }
    });
    document.body.append(d);
    d.showModal();
  }

  window.ADI2KEY = { get, set, ask };
})();
