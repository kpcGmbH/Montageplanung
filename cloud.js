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
  // preferRemote (nur für Rückgängig/Wiederholen): im echten Konflikt gewinnt der AKTUELLE Stand (remote) statt
  // der lokalen Seite. Sonst nähme „Rückgängig" auch das mit, was jemand anderes inzwischen an genau derselben
  // Stelle eingetragen hat – man darf nur die eigene Aktion zurücknehmen.
  function merge3(base, local, remote, preferRemote) {
    if (eq(local, remote)) return local;
    if (eq(base, local)) return remote;    // nur entfernt geändert
    if (eq(base, remote)) return local;    // nur lokal geändert
    if (isObj(local) && isObj(remote)) {   // Objekte: Schlüssel einzeln mergen
      const bb = isObj(base) ? base : {}, out = {};
      for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        const inL = k in local, inR = k in remote, lv = local[k], rv = remote[k], bv = bb[k], inB = k in bb;
        if (inL && inR) out[k] = merge3(bv, lv, rv, preferRemote);
        else if (inL) { if (!(inB && eq(lv, bv))) out[k] = lv; }   // entfernt gelöscht & lokal unverändert → weglassen
        else { if (!(inB && eq(rv, bv))) out[k] = rv; }            // lokal gelöscht & entfernt unverändert → weglassen
      }
      return out;
    }
    let ik = (Array.isArray(local) && Array.isArray(remote)) ? (idKeyOf(local) || idKeyOf(remote)) : null;
    // Hat nur eine Seite die Schlüssel (z. B. neue Balken-IDs, alter Stand ohne), nicht darüber mergen – sonst doppelte Einträge
    const hasKey = (arr) => !Array.isArray(arr) || !arr.length || arr.every(e => e && typeof e === 'object' && e[ik] != null);
    if (ik === 'bid' && !(hasKey(local) && hasKey(remote) && hasKey(base))) ik = null;
    if (ik) {                              // Arrays mit stabilem Schlüssel: elementweise mergen
      const bm = mapBy(base, ik), rm = mapBy(remote, ik), out = [], seen = new Set();
      for (const e of local) { const id = e[ik]; seen.add(id);
        if (rm.has(id)) out.push(merge3(bm.get(id), e, rm.get(id), preferRemote));
        else if (!(bm.has(id) && eq(e, bm.get(id)))) out.push(e);   // entfernt gelöscht & lokal unverändert → weglassen
      }
      for (const e of remote) { const id = e[ik]; if (seen.has(id)) continue;
        if (!bm.has(id)) out.push(e);                 // neu in entfernt
        else if (!eq(e, bm.get(id))) out.push(e);     // entfernt geändert, lokal gelöscht → Änderung behalten
        // sonst: unverändert & lokal gelöscht → weglassen
      }
      return out;
    }
    if (Array.isArray(local) && Array.isArray(remote)) {
      // Arrays ohne Schlüssel (z. B. Zuordnungen „ganze Phase" als Text, Gewerke-Listen): als Menge zusammenführen –
      // beide Seiten dürfen Einträge hinzufügen/entfernen, statt dass eine Seite die andere komplett überschreibt.
      const key = (x) => JSON.stringify((x && typeof x === 'object' && !Array.isArray(x) && 'bid' in x) ? Object.assign({}, x, { bid: undefined }) : x), B = new Set((Array.isArray(base) ? base : []).map(key)), R = new Set(remote.map(key));
      const out = [], seen = new Set();
      for (const e of local) { const k = key(e); if (seen.has(k)) continue; if (R.has(k) || !B.has(k)) { out.push(e); seen.add(k); } }
      for (const e of remote) { const k = key(e); if (seen.has(k)) continue; if (!B.has(k)) { out.push(e); seen.add(k); } }
      return out;
    }
    return preferRemote ? remote : local;   // Primitive / Typwechsel: letzter gewinnt (lokal)
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

  // Sitzung abgelaufen (stille Token-Erneuerung schlägt fehl): KEIN Popup aus dem Hintergrund – Browser blockieren
  // das („popup_window_error"). Beim Laden der Seite direkt per Weiterleitung neu anmelden (nichts geht verloren),
  // mitten in der Arbeit nur einen Hinweis zeigen und die ungespeicherten Änderungen für danach sichern.
  let needRelogin = false, initPhase = false;
  const UNSAVED_KEY = 'montageplanung_unsaved', RELOGIN_TS_KEY = 'montageplanung_relogin_ts';
  // Noch nicht in der Cloud angekommene Änderungen (mit dem Stand, auf dem sie beruhen) im Browser merken:
  // nach einem Speicherfehler, geschlossenem Tab oder neuer Anmeldung werden sie beim nächsten Start zusammengeführt.
  function rememberUnsaved(local) {
    try {
      if (local && baseSnap && !eq(local, baseSnap)) localStorage.setItem(UNSAVED_KEY, JSON.stringify({ base: baseSnap, local, ts: Date.now(), user: msalAccount && msalAccount.username }));
    } catch (e) { /* Speicher voll / gesperrt → ohne Sicherung weiter */ }
  }
  const clearUnsaved = () => { try { localStorage.removeItem(UNSAVED_KEY); sessionStorage.removeItem(UNSAVED_KEY); } catch (e) {} };
  function stashUnsaved() { rememberUnsaved(snapFn ? snapFn() : null); }
  async function restoreUnsaved() {
    let st = null;
    try { st = JSON.parse(localStorage.getItem(UNSAVED_KEY) || sessionStorage.getItem(UNSAVED_KEY) || 'null'); clearUnsaved(); } catch (e) { return; }
    if (!st || !st.local || !baseSnap || Date.now() - (st.ts || 0) > 3 * 24 * 3600 * 1000) return;
    if (st.user && msalAccount && st.user !== msalAccount.username) return;   // fremdes Konto (gemeinsamer PC) → nicht übernehmen
    const merged = merge3(st.base || baseSnap, st.local, baseSnap, true);   // im Konflikt gilt der neuere Stand der anderen
    if (eq(merged, baseSnap)) return;
    if (applyFn) applyFn(clone(merged), 'merge');
    await push(merged);
    setStatus('Änderungen von vor der Anmeldung übernommen ' + hhmm(), 'ok');
  }
  function reloginError() {
    needRelogin = true;
    setStatus('Sitzung abgelaufen – bitte „Neu anmelden" klicken', 'warn');
    const err = new Error('Sitzung abgelaufen – bitte neu anmelden'); err.relogin = true; return err;
  }
  async function getToken() {
    try {
      const res = await msalApp.acquireTokenSilent({ scopes: GRAPH_SCOPES, account: msalAccount });
      needRelogin = false;
      return res.accessToken;
    } catch (e) {
      if (IN_POPUP) throw reloginError();
      // Automatisch weiterleiten nur beim Seitenstart oder auf Mobilgeräten – und höchstens einmal pro Minute (keine Schleife)
      let last = 0; try { last = +sessionStorage.getItem(RELOGIN_TS_KEY) || 0; } catch (x) {}
      if ((USE_REDIRECT || initPhase) && Date.now() - last > 60000) {
        try { sessionStorage.setItem(RELOGIN_TS_KEY, String(Date.now())); } catch (x) {}
        stashUnsaved();
        setStatus('Sitzung abgelaufen – Anmeldung wird erneuert…', 'sync');
        await msalApp.acquireTokenRedirect({ scopes: GRAPH_SCOPES, account: msalAccount, loginHint: msalAccount && msalAccount.username });
        const err = new Error('Anmeldung wird erneuert'); err.relogin = true; throw err;
      }
      stashUnsaved();
      throw reloginError();
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

  async function pull(initial, force) {
    await resolveSite();
    const r = await graph(planPath());
    if (r.status === 404) { etag = null; baseSnap = null; setStatus('angemeldet · noch keine Cloud-Daten', 'ok'); return null; }
    if (!r.ok) throw new Error('Laden fehlgeschlagen (' + r.status + ')');
    const newEtag = r.headers.get('ETag') || r.headers.get('etag');
    if (!initial && !force && baseSnap && newEtag && newEtag === etag) return null;   // nichts Neues am Server
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

  async function push(snap, noMerge) {
    await resolveSite();
    const headers = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    const r = await graph(planPath(), { method: 'PUT', headers, body: JSON.stringify(snap) });
    if (r.status === 412) {   // jemand anderes hat gespeichert → zusammenführen (bei offenem Dialog erst danach)
      if (noMerge) { const err = new Error('später zusammenführen'); err.deferred = true; throw err; }
      return await mergeAndRetry(0);
    }
    if (!r.ok) throw new Error('Speichern fehlgeschlagen (' + r.status + ')');
    const j = await r.json().catch(() => ({}));
    etag = j.eTag || j.cTag || etag; baseSnap = clone(snap);
    clearUnsaved();
    setStatus('gespeichert ' + hhmm(), 'ok');
  }

  // Konflikt: aktuellen Serverstand holen, mit lokalen Änderungen zusammenführen, erneut speichern
  async function mergeAndRetry(tries) {
    if (tries > 5) throw new Error('Speicher-Konflikt – wird erneut versucht');
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
    clearUnsaved();
    setStatus('zusammengeführt & gespeichert ' + hhmm(), 'ok');
  }

  // Live-Sync: regelmäßig + bei Fokus den Serverstand holen und mergen
  let canSyncFn = () => true;
  let retryTimer = null;
  // Speichern ausführen: immer den Stand von JETZT (kam ein Live-Sync dazwischen, enthielte der vorgemerkte Stand
  // dessen Änderungen nicht). Bei offenem Dialog nur ohne Zusammenführen; sonst später erneut.
  async function flushSave() {
    if (syncing) { saveTimer = setTimeout(flushSave, 400); return; }
    const paused = !canSyncFn();
    syncing = true;
    try { setStatus('speichere…', 'sync'); await push(snapFn ? snapFn() : pendingSnap, paused); clearTimeout(retryTimer); retryTimer = null; }
    catch (e) {
      if (e.deferred) { saveTimer = setTimeout(flushSave, 1500); }
      else if (!e.relogin) {
        setStatus('Speicher-Fehler: ' + e.message + ' – neuer Versuch in 20 s', 'warn');
        clearTimeout(retryTimer); retryTimer = setTimeout(flushSave, 20000);   // genau EIN Wiederholversuch, keine Kettenbildung
      }
    }
    finally { syncing = false; }
  }
  async function safePull() { if (syncing || !msalAccount || !canSyncFn()) return; syncing = true; try { await pull(false); } catch (e) { /* still weiter */ } finally { syncing = false; } }
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
    needsLogin() { return needRelogin; },   // Sitzung abgelaufen → Nutzer muss „Neu anmelden" klicken
    inPopup() { return IN_POPUP; },
    saveDraft(name, obj) { return saveDraftFile(name, obj); },
    loadDraft(name) { return loadDraftFile(name); },
    account() { return msalAccount && (msalAccount.username || msalAccount.name); },
    onApply(fn) { applyFn = fn; },
    onStatus(fn) { statusFn = fn; },
    onSnapshot(fn) { snapFn = fn; },
    onCanSync(fn) { canSyncFn = fn; },   // false, solange ein Dialog offen ist → kein Abgleich/Speichern in dieser Zeit   // liefert cloud.js den aktuellen lokalen Stand fürs Mergen
    merge3(base, local, remote, preferRemote) { return merge3(base, local, remote, preferRemote); },   // 3-Wege-Merge (auch für Tests)

    async init() {
      try { await msalInit(); }
      catch (e) { console.warn('Cloud/MSAL init:', e); setStatus('offline (lokal)', 'off'); return false; }
      if (msalAccount) {
        setStatus('angemeldet: ' + (msalAccount.username || ''), 'ok');
        initPhase = true;
        try { await pull(true); await restoreUnsaved(); } catch (e) { if (!e.relogin) setStatus('Fehler: ' + e.message, 'warn'); }
        finally { initPhase = false; }
        startSync();
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
        if (msalAccount) stashUnsaved();   // erneute Anmeldung mitten in der Arbeit: Ungespeichertes sichern
        await msalApp.loginRedirect(Object.assign({ scopes: GRAPH_SCOPES }, msalAccount && msalAccount.username ? { loginHint: msalAccount.username } : {}));
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
      try { await pull(false, true); } catch (e) { if (!e.relogin) setStatus('Fehler: ' + e.message, 'warn'); } finally { syncing = false; }
    },
    scheduleSave(snap) {
      if (!msalAccount) return;               // ohne Login nur lokal speichern
      pendingSnap = snap;
      rememberUnsaved(snap);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushSave, 1500);
    },
  };
})();
