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

  const setStatus = (text, cls) => { if (statusFn) statusFn(text, cls || ''); };
  const hhmm = () => { const d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };

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

  async function pull() {
    await resolveSite();
    const r = await graph('/sites/' + siteId + '/drive/root:/' + MS_CONFIG.filePath + ':/content');
    if (r.status === 404) { etag = null; setStatus('angemeldet · noch keine Cloud-Daten', 'ok'); return null; }
    if (!r.ok) throw new Error('Laden fehlgeschlagen (' + r.status + ')');
    etag = r.headers.get('ETag') || r.headers.get('etag');
    const data = await r.json();
    if (applyFn) applyFn(data);
    setStatus('geladen ' + hhmm(), 'ok');
    return data;
  }

  async function push(snap) {
    await resolveSite();
    const headers = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    const r = await graph('/sites/' + siteId + '/drive/root:/' + MS_CONFIG.filePath + ':/content',
      { method: 'PUT', headers, body: JSON.stringify(snap) });
    if (r.status === 412) { setStatus('⚠ Konflikt – bitte „↻ Laden"', 'warn'); return; }
    if (!r.ok) throw new Error('Speichern fehlgeschlagen (' + r.status + ')');
    const j = await r.json().catch(() => ({}));
    etag = j.eTag || j.cTag || etag;
    setStatus('gespeichert ' + hhmm(), 'ok');
  }

  return {
    isReady() { return !!msalAccount; },
    inPopup() { return IN_POPUP; },
    account() { return msalAccount && (msalAccount.username || msalAccount.name); },
    onApply(fn) { applyFn = fn; },
    onStatus(fn) { statusFn = fn; },

    async init() {
      try { await msalInit(); }
      catch (e) { console.warn('Cloud/MSAL init:', e); setStatus('offline (lokal)', 'off'); return false; }
      if (msalAccount) {
        setStatus('angemeldet: ' + (msalAccount.username || ''), 'ok');
        try { await pull(); } catch (e) { setStatus('Fehler: ' + e.message, 'warn'); }
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
      if (msalApp && msalAccount) { try { await msalApp.logoutPopup({ account: msalAccount }); } catch (e) {} }
      msalAccount = null; siteId = null; etag = null;
      setStatus('abgemeldet', 'off');
    },
    async reload() {
      if (!msalAccount) return;
      try { await pull(); } catch (e) { setStatus('Fehler: ' + e.message, 'warn'); }
    },
    scheduleSave(snap) {
      if (!msalAccount) return;               // ohne Login nur lokal speichern
      pendingSnap = snap;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try { setStatus('speichere…', 'sync'); await push(pendingSnap); }
        catch (e) { setStatus('Speicher-Fehler: ' + e.message, 'warn'); }
      }, 1500);
    },
  };
})();
