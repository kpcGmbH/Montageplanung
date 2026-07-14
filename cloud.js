// ============================================================================
// Cloud-Sync für die Montageplanung
// Microsoft-Login (MSAL / Entra ID) + geteilte Daten in SharePoint via Graph.
// Spiegelt 1:1 das Muster der KPC Montagefortschrittsapp.
//
// Der komplette Plan (groups/team/assignments) wird als EINE Datei
//   <sitePath>/Freigegebene Dokumente/<filePath>
// gespeichert. Optimistische Sperre über ETag (If-Match) verhindert,
// dass sich mehrere Planer gegenseitig überschreiben.
// ============================================================================
window.Cloud = (function () {
  const MS_CONFIG = {
    tenantId: 'cba1b1fc-4a80-4da1-a7f1-e3e4614056eb',      // KPC-Tenant (wie Fortschrittsapp)
    clientId: '68f89557-eef9-4481-b45c-29919ed7b55d',      // bestehende Entra-App (Redirect-URI der Pages-URL ergänzen!)
    spHost:   'kpcfulda.sharepoint.com',
    sitePath: '/sites/Montageplanung',                     // NEU von der IT anzulegen
    filePath: 'plan.json',                                 // Datei in der Standard-Dokumentbibliothek der Site
  };
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const GRAPH_SCOPES = ['User.Read', 'Sites.Selected'];
  // Läuft die App selbst in einem Popup-/App-Fenster (z. B. aus Teams/Outlook/Edge per Link geöffnet,
  // window.opener gesetzt)? Dann verbietet MSAL SOWOHL Popup ALS AUCH Weiterleitung („block_nested_popups").
  // Eine Anmeldung ist dort nicht möglich – der Nutzer muss die App im Hauptfenster/normalen Tab öffnen.
  const IN_POPUP = (() => { try { return !!window.opener && window.opener !== window; } catch (e) { return false; } })();
  const USE_REDIRECT = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
  // Zeigt einen anklickbaren Link, der die App in einem normalen Top-Level-Tab öffnet (Gate + Banner).
  function showOpenInMainWindow() {
    setStatus('In diesem Fenster ist keine Microsoft-Anmeldung möglich (eingebettetes Fenster).', 'warn');
    for (const id of ['gateErr', 'loginNoticeErr']) {
      const err = document.getElementById(id);
      if (!err) continue;
      err.hidden = false; err.innerHTML = '';
      err.appendChild(document.createTextNode('Dieses kleine/eingebettete Fenster (z. B. aus Teams/Outlook) erlaubt keine Anmeldung. '));
      const a = document.createElement('a');
      a.href = window.location.origin + window.location.pathname; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Hier im normalen Browser-Tab öffnen';
      a.style.fontWeight = '700'; a.style.textDecoration = 'underline';
      err.appendChild(a);
      err.appendChild(document.createTextNode(' – und dort anmelden.'));
    }
  }

  let msalApp = null, msalAccount = null, siteId = null, etag = null;
  let applyFn = null, statusFn = null, saveTimer = null, pendingSnap = null;
  let snapFn = null, baseSnap = null, syncing = false, pollTimer = null;   // Auto-Merge/Live-Sync

  const setStatus = (text, cls) => { if (statusFn) statusFn(text, cls || ''); };
  const hhmm = () => { const d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };

  // ---- 3-Wege-Merge (Basis / lokal / entfernt) für konfliktarmes gemeinsames Speichern ----
  const clone = (o) => JSON.parse(JSON.stringify(o));   // eigene Kopie – Basis darf nicht mit-mutieren
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  function idKeyOf(arr) {   // Schlüssel, über den ein Array zuverlässig zusammengeführt werden kann
    if (!Array.isArray(arr) || !arr.length) return null;
    for (const k of ['id', 'bid', 'pid', 'name']) if (arr.every(e => e && typeof e === 'object' && e[k] != null)) return k;
    return null;
  }
  const mapBy = (arr, k) => { const m = new Map(); if (Array.isArray(arr)) for (const e of arr) m.set(e[k], e); return m; };
  function merge3(base, local, remote) {
    if (eq(local, remote)) return local;
    if (eq(base, local)) return remote;    // nur entfernt geändert
    if (eq(base, remote)) return local;    // nur lokal geändert
    if (isObj(local) && isObj(remote)) {   // Objekte: Schlüssel einzeln mergen
      const bb = isObj(base) ? base : {}, out = {};
      for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        const inL = k in local, inR = k in remote, lv = local[k], rv = remote[k], bv = bb[k], inB = k in bb;
        if (inL && inR) out[k] = merge3(bv, lv, rv);
        else if (inL) { if (!(inB && eq(lv, bv))) out[k] = lv; }   // entfernt gelöscht & lokal unverändert → weglassen
        else { if (!(inB && eq(rv, bv))) out[k] = rv; }            // lokal gelöscht & entfernt unverändert → weglassen
      }
      return out;
    }
    const ik = (Array.isArray(local) && Array.isArray(remote)) ? (idKeyOf(local) || idKeyOf(remote)) : null;
    if (ik) {                              // Arrays mit stabilem Schlüssel: elementweise mergen
      const bm = mapBy(base, ik), rm = mapBy(remote, ik), out = [], seen = new Set();
      for (const e of local) { const id = e[ik]; seen.add(id);
        if (rm.has(id)) out.push(merge3(bm.get(id), e, rm.get(id)));
        else if (!(bm.has(id) && eq(e, bm.get(id)))) out.push(e);   // entfernt gelöscht & lokal unverändert → weglassen
      }
      for (const e of remote) { const id = e[ik]; if (seen.has(id)) continue;
        if (!bm.has(id)) out.push(e);                 // neu in entfernt
        else if (!eq(e, bm.get(id))) out.push(e);     // entfernt geändert, lokal gelöscht → Änderung behalten
        // sonst: unverändert & lokal gelöscht → weglassen
      }
      return out;
    }
    return local;   // Arrays ohne Schlüssel / Primitive / Typwechsel: letzter gewinnt (lokal)
  }

  async function msalInit() {
    if (typeof msal === 'undefined') throw new Error('MSAL-Bibliothek nicht geladen (Internet/CDN prüfen)');
    msalApp = new msal.PublicClientApplication({
      auth: {
        clientId: MS_CONFIG.clientId,
        authority: 'https://login.microsoftonline.com/' + MS_CONFIG.tenantId,
        redirectUri: (window.location.origin + window.location.pathname).replace(/index\.html$/, ''),
      },
      cache: { cacheLocation: 'localStorage' },
    });
    if (typeof msalApp.initialize === 'function') await msalApp.initialize();
    const resp = await msalApp.handleRedirectPromise();
    if (resp && resp.account) msalAccount = resp.account;
    if (!msalAccount) { const a = msalApp.getAllAccounts(); if (a.length) msalAccount = a[0]; }
    if (msalAccount) msalApp.setActiveAccount(msalAccount);
    return msalAccount;
  }

  async function getToken() {
    try {
      const res = await msalApp.acquireTokenSilent({ scopes: GRAPH_SCOPES, account: msalAccount });
      return res.accessToken;
    } catch (e) {
      if (USE_REDIRECT) { await msalApp.acquireTokenRedirect({ scopes: GRAPH_SCOPES }); throw e; }
      const res = await msalApp.acquireTokenPopup({ scopes: GRAPH_SCOPES });
      msalAccount = res.account;
      return res.accessToken;
    }
  }

  async function graph(path, opts) {
    opts = opts || {};
    const token = await getToken();
    const headers = Object.assign({ 'Authorization': 'Bearer ' + token }, opts.headers || {});
    return fetch(GRAPH + path, Object.assign({}, opts, { headers }));
  }

  async function resolveSite() {
    if (siteId) return;
    const r = await graph('/sites/' + MS_CONFIG.spHost + ':' + MS_CONFIG.sitePath);
    if (!r.ok) throw new Error('SharePoint-Site nicht erreichbar (' + r.status + ')');
    siteId = (await r.json()).id;
  }

  const planPath = () => '/sites/' + siteId + '/drive/root:/' + MS_CONFIG.filePath + ':/content';

  async function pull(initial) {
    await resolveSite();
    const r = await graph(planPath());
    if (r.status === 404) { etag = null; baseSnap = null; setStatus('angemeldet · noch keine Cloud-Daten', 'ok'); return null; }
    if (!r.ok) throw new Error('Laden fehlgeschlagen (' + r.status + ')');
    const newEtag = r.headers.get('ETag') || r.headers.get('etag');
    if (!initial && baseSnap && newEtag && newEtag === etag) return null;   // nichts Neues am Server
    const remote = await r.json();
    let toApply, hadLocal = false;
    if (initial || !baseSnap) { toApply = remote; }
    else { const local = snapFn ? snapFn() : remote; toApply = merge3(baseSnap, local, remote); hadLocal = !eq(toApply, remote); }
    baseSnap = remote; etag = newEtag;
    if (applyFn) applyFn(clone(toApply), initial ? 'init' : 'merge');
    setStatus((initial ? 'geladen ' : 'aktualisiert ') + hhmm(), 'ok');
    if (hadLocal) { try { await push(toApply); } catch (e) { /* nächster Sync versucht es erneut */ } }
    return toApply;
  }

  async function push(snap) {
    await resolveSite();
    const headers = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    const r = await graph(planPath(), { method: 'PUT', headers, body: JSON.stringify(snap) });
    if (r.status === 412) { return await mergeAndRetry(0); }   // jemand anderes hat gespeichert → zusammenführen
    if (!r.ok) throw new Error('Speichern fehlgeschlagen (' + r.status + ')');
    const j = await r.json().catch(() => ({}));
    etag = j.eTag || j.cTag || etag; baseSnap = clone(snap);
    setStatus('gespeichert ' + hhmm(), 'ok');
  }

  // Konflikt: aktuellen Serverstand holen, mit lokalen Änderungen zusammenführen, erneut speichern
  async function mergeAndRetry(tries) {
    if (tries > 5) { setStatus('⚠ Speicher-Konflikt – bitte „↻ Laden"', 'warn'); return; }
    const r = await graph(planPath());
    if (!r.ok) throw new Error('Laden fehlgeschlagen (' + r.status + ')');
    const newEtag = r.headers.get('ETag') || r.headers.get('etag');
    const remote = await r.json();
    const local = snapFn ? snapFn() : remote;
    const merged = merge3(baseSnap || remote, local, remote);
    baseSnap = remote; etag = newEtag;
    if (applyFn) applyFn(clone(merged), 'merge');
    const pr = await graph(planPath(), { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': newEtag }, body: JSON.stringify(merged) });
    if (pr.status === 412) return mergeAndRetry(tries + 1);
    if (!pr.ok) throw new Error('Speichern fehlgeschlagen (' + pr.status + ')');
    const j = await pr.json().catch(() => ({}));
    etag = j.eTag || j.cTag || etag; baseSnap = clone(merged);
    setStatus('zusammengeführt & gespeichert ' + hhmm(), 'ok');
  }

  // Live-Sync: regelmäßig + bei Fokus den Serverstand holen und mergen
  async function safePull() { if (syncing || !msalAccount) return; syncing = true; try { await pull(false); } catch (e) { /* still weiter */ } finally { syncing = false; } }
  const onFocusSync = () => safePull();
  const onVisSync = () => { if (document.visibilityState === 'visible') safePull(); };
  function startSync() {
    if (pollTimer) return;
    pollTimer = setInterval(safePull, 15000);
    window.addEventListener('focus', onFocusSync);
    document.addEventListener('visibilitychange', onVisSync);
  }
  function stopSync() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    window.removeEventListener('focus', onFocusSync);
    document.removeEventListener('visibilitychange', onVisSync);
  }

  // Termineinladungs-Zwischenstände: je Projekt eine JSON-Datei im Ordner „Termineinladungen/"
  const draftPath = (name) => '/sites/' + siteId + '/drive/root:/Termineinladungen/' + encodeURIComponent(name) + ':/content';
  async function saveDraftFile(name, obj) {
    await resolveSite();
    const put = () => graph(draftPath(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
    let r = await put();
    if (r.status === 404) {   // Ordner fehlt → anlegen und erneut versuchen
      await graph('/sites/' + siteId + '/drive/root/children',
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Termineinladungen', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) }).catch(() => {});
      r = await put();
    }
    if (!r.ok) throw new Error('Speichern fehlgeschlagen (' + r.status + ')');
    return true;
  }
  async function loadDraftFile(name) {
    await resolveSite();
    const r = await graph(draftPath(name));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('Laden fehlgeschlagen (' + r.status + ')');
    return await r.json();
  }

  return {
    isReady() { return !!msalAccount; },
    inPopup() { return IN_POPUP; },
    saveDraft(name, obj) { return saveDraftFile(name, obj); },
    loadDraft(name) { return loadDraftFile(name); },
    account() { return msalAccount && (msalAccount.username || msalAccount.name); },
    onApply(fn) { applyFn = fn; },
    onStatus(fn) { statusFn = fn; },
    onSnapshot(fn) { snapFn = fn; },   // liefert cloud.js den aktuellen lokalen Stand fürs Mergen
    merge3(base, local, remote) { return merge3(base, local, remote); },   // 3-Wege-Merge (auch für Tests)

    async init() {
      try { await msalInit(); }
      catch (e) { console.warn('Cloud/MSAL init:', e); setStatus('offline (lokal)', 'off'); return false; }
      if (msalAccount) {
        setStatus('angemeldet: ' + (msalAccount.username || ''), 'ok');
        try { await pull(true); startSync(); } catch (e) { setStatus('Fehler: ' + e.message, 'warn'); }
        return true;
      }
      if (IN_POPUP) { showOpenInMainWindow(); return false; }  // im Popup-Fenster gleich den Hinweis zeigen
      setStatus('nicht angemeldet', 'off');
      return false;
    },
    async login() {
      // Im Popup-/eingebetteten Fenster ist keine Anmeldung möglich → Hinweis zum Hauptfenster.
      if (IN_POPUP) { showOpenInMainWindow(); return; }
      // Weiterleitung statt Popup: robust in allen Browsern (kein Popup-Blocker, kein block_nested_popups).
      try {
        if (!msalApp) await msalInit();
        setStatus('Anmeldung wird geöffnet…', 'sync');
        await msalApp.loginRedirect({ scopes: GRAPH_SCOPES });
      } catch (e) {
        console.error('Login-Fehler:', e);
        const code = e && (e.errorCode || e.errorNo);
        if (code === 'block_nested_popups') { showOpenInMainWindow(); return; }
        const msg = (e && (e.errorMessage || e.message)) || String(e);
        setStatus('Login-Fehler: ' + (code ? code + ' – ' : '') + msg, 'warn');
      }
    },
    async logout() {
      stopSync();
      if (msalApp && msalAccount) { try { await msalApp.logoutPopup({ account: msalAccount }); } catch (e) {} }
      msalAccount = null; siteId = null; etag = null; baseSnap = null;
      setStatus('abgemeldet', 'off');
    },
    async reload() {
      if (!msalAccount || syncing) return;
      syncing = true;
      try { await pull(true); } catch (e) { setStatus('Fehler: ' + e.message, 'warn'); } finally { syncing = false; }
    },
    scheduleSave(snap) {
      if (!msalAccount) return;               // ohne Login nur lokal speichern
      pendingSnap = snap;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        if (syncing) { saveTimer = setTimeout(() => { if (window.Cloud) window.Cloud.scheduleSave(pendingSnap); }, 400); return; }
        syncing = true;
        try { setStatus('speichere…', 'sync'); await push(pendingSnap); }
        catch (e) { setStatus('Speicher-Fehler: ' + e.message, 'warn'); }
        finally { syncing = false; }
      }, 1500);
    },
  };
})();
