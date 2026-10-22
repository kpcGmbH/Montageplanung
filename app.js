// Montageplanung – Zeitplan + Ressourcen-/Auslastungsplanung
(function () {
  const MS_DAY = 86400000;
  const MONTHS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
  const STORAGE_KEY = 'montageplanung_v10';

  const parse = (s) => { const [y,m,d] = s.split('-').map(Number); return Date.UTC(y, m-1, d); };
  const addDays = (ms, n) => ms + n * MS_DAY;
  const dayIndex = (ms, startMs) => Math.round((ms - startMs) / MS_DAY);
  const pad = (n) => String(n).padStart(2, '0');
  const isoStr = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`; };
  const fmt = (ms) => { const d = new Date(ms); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth()+1)}.${d.getUTCFullYear()}`; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  // Heutiges Datum (lokaler Kalendertag) als UTC-Mitternacht-ms – die „Heute"-Linie läuft mit.
  const todayMs = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };

  function isoWeek(ms) {
    const d = new Date(ms);
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const fdNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - fdNum + 3);
    return 1 + Math.round((d - firstThursday) / (7 * MS_DAY));
  }

  const startMs = parse(PLAN.rangeStart);
  const endMs = Math.max(parse(PLAN.rangeEnd), addDays(todayMs(), 548));   // Zeitraum wächst mit (sonst Einsätze ab Ende auf den letzten Tag gequetscht)
  const totalDays = dayIndex(endMs, startMs) + 1;
  const internCount = () => PLAN.team.filter(m => m.type === 'intern').length;
  const externCount = () => PLAN.team.filter(m => m.type === 'extern').length;

  let dayWidth = 18;
  let filter = '';
  let viewMode = 'timeline';
  const hiddenCats = new Set();
  const collapsedSites = new Set();
  let lanesCollapsed = true;   // Monteur-Zeilen unter den Fenstern standardmäßig eingeklappt (Gesamtüberblick)
  const collapsedGroups = new Set(['Ressourcen / Monteure', 'Bauleiter']);   // Gruppen standardmäßig eingeklappt
  let scrollTodayPending = true;   // erster Zeitplan-Aufbau springt auf die aktuelle Woche
  let showArchived = false;        // archivierte Projekte im Zeitplan mitanzeigen?
  let assignments = {}; // Wochen-Einsatzplan: 'personId|YYYY-MM-DD' -> { text, type }

  // ---- Persistenz (Gruppen/Zeilen + Monteure-Team) ----
  function snapshot() {
    const groups = PLAN.groups.map(g => ({ name: g.name, rows: g.rows.map(r => ({ id: r.id, label: r.label, site: r.site, nummer: r.nummer, ort: r.ort, name: r.name, strasse: r.strasse, plz: r.plz, ti: r.ti, archived: r.archived, capRole: r.capRole, bars: r.bars })) }));
    return { groups, team: PLAN.team, assignments, vehicles: (PLAN.vehicles || []), cars: (PLAN.cars || {}), nights: (PLAN.nights || {}), changelog: (PLAN.changelog || []) };
  }
  function applySnapshot(data) {
    if (data && Array.isArray(data.groups) && data.groups.length) PLAN.groups = data.groups;
    if (data && Array.isArray(data.team) && data.team.length) PLAN.team = data.team;
    if (data && data.assignments) assignments = data.assignments;
    // Fuhrpark (Katalog) + Fahrzeug je Person/Tag; fehlt der Katalog im Stand, bleibt der aus data.js
    if (data && Array.isArray(data.vehicles) && data.vehicles.length) PLAN.vehicles = data.vehicles;
    for (const v of (PLAN.vehicles || [])) if (v.id === 'kp190' && +v.seats === 2) v.seats = 3;   // Korrektur: KP-170 hat 3 Sitze
    for (const v of (PLAN.vehicles || [])) if (v.name === 'KP-190') v.name = 'KP-170';   // Korrektur: das Fahrzeug heißt KP-170 (ID bleibt, damit Zuordnungen gelten)
    if (data && data.cars && typeof data.cars === 'object') PLAN.cars = data.cars; else PLAN.cars = PLAN.cars || {};
    if (data && data.nights && typeof data.nights === 'object') PLAN.nights = data.nights; else PLAN.nights = PLAN.nights || {};
    // Changelog (Änderungsverlauf) – geteilt über den 3-Wege-Merge (Array-Vereinigung über id)
    if (data && Array.isArray(data.changelog)) PLAN.changelog = data.changelog;
    else PLAN.changelog = PLAN.changelog || [];
  }
  function saveLocal() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); } catch (e) {} }
  // ---- Undo/Redo: Verlauf lokaler Änderungen ----
  // Jeder Eintrag hält den Stand VOR und NACH einer eigenen Änderung ({before, after}, beides JSON).
  // Rückgängig setzt NICHT den alten Gesamtstand wieder ein, sondern nimmt genau diese eine Änderung aus dem
  // AKTUELLEN Stand heraus (3-Wege-Merge, histStep). Vorher wurde der Snapshot von vor der Änderung komplett
  // zurückgespielt – und der stammte vom letzten EIGENEN Speichern. Alles, was Kolleg:innen seitdem eingetragen
  // hatten (per Live-Sync längst sichtbar), verschwand dabei wortlos, auch in der Cloud (gemeldet 09.10.2026:
  // „frei" bei zwei Monteuren weg, im Verlauf stand nur „Änderung rückgängig gemacht").
  const undoStack = [], redoStack = [], MAX_HIST = 80;
  let histPrev = null, suppressHistory = false, batchDepth = 0;
  let kdData = [];   // Kundendienst-Verträge (eigene Datei, nur für freigegebene Logins)
  function updateUndoUI() {
    const u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
  }
  function histReset() { histPrev = JSON.stringify(snapshot()); undoStack.length = 0; redoStack.length = 0; updateUndoUI(); }
  // Nach einem Hintergrund-Merge aus der Cloud: Vergleichsstand nachziehen. Sonst gilt beim nächsten eigenen
  // Speichern alles, was andere inzwischen geändert haben, als Teil der eigenen Änderung.
  function histSync() { histPrev = JSON.stringify(snapshot()); }
  // Eine Änderung (von → nach) auf den aktuellen Stand anwenden, ohne Fremdes anzufassen.
  function histStep(vonJson, nachJson) {
    const cur = JSON.parse(JSON.stringify(snapshot()));
    const m3 = window.Cloud && Cloud.merge3;
    // true = im Konflikt gewinnt der aktuelle Stand: hat jemand anderes dieselbe Stelle inzwischen geändert,
    // bleibt dessen Eintrag stehen und nur der Rest der eigenen Aktion wird zurückgenommen.
    return m3 ? m3(JSON.parse(vonJson), JSON.parse(nachJson), cur, true) : JSON.parse(nachJson);
  }
  function applyHistState(state) {
    const keepLog = PLAN.changelog;        // Änderungsverlauf ist append-only – nicht mit zurückrollen
    applySnapshot(state);
    PLAN.changelog = keepLog;
    histSync();
    suppressHistory = true; saveLocal(); if (window.Cloud) Cloud.scheduleSave(snapshot()); suppressHistory = false;
    buildLegend(); render(); updateUndoUI();
  }
  function undo() { if (!undoStack.length) return; logChange('Änderung rückgängig gemacht'); const e = undoStack.pop(); redoStack.push(e); applyHistState(histStep(e.after, e.before)); }
  function redo() { if (!redoStack.length) return; logChange('Änderung wiederholt'); const e = redoStack.pop(); undoStack.push(e); applyHistState(histStep(e.before, e.after)); }
  // Ein Montagefenster umfasst immer alle seine Einsätze – sonst wären sie im Zeitplan unsichtbar, während die
  // Woche sie trotzdem zeigt. fitBar erweitert das Fenster auf Phasen + Bauleitung (nie kürzen). true = angepasst.
  function fitBar(bar) {
    const lo = (a, b) => (parse(b) < parse(a) ? b : a), hi = (a, b) => (parse(b) > parse(a) ? b : a);
    let bs = bar.start, be = bar.end;
    for (const ph of (bar.phases || [])) if (ph.start && ph.end) { bs = lo(bs, ph.start); be = hi(be, ph.end); }
    for (const a of (bar.bl || [])) if (a && typeof a !== 'string' && a.start && a.end) { bs = lo(bs, a.start); be = hi(be, a.end); }
    if (bs === bar.start && be === bar.end) return false;
    bar.start = bs; bar.end = be;
    return true;
  }
  // Taggenaue Zuordnungen außerhalb ihrer Phase (z. B. nach dem Kürzen eines Fensters oder Ziehen in der Woche):
  // direkt angrenzend → Phase verlängern; mit Lücke → eigenes Montagefenster, damit kein Bedarf in der Lücke entsteht.
  function splitStray(row, bar) {
    const day = (iso, n) => isoStr(addDays(parse(iso), n));
    const made = [];
    for (const ph of (bar.phases || [])) {
      if (!ph.start) continue;
      if (!ph.end) ph.end = ph.start;
      const S = parse(ph.start), E = parse(ph.end), keep = [], before = [], after = [];
      for (const a of (ph.assigned || [])) {
        if (!a || typeof a === 'string' || !a.start || !a.end) { keep.push(a); continue; }
        const rs = parse(a.start), re = parse(a.end);
        if (rs >= S && re <= E) { keep.push(a); continue; }
        if (re >= S && rs <= E) keep.push({ id: a.id, start: rs < S ? ph.start : a.start, end: re > E ? ph.end : a.end });
        if (rs < S) before.push({ id: a.id, start: a.start, end: re < S ? a.end : day(ph.start, -1) });
        if (re > E) after.push({ id: a.id, start: rs > E ? a.start : day(ph.end, 1), end: a.end });
      }
      if (!before.length && !after.length) continue;
      const workBetween = (fromISO, toISO) => { let n = 0; for (let ms = parse(fromISO); ms <= parse(toISO); ms = addDays(ms, 1)) if (ph.weekend || isWorkdayMs(ms)) n++; return n; };
      const handle = (segs, isAfter) => {
        if (!segs.length) return;
        const gs = segs.map(x => x.start).sort()[0], ge = segs.map(x => x.end).sort().pop();
        const gap = isAfter ? workBetween(day(ph.end, 1), day(gs, -1)) : workBetween(day(ge, 1), day(ph.start, -1));
        if (!gap) { if (isAfter) ph.end = ge; else ph.start = gs; keep.push(...segs); return; }   // angrenzend → verlängern
        const nb = { label: bar.label || '', cat: bar.cat, start: gs, end: ge,
          phases: [{ trade: ph.trade, start: gs, end: ge, days: daysCount(gs, ge, !!ph.weekend), weekend: !!ph.weekend, count: new Set(segs.map(x => x.id)).size, assigned: segs }] };
        if (ph.overnight) nb.phases[0].overnight = true;
        for (const k of ['strasse', 'plz', 'ort', 'ti', 'hotel']) if (bar[k]) nb[k] = bar[k];
        made.push(nb);
      };
      handle(before, false); handle(after, true);
      ph.assigned = keep;
      ph.days = isHalf(ph) && Math.ceil(+ph.days) === daysCount(ph.start, ph.end, !!ph.weekend) ? ph.days : daysCount(ph.start, ph.end, !!ph.weekend);
    }
    for (const nb of made) row.bars.push(nb);
  }
  function fitWindows() {
    const g = PLAN.groups.find(x => x.name === 'Projekte'); if (!g) return;
    for (const row of g.rows) for (const bar of (row.bars || []).slice()) if (bar.start && bar.end) { splitStray(row, bar); fitBar(bar); }
  }
  // Mehrteilige Aktionen (z. B. Zelle speichern = entfernen + neu zuordnen + Notiz) als EIN Speichern
  // und EIN Rückgängig-Schritt; Zwischenschritte räumen nichts auf (kein Löschen gerade geleerter Fenster).
  function historyBatch(fn) {
    batchDepth++;
    try { fn(); } finally { batchDepth--; save(); }
  }
  function save() {
    if (batchDepth > 0) return;
    if ((PLAN.changelog || []).length > 500) { PLAN.changelog.sort((a, b) => a.ts - b.ts); PLAN.changelog.splice(0, PLAN.changelog.length - 500); }
    pruneEmptyWeekBars();   // leere Woche-Fragmente entfernen
    fitWindows();           // kein Einsatz außerhalb seines Fensters
    ensureIds();   // neue Balken/Phasen bekommen stabile IDs vor dem Sync (fürs Zusammenführen)
    saveLocal();
    const snap = snapshot(), json = JSON.stringify(snap);
    if (json !== histPrev) {
      if (!suppressHistory && histPrev !== null) { undoStack.push({ before: histPrev, after: json }); if (undoStack.length > MAX_HIST) undoStack.shift(); redoStack.length = 0; }
      histPrev = json;
    }
    if (window.Cloud) Cloud.scheduleSave(snap);
    updateUndoUI();
  }
  function load() {
    let raw; try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return; }
    if (!raw) return;
    try { applySnapshot(JSON.parse(raw)); } catch (e) {}
  }

  // ---- Änderungsverlauf (wer / was / wann) ----
  // Geteilt über den Plan (Cloud-Merge vereinigt die Einträge). Nur bewusste Planungsaktionen werden
  // protokolliert – nicht jedes Zwischenspeichern (z. B. Tippen im Monteur-Dialog).
  PLAN.changelog = PLAN.changelog || [];
  let logPanelOpen = false, logFilter = 'alle';
  function currentUser() {
    try { const a = window.Cloud && Cloud.account && Cloud.account(); if (a) return a; } catch (e) {}
    return 'lokal';
  }
  function logChange(text, view) {
    if (!text) return;
    PLAN.changelog = PLAN.changelog || [];
    PLAN.changelog.push({
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      ts: Date.now(),
      user: currentUser(),
      view: view || (viewMode === 'week' ? 'woche' : viewMode === 'service' ? 'kundendienst' : 'zeitplan'),
      text: String(text),
    });
    if (PLAN.changelog.length > 500) PLAN.changelog.splice(0, PLAN.changelog.length - 500);
    if (logPanelOpen) renderChangelog();
  }
  const wdLocal = (ts) => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(ts).getDay()];
  const p2 = (n) => ('0' + n).slice(-2);
  const hhmmTs = (ts) => { const d = new Date(ts); return p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  const dayTs = (ts) => { const d = new Date(ts); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear(); };
  const shortUser = (u) => { if (!u) return 'lokal'; const s = String(u); const i = s.indexOf('@'); return i > 0 ? s.slice(0, i) : s; };
  function renderChangelog() {
    const list = document.getElementById('hist-list'); if (!list) return;
    const all = (PLAN.changelog || []).slice().sort((a, b) => b.ts - a.ts);
    const items = all.filter(e => logFilter === 'alle' || e.view === logFilter);
    const cnt = document.getElementById('hist-count');
    if (cnt) cnt.textContent = items.length + ' Einträge' + (all.length !== items.length ? ' von ' + all.length : '');
    list.innerHTML = '';
    if (!items.length) { list.appendChild(el('div', 'hist-empty', 'Noch keine Änderungen protokolliert.')); return; }
    let lastDay = '';
    for (const e of items) {
      const day = dayTs(e.ts);
      if (day !== lastDay) { lastDay = day; list.appendChild(el('div', 'hist-day', wdLocal(e.ts) + ' · ' + day)); }
      const rowEl = el('div', 'hist-row');
      rowEl.appendChild(el('span', 'hist-time', hhmmTs(e.ts)));
      rowEl.appendChild(el('span', 'hist-badge hb-' + (e.view || 'zeitplan'), e.view === 'woche' ? 'Woche' : e.view === 'kundendienst' ? 'Kundendienst' : 'Zeitplan'));
      const usr = el('span', 'hist-user', shortUser(e.user)); usr.title = e.user || '';
      rowEl.appendChild(usr);
      rowEl.appendChild(el('span', 'hist-text', e.text));
      list.appendChild(rowEl);
    }
  }
  function openChangelog() { logPanelOpen = true; renderChangelog(); document.getElementById('hoverlay').hidden = false; }
  function closeChangelog() { logPanelOpen = false; document.getElementById('hoverlay').hidden = true; }

  // ---- Kopieren / Einfügen (Woche-Zelle, Person-Woche, Montagefenster) ----
  let clip = null;   // { kind:'cell'|'personweek'|'bar', ... }
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---- Tagesraster ----
  const days = [];
  for (let i = 0; i < totalDays; i++) {
    const ms = addDays(startMs, i);
    const d = new Date(ms);
    days.push({ i, ms, dow: d.getUTCDay(), dom: d.getUTCDate(), month: d.getUTCMonth(),
                year: d.getUTCFullYear(), week: isoWeek(ms), work: d.getUTCDay() >= 1 && d.getUTCDay() <= 5 });
  }
  function groupRuns(keyFn) {
    const runs = [];
    for (const day of days) {
      const k = keyFn(day);
      const last = runs[runs.length - 1];
      if (last && last.key === k) { last.count++; last.daysList.push(day); }
      else runs.push({ key: k, count: 1, day, daysList: [day] });
    }
    return runs;
  }
  const weekRuns = groupRuns(d => `${d.year}-${d.week}`);

  // ---- Standard-Personalbedarf für Termine ohne Angabe (Startwerte, editierbar) ----
  function workingDaysIn(x0, x1) { let n = 0; for (let i = x0; i <= x1; i++) if (days[i].work) n++; return n; }
  // ---- Montagetage / Wochenend-Logik ----
  // Ein Einsatz wird über Startdatum + Anzahl Montagetage definiert (Grundlage: Einsatzplanung).
  // In der Regel Mo–Fr; bei weekend=true zählen auch Sa/So als Arbeitstag (Sonderfall).
  const isWorkdayMs = (ms) => { const w = new Date(ms).getUTCDay(); return w >= 1 && w <= 5; };
  // Nächster Werktag ab dem Datum (inkl. des Datums selbst).
  function snapWorkday(iso) { let ms = parse(iso); while (!isWorkdayMs(ms)) ms = addDays(ms, 1); return isoStr(ms); }
  // Enddatum = Datum des n-ten Montagetags ab Start (Start zählt als Tag 1, falls Arbeitstag).
  // Halbe Tage sind erlaubt (0,5 / 1,5 …): der letzte Tag ist dann nur ein halber, belegt aber seinen Kalendertag.
  const halfDays = (v) => Math.max(0.5, Math.round((+v || 1) * 2) / 2);
  const isHalf = (ph) => !!ph && (+ph.days % 1) !== 0;
  function endFromDays(startISO, nDays, weekend) {
    nDays = Math.max(1, Math.ceil(+nDays || 1));
    let ms = parse(startISO), count = 0;
    for (;;) {
      if (weekend || isWorkdayMs(ms)) { count++; if (count >= nDays) return isoStr(ms); }
      ms = addDays(ms, 1);
    }
  }
  // Anzahl Montagetage im Bereich [start..end] (für Migration bestehender Phasen).
  function daysCount(startISO, endISO, weekend) {
    let ms = parse(startISO); const e = parse(endISO); let n = 0;
    while (ms <= e) { if (weekend || isWorkdayMs(ms)) n++; ms = addDays(ms, 1); }
    return Math.max(1, n);
  }
  const WD_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const wdShort = (iso) => WD_SHORT[new Date(parse(iso)).getUTCDay()];
  // Setzt days/weekend auf einer Phase (falls fehlend) und hält end konsistent zu start+days.
  function normalizePhase(ph) {
    if (typeof ph.weekend !== 'boolean') ph.weekend = false;
    if (!(+ph.days > 0)) ph.days = daysCount(ph.start, ph.end || ph.start, ph.weekend);
    if (!ph.weekend) ph.start = snapWorkday(ph.start);
    ph.end = endFromDays(ph.start, ph.days, ph.weekend);
    return ph;
  }
  function seedCrew() {
    // KEIN automatischer Personalbedarf mehr: Ein Fenster ohne gewählte Phase bleibt ohne Personen.
    // Alt-Daten: jeden Auto-/Alt-Bedarf OHNE zugeordnete Monteure entfernen (auch mit Gewerk),
    // damit an leeren Terminen nicht länger „2 Personen" auftauchen. Bedarfe MIT zugeordneten
    // Monteuren (echte Alt-Zuordnungen) bleiben unangetastet.
    for (const g of PLAN.groups) {
      if (g.name !== 'Projekte') continue;
      for (const row of g.rows) for (const bar of (row.bars || [])) {
        if (bar.crew && !((bar.crew.assigned || []).length)) delete bar.crew;
      }
    }
  }
  // Stabile IDs für Balken (bid) und Phasen (pid) – Voraussetzung fürs zuverlässige Zusammenführen (3-Wege-Merge).
  // Backfill deterministisch (rowId + Position + Datum), damit alle Clients einem Alt-Balken dieselbe ID geben.
  function ensureIds() {
    // Eindeutig innerhalb der Liste: fällt die deterministische ID mit einer vorhandenen zusammen, Zusatz anhängen
    const uniq = (id, taken) => { let x = id, n = 1; while (taken.has(x)) x = id + '~d' + (n++); taken.add(x); return x; };   // deterministisch: alle Clients vergeben dieselbe ID
    const fix = (bars, prefix, withPhases) => {
      const taken = new Set();
      (bars || []).forEach((bar, bi) => {
        if (!bar.bid || taken.has(bar.bid)) bar.bid = uniq(prefix + '~' + (bar.start || '') + '~' + (bar.end || '') + '~' + bi, taken); else taken.add(bar.bid);
        if (!withPhases) return;
        const pt = new Set();
        (bar.phases || []).forEach((ph, pi) => {
          if (!ph.pid || pt.has(ph.pid)) ph.pid = uniq(bar.bid + '~p' + pi + '~' + (ph.trade || ''), pt); else pt.add(ph.pid);
          normalizePhase(ph);   // Altdaten: days/weekend nachziehen, end konsistent zu start+days
        });
      });
    };
    for (const g of PLAN.groups) for (const row of g.rows) fix(row.bars, 'b~' + row.id, g.name === 'Projekte');
    for (const m of (PLAN.team || [])) fix(m.bars, 't~' + m.id, false);   // Urlaub/Buchungen: sonst kein Schlüssel fürs Zusammenführen
  }

  // Einmalige Migration: die alten Sammelzeilen (Monteure Urlaub / Urlaub / ext. Monteure …)
  // auf die jeweiligen Monteure der Liste verteilen. Verlustfrei: nicht zuordenbare
  // Urlaube landen in einer Zeile „Urlaub (nicht zugeordnet)". Läuft nur, solange es noch
  // Sammelzeilen gibt (danach automatisch inaktiv).
  function migrateTeamResources() {
    const g = PLAN.groups.find(x => x.name === 'Ressourcen / Monteure');
    if (!g) return;
    const keep = /steinacker|schulung|nicht zugeordnet/i;
    const isLegacy = (r) => /^r\d+$/.test(r.id || '');   // nur alte Import-Zeilen; selbst angelegte (res…) bleiben unangetastet
    const generic = g.rows.filter(r => isLegacy(r) && !keep.test(r.label || ''));
    if (!generic.length) return;
    const strip = (b, extern) => Object.assign({ start: b.start, end: b.end, label: b.label || '', cat: extern ? 'booking' : 'vacation' }, b.size ? { size: b.size } : {});
    const matchMember = (lbl) => {
      const t = (lbl || '').toLowerCase(); if (!t) return null;
      for (const m of PLAN.team) { const f = (m.name || '').split(/[\s/]/)[0].toLowerCase(); if (f && t.includes(f)) return m; }
      return null;
    };
    const leftover = [];
    for (const row of generic) for (const bar of (row.bars || [])) {
      const m = matchMember(bar.label);
      if (m) { (m.bars = m.bars || []).push(strip(bar, m.type === 'extern')); }
      else leftover.push(strip(bar, false));
    }
    g.rows = g.rows.filter(r => !(isLegacy(r) && !keep.test(r.label || '')));
    if (leftover.length) g.rows.push({ id: 'res-leftover', label: 'Urlaub (nicht zugeordnet)', capRole: 'monteur', bars: leftover });
  }

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  // ---- Kapazität / Auslastung berechnen ----
  // Kapazität pro Tag = interne Monteure − Urlaub + gebuchte externe Trupps (an Arbeitstagen).
  // Bedarf = feste Arbeitstage je Termin, per Heuristik optimal im Vertragsfenster verteilt
  // (Resource Leveling: Tage dorthin legen, wo am meisten Kapazität frei ist).
  function computeCapacity() {
    const cap = new Array(totalDays).fill(0);
    const demand = new Array(totalDays).fill(0);
    const infeasible = new Set();

    const intern = internCount();
    for (let i = 0; i < totalDays; i++) cap[i] = days[i].work ? intern : 0;

    // Verfügbarkeit je Monteur aus der Liste: interner Urlaub −1, externe Buchung +Truppstärke
    for (const m of PLAN.team) {
      const extern = m.type === 'extern';
      const def = +m.size || 1; // Standard-Truppstärke des externen Monteurs
      for (const bar of (m.bars || [])) {
        const x0 = clamp(dayIndex(parse(bar.start), startMs), 0, totalDays-1);
        const x1 = clamp(dayIndex(parse(bar.end), startMs), 0, totalDays-1);
        const delta = extern ? (+bar.size || def) : -1;
        for (let i = x0; i <= x1; i++) if (days[i].work) cap[i] = Math.max(0, cap[i] + delta);
      }
    }

    // Zusätzliche Datenzeilen mit Kapazitäts-Rolle: 'monteur' = Urlaub (−1), 'extern' = Buchung (+1).
    // 'none' (z. B. Bauleiter-Urlaub, Schulungen) bleibt ohne Wirkung.
    for (const g of PLAN.groups) for (const r of g.rows) {
      if (r.capRole !== 'monteur' && r.capRole !== 'extern') continue;
      const delta = r.capRole === 'extern' ? +1 : -1;
      for (const bar of r.bars) {
        if (bar.cat !== 'vacation' && bar.cat !== 'booking') continue;
        const x0 = clamp(dayIndex(parse(bar.start), startMs), 0, totalDays-1);
        const x1 = clamp(dayIndex(parse(bar.end), startMs), 0, totalDays-1);
        for (let i = x0; i <= x1; i++) if (days[i].work) cap[i] = Math.max(0, cap[i] + delta);
      }
    }

    // Jobs sammeln (Projekt-Termine mit Personalbedarf)
    const jobs = [];
    for (const g of PLAN.groups) {
      if (g.name !== 'Projekte') continue;
      for (const r of g.rows) { if (r.archived) continue; for (const bar of r.bars) {
        if (bar.cat === 'vacation' || bar.cat === 'subcontractor' || bar.cat === 'bauleitung') continue;
        if (bar.phases && bar.phases.length) {
          // Gewerk-Phasen: jede Phase belegt ihre eigenen Arbeitstage mit ihrer Personenzahl (feste Lage)
          for (const ph of bar.phases) {
            const count = +ph.count || 0; if (count <= 0) continue;
            const x0 = clamp(dayIndex(parse(ph.start), startMs), 0, totalDays-1);
            const x1 = clamp(dayIndex(parse(ph.end), startMs), 0, totalDays-1);
            const slots = []; for (let i = x0; i <= x1; i++) if (days[i].work || ph.weekend) slots.push(i);
            if (!slots.length) continue;
            jobs.push({ bar, count, need: slots.length, slots, slack: 0, x0 });
          }
          continue;
        }
        if (!bar.crew) continue;
        const count = +bar.crew.count || 0;
        if (count <= 0) continue;
        const cs = bar.crew.start || bar.start, ce = bar.crew.end || bar.end;
        const x0 = clamp(dayIndex(parse(cs), startMs), 0, totalDays-1);
        const x1 = clamp(dayIndex(parse(ce), startMs), 0, totalDays-1);
        const slots = []; for (let i = x0; i <= x1; i++) if (days[i].work) slots.push(i);
        if (!slots.length) continue;
        let need;
        if (bar.crew.start) { need = slots.length; }  // konkreter Einsatz-Zeitraum (feste Lage)
        else { need = Math.min(+bar.crew.days || slots.length, slots.length); if (slots.length < (+bar.crew.days || 0)) infeasible.add(bar); } // Legacy: Arbeitstage im Fenster
        jobs.push({ bar, count, need, slots, slack: slots.length - need, x0 });
      } }
    }
    // Engste Fenster zuerst verteilen
    jobs.sort((a, z) => (a.slack - z.slack) || (a.x0 - z.x0));
    for (const job of jobs) {
      const ranked = job.slots.slice().sort((i, j) => (demand[i] - demand[j]) || (i - j));
      const chosen = ranked.slice(0, job.need);
      for (const i of chosen) demand[i] += job.count;
    }
    return { demand, cap, infeasible };
  }

  // ---- Engpass: konkret zugeordnete Monteure mit überlappenden Einsätzen (je Phase) ----
  function computeConflicts() {
    // Je Monteur und Arbeitstag: welche Fenster ihn belegen (halber letzter Tag = 0,5). Doppelt verplant ist,
    // wer an einem Tag in mindestens zwei Fenstern zusammen ≥ 2 belegt ist (halber Tag + ganzer Tag ist erlaubt).
    const load = {};
    const add = (id, s, e, bar, weekend, halfEnd) => {
      if (!s || !e) return;
      for (let ms = parse(s); ms <= parse(e); ms = addDays(ms, 1)) {
        if (!weekend && !isWorkdayMs(ms)) continue;
        const w = (halfEnd && isoStr(ms) === halfEnd) ? 0.5 : 1;
        const day = ((load[id] = load[id] || {})[ms] = load[id][ms] || new Map());
        day.set(bar, Math.max(day.get(bar) || 0, w));
      }
    };
    for (const g of PLAN.groups) for (const r of g.rows) {
      if (r.archived) continue;
      for (const bar of r.bars) {
        if (bar.phases && bar.phases.length) {
          for (const ph of bar.phases) for (const rg of assignedRanges(ph)) add(rg.id, rg.start, rg.end, bar, !!ph.weekend, isHalf(ph) ? ph.end : null);
        } else if (bar.crew) {
          for (const id of (bar.crew.assigned || [])) add(id, bar.crew.start || bar.start, bar.crew.end || bar.end, bar, false, null);
        }
      }
    }
    const conflict = new Set();
    for (const id in load) for (const ms in load[id]) {
      const day = load[id][ms];
      if (day.size < 2) continue;
      let sum = 0; for (const w of day.values()) sum += w;
      if (sum >= 2) for (const bar of day.keys()) conflict.add(bar);
    }
    return conflict;
  }

  // ---- Header (Zeitskala) ----
  function buildHeader() {
    const header = el('div', 'header');
    header.appendChild(el('div', 'corner', 'KW · Monat · Tag'));
    const scale = el('div', 'timescale');
    scale.style.width = (totalDays * dayWidth) + 'px';

    const months = el('div', 'tier months');
    for (const run of groupRuns(d => `${d.year}-${d.month}`)) {
      const c = el('div', 'cell', `${MONTHS[run.day.month]} ${run.day.year}`);
      c.style.width = (run.count * dayWidth) + 'px';
      months.appendChild(c);
    }
    const weeks = el('div', 'tier weeks');
    for (const run of weekRuns) {
      const c = el('div', 'cell', 'KW ' + run.day.week);
      c.style.width = (run.count * dayWidth) + 'px';
      if (run.count * dayWidth < 26) c.textContent = run.day.week;
      weeks.appendChild(c);
    }
    const daysTier = el('div', 'tier days');
    for (const d of days) {
      const c = el('div', 'cell' + (d.work ? '' : ' weekend'), pad(d.dom));
      c.style.width = dayWidth + 'px';
      daysTier.appendChild(c);
    }
    scale.appendChild(months); scale.appendChild(weeks); scale.appendChild(daysTier);
    header.appendChild(scale);
    return header;
  }

  // ---- Auslastungs-Zeile ----
  function buildCapRow(capData) {
    const row = el('div', 'caprow');
    row.appendChild(el('div', 'cap-label', 'Auslastung · MT/KW'));
    const scale = el('div', 'cap-scale');
    scale.style.width = (totalDays * dayWidth) + 'px';
    for (const run of weekRuns) {
      let dem = 0, cap = 0;
      for (const d of run.daysList) { dem += capData.demand[d.i]; cap += capData.cap[d.i]; }
      const util = cap > 0 ? dem / cap : (dem > 0 ? 99 : 0);
      let cls = 'cap-idle';
      if (dem > 0 || cap > 0) cls = util > 1.0 ? 'cap-over' : util >= 0.85 ? 'cap-warn' : 'cap-ok';
      const cell = el('div', 'cap-cell ' + cls);
      cell.style.width = (run.count * dayWidth) + 'px';
      cell.textContent = (run.count * dayWidth >= 34) ? `${Math.round(dem)}/${Math.round(cap)}` : Math.round(dem) || '';
      cell.title = `KW ${run.day.week} (${run.day.year})\nBedarf: ${Math.round(dem)} Monteur-Tage\nKapazität: ${Math.round(cap)} Monteur-Tage\nAuslastung: ${cap > 0 ? Math.round(util*100) : '–'}%${util > 1 ? '  ⚠ ENGPASS' : ''}`;
      scale.appendChild(cell);
    }
    row.appendChild(scale);
    return row;
  }

  // ---- Balken ----
  function matches(row) {
    if (!filter) return true;
    return row.label.toLowerCase().includes(filter) ||
      (row.site && row.site.toLowerCase().includes(filter)) ||
      row.bars.some(b => (b.label || '').toLowerCase().includes(filter));
  }
  const bauleiterRows = () => { const g = PLAN.groups.find(x => x.name === 'Bauleiter'); return g ? g.rows : []; };
  const monteurName = (id) => {
    const m = PLAN.team.find(t => t.id === id); if (m) return m.name;
    const b = bauleiterRows().find(r => r.id === id); if (b) return b.label || 'Bauleiter';
    return id;
  };
  // Personen, die ein zugeordneter Monteur mitbringt (Truppstärke). Externe Trupps zählen mit ihrer Stärke,
  // interne Monteure als 1 Person. Grundlage der Bedarfs-Deckung ("(offen)" / fehlender Monteur).
  const personCount = (id) => { const m = PLAN.team.find(t => t.id === id); return m ? Math.max(1, +m.size || 1) : 1; };
  const sumPersons = (ids) => { let n = 0; ids.forEach(id => { n += personCount(id); }); return n; };
  const TRADES = () => PLAN.trades || {};
  // Kann der Monteur das Gewerk? Volle Sanitär-Qualifikation deckt auch kleine Sanitäranschlüsse ab.
  function qualifies(m, tradeKey) {
    if (!tradeKey) return true;
    const t = m.trades || [];
    if (t.includes(tradeKey)) return true;
    if (tradeKey === 'sanitaer_klein' && t.includes('sanitaer')) return true;
    return false;
  }
  // Phasen-Zuordnung pro Person als Bereich (unterstützt Alt-Format String-ID = ganze Phase
  // sowie neues Format {id,start,end} = taggenauer Teilbereich, für Verschieben in der Woche).
  const idOf = (a) => (typeof a === 'string' ? a : (a && a.id));
  const assignedRanges = (ph) => (ph.assigned || []).map(a => (typeof a === 'string' ? { id: a, start: ph.start, end: ph.end } : { id: a.id, start: a.start, end: a.end }));
  // Entfernt einen einzelnen Tag aus einem Bereich → 0–2 Teilbereiche
  function splitRange(id, s, e, dayISO) {
    const D = parse(dayISO), out = [];
    if (parse(s) < D) out.push({ id, start: s, end: isoStr(addDays(D, -1)) });
    if (parse(e) > D) out.push({ id, start: isoStr(addDays(D, 1)), end: e });
    return out;
  }
  // ---- Bauleitung am Montagefenster (bar.bl) – analog zu den Monteur-Phasen, aber ohne Gewerk ----
  const blRanges = (bar) => (bar.bl || []).map(a => (typeof a === 'string' ? { id: a, start: bar.start, end: bar.end } : { id: a.id, start: a.start, end: a.end }));
  function addToBl(bar, id, dayISO) {
    bar.bl = bar.bl || [];
    const D = parse(dayISO);
    if (!blRanges(bar).some(r => r.id === id && parse(r.start) <= D && parse(r.end) >= D)) bar.bl.push({ id, start: dayISO, end: dayISO });
  }
  function removeFromBl(bar, id, dayISO) {
    if (!bar.bl) return;
    const D = parse(dayISO), next = [];
    for (const a of bar.bl) {
      const r = (typeof a === 'string') ? { id: a, start: bar.start, end: bar.end } : { id: a.id, start: a.start, end: a.end };
      if (r.id !== id || parse(r.start) > D || parse(r.end) < D) { next.push(a); continue; }
      for (const seg of splitRange(r.id, r.start, r.end, dayISO)) next.push(seg);
    }
    bar.bl = next;
  }
  // Wandelt einen alten Sammelbedarf (crew) verlustfrei in eine Phase um – Voraussetzung fürs taggenaue Bearbeiten.
  function phasesOf(bar) {
    if (bar.phases && bar.phases.length) return bar.phases;
    // Nur einen Bedarf mit echtem Inhalt (Gewerk ODER zugeordnete Monteure) in eine Phase wandeln.
    // Ein leerer Auto-Bedarf (nur Zeitfenster, kein Gewerk) bleibt Bedarf – KEIN Auto-Edelstahl.
    if (bar.crew && (bar.crew.trade || (bar.crew.assigned || []).length)) {
      bar.phases = [{ trade: bar.crew.trade || 'edelstahl', start: bar.crew.start || bar.start, end: bar.crew.end || bar.end, count: +bar.crew.count || 1, assigned: (bar.crew.assigned || []).slice() }];
      delete bar.crew; return bar.phases;
    }
    return [];
  }
  // Ziel-Phase für eine Zuordnung bestimmen: vorhandene Phase mit dem Gewerk, sonst neu anlegen –
  // und einen leeren Auto-Bedarf mit GENAU DIESEM (gewählten) Gewerk materialisieren (kein Auto-Edelstahl).
  function getOrCreatePhase(bar, tradeKey) {
    tradeKey = tradeKey || 'edelstahl';
    if (!(bar.phases && bar.phases.length) && bar.crew) {
      bar.phases = [{ trade: tradeKey, start: bar.crew.start || bar.start, end: bar.crew.end || bar.end, days: daysCount(bar.crew.start || bar.start, bar.crew.end || bar.end, false), weekend: false, count: +bar.crew.count || 1, assigned: (bar.crew.assigned || []).slice() }];
      delete bar.crew; return bar.phases[0];
    }
    bar.phases = bar.phases || [];
    let ph = bar.phases.find(p => (p.trade || 'edelstahl') === tradeKey);
    if (!ph) { ph = { trade: tradeKey, start: bar.start, end: bar.end, days: daysCount(bar.start, bar.end, false), weekend: false, count: 1, assigned: [] }; bar.phases.push(ph); }
    return ph;
  }
  // Entfernt Person an genau EINEM Tag aus einer Phase (splittet den Bereich bei Bedarf).
  function removeFromPhase(ph, id, dayISO) {
    const D = parse(dayISO), next = [];
    for (const a of (ph.assigned || [])) {
      const r = (typeof a === 'string') ? { id: a, start: ph.start, end: ph.end } : { id: a.id, start: a.start, end: a.end };
      if (r.id !== id || parse(r.start) > D || parse(r.end) < D) { next.push(a); continue; }
      for (const seg of splitRange(r.id, r.start, r.end, dayISO)) next.push(seg);
    }
    ph.assigned = next;
  }
  // Fügt Person an genau EINEM Tag zu einer Phase hinzu (als taggenauer Bereich).
  function addToPhase(ph, id, dayISO) {
    ph.assigned = ph.assigned || [];
    const D = parse(dayISO);
    const covered = assignedRanges(ph).some(r => r.id === id && parse(r.start) <= D && parse(r.end) >= D);
    if (!covered) ph.assigned.push({ id, start: dayISO, end: dayISO });
    // count (geplante Truppstärke) bleibt unverändert – ein Tages-Handoff erhöht den Bedarf nicht
  }
  // Gelöschte Monteure/Bauleiter überall austragen – sonst zählen sie weiter als Besetzung und tauchen als ID auf
  function purgePerson(id) {
    let n = 0;
    for (const g of PLAN.groups) for (const r of g.rows) for (const bar of (r.bars || [])) {
      for (const ph of (bar.phases || [])) { const before = (ph.assigned || []).length; ph.assigned = (ph.assigned || []).filter(a => idOf(a) !== id); n += before - ph.assigned.length; }
      if (bar.bl) { const before = bar.bl.length; bar.bl = bar.bl.filter(a => idOf(a) !== id); n += before - bar.bl.length; if (!bar.bl.length) delete bar.bl; }
      if (bar.crew && bar.crew.assigned) bar.crew.assigned = bar.crew.assigned.filter(a => idOf(a) !== id);
    }
    const pre = id + '|';
    for (const k of Object.keys(assignments)) if (k.startsWith(pre)) delete assignments[k];
    for (const k of Object.keys(PLAN.cars || {})) if (k.startsWith(pre)) delete PLAN.cars[k];
    for (const k of Object.keys(PLAN.nights || {})) if (k.startsWith(pre)) delete PLAN.nights[k];
    let kdChanged = false;
    for (const sv of kdData) for (const t of (sv.termine || [])) if ((t.wer || []).includes(id)) { t.wer = t.wer.filter(x => x !== id); kdChanged = true; }
    if (kdChanged) kdSave();
    return n;
  }
  const projRows = () => { const g = PLAN.groups.find(x => x.name === 'Projekte'); return g ? g.rows.filter(r => !r.archived) : []; };
  // Verschiebt einen Tages-Einsatz von (fromId, fromDate) auf (toId, toDate) und schreibt es in den Zeitplan zurück.
  const rowLabels = (ids) => (ids || []).map(id => { const r = projRows().find(x => x.id === id); return r ? (r.site || r.label) : '?'; });
  function weekReassign(fromId, fromDate, toId, toDate, projectIds) {
    if (fromId === toId && fromDate === toDate) return;
    const names = rowLabels(projectIds), D = parse(fromDate);
    for (const row of projRows()) {
      if ((projectIds || []).indexOf(row.id) < 0) continue;
      for (const bar of row.bars) for (const ph of phasesOf(bar)) {
        const here = assignedRanges(ph).some(r => r.id === fromId && parse(r.start) <= D && parse(r.end) >= D);
        if (!here) continue;
        removeFromPhase(ph, fromId, fromDate);
        addToPhase(ph, toId, toDate);
      }
    }
    const proj = (names && names.length) ? names.join(', ') : 'Einsatz';
    if (fromId === toId) logChange(`${proj}: ${monteurName(fromId)} von ${fmt(parse(fromDate))} auf ${fmt(parse(toDate))} verschoben`, 'woche');
    else logChange(`${proj}: Übergabe von ${monteurName(fromId)} an ${monteurName(toId)} am ${fmt(parse(toDate))}`, 'woche');
    save();
  }
  // Verschiebt den GANZEN Einsatz (Montagebalken + alle Phasen + Zuordnungen) um die Tagesdifferenz.
  // Grundlage für „Einsatz um einen Tag nach vorne/hinten" per Drag in der Woche → wirkt im Zeitplan.
  function weekShiftEinsatz(pid, fromDate, toDate, projectIds) {
    const delta = Math.round((parse(toDate) - parse(fromDate)) / MS_DAY);
    if (!delta) return;
    const D = parse(fromDate);
    const sh = (iso) => isoStr(addDays(parse(iso), delta));
    for (const row of projRows()) {
      if ((projectIds || []).indexOf(row.id) < 0) continue;
      const nm = row.site || row.label;
      for (const bar of row.bars) {
        const phs = phasesOf(bar);
        const hit = phs.some(ph => assignedRanges(ph).some(r => r.id === pid && parse(r.start) <= D && parse(r.end) >= D));
        if (!hit) continue;
        const before = shiftSnap(bar);
        bar.start = sh(bar.start); bar.end = sh(bar.end);
        shiftBarContent(bar, delta);
        logChange(`Ganzer Einsatz „${bar.label || nm}" (${nm}) verschoben – gezogen bei ${monteurName(pid)} · ${describeShift(bar, before)}`, 'woche');
        save();
        return;   // nur den einen (getroffenen) Einsatz verschieben
      }
    }
  }
  // Entfernt Person an genau einem Tag aus den genannten Projekten (Zeilen-IDs). Leere Liste = nichts.
  function removePersonDay(pid, dayISO, projectIds) {
    if (!projectIds || !projectIds.length) return;
    for (const row of projRows()) {
      if (projectIds.indexOf(row.id) < 0) continue;
      for (const bar of row.bars) { for (const ph of phasesOf(bar)) removeFromPhase(ph, pid, dayISO); removeFromBl(bar, pid, dayISO); }
    }
    save();
  }
  function tradeTags(trades) {
    const wrap = el('span', 'trade-tags');
    for (const key of (trades || [])) {
      const t = TRADES()[key]; if (!t) continue;
      const tag = el('span', 'trade-tag', t.short); tag.style.background = t.color; tag.title = t.label;
      wrap.appendChild(tag);
    }
    return wrap;
  }

  // Effektive Kategorie (= Farbe): externe Monteur-Zeile → Buchung, interne → Urlaub, sonst die Bar-Kategorie
  function effCat(row, bar) {
    return row.capRole === 'extern' ? 'booking' : row.capRole === 'monteur' ? 'vacation' : bar.cat;
  }
  function makeBar(row, bar, flags) {
    const cat = PLAN.categories[effCat(row, bar)] || PLAN.categories.preplanning;
    const x0 = dayIndex(parse(bar.start), startMs);
    const x1 = dayIndex(parse(bar.end), startMs);
    const reasons = flags.get(bar);
    const b = el('div', 'bar' + (reasons ? ' conflict' : ''));
    b.style.left = (x0 * dayWidth) + 'px';
    b.style.width = Math.max((x1 - x0 + 1) * dayWidth - 2, dayWidth - 2) + 'px';
    b.style.background = cat.fill; b.style.borderColor = cat.border; b.style.color = cat.text;
    b.appendChild(el('span', 'lbl', bar.label || ''));
    if (bar.crew && bar.crew.count > 0) {
      const nd = bar.crew.start
        ? workingDaysIn(clamp(dayIndex(parse(bar.crew.start), startMs), 0, totalDays-1), clamp(dayIndex(parse(bar.crew.end || bar.crew.start), startMs), 0, totalDays-1))
        : (+bar.crew.days || 0);
      if (nd > 0) b.appendChild(el('span', 'badge', `${bar.crew.count}×${nd}T`));
    }
    const reqTrade = bar.crew && bar.crew.trade && TRADES()[bar.crew.trade];
    if (reqTrade) {
      const tg = el('span', 'trade-tag', reqTrade.short); tg.style.background = reqTrade.color; tg.style.marginLeft = '4px'; tg.title = 'Benötigtes Gewerk: ' + reqTrade.label;
      b.appendChild(tg);
    }
    if (row.capRole === 'extern')
      b.appendChild(el('span', 'badge', `${(+bar.size || (row._member && +row._member.size) || 1)} P`));
    // Resize-Randgriffe nur bei ausreichend breiten Balken – sonst deckten sie den ganzen Balken ab
    // und das Verschieben (Mitte greifen) wäre nicht möglich. Schmale Balken: Größe über den Editor ändern.
    const barW = Math.max((x1 - x0 + 1) * dayWidth - 2, dayWidth - 2);
    if (barW >= 28) {
      b.appendChild(el('div', 'h h-l'));
      b.appendChild(el('div', 'h h-r'));
    }
    const crewTxt = bar.crew && bar.crew.count
      ? `\nBedarf: ${bar.crew.count} Monteure · ${bar.crew.start ? fmt(parse(bar.crew.start)) + '–' + fmt(parse(bar.crew.end || bar.crew.start)) : (bar.crew.days || 0) + ' Arbeitstage'}`
        + (reqTrade ? `\nGewerk: ${reqTrade.label}` : '')
        + (bar.crew.assigned && bar.crew.assigned.length ? `\nZugeordnet: ${bar.crew.assigned.map(monteurName).join(', ')}` : '')
      : '';
    b.title = `${row.label}\n${bar.label || '(ohne Bezeichnung)'}\n${cat.label}\n${fmt(parse(bar.start))} – ${fmt(parse(bar.end))}${crewTxt}${reasons ? '\n⚠ ' + reasons.join('\n⚠ ') : ''}`;
    b._row = row; b._bar = bar;
    attachDrag(b);
    return b;
  }

  // Monteur-Lanes unter dem Fenster: je zugeordnetem Monteur eine Zeile (genau über seine Tage),
  // dazu eine schraffierte „(offen)"-Zeile für Gewerk-Tage, an denen noch nicht voll besetzt ist.
  function phaseLanes(bar) {
    const lanes = [];
    for (const ph of (bar.phases || [])) {
      const ranges = assignedRanges(ph);
      const order = [], byId = {};
      for (const r of ranges) { if (!byId[r.id]) { byId[r.id] = []; order.push(r.id); } byId[r.id].push({ start: r.start, end: r.end }); }
      for (const id of order) lanes.push({ trade: ph.trade, name: monteurName(id), segments: byId[id] });
      // offene Abdeckung: Werktage im Phasenfenster, an denen weniger Personen als count zugeordnet sind
      const need = +ph.count || 0, openSegs = []; let cur = null;
      for (let d = parse(ph.start); d <= parse(ph.end); d = addDays(d, 1)) {
        const dow = new Date(d).getUTCDay();
        let open = false;
        if (ph.weekend || (dow !== 0 && dow !== 6)) {
          const have = sumPersons(new Set(ranges.filter(r => parse(r.start) <= d && parse(r.end) >= d).map(r => r.id).filter(id => !unavailable(id, d))));
          open = have < need;
        }
        if (open) { const iso = isoStr(d); if (!cur) cur = { start: iso, end: iso }; else cur.end = iso; }
        else if (cur) { openSegs.push(cur); cur = null; }
      }
      if (cur) openSegs.push(cur);
      if (openSegs.length) lanes.push({ trade: ph.trade, name: '(offen)', open: true, segments: openSegs });
    }
    // Bauleitung-Zeilen (je zugeordnetem Bauleiter eine Zeile über seine Tage)
    const blById = {}, blOrder = [];
    for (const r of blRanges(bar)) { if (!blById[r.id]) { blById[r.id] = []; blOrder.push(r.id); } blById[r.id].push({ start: r.start, end: r.end }); }
    for (const id of blOrder) lanes.push({ bl: true, name: monteurName(id), segments: blById[id] });
    return lanes;
  }
  function renderLanes(track, row, windowBar, lanes, yBase) {
    lanes.forEach((lane, li) => {
      const t = lane.bl ? { color: '#7e57c2', short: 'BL', label: 'Bauleitung' }
        : (TRADES()[lane.trade] || { color: '#9aa0a6', short: '?', label: lane.trade || 'Gewerk' });
      const top = (yBase || 0) + 25 + li * 15;
      let minX = Infinity;
      for (const seg of lane.segments) {
        const x0 = dayIndex(parse(seg.start), startMs), x1 = dayIndex(parse(seg.end), startMs);
        if (x0 < minX) minX = x0;
        const d = el('div', 'lane-seg' + (lane.open ? ' lane-open' : ''));
        d.style.left = (x0 * dayWidth) + 'px';
        d.style.width = Math.max((x1 - x0 + 1) * dayWidth - 2, 4) + 'px';
        d.style.top = top + 'px';
        if (lane.open) d.style.setProperty('--gw', t.color);
        else { d.style.background = 'color-mix(in srgb, ' + t.color + ' 22%, #fff)'; d.style.borderLeftColor = t.color; }
        d.title = t.label + (lane.open ? ' – noch nicht voll besetzt' : ' · ' + lane.name) + '\n' + fmt(parse(seg.start)) + ' – ' + fmt(parse(seg.end));
        d._row = row; d._bar = windowBar;
        d.addEventListener('click', () => openEditor(row, windowBar, false));
        track.appendChild(d);
      }
      const lab = el('div', 'lane-lbl' + (lane.open ? ' lane-lbl-open' : ''), lane.open ? t.short + ' (offen)' : (lane.bl ? lane.name : t.short + ' ' + lane.name));
      lab.style.left = (minX * dayWidth + 5) + 'px';
      lab.style.top = (top + 1) + 'px';
      if (lane.open) lab.style.color = t.color;
      track.appendChild(lab);
    });
  }
  // Eingeklappt: kompakte Zusammenfassung der Monteur-Lanes direkt auf dem Fensterbalken.
  function addLaneSummary(wb, lanes) {
    if (!lanes || !lanes.length) return;
    const names = [...new Set(lanes.filter(l => !l.open && !l.bl).map(l => l.name))];
    const blNames = [...new Set(lanes.filter(l => l.bl).map(l => l.name))];
    const openTrades = [...new Set(lanes.filter(l => l.open).map(l => l.trade))];
    const wrap = el('span', 'bar-sum');
    if (names.length) {
      const b = el('span', 'bar-sum-m', '👤' + names.length);
      b.title = 'Zugeordnet: ' + names.join(', ');
      wrap.appendChild(b);
    }
    if (blNames.length) {
      const b = el('span', 'bar-sum-bl', 'BL');
      b.title = 'Bauleitung: ' + blNames.join(', ');
      wrap.appendChild(b);
    }
    if (openTrades.length) {
      const shorts = openTrades.map(t => (TRADES()[t] && TRADES()[t].short) || '?').join('/');
      const o = el('span', 'bar-sum-open', '⚠ ' + shorts);
      o.title = 'Noch offener Bedarf: ' + openTrades.map(t => (TRADES()[t] && TRADES()[t].label) || t).join(', ');
      wrap.appendChild(o);
    }
    if (wrap.childNodes.length) wb.appendChild(wrap);
  }

  function buildBody(flags) {
    const body = el('div', 'body');
    const trackW = totalDays * dayWidth;
    let visible = 0;

    function makeRow(group, row, idx, indent) {
      const isProjects = group.name === 'Projekte';
      const isResources = group.name === 'Ressourcen / Monteure';
      const isBauleiter = group.name === 'Bauleiter';
      const isTeam = !!row._member;
      const editable = isProjects || isResources || isBauleiter;
      const r = el('div', 'row' + (idx % 2 ? ' alt' : '') + (row.archived ? ' archived' : ''));
      const roleTag = row.capRole === 'extern' ? '  ⟂ extern'
        : (isResources && row.capRole === 'none') ? '  ⓘ keine Kapazität' : '';
      const label = el('div', 'label', row.label); label.title = row.label + roleTag + '  (Doppelklick: bearbeiten)';
      if (isResources && row.capRole === 'none') label.classList.add('row-info');
      if (row.capRole === 'extern') label.classList.add('res-extern');
      if (indent) label.classList.add('area');
      if (isTeam) {
        label.classList.add('editable');
        label.addEventListener('dblclick', () => openTeamDialog());
      } else if (editable) {
        label.classList.add('editable');
        label.addEventListener('dblclick', () => isProjects ? openProjectDialog(row) : openResourceDialog(row, isBauleiter ? 'bauleiter' : 'resource'));
        if (isProjects) {
          const ti = el('span', 'row-ti', '✉'); ti.title = 'Termineinladung erstellen';
          ti.onclick = (e) => { e.stopPropagation(); openTermineinladung(row); };
          label.appendChild(ti);
          // Archivieren / Wiederherstellen (nach Projektabschluss)
          const arch = el('span', 'row-arch', row.archived ? '↩' : '📦');
          arch.title = row.archived ? 'Wiederherstellen (aus dem Archiv holen)' : 'Projekt archivieren (nach Abschluss ausblenden)';
          arch.onclick = (e) => {
            e.stopPropagation();
            row.archived = !row.archived;
            logChange(`Projekt „${row.site || row.label}" ${row.archived ? 'archiviert' : 'wiederhergestellt'}`, 'zeitplan');
            save(); render();
          };
          label.appendChild(arch);
        }
        const del = el('span', 'row-del', '✕'); del.title = (isProjects ? (row.site ? 'Bereich' : 'Projekt') : isBauleiter ? 'Bauleiter' : 'Zeile') + ' löschen';
        del.onclick = (e) => {
          e.stopPropagation();
          if (confirm(`„${row.label}" wirklich löschen?`)) {
            historyBatch(() => {
              group.rows.splice(group.rows.indexOf(row), 1);
              if (group.name === 'Bauleiter') purgePerson(row.id);
              logChange(`${group.name === 'Projekte' ? 'Projekt' : 'Zeile'} „${row.site ? row.site + ' · ' : ''}${row.label}" gelöscht`, 'zeitplan');
            });
            render();
          }
        };
        label.appendChild(del);
      }
      const track = el('div', 'track'); track.style.width = trackW + 'px'; track._row = row;
      track.addEventListener('dblclick', (e) => {
        if (e.target !== track) return;
        const day = clamp(Math.floor(e.offsetX / dayWidth), 0, totalDays - 1);
        const ms = addDays(startMs, day);
        const s = isoStr(ms);
        const bar = (row.capRole === 'extern' || row.capRole === 'monteur')
          ? { start: s, end: s, label: '', cat: row.capRole === 'extern' ? 'booking' : 'vacation' }
          : { start: s, end: s, label: '', cat: 'preplanning' };   // kein Auto-Personalbedarf – Personen erst über eine Phase
        row.bars.push(bar);
        openEditor(row, bar, true);
      });
      // Monteur-Lanes unter dem Fensterbalken; sich zeitlich überlappende Fenster werden vertikal gestapelt
      const visBars = row.bars.filter(bar => !hiddenCats.has(effCat(row, bar)));
      const laneMap = new Map();
      for (const bar of visBars) laneMap.set(bar, phaseLanes(bar));
      const showLanes = !lanesCollapsed;
      const bandH = (bar) => { const n = showLanes ? (laneMap.get(bar) || []).length : 0; return n > 0 ? 28 + n * 15 : 26; };
      // Stapel-Zuweisung (Intervall-Partitionierung): sich überlappende Balken kommen in verschiedene Etagen
      const stackMap = new Map();
      const laneEnds = [];
      for (const bar of visBars.slice().sort((a, b) => parse(a.start) - parse(b.start) || parse(a.end) - parse(b.end))) {
        const s = parse(bar.start); let k = 0;
        while (k < laneEnds.length && laneEnds[k] >= s) k++;
        stackMap.set(bar, k); laneEnds[k] = parse(bar.end);
      }
      const numStacks = laneEnds.length;
      const stacked = numStacks > 1;
      // vertikale Position je Etage = kumulierte Höhe der Etagen darüber (+ kleine Lücke)
      const stackH = new Array(numStacks).fill(0);
      for (const bar of visBars) stackH[stackMap.get(bar)] = Math.max(stackH[stackMap.get(bar)], bandH(bar));
      const stackY = []; let accY = 0;
      for (let k = 0; k < numStacks; k++) { stackY[k] = accY; accY += stackH[k] + 4; }
      const lanes = showLanes ? Math.max(0, ...[...laneMap.values()].map(l => l.length)) : 0;
      if (stacked) r.style.height = accY + 'px';
      else if (lanes > 0) r.style.height = (28 + lanes * 15) + 'px';
      for (const bar of visBars) {
        const wb = makeBar(row, bar, flags);
        const bl = showLanes ? (laneMap.get(bar) || []) : [];
        if (bl.length) wb.style.height = '20px';   // Fenster kompakt halten, Lanes darunter
        const yBase = stacked ? stackY[stackMap.get(bar)] : 0;
        if (stacked) { wb.style.top = (yBase + 3) + 'px'; wb.style.height = '20px'; }
        // Eingeklappt: kompakte Zusammenfassung (Monteure/offener Bedarf) direkt am Balken
        if (!showLanes) addLaneSummary(wb, laneMap.get(bar) || []);
        track.appendChild(wb);
        renderLanes(track, row, bar, bl, yBase);
      }
      r.appendChild(label); r.appendChild(track);
      return r;
    }

    function makeSiteHeader(group, site, areas) {
      const collapsed = collapsedSites.has(site);
      const r = el('div', 'row site-header');
      const label = el('div', 'label site-label');
      const tog = el('span', 'site-toggle', collapsed ? '▸' : '▾');
      label.appendChild(tog);
      label.appendChild(document.createTextNode(' ' + site));
      label.title = `${site} · ${areas.length} Bereiche  (Klick: auf/zu)`;
      label.onclick = () => { collapsed ? collapsedSites.delete(site) : collapsedSites.add(site); render(); };
      const add = el('span', 'site-add', '＋'); add.title = 'Bereich hinzufügen';
      add.onclick = (e) => { e.stopPropagation(); openProjectDialog(null, site); };
      label.appendChild(add);
      // Ganze Baustelle archivieren / wiederherstellen (alle Bereiche mit diesem Site-Namen)
      const siteAll = group.rows.filter(x => x.site === site);
      const allArch = siteAll.length && siteAll.every(x => x.archived);
      const arch = el('span', 'row-arch', allArch ? '↩' : '📦');
      arch.title = allArch ? 'Baustelle wiederherstellen' : 'Baustelle archivieren (alle Bereiche)';
      arch.onclick = (e) => {
        e.stopPropagation();
        siteAll.forEach(x => { x.archived = !allArch; });
        logChange(`Baustelle „${site}" ${allArch ? 'wiederhergestellt' : 'archiviert'} (${siteAll.length} Bereiche)`, 'zeitplan');
        save(); render();
      };
      label.appendChild(arch);
      const track = el('div', 'track site-track'); track.style.width = trackW + 'px';
      let min = Infinity, max = -Infinity;
      for (const a of areas) for (const b of a.bars) {
        const s = dayIndex(parse(b.start), startMs), e = dayIndex(parse(b.end), startMs);
        if (s < min) min = s; if (e > max) max = e;
      }
      if (min <= max) {
        const bar = el('div', 'site-rollup');
        bar.style.left = (min * dayWidth) + 'px';
        bar.style.width = Math.max((max - min + 1) * dayWidth - 2, dayWidth) + 'px';
        bar.title = `${site}: ${fmt(addDays(startMs, min))} – ${fmt(addDays(startMs, max))} · ${areas.length} Bereiche`;
        if (collapsed) bar.appendChild(el('span', 'lbl', `${areas.length} Bereiche`));
        track.appendChild(bar);
      }
      r.appendChild(label); r.appendChild(track);
      return r;
    }

    function makeGroupRow(name, collapsible, count) {
      const gr = el('div', 'group-row');
      gr.style.width = 'calc(var(--label-w) + ' + trackW + 'px)';
      const lbl = el('div', 'group-row-label');
      if (collapsible) {
        const collapsed = collapsedGroups.has(name);
        lbl.classList.add('collapsible');
        lbl.appendChild(el('span', 'group-toggle', collapsed ? '▸' : '▾'));
        lbl.appendChild(document.createTextNode(' ' + name + (count ? '  (' + count + ')' : '')));
        lbl.title = 'Klick: ' + (collapsed ? 'ausklappen' : 'einklappen');
        lbl.onclick = () => { collapsed ? collapsedGroups.delete(name) : collapsedGroups.add(name); render(); };
      } else {
        lbl.textContent = name;
      }
      gr.appendChild(lbl);
      return gr;
    }

    for (const group of PLAN.groups) {
      // Archivierte Projekte nur zeigen, wenn der Archiv-Schalter aktiv ist
      const rows = group.rows.filter(r => matches(r) && (showArchived || !r.archived));
      const isRes = group.name === 'Ressourcen / Monteure';
      if (!rows.length && !(isRes && PLAN.team.length)) continue;
      // Team-Zeilen (nur bei Ressourcen) einmal aufbauen – auch für die Anzahl im Kopf
      const teamRows = isRes ? PLAN.team.map(m => ({
        _member: m, id: 'mon-' + m.id, label: m.name || '(ohne Name)',
        capRole: m.type === 'extern' ? 'extern' : 'monteur',
        bars: (m.bars = m.bars || [])
      })).filter(matches) : [];
      const collapsible = (group.name === 'Ressourcen / Monteure' || group.name === 'Bauleiter');
      const count = isRes ? (teamRows.length + rows.length) : rows.length;
      body.appendChild(makeGroupRow(group.name, collapsible, count));
      if (collapsible && collapsedGroups.has(group.name)) { visible++; continue; }   // eingeklappt: Zeilen überspringen
      let idx = 0;
      if (isRes) {
        for (const tr of teamRows) { body.appendChild(makeRow(group, tr, idx++, false)); visible++; }
        // zusätzliche Datenzeilen (Steinacker, Schulungen, „nicht zugeordnet" …)
        for (const row of rows) { body.appendChild(makeRow(group, row, idx++, false)); visible++; }
      } else if (group.name === 'Projekte') {
        // Zeilen in Blöcke gruppieren: Baustellen (site) sammeln, Einzelprojekte einzeln
        const blocks = []; const bySite = {};
        for (const row of rows) {
          if (row.site) {
            let blk = bySite[row.site];
            if (!blk) { blk = { site: row.site, areas: [] }; bySite[row.site] = blk; blocks.push(blk); }
            blk.areas.push(row);
          } else blocks.push({ row });
        }
        // „Kleinprojekte" (Sammelzeile) immer ans Ende der Projektliste anheften
        const isKlein = (blk) => !blk.site && /kleinprojekt/i.test((blk.row && blk.row.label) || '');
        blocks.sort((a, b) => (isKlein(a) ? 1 : 0) - (isKlein(b) ? 1 : 0));
        for (const blk of blocks) {
          if (blk.site) {
            body.appendChild(makeSiteHeader(group, blk.site, blk.areas)); visible++;
            if (!collapsedSites.has(blk.site))
              for (const area of blk.areas) { body.appendChild(makeRow(group, area, idx++, true)); visible++; }
          } else { body.appendChild(makeRow(group, blk.row, idx++, false)); visible++; }
        }
      } else {
        for (const row of rows) { body.appendChild(makeRow(group, row, idx++, false)); visible++; }
      }
    }
    const todayIdx = dayIndex(todayMs(), startMs);
    if (todayIdx >= 0 && todayIdx < totalDays) {
      const line = el('div', 'todayline');
      line.style.left = `calc(var(--label-w) + ${todayIdx * dayWidth + Math.floor(dayWidth/2)}px)`;
      body.appendChild(line);
    }
    if (!visible) body.appendChild(makeGroupRow('Keine Treffer'));
    return body;
  }

  // ---- Ziehen / Größe ändern ----
  // Verschiebt Phasen (Werktagsregel, Zuordnungen auf das neue Phasenfenster begrenzt), Alt-Bedarf und
  // taggenaue Bauleitung eines Fensters um delta Kalendertage. Das Fenster selbst (start/end) setzt der Aufrufer.
  function shiftBarContent(bar, delta) {
    const sh = (iso) => isoStr(addDays(parse(iso), delta));
    for (const ph of (bar.phases || [])) {
      const oldStart = ph.start;
      if (!(+ph.days > 0)) ph.days = daysCount(oldStart, ph.end || oldStart, ph.weekend);
      let ns = sh(oldStart);
      if (!ph.weekend) ns = snapWorkday(ns);   // Werktags-Einsatz nicht auf Sa/So beginnen lassen
      const pdelta = Math.round((parse(ns) - parse(oldStart)) / MS_DAY);
      const psh = (iso) => isoStr(addDays(parse(iso), pdelta));
      ph.start = ns;
      ph.end = endFromDays(ns, ph.days, ph.weekend);
      const nsMs = parse(ns), neMs = parse(ph.end);
      ph.assigned = (ph.assigned || []).map(a => {
        if (typeof a === 'string') return a;                       // ganze Phase → wandert automatisch mit
        let rs = parse(psh(a.start)), re = parse(psh(a.end));
        if (rs < nsMs) rs = nsMs; if (re > neMs) re = neMs;        // auf neues Phasenfenster begrenzen
        if (rs > re) return null;
        return { id: a.id, start: isoStr(rs), end: isoStr(re) };
      }).filter(Boolean);
    }
    if (bar.crew && bar.crew.start) { bar.crew.start = sh(bar.crew.start); bar.crew.end = sh(bar.crew.end || bar.crew.start); }
    // Bauleitung wandert mit (sonst zöge die Fenster-Regel das Fenster über die alten Tage zurück)
    if (bar.bl) bar.bl = bar.bl.map(a => (typeof a === 'string' ? a : { id: a.id, start: sh(a.start), end: sh(a.end) }));
  }
  // Verlaufstext fürs Verschieben: altes → neues Fenster, je Gewerk der Zeitraum und wer mitgewandert ist
  const shiftSnap = (bar) => ({ start: bar.start, end: bar.end, phases: (bar.phases || []).map(p => ({ trade: p.trade, start: p.start, end: p.end })),
    ids: [...new Set((bar.phases || []).flatMap(p => assignedRanges(p).map(r => r.id)))], bl: [...new Set(blRanges(bar).map(r => r.id))] });
  function describeShift(bar, before) {
    const dd = (iso) => WD_SHORT[new Date(parse(iso)).getUTCDay()] + ' ' + fmt(parse(iso)).slice(0, 6);
    const span = (o) => o.start === o.end ? dd(o.start) : dd(o.start) + '–' + dd(o.end);
    const parts = ['Fenster ' + span(before) + ' → ' + span(bar)];
    (bar.phases || []).forEach((p, i) => { const o = before.phases[i]; if (o && (o.start !== p.start || o.end !== p.end)) parts.push(((TRADES()[p.trade] || {}).label || 'Phase') + ': ' + span(o) + ' → ' + span(p)); });
    if (before.ids.length) parts.push('Monteure mit verschoben: ' + before.ids.map(monteurName).join(', '));
    if (before.bl.length) parts.push('Bauleitung mit verschoben: ' + before.bl.map(monteurName).join(', '));
    return parts.join(' · ');
  }
  function attachDrag(b, opts) {
    opts = opts || {};
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const mode = e.target.classList.contains('h-l') ? 'l'
                 : e.target.classList.contains('h-r') ? 'r' : 'move';
      const bar = b._bar;
      const ox0 = dayIndex(parse(bar.start), startMs);
      const ox1 = dayIndex(parse(bar.end), startMs);
      const startX = e.clientX;
      let nx0 = ox0, nx1 = ox1, moved = false;
      b.classList.add('dragging'); b.setPointerCapture(e.pointerId);
      const onMove = (ev) => {
        const delta = Math.round((ev.clientX - startX) / dayWidth);
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        if (mode === 'move') { nx0 = ox0 + delta; nx1 = ox1 + delta; }
        else if (mode === 'l') { nx0 = Math.min(ox0 + delta, ox1); nx1 = ox1; }
        else { nx1 = Math.max(ox1 + delta, ox0); nx0 = ox0; }
        nx0 = clamp(nx0, 0, totalDays - 1); nx1 = clamp(nx1, 0, totalDays - 1);
        b.style.left = (nx0 * dayWidth) + 'px';
        b.style.width = Math.max((nx1 - nx0 + 1) * dayWidth - 2, dayWidth - 2) + 'px';
      };
      const onUp = () => {
        b.removeEventListener('pointermove', onMove);
        b.removeEventListener('pointerup', onUp);
        b.classList.remove('dragging');
        if (!moved && mode === 'move') { (opts.onClick ? opts.onClick() : openEditor(b._row, bar, false)); return; }
        if (nx0 !== ox0 || nx1 !== ox1) {
          const before = shiftSnap(bar);
          bar.start = isoStr(addDays(startMs, nx0));
          bar.end = isoStr(addDays(startMs, nx1));
          // Beim Verschieben (nicht Resize) wandern die Gewerke/Phasen + Zuordnungen mit.
          if (mode === 'move') shiftBarContent(bar, nx0 - ox0);
          if (mode !== 'move' && fitBar(bar)) toast('Das Fenster kann nicht kürzer sein als die darin geplanten Einsätze – zuerst die Phase kürzen.');
          const rowNm = b._row.site || b._row.label, barNm = bar.label || '(ohne Bezeichnung)';
          if (mode === 'move') logChange(`Einsatz „${barNm}" (${rowNm}) verschoben · ${describeShift(bar, before)}`, 'zeitplan');
          else logChange(`Einsatz „${barNm}" (${rowNm}) Fenster geändert → ${fmt(parse(bar.start))}–${fmt(parse(bar.end))} (Monteure nicht verschoben)`, 'zeitplan');
          save(); render();
        }
      };
      b.addEventListener('pointermove', onMove);
      b.addEventListener('pointerup', onUp);
    });
  }

  // ---- Editor ----
  const overlay = document.getElementById('overlay');
  const fLabel = document.getElementById('f-label');
  // Bekanntes Kleinprojekt gewählt → Adresse übernehmen (nur wenn noch keine eingetragen ist)
  fLabel.addEventListener('input', () => {
    if (!current || !isKleinRow(current.row)) return;
    const k = kleinKnown().get(fLabel.value.trim().toLowerCase()); if (!k) return;
    const els = ADDR_KEYS.map(key => document.getElementById('f-' + key));
    if (els.every(e => !e.value.trim())) ADDR_KEYS.forEach((key, i) => { els[i].value = k[key] || ''; });
  });
  const fCat = document.getElementById('f-cat');
  const fStart = document.getElementById('f-start');
  const fEnd = document.getElementById('f-end');
  let current = null;

  for (const key of Object.keys(PLAN.categories)) {
    const o = el('option', null, PLAN.categories[key].label); o.value = key; fCat.appendChild(o);
  }

  // Bauleitung am Fenster (Arbeitskopie: gewählte Bauleiter-IDs). Kategorie „Bauleitung" = Termin ohne Monteure.
  let blDraft = new Set();
  function renderBlChips() {
    const box = document.getElementById('f-bl'); box.innerHTML = '';
    const rows = bauleiterRows();
    if (!rows.length) { box.appendChild(el('span', 'phase-hint', 'Noch keine Bauleiter angelegt (Button „Bauleiter" oben).')); return; }
    for (const r of rows) {
      const on = blDraft.has(r.id), chip = el('span', 'trade-chip' + (on ? ' on' : ''), r.label || 'Bauleiter');
      if (on) chip.style.background = '#7e57c2';
      chip.onclick = () => { if (on) blDraft.delete(r.id); else blDraft.add(r.id); renderBlChips(); };
      box.appendChild(chip);
    }
  }
  const isProjRow = (row) => { const g = PLAN.groups.find(x => x.name === 'Projekte'); return !!(g && g.rows.indexOf(row) >= 0); };
  function applyCatMode() {
    if (!current) return;
    const proj = isProjRow(current.row);   // Phasen/Bauleitung/Hotel/Einladung nur bei Projekten (nicht bei Ressourcen-/Bauleiter-Zeilen)
    document.getElementById('f-crew-wrap').style.display = (proj && fCat.value !== 'bauleitung') ? '' : 'none';   // Bauleitungs-Termin: keine Monteur-Phasen
    document.getElementById('f-bl-wrap').style.display = proj ? '' : 'none';
  }
  fCat.addEventListener('change', applyCatMode);

  // Montage-Phasen (Arbeitskopie während der Dialog offen ist)
  const fPhases = document.getElementById('f-phases');
  let phaseDraft = [];
  function renderPhaseList() {
    fPhases.innerHTML = '';
    phaseDraft.forEach((ph, i) => {
      const card = el('div', 'phase-card');
      // Gewerk
      const gwL = el('label', 'phase-gw', 'Gewerk');
      const sel = document.createElement('select');
      for (const k of Object.keys(TRADES())) { const o = el('option', null, TRADES()[k].label); o.value = k; sel.appendChild(o); }
      sel.value = ph.trade || 'edelstahl';
      gwL.appendChild(sel);
      // Start / Montagetage / Wochenende / Personen / Löschen
      if (typeof ph.weekend !== 'boolean') ph.weekend = false;
      if (!(+ph.days > 0)) ph.days = daysCount(ph.start, ph.end || ph.start, ph.weekend);
      const von = document.createElement('input'); von.type = 'date'; von.value = ph.start;
      const dur = document.createElement('input'); dur.type = 'number'; dur.min = '0.5'; dur.step = '0.5'; dur.value = ph.days; dur.title = 'Anzahl Montagetage (halbe Tage möglich, z. B. 0,5 oder 1,5)';
      const wkc = document.createElement('input'); wkc.type = 'checkbox'; wkc.checked = !!ph.weekend; wkc.title = 'Auch am Wochenende (Sa/So) arbeiten';
      const cnt = document.createElement('input'); cnt.type = 'number'; cnt.min = '1'; cnt.step = '1'; cnt.value = ph.count || 1; cnt.title = 'Anzahl Personen';
      const endHint = el('div', 'phase-endhint', '');
      let rebuildAsg = null;   // Monteur-Liste neu zeichnen, wenn sich der Zeitraum ändert (Teil-Zuordnungen)
      const refreshEnd = () => {
        if (!ph.weekend) { ph.start = snapWorkday(ph.start); von.value = ph.start; }
        ph.end = endFromDays(ph.start, ph.days, ph.weekend);
        if (rebuildAsg) rebuildAsg();
        endHint.textContent = '→ endet ' + wdShort(ph.end) + ' ' + fmt(parse(ph.end)) + (isHalf(ph) ? (+ph.days < 1 ? ' · halber Tag' : ' · letzter Tag halb') : '') + (ph.weekend ? ' · inkl. Wochenende' : '');
      };
      von.onchange = () => { ph.start = von.value || ph.start; refreshEnd(); };
      dur.oninput = () => { ph.days = halfDays(String(dur.value).replace(',', '.')); refreshEnd(); };
      wkc.onchange = () => { ph.weekend = wkc.checked; refreshEnd(); };
      const ngc = document.createElement('input'); ngc.type = 'checkbox'; ngc.checked = !!ph.overnight;
      ngc.title = 'Mit Übernachtung: Vorgabe für alle Monteure dieser Phase (jede Nacht, auf die ein weiterer Einsatztag folgt). In der Woche je Person und Tag änderbar.';
      ngc.onchange = () => { ph.overnight = ngc.checked; };
      cnt.oninput = () => { ph.count = Math.max(1, +cnt.value || 1); };
      const del = el('span', 'phase-del', '✕'); del.title = 'Phase entfernen'; del.onclick = () => { phaseDraft.splice(i, 1); renderPhaseList(); };
      // Termineinladung nur für dieses Gewerk (eigener Entwurf): speichert die Maske und öffnet die Einladung der Phase
      const pti = el('span', 'phase-ti', '✉'); pti.title = 'Termineinladung für dieses Gewerk (Zeitraum, Monteure und Tätigkeit der Phase)\nDie Maske wird dabei gespeichert.';
      pti.onclick = () => {
        if (!current) return;
        const { row, bar } = current;
        document.getElementById('f-save').click();
        if (current || !bar.phases || !bar.phases[i] || row.bars.indexOf(bar) < 0) return;   // Speichern abgebrochen
        openTermineinladung(row, bar, i);
      };
      const line2 = el('div', 'phase-row2');
      const vonL = el('label', 'phase-fld', 'Start'); vonL.appendChild(von);
      const durL = el('label', 'phase-fld phase-cnt', 'Montagetage'); durL.appendChild(dur);
      const wkL = el('label', 'phase-fld phase-wk', 'Sa/So'); wkL.appendChild(wkc);
      const ngL = el('label', 'phase-fld phase-wk', '🌙 Übern.'); ngL.title = ngc.title; ngL.appendChild(ngc);
      const cntL = el('label', 'phase-fld phase-cnt', 'Pers.'); cntL.appendChild(cnt);
      line2.appendChild(vonL); line2.appendChild(durL); line2.appendChild(wkL); line2.appendChild(ngL); line2.appendChild(cntL); line2.appendChild(pti); line2.appendChild(del);
      refreshEnd();
      // Monteur-Zuordnung – nur nach Gewerk qualifizierte
      const asgTitle = el('div', 'assign-title', '');
      const asg = el('div', 'assign-list');
      const buildAsg = () => {
        asgTitle.textContent = 'Monteure' + (ph.trade && TRADES()[ph.trade] ? ' (' + TRADES()[ph.trade].label + ')' : '');
        asg.innerHTML = '';
        let any = false;
        for (const m of PLAN.team) {
          if (ph.trade && !qualifies(m, ph.trade)) continue;
          any = true;
          const lab = el('label', null);
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = m.id; cb.checked = (ph.assigned || []).some(a => idOf(a) === m.id);
          // Nur an einzelnen Tagen eingeplant (z. B. aus der Woche)? → halb angehakt + Tage nennen; Klick = ganze Phase
          let partDays = null;
          if (cb.checked && !(ph.assigned || []).some(a => a === m.id)) {
            const covered = new Set();
            for (const a of ph.assigned) if (typeof a !== 'string' && a.id === m.id) for (let x = parse(a.start); x <= parse(a.end); x = addDays(x, 1)) covered.add(x);
            const all = []; for (let x = parse(ph.start); x <= parse(ph.end); x = addDays(x, 1)) if (ph.weekend || isWorkdayMs(x)) all.push(x);
            const on = all.filter(x => covered.has(x));
            if (on.length < all.length) { partDays = on; cb.checked = false; cb.indeterminate = true; }
          }
          cb.onchange = () => {
            ph.assigned = (ph.assigned || []).filter(a => idOf(a) !== m.id);  // vorhandene (Teil-)Bereiche der Person entfernen
            if (cb.checked) ph.assigned.push(m.id);                            // anhaken = ganze Phase
            const n = new Set(ph.assigned.map(idOf)).size;
            if (n > (+ph.count || 0)) { ph.count = n; cnt.value = ph.count; }
          };
          const span = el('span', m.type === 'extern' ? 'ext' : null, m.name + (m.type === 'extern' ? ' (ext)' : ''));
          lab.appendChild(cb); lab.appendChild(span); lab.appendChild(tradeTags(m.trades));
          if (partDays) {
            const txt = partDays.length ? 'nur ' + partDays.slice(0, 4).map(x => WD_SHORT[new Date(x).getUTCDay()] + ' ' + fmt(x).slice(0, 6)).join(', ') + (partDays.length > 4 ? ' …' : '') : 'außerhalb des Zeitraums';
            lab.appendChild(el('span', 'assign-part', txt));
            lab.title = m.name + ' ist nur an einzelnen Tagen dieser Phase eingeplant.\nAnhaken = für die ganze Phase einplanen.';
          }
          asg.appendChild(lab);
        }
        if (!any) asg.appendChild(el('span', 'assign-empty', '— kein Monteur mit dieser Qualifikation —'));
      };
      sel.onchange = () => {
        ph.trade = sel.value;
        ph.assigned = (ph.assigned || []).filter(a => { const m = PLAN.team.find(t => t.id === idOf(a)); return m && qualifies(m, ph.trade); });
        buildAsg();
      };
      buildAsg();
      rebuildAsg = buildAsg;
      card.appendChild(gwL); card.appendChild(line2); card.appendChild(endHint); card.appendChild(asgTitle); card.appendChild(asg);
      fPhases.appendChild(card);
    });
  }
  document.getElementById('f-phase-add').onclick = () => {
    const b = current && current.bar;
    const last = phaseDraft[phaseDraft.length - 1];
    // Neue Phase erbt den Zeitraum der vorherigen (z. B. Elektro analog Edelstahl); Gewerk = nächstes noch nicht genutztes
    const used = new Set(phaseDraft.map(p => p.trade));
    const trade = last ? (Object.keys(TRADES()).find(k => !used.has(k)) || last.trade) : 'edelstahl';
    const start = last ? last.start : ((b && b.start) || fStart.value);
    const daysN = last ? last.days : 5;
    const weekend = last ? !!last.weekend : false;
    phaseDraft.push({
      trade,
      start: weekend ? start : snapWorkday(start),
      days: daysN,
      weekend,
      end: endFromDays(weekend ? start : snapWorkday(start), daysN, weekend),
      count: 1,
      assigned: [],
    });
    renderPhaseList();
  };

  function openEditor(row, bar, isNew) {
    current = { row, bar, isNew };
    const isExtern = row.capRole === 'extern';
    const isMonteur = row.capRole === 'monteur';
    document.getElementById('dlgTitle').textContent = (isNew ? 'Neuer Eintrag' : 'Bearbeiten') + ' · ' + row.label;
    fLabel.value = bar.label || '';
    fCat.value = bar.cat;
    fStart.value = bar.start; fEnd.value = bar.end;
    // Kleinprojekte: Adresse je Montage + Vorschläge aus früheren Kleinprojekten
    const klein = isKleinRow(row);
    document.getElementById('f-addr-wrap').style.display = klein ? '' : 'none';
    for (const k of ADDR_KEYS) document.getElementById('f-' + k).value = klein ? (bar[k] || '') : '';
    if (klein) { fillKleinList(); fLabel.setAttribute('list', 'kleinList'); } else fLabel.removeAttribute('list');
    // Kontextabhängige Felder
    blDraft = new Set(blRanges(bar).map(r => r.id)); renderBlChips();
    document.getElementById('f-hotel').value = bar.hotel || '';
    document.getElementById('f-hotel-wrap').style.display = isProjRow(row) ? '' : 'none';
    applyCatMode();   // Montage-Phasen nur bei Projekten (nicht bei Kategorie „Bauleitung"), Bauleitung nur bei Projekten
    document.getElementById('f-cat-wrap').style.display = (isExtern || isMonteur) ? 'none' : '';    // Kategorie/Farbe ergibt sich bei Monteuren aus intern/extern
    document.getElementById('f-size-wrap').style.display = isExtern ? '' : 'none';                  // Truppstärke nur bei externen Buchungen
    document.getElementById('f-ti').style.display = isProjRow(row) ? '' : 'none';                   // Termineinladung nur bei Projekt-Montagen
    document.getElementById('f-size').value = bar.size || (row._member && row._member.size) || 1;
    // Phasen laden – bestehender Sammelbedarf (crew) wird verlustfrei als erste Phase übernommen
    const cloneAssigned = (arr) => (arr || []).map(a => (typeof a === 'string' ? a : { id: a.id, start: a.start, end: a.end }));
    if (bar.phases && bar.phases.length) {
      phaseDraft = bar.phases.map(p => {
        const weekend = !!p.weekend;
        const daysN = +p.days > 0 ? p.days : daysCount(p.start, p.end || p.start, weekend);
        return { pid: p.pid, trade: p.trade || 'edelstahl', start: p.start, days: daysN, weekend, end: p.end, count: p.count || 1, assigned: cloneAssigned(p.assigned), overnight: !!p.overnight };
      });
    } else if (bar.crew && ((bar.crew.assigned || []).length || bar.crew.trade)) {
      // Alt-Bedarf nur übernehmen, wenn er wirklich etwas enthält (Gewerk oder zugeordnete Monteure).
      // Ein leeres Fenster bekommt KEINE automatische Default-Phase (kein Auto-Edelstahl).
      const cs = bar.crew.start || bar.start, ce = bar.crew.end || bar.end;
      phaseDraft = [{ trade: bar.crew.trade || 'edelstahl', start: cs, days: daysCount(cs, ce, false), weekend: false, end: ce, count: +bar.crew.count || 1, assigned: cloneAssigned(bar.crew.assigned) }];
    } else {
      phaseDraft = [];
    }
    renderPhaseList();
    overlay.hidden = false; fLabel.focus();
  }
  function closeEditor() { overlay.hidden = true; current = null; }

  document.getElementById('f-save').onclick = () => {
    if (!current) return;
    const { row, bar } = current;
    const blOnly = isProjRow(row) && fCat.value === 'bauleitung';
    if (blOnly && phaseDraft.some(p => (p.assigned || []).length)
      && !confirm('Kategorie „Bauleitung": Diesem Termin werden keine Monteure zugeordnet.\nDie vorhandenen Monteur-Phasen werden entfernt. Fortfahren?')) return;
    // Phasen VOR dem Übernehmen berechnen: taggenaue Zuordnungen, die außerhalb des (geänderten) Phasenzeitraums
    // liegen, fallen dabei weg – das nicht stillschweigend tun, sondern nachfragen und im Verlauf festhalten.
    const isProject = isProjRow(row);
    const lost = new Map();   // Person → entfallende Tage
    const newPhases = (isProject && phaseDraft.length && !blOnly)
      ? phaseDraft.map(p => {
          const weekend = !!p.weekend;
          const daysN = halfDays(p.days);
          const s = weekend ? p.start : snapWorkday(p.start);   // Werktags-Einsatz beginnt an einem Werktag
          const e = endFromDays(s, daysN, weekend);             // Ende = Start + Montagetage (Wochenende ggf. übersprungen)
          const asg = (p.assigned || []).map(a => {
            if (typeof a === 'string') return a;                         // ganze Phase → folgt dem Zeitraum
            // Teilbereich auf das (evtl. geänderte) Phasenfenster begrenzen
            let rs = a.start > s ? a.start : s, re = a.end < e ? a.end : e;
            for (let ms = parse(a.start); ms <= parse(a.end); ms = addDays(ms, 1)) {
              const iso = isoStr(ms);
              if ((weekend || isWorkdayMs(ms)) && (rs > re || iso < rs || iso > re)) { if (!lost.has(a.id)) lost.set(a.id, []); lost.get(a.id).push(iso); }
            }
            if (rs > re) return null;
            return (rs === s && re === e) ? a.id : { id: a.id, start: rs, end: re };
          }).filter(Boolean);
          return Object.assign(p.pid ? { pid: p.pid } : {}, { trade: p.trade, start: s, days: daysN, weekend, end: e, count: Math.max(1, +p.count || 1), assigned: asg }, p.overnight ? { overnight: true } : {});
        })
      : undefined;
    const dayList = (arr) => { const u = [...new Set(arr)].sort(); return u.slice(0, 6).map(d => fmt(parse(d)).slice(0, 6)).join(', ') + (u.length > 6 ? ' …' : ''); };
    // Tage, an denen die Person in einer anderen Phase des Fensters weiter eingeplant ist, zählen nicht als verloren
    const stillOn = new Map();
    for (const ph of (newPhases || [])) for (const r of assignedRanges(ph)) for (let ms = parse(r.start); ms <= parse(r.end); ms = addDays(ms, 1)) { if (!stillOn.has(r.id)) stillOn.set(r.id, new Set()); stillOn.get(r.id).add(isoStr(ms)); }
    const lostTxt = [...lost].map(([id, days]) => [id, days.filter(d => !(stillOn.get(id) || new Set()).has(d))]).filter(x => x[1].length).map(([id, days]) => monteurName(id) + ' (' + dayList(days) + ')');
    if (lostTxt.length && !confirm('Durch den geänderten Zeitraum der Phase entfallen taggenaue Einsätze:\n\n• ' + lostTxt.join('\n• ') + '\n\nTrotzdem speichern?\n(Abbrechen = zurück zur Maske, z. B. um die Montagetage anzupassen)')) return;
    const idsBefore = new Set((bar.phases || []).flatMap(ph => (ph.assigned || []).map(idOf)));
    delete bar.weekgen;   // manuell bearbeitet → als echtes Fenster behandeln (nicht mehr als Woche-Fragment auto-aufräumen)
    bar.label = fLabel.value.trim();
    if (isKleinRow(row)) setAddr(bar, { strasse: document.getElementById('f-strasse').value, plz: document.getElementById('f-plz').value, ort: document.getElementById('f-ort').value });
    let s = fStart.value || bar.start, e = fEnd.value || bar.end;
    if (parse(e) < parse(s)) e = s;
    bar.start = s; bar.end = e;
    if (row.capRole === 'extern') {
      bar.cat = 'booking';
      const val = Math.max(1, +document.getElementById('f-size').value || 1);
      const def = (row._member && +row._member.size) || 1;
      if (val === def) delete bar.size; else bar.size = val;  // = Standard → erben; sonst überschreiben
      delete bar.crew;
    } else if (row.capRole === 'monteur') {
      bar.cat = 'vacation';
      delete bar.crew; delete bar.size;
    } else {
      // Projekt-Fenster: kein eigener Bedarf mehr – alles steckt in den Phasen
      bar.cat = fCat.value;
      if (isProject) {
      bar.phases = newPhases;
      delete bar.crew;
      // Bauleitung: abgewählte entfernen, taggenaue Bereiche (aus der Woche) aufs Fenster begrenzen, neue = ganzes Fenster
      const bl = [];
      for (const id of blDraft) {
        const had = (bar.bl || []).filter(a => idOf(a) === id).map(a => {
          if (typeof a === 'string') return a;
          const rs = a.start > s ? a.start : s, re = a.end < e ? a.end : e;
          return rs > re ? null : { id, start: rs, end: re };
        }).filter(Boolean);
        if (had.length) bl.push(...had);
        else if (!(bar.bl || []).some(a => idOf(a) === id)) bl.push(id);   // neu gewählt = ganzes Fenster; alte Tage außerhalb entfallen
      }
      if (bl.length) bar.bl = bl; else delete bar.bl;
      const hotel = document.getElementById('f-hotel').value.trim();
      if (hotel) bar.hotel = hotel; else delete bar.hotel;
      if (fitBar(bar)) toast('Montagefenster auf die geplanten Einsätze erweitert (' + fmt(parse(bar.start)) + '–' + fmt(parse(bar.end)) + ').');
      }
    }
    const rowNm = row.site || row.label, barNm = bar.label || '(ohne Bezeichnung)';
    const asgNames = (bar.phases || []).flatMap(ph => (ph.assigned || []).map(idOf)).filter((v, i, a) => a.indexOf(v) === i).map(monteurName);
    const blNames = [...new Set(blRanges(bar).map(r => r.id))].map(monteurName);
    // Im Verlauf festhalten, wer dazugekommen / herausgefallen ist und welche Tage gekürzt wurden
    const idsAfter = new Set((bar.phases || []).flatMap(ph => (ph.assigned || []).map(idOf)));
    const added = [...idsAfter].filter(id => !idsBefore.has(id)).map(monteurName), removed = [...idsBefore].filter(id => !idsAfter.has(id)).map(monteurName);
    const diff = (current.isNew ? '' : (added.length ? ' · neu: ' + added.join(', ') : '') + (removed.length ? ' · entfernt: ' + removed.join(', ') : '')) + (lostTxt.length ? ' · Tage entfallen: ' + lostTxt.join('; ') : '');
    const who = (asgNames.length ? ' · Monteure: ' + asgNames.join(', ') : '') + (blNames.length ? ' · Bauleitung: ' + blNames.join(', ') : '') + diff;
    logChange(`Termin „${barNm}" (${rowNm}) ${current.isNew ? 'angelegt' : 'bearbeitet'} → ${fmt(parse(bar.start))}–${fmt(parse(bar.end))}${who}`, 'zeitplan');
    save(); render(); closeEditor();
  };
  document.getElementById('f-delete').onclick = () => {
    if (!current) return;
    if (!current.isNew && !confirm(`Termin „${current.bar.label || '(ohne Bezeichnung)'}" mit allen Phasen, Monteuren und der Bauleitung löschen?`)) return;
    const rowNm = current.row.site || current.row.label, barNm = current.bar.label || '(ohne Bezeichnung)';
    const i = current.row.bars.indexOf(current.bar);
    if (i >= 0) current.row.bars.splice(i, 1);
    logChange(`Termin „${barNm}" (${rowNm}) gelöscht`, 'zeitplan');
    save(); render(); closeEditor();
  };
  // Montagefenster duplizieren: Kopie direkt im Anschluss (gleiche Länge/Gewerke/Zuordnungen)
  document.getElementById('f-duplicate').onclick = () => {
    if (!current) return;
    const { row, bar } = current;
    const clone = JSON.parse(JSON.stringify(bar));
    delete clone.bid;
    const len = Math.round((parse(bar.end) - parse(bar.start)) / MS_DAY);
    const ns = snapWorkday(isoStr(addDays(parse(bar.end), 1)));   // Kopie startet am nächsten Werktag nach dem Original
    const delta = Math.round((parse(ns) - parse(bar.start)) / MS_DAY);
    clone.start = ns; clone.end = isoStr(addDays(parse(ns), len));
    (clone.phases || []).forEach(p => { delete p.pid; });
    shiftBarContent(clone, delta);   // Phasen mit Werktagsregel, Zuordnungen und Bauleitung mitverschieben
    clone.label = bar.label ? bar.label + ' (Kopie)' : 'Kopie';
    row.bars.push(clone);
    logChange(`Montagefenster „${bar.label || ''}" (${row.site || row.label}) dupliziert → ${fmt(parse(clone.start))}–${fmt(parse(clone.end))}`, 'zeitplan');
    save(); render(); closeEditor(); openEditor(row, clone, false);
  };
  // Termineinladung für genau diese Montage (nützlich bei „Kleinprojekte" mit vielen Einzelmontagen)
  document.getElementById('f-ti').onclick = () => {
    if (!current) return;
    const { row, bar } = current;
    document.getElementById('f-save').click();
    if (current || row.bars.indexOf(bar) < 0) return;   // Speichern abgebrochen
    openTermineinladung(row, bar);
  };
  document.getElementById('f-cancel').onclick = () => {
    if (current && current.isNew) {
      const i = current.row.bars.indexOf(current.bar);
      if (i >= 0) current.row.bars.splice(i, 1);
      render();
    }
    closeEditor();
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.getElementById('f-cancel').click(); });
  document.addEventListener('keydown', (e) => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') document.getElementById('f-cancel').click();
    if (e.key === 'Enter' && e.target.tagName !== 'INPUT') document.getElementById('f-save').click();
  });

  // ---- Ressourcen-Zeilen-Dialog ----
  const roverlay = document.getElementById('roverlay');
  const rName = document.getElementById('r-name');
  const rRole = document.getElementById('r-role');
  let curResource = null, curResKind = 'resource', resTrades = [];
  const rTeamOpt = () => [...rRole.options].find(o => o.value === 'teammonteur');
  function renderResTrades() {
    const wrap = document.getElementById('r-trades-wrap');
    const box = document.getElementById('r-trades');
    const show = rRole.value === 'teammonteur';
    wrap.hidden = !show;
    if (!show) return;
    box.innerHTML = '';
    for (const key of Object.keys(TRADES())) {
      const t = TRADES()[key];
      const on = resTrades.includes(key);
      const chip = el('span', 'trade-chip' + (on ? ' on' : ''), t.label);
      if (on) { chip.style.background = t.color; chip.style.borderColor = t.color; }
      chip.onclick = () => {
        const i = resTrades.indexOf(key);
        if (i >= 0) resTrades.splice(i, 1); else resTrades.push(key);
        renderResTrades();
      };
      box.appendChild(chip);
    }
  }
  function openResourceDialog(row, kind) {
    curResource = row; curResKind = kind || 'resource'; resTrades = [];
    const bl = curResKind === 'bauleiter';
    document.getElementById('rTitle').textContent =
      (row ? (bl ? 'Bauleiter bearbeiten' : 'Ressourcen-Zeile bearbeiten') : (bl ? 'Neuer Bauleiter' : 'Neue Zeile anlegen'));
    document.getElementById('r-role-wrap').style.display = bl ? 'none' : ''; // Bauleiter: keine Kapazitätswirkung
    document.getElementById('r-delete').style.display = row ? '' : 'none';
    // „Einzel-Monteur" nur beim Neuanlegen (bestehende Ressourcen-Zeilen sind keine Team-Mitglieder)
    if (rTeamOpt()) rTeamOpt().hidden = !!row;
    rName.value = row ? (row.label || '') : '';
    rRole.value = row ? (row.capRole || 'none') : (bl ? 'none' : 'teammonteur');
    document.getElementById('r-monteur-type').value = 'intern';
    rName.placeholder = bl ? 'z. B. BL Becker' : 'z. B. Freddie Schoor / Sammel-Urlaub';
    renderResTrades();
    roverlay.hidden = false; rName.focus();
  }
  rRole.addEventListener('change', renderResTrades);
  function closeResourceDialog() { roverlay.hidden = true; curResource = null; }
  document.getElementById('r-save').onclick = () => {
    const name = rName.value.trim();
    if (!name) { rName.focus(); return; }
    const bl = curResKind === 'bauleiter';
    const role = bl ? 'none' : rRole.value;
    // Einzel-Monteur: als echtes Team-Mitglied anlegen (zuweisbar, mit Gewerk) statt als Kapazitätszeile
    if (!curResource && !bl && role === 'teammonteur') {
      const mtype = document.getElementById('r-monteur-type').value === 'extern' ? 'extern' : 'intern';
      const member = { id: 't' + Date.now(), name, type: mtype, trades: resTrades.slice() };
      if (mtype === 'extern') member.size = 1;   // Standard-Truppstärke; im Monteure-Dialog anpassbar
      PLAN.team.push(member);
      save(); render(); closeResourceDialog(); return;
    }
    if (curResource) {
      curResource.label = name; curResource.capRole = role;
    } else {
      const groupName = bl ? 'Bauleiter' : 'Ressourcen / Monteure';
      let g = PLAN.groups.find(x => x.name === groupName);
      if (!g) {
        g = { name: groupName, rows: [] };
        const projIdx = PLAN.groups.findIndex(x => x.name === 'Projekte');
        if (projIdx >= 0) PLAN.groups.splice(projIdx, 0, g); else PLAN.groups.push(g);
      }
      g.rows.push({ id: (bl ? 'bl' : 'res') + Date.now(), label: name, capRole: role, bars: [] });
    }
    save(); render(); closeResourceDialog();
  };
  document.getElementById('r-delete').onclick = () => {
    if (!curResource) return;
    if (!confirm(`„${curResource.label}" wirklich löschen?`)) return;
    const res = curResource;
    historyBatch(() => {
      for (const g of PLAN.groups) { const i = g.rows.indexOf(res); if (i >= 0) g.rows.splice(i, 1); }
      if (curResKind === 'bauleiter') purgePerson(res.id);
      logChange(`${curResKind === 'bauleiter' ? 'Bauleiter' : 'Zeile'} „${res.label || ''}" gelöscht`, 'zeitplan');
    });
    render(); closeResourceDialog();
  };
  document.getElementById('r-cancel').onclick = () => closeResourceDialog();
  roverlay.addEventListener('click', (e) => { if (e.target === roverlay) closeResourceDialog(); });
  roverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeResourceDialog();
    if (e.key === 'Enter') document.getElementById('r-save').click();
  });

  // ---- Monteure-Dialog ----
  const moverlay = document.getElementById('moverlay');
  const mList = document.getElementById('m-list');
  function teamCapInfo() {
    const i = internCount(), x = externCount();
    const counts = Object.keys(TRADES()).map(k => {
      const n = PLAN.team.filter(m => m.type === 'intern' && (m.trades || []).includes(k)).length;
      return `${TRADES()[k].label}: ${n}`;
    }).join(' · ');
    return `Interne Monteure: ${i} · Basis-Kapazität: ${i * 5} MT/Woche · Externe: ${x}`
         + (counts ? `<br><span class="m-cap-sub">Qualifikationen (intern): ${counts}</span>` : '');
  }
  function refreshCapInfo() { document.getElementById('m-cap').innerHTML = teamCapInfo(); }
  function renderTeamList() {
    refreshCapInfo();
    mList.innerHTML = '';
    PLAN.team.forEach((m) => {
      if (!m.trades) m.trades = [];
      const item = el('div', 'm-item');
      const row1 = el('div', 'm-row1');
      const name = document.createElement('input'); name.type = 'text'; name.value = m.name; name.placeholder = 'Name';
      name.addEventListener('input', () => { m.name = name.value; });
      let oldName = m.name;
      name.addEventListener('change', () => {
        const nn = name.value.trim();
        for (const v of (PLAN.vehicles || [])) if (oldName && v.driver === oldName) v.driver = nn;   // Stammfahrzeug folgt dem neuen Namen
        if (oldName !== nn) logChange(`Monteur umbenannt: „${oldName}" → „${nn}"`, 'zeitplan');
        m.name = nn; oldName = nn; save(); render();
      });
      const sel = document.createElement('select');
      [['intern', 'intern'], ['extern', 'extern (zubuchbar)']].forEach(([v, t]) => {
        const o = el('option', null, t); o.value = v; sel.appendChild(o);
      });
      sel.value = m.type;
      // Standard-Truppstärke – nur bei Externen
      const sizeWrap = el('label', 'm-size', 'Trupp ');
      sizeWrap.title = 'Standard-Truppstärke (Personen je Buchung) – nur extern';
      const sizeInp = document.createElement('input'); sizeInp.type = 'number'; sizeInp.min = '1'; sizeInp.step = '1'; sizeInp.value = m.size || 1;
      sizeInp.addEventListener('input', () => { m.size = Math.max(1, +sizeInp.value || 1); save(); render(); });
      sizeWrap.appendChild(sizeInp);
      sizeWrap.style.display = m.type === 'extern' ? '' : 'none';
      sel.addEventListener('change', () => {
        const toExt = sel.value === 'extern', bars = (m.bars || []).filter(b => b.cat === (toExt ? 'vacation' : 'booking'));
        if (bars.length && !confirm(`${bars.length} Eintrag/Einträge von „${m.name}" ${toExt ? 'sind Urlaub – sie werden zu Buchungen (erhöhen die Kapazität)' : 'sind Buchungen – sie werden zu Urlaub (verringern die Kapazität)'}. Fortfahren?`)) { sel.value = m.type; return; }
        for (const b of bars) b.cat = toExt ? 'booking' : 'vacation';
        m.type = sel.value;
        logChange(`Monteur „${m.name}" ist jetzt ${toExt ? 'extern' : 'intern'}`, 'zeitplan');
        if (m.type === 'extern' && !m.size) m.size = 1;
        sizeWrap.style.display = m.type === 'extern' ? '' : 'none';
        save(); render(); refreshCapInfo();
      });
      const del = el('span', 'm-del', '✕'); del.title = 'Monteur entfernen';
      del.onclick = () => {
        if (!confirm(`„${m.name}" wirklich entfernen?\nAlle Einsätze und Wochen-Einträge dieser Person werden ebenfalls entfernt.`)) return;
        historyBatch(() => {
          PLAN.team.splice(PLAN.team.indexOf(m), 1);
          const n = purgePerson(m.id);
          logChange(`Monteur „${m.name}" entfernt` + (n ? ` (${n} Einsatz-Zuordnung${n > 1 ? 'en' : ''} mit entfernt)` : ''), 'zeitplan');
        });
        render(); renderTeamList();
      };
      row1.appendChild(name); row1.appendChild(sel); row1.appendChild(sizeWrap); row1.appendChild(del);

      const chips = el('div', 'm-trades');
      for (const key of Object.keys(TRADES())) {
        const t = TRADES()[key];
        const chip = el('span', 'trade-chip' + (m.trades.includes(key) ? ' on' : ''), t.label);
        if (m.trades.includes(key)) { chip.style.background = t.color; chip.style.borderColor = t.color; }
        chip.onclick = () => {
          const idx = m.trades.indexOf(key);
          if (idx >= 0) m.trades.splice(idx, 1); else m.trades.push(key);
          save();
          const on = m.trades.includes(key);
          chip.classList.toggle('on', on);
          chip.style.background = on ? t.color : ''; chip.style.borderColor = on ? t.color : '';
          refreshCapInfo();
        };
        chips.appendChild(chip);
      }
      item.appendChild(row1); item.appendChild(chips);
      mList.appendChild(item);
    });
  }
  function openTeamDialog() { renderTeamList(); moverlay.hidden = false; }
  document.getElementById('manageTeam').onclick = openTeamDialog;
  document.getElementById('m-add').onclick = () => {
    PLAN.team.push({ id: 't' + Date.now(), name: '', type: 'intern', trades: [] });
    save(); render(); renderTeamList();
    const inputs = mList.querySelectorAll('input'); if (inputs.length) inputs[inputs.length - 1].focus();
  };
  // Schließen: angelegte, aber namenlos gebliebene Einträge wieder entfernen; Ansicht mit neuen Namen zeichnen
  function closeTeamDialog() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // offene Namensänderung übernehmen
    const before = PLAN.team.length;
    PLAN.team = PLAN.team.filter(m => (m.name || '').trim() || (m.bars || []).length);
    moverlay.hidden = true;
    if (PLAN.team.length !== before) save();
    render();
  }
  document.getElementById('m-close').onclick = closeTeamDialog;
  moverlay.addEventListener('click', (e) => { if (e.target === moverlay) closeTeamDialog(); });

  // ---- Bauleiter-Dialog (Liste analog Monteure) ----
  const bloverlay = document.getElementById('bloverlay');
  const blList = document.getElementById('bl-list');
  function bauleiterGroup() {
    let g = PLAN.groups.find(x => x.name === 'Bauleiter');
    if (!g) {
      g = { name: 'Bauleiter', rows: [] };
      const pi = PLAN.groups.findIndex(x => x.name === 'Projekte');
      if (pi >= 0) PLAN.groups.splice(pi, 0, g); else PLAN.groups.push(g);
    }
    return g;
  }
  function renderBauleiterList() {
    const g = bauleiterGroup();
    document.getElementById('bl-cap').textContent = g.rows.length + ' Bauleiter · Urlaube im Zeitplan pro Person eintragbar (ohne Wirkung auf die Monteur-Kapazität)';
    blList.innerHTML = '';
    g.rows.forEach((row) => {
      if (!row.bars) row.bars = [];
      row.capRole = 'none';
      const item = el('div', 'm-item');
      const r1 = el('div', 'm-row1');
      const name = document.createElement('input'); name.type = 'text'; name.value = row.label || ''; name.placeholder = 'Name';
      name.addEventListener('input', () => { row.label = name.value; });
      name.addEventListener('change', () => { row.label = name.value.trim(); save(); render(); });
      const del = el('span', 'm-del', '✕'); del.title = 'Bauleiter entfernen';
      del.onclick = () => {
        if (!confirm(`„${row.label || 'Bauleiter'}" wirklich entfernen?\nDie Bauleitungs-Einträge dieser Person werden ebenfalls entfernt.`)) return;
        historyBatch(() => {
          g.rows.splice(g.rows.indexOf(row), 1);
          purgePerson(row.id);
          logChange(`Bauleiter „${row.label || ''}" entfernt`, 'zeitplan');
        });
        render(); renderBauleiterList();
      };
      r1.appendChild(name); r1.appendChild(del);
      item.appendChild(r1); blList.appendChild(item);
    });
  }
  document.getElementById('manageBauleiter').onclick = () => { renderBauleiterList(); bloverlay.hidden = false; };
  document.getElementById('bl-add').onclick = () => {
    bauleiterGroup().rows.push({ id: 'bl' + Date.now(), label: '', capRole: 'none', bars: [] });
    save(); render(); renderBauleiterList();
    const inputs = blList.querySelectorAll('input'); if (inputs.length) inputs[inputs.length - 1].focus();
  };
  function closeBlDialog() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const g = PLAN.groups.find(x => x.name === 'Bauleiter');
    const before = g ? g.rows.length : 0;
    if (g) g.rows = g.rows.filter(r => (r.label || '').trim() || (r.bars || []).length);
    bloverlay.hidden = true;
    if (g && g.rows.length !== before) save();
    render();
  }
  document.getElementById('bl-close').onclick = closeBlDialog;
  bloverlay.addEventListener('click', (e) => { if (e.target === bloverlay) closeBlDialog(); });

  // ---- Projekt-Dialog (Nummer / Ort / Name) ----
  const poverlay = document.getElementById('poverlay');
  const pSite = document.getElementById('p-site');
  const pNr = document.getElementById('p-nr');
  const pOrt = document.getElementById('p-ort');
  const pName = document.getElementById('p-name');
  let curProject = null; // bestehende Zeile (bearbeiten) oder null (neu)

  const composeLabel = (nr, ort, name) => [nr, ort, name].map(s => (s || '').trim()).filter(Boolean).join(' ');
  function parseLabel(label) {
    const t = (label || '').trim().split(/\s+/).filter(Boolean);
    if (!t.length) return { nr: '', ort: '', name: '' };
    if (/\d/.test(t[0]) || /^x+$/i.test(t[0])) return { nr: t[0], ort: t[1] || '', name: t.slice(2).join(' ') };
    return { nr: '', ort: t[0] || '', name: t.slice(1).join(' ') };
  }
  // Baustellen-Modus: bei gesetzter Baustelle wird die Zeile ein Bereich (nur Bereichsname).
  function applyAreaMode() {
    const isArea = pSite.value.trim() !== '';
    document.getElementById('p-nr-wrap').style.display = isArea ? 'none' : '';
    document.getElementById('p-ort-wrap').style.display = isArea ? 'none' : '';
    document.getElementById('p-name-label').textContent = isArea ? 'Bereich' : 'Projektname';
    pName.placeholder = isArea ? 'z. B. UG, EG, 1.OG, MEK …' : 'z. B. Kantine Neubau';
  }
  pSite.addEventListener('input', applyAreaMode);

  function openProjectDialog(row, presetSite) {
    curProject = row;
    document.getElementById('pTitle').textContent = row ? (row.site ? 'Bereich bearbeiten' : 'Projekt bearbeiten') : (presetSite ? 'Neuer Bereich' : 'Neues Projekt');
    document.getElementById('p-delete').style.display = row ? '' : 'none';
    let nr = '', ort = '', name = '', site = presetSite || '';
    if (row) {
      site = row.site || '';
      if (row.site) { name = row.label || ''; }
      else if (row.nummer != null || row.ort != null || row.name != null) { nr = row.nummer || ''; ort = row.ort || ''; name = row.name || ''; }
      else { const p = parseLabel(row.label); nr = p.nr; ort = p.ort; name = p.name; }
    }
    pSite.value = site; pNr.value = nr; pOrt.value = ort; pName.value = name;
    const pa = row ? rowAddr(row) : (presetSite ? rowAddr({ site: presetSite }) : { strasse: '', plz: '' });   // neuer Bereich: Adresse der Baustelle übernehmen
    document.getElementById('p-strasse').value = pa.strasse; document.getElementById('p-plz').value = pa.plz;
    applyAreaMode();
    poverlay.hidden = false;
    (site ? pName : pNr).focus();
  }
  function closeProjectDialog() { poverlay.hidden = true; curProject = null; }

  document.getElementById('p-save').onclick = () => {
    const site = pSite.value.trim();
    const nr = pNr.value.trim(), ort = pOrt.value.trim(), name = pName.value.trim();
    if (site) {
      if (!name) { pName.focus(); return; } // Bereich braucht einen Namen
    } else if (!nr && !ort && !name) { pNr.focus(); return; }
    const fields = site
      ? { site, label: name, nummer: undefined, ort: undefined, name }
      : { site: undefined, nummer: nr, ort, name, label: composeLabel(nr, ort, name) };
    fields.strasse = document.getElementById('p-strasse').value.trim() || undefined;
    fields.plz = document.getElementById('p-plz').value.trim() || undefined;
    if (site) {   // Adresse gilt für die ganze Baustelle → auf alle Bereiche übertragen (leer lassen = vorhandene behalten)
      const pg = PLAN.groups.find(x => x.name === 'Projekte');
      if (fields.strasse || fields.plz) { for (const r of (pg ? pg.rows : [])) if (r.site === site) { r.strasse = fields.strasse; r.plz = fields.plz; } }
      else { const a = rowAddr({ site }); fields.strasse = a.strasse || undefined; fields.plz = a.plz || undefined; }
    }
    if (curProject) {
      Object.assign(curProject, fields);
      save(); render(); closeProjectDialog();
    } else {
      let g = PLAN.groups.find(x => x.name === 'Projekte');
      if (!g) { g = { name: 'Projekte', rows: [] }; PLAN.groups.push(g); }
      g.rows.push(Object.assign({ id: 'p' + Date.now(), bars: [] }, fields));
      collapsedSites.delete(site); // neu angelegten Bereich sichtbar machen
      save(); render(); closeProjectDialog();
      if (!site) viewport.scrollTop = viewport.scrollHeight;
    }
  };
  document.getElementById('p-delete').onclick = () => {
    if (!curProject) return;
    if (!confirm(`Projekt „${curProject.label}" wirklich löschen?`)) return;
    const pr = curProject;
    historyBatch(() => {
      for (const g of PLAN.groups) { const i = g.rows.indexOf(pr); if (i >= 0) g.rows.splice(i, 1); }
      logChange(`Projekt „${pr.site ? pr.site + ' · ' : ''}${pr.label}" gelöscht (${(pr.bars || []).length} Termin${(pr.bars || []).length === 1 ? '' : 'e'})`, 'zeitplan');
    });
    render(); closeProjectDialog();
  };
  document.getElementById('p-cancel').onclick = () => closeProjectDialog();
  poverlay.addEventListener('click', (e) => { if (e.target === poverlay) closeProjectDialog(); });
  poverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProjectDialog();
    if (e.key === 'Enter') document.getElementById('p-save').click();
  });

  // ---- Render & Steuerung ----
  const viewport = document.getElementById('viewport');
  function render() { viewMode === 'week' ? renderWeek() : viewMode === 'service' ? renderService() : renderTimeline(); if (typeof updateArchiveToggle === 'function') updateArchiveToggle(); }
  let weekShown = false;
  function renderTimeline() {
    weekShown = false;
    document.documentElement.style.setProperty('--dw', dayWidth + 'px');
    const sl = viewport.scrollLeft, st = viewport.scrollTop;
    const capData = computeCapacity();
    const conflicts = computeConflicts();
    const flags = new Map();
    const addFlag = (bar, reason) => { const a = flags.get(bar) || []; a.push(reason); flags.set(bar, a); };
    conflicts.forEach(bar => addFlag(bar, 'Monteur doppelt verplant'));
    capData.infeasible.forEach(bar => addFlag(bar, 'Fenster zu kurz für die Arbeitstage'));
    const sheet = el('div', 'sheet');
    sheet.appendChild(buildHeader());
    sheet.appendChild(buildCapRow(capData));
    sheet.appendChild(buildBody(flags));
    viewport.innerHTML = '';
    viewport.appendChild(sheet);
    viewport.scrollLeft = sl; viewport.scrollTop = st;
    // Beim ersten Aufbau (auch nach dem Laden der Cloud-Daten) auf die aktuelle Woche springen.
    if (scrollTodayPending) { scrollTodayPending = false; requestAnimationFrame(scrollToToday); }
  }

  // ================= WOCHEN-EINSATZPLAN =================
  const WDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  // Manuelle Zell-Typen (Zusätze) – KEIN „baustelle": Baustellen-Einsätze kommen aus dem Zeitplan
  // und würden mit type==='baustelle' beim Rendern ausgeblendet. Default = erster Eintrag (ibn).
  const CELL_TYPES = {
    montage:      { label: 'Montage' },
    bauleitung:   { label: 'Bauleitung' },
    ibn:          { label: 'IBN / Inbetriebnahme' },
    kundendienst: { label: 'Kundendienst' },
    buero:        { label: 'Büro / Info' },
    nv:           { label: 'n.v. / nicht verfügbar' },
    urlaub:       { label: 'frei' },
  };
  const CELL_TYPE_DEFAULT = 'montage';
  // Standardtext je Typ (wie in der Palette) – füllt das Textfeld, damit ein Eintrag ohne Tippen speicherbar ist
  const CELL_TYPE_TEXT = { montage: 'Montage', bauleitung: 'Bauleitung', ibn: 'IBN', kundendienst: 'Kundendienst', buero: 'Büro', nv: 'n.v.', urlaub: 'frei' };
  const CELL_TYPE_TEXT_SET = new Set(Object.keys(CELL_TYPE_TEXT).map(k => CELL_TYPE_TEXT[k]));
  const mondayMs = (ms) => { const d = new Date(ms); return addDays(ms, -((d.getUTCDay() + 6) % 7)); };
  let selMonday = mondayMs(todayMs());
  const akey = (pid, dISO) => pid + '|' + dISO;
  // Nur echte Abwesenheit gibt einen geplanten Einsatz frei. Andere manuelle Termine (Büro, IBN,
  // Kundendienst, Montage, eigener Text) bedeuten NICHT, dass die Person weg ist – sie koexistieren
  // mit dem Einsatz (z. B. nur anteilig am Tag) und werden zusätzlich angezeigt.
  const ABSENCE_TYPES = new Set(['urlaub', 'nv']);

  // ---- Fuhrpark: Fahrzeug je Person und Tag ----
  // PLAN.vehicles = Katalog (Name, Sitze, Stammfahrer per Name). PLAN.cars['pid|Datum'] = Fahrzeug-ID oder 'none'.
  // Ohne Eintrag fährt der Stammfahrer an Einsatztagen sein Stammfahrzeug.
  const vehicles = () => PLAN.vehicles || [];
  const vehById = (id) => vehicles().find(v => v.id === id) || null;
  function defaultVehOf(pid) {
    const n = (monteurName(pid) || '').trim().toLowerCase(); if (!n) return null;
    return vehicles().find(v => { const d = (v.driver || '').trim().toLowerCase(); return d && (d === n || d.startsWith(n + ' ') || n.startsWith(d + ' ')); }) || null;
  }
  // Einsatztag = Baustelle oder ein Termin, zu dem man fährt (nicht frei / n.v. / Büro)
  function carActive(pid, iso, derived) {
    const k = akey(pid, iso), d = derived[k], a = assignments[k];
    const note = (a && a.type !== 'baustelle') ? a : null;
    if (note && ABSENCE_TYPES.has(note.type)) return false;
    if (d && d.urlaub && !(d.projects || []).length) return false;
    return !!((d && d.projects.length) || (note && note.type !== 'buero') || svcDay(pid, parse(iso)).length);
  }
  // Hat die Person an dem Tag überhaupt etwas (Baustelle oder Termin, keine Abwesenheit)?
  function carPresent(pid, iso, derived) {
    const k = akey(pid, iso), d = derived[k], a = assignments[k];
    const note = (a && a.type !== 'baustelle') ? a : null;
    if (note && ABSENCE_TYPES.has(note.type)) return false;
    return !!((d && d.projects.length && !(d.urlaub && !note)) || note || svcDay(pid, parse(iso)).length);
  }
  function effVeh(pid, iso, derived) {
    const x = (PLAN.cars || {})[akey(pid, iso)];
    if (x === 'none') return null;
    if (x) return carPresent(pid, iso, derived) ? vehById(x) : null;   // alte Wahl an einem jetzt leeren Tag zählt nicht
    return carActive(pid, iso, derived) ? defaultVehOf(pid) : null;
  }
  // Belegung eines Tages: Fahrzeug-ID → Namen der Insassen
  function carOcc(iso, derived) {
    const occ = {};
    for (const p of weekPeople()) { const v = effVeh(p.id, iso, derived); if (v) (occ[v.id] = occ[v.id] || []).push(p.name); }
    return occ;
  }
  // ---- Übernachtungen: Nacht NACH einem Tag, je Person ----
  // Vorgabe aus der Phase („mit Übernachtung": jede Nacht, auf die ein weiterer Einsatztag der Person folgt),
  // in der Woche je Person/Tag überschreibbar: PLAN.nights['pid|Datum'] = 1 (ja) / 0 (nein).
  function effNight(key, der) {
    const x = (PLAN.nights || {})[key];
    return x === 1 ? true : x === 0 ? false : !!(der && der.nightDef);
  }
  function setNight(key, on, der) {
    PLAN.nights = PLAN.nights || {};
    if (!!on === !!(der && der.nightDef)) delete PLAN.nights[key]; else PLAN.nights[key] = on ? 1 : 0;
  }
  const vehLabel = (v) => v.name + (v.note ? ' (' + v.note + ')' : '');
  // Auswahl aus der Maske speichern: entspricht sie der Vorauswahl (Stammfahrzeug bzw. keines), bleibt kein Eintrag.
  function setCar(pid, iso, val, derived) {
    PLAN.cars = PLAN.cars || {};
    const k = akey(pid, iso), def = defaultVehOf(pid);
    // Stammfahrzeug nur dann „ohne Eintrag", wenn es an dem Tag ohnehin gilt (Einsatztag); sonst explizit merken
    const isDefault = def ? (val === def.id && carActive(pid, iso, derived || {})) : val === 'none';
    if (!val || isDefault) delete PLAN.cars[k]; else PLAN.cars[k] = val;
  }
  // Manuelle Abwesenheit (frei / n.v.) im Wochenkalender? Dann ist die Person an dem Tag NICHT auf dem
  // geplanten Zeitplan-Einsatz → gibt den Phasen-Platz frei (offener Bedarf).
  const weekOverride = (pid, dISO) => { const a = assignments[akey(pid, dISO)]; return !!(a && ABSENCE_TYPES.has(a.type)); };
  // Ist die Person an dem Tag laut Zeitplan im Urlaub (interner Vacation-Balken)? Dann auch nicht verfügbar.
  const onUrlaub = (pid, ms) => { const m = PLAN.team.find(t => t.id === pid); return !!(m && m.type !== 'extern' && (m.bars || []).some(b => b.cat === 'vacation' && parse(b.start) <= ms && parse(b.end) >= ms)); };
  // Zugeordnet, aber an dem Tag faktisch weg (überschrieben ODER im Urlaub) → gibt den Phasen-Platz frei.
  const unavailable = (pid, ms) => weekOverride(pid, isoStr(ms)) || onUrlaub(pid, ms);

  // Ist der (externe) Monteur in der gewählten Woche gebucht?
  function bookedThisWeek(m) {
    const w0 = selMonday, w1 = addDays(selMonday, 6);
    return (m.bars || []).some(b => parse(b.start) <= w1 && parse(b.end) >= w0);
  }
  function weekPeople() {
    // Externe nur zeigen, wenn sie in dieser Woche gebucht sind; interne immer.
    const monteure = PLAN.team
      .filter(m => m.type !== 'extern' || bookedThisWeek(m))
      .map(m => ({ id: m.id, name: m.name, kind: m.type === 'extern' ? 'extern' : 'monteur', trades: m.trades }));
    const blGroup = PLAN.groups.find(g => g.name === 'Bauleiter');
    const bauleiter = (blGroup ? blGroup.rows : []).map(r => ({ id: r.id, name: r.label, kind: 'bauleiter' }));
    return monteure.concat(bauleiter);
  }
  function weekDates() { return WDAYS.map((_, i) => addDays(selMonday, i)); }
  function barsOverlappingWeek() {
    const w0 = selMonday, w1 = addDays(selMonday, 6);
    const out = [];
    const proj = PLAN.groups.find(g => g.name === 'Projekte');
    if (!proj) return out;
    for (const row of proj.rows) for (const bar of row.bars) {
      if (parse(bar.start) <= w1 && parse(bar.end) >= w0) out.push({ row, bar });
    }
    return out;
  }
  function weekPalette() {
    // Baustellen-Einsätze kommen aus dem Zeitplan; per Palette nur manuelle Zusätze
    return [{ text: 'Montage', type: 'montage' }, { text: 'Bauleitung', type: 'bauleitung' }, { text: 'IBN', type: 'ibn' }, { text: 'Kundendienst', type: 'kundendienst' }, { text: 'Büro', type: 'buero' }, { text: 'n.v.', type: 'nv' }, { text: 'frei', type: 'urlaub' }];
  }

  // „Kleinprojekte" ist eine Sammelzeile: in der Woche zählt die Bezeichnung der einzelnen Montage,
  // nicht der Zeilentitel. `projects` bleibt der Zeilenname (Schlüssel für Verschieben/Bearbeiten).
  const isKleinRow = (row) => !!row && !row.site && /kleinprojekt/i.test(row.label || '');
  // ---- Baustellenadresse: am Projekt (Straße/PLZ + Ort), bei Kleinprojekten an der einzelnen Montage ----
  const ADDR_KEYS = ['strasse', 'plz', 'ort'];
  function setAddr(obj, src) { for (const k of ADDR_KEYS) { const v = String((src && src[k]) || '').trim(); if (v) obj[k] = v; else delete obj[k]; } }
  const addrText = (o) => o ? [o.strasse, [o.plz, o.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  // Bereiche einer Baustelle teilen sich die Adresse → notfalls beim Geschwister-Bereich nachsehen
  function rowAddr(row) {
    const g = PLAN.groups.find(x => x.name === 'Projekte');
    const src = (row.strasse || row.plz || !row.site || !g) ? row : (g.rows.find(r => r.site === row.site && (r.strasse || r.plz)) || row);
    return { strasse: src.strasse || '', plz: src.plz || '', ort: row.ort || '' };
  }
  function addrOf(row, bar) {
    if (isKleinRow(row)) return bar ? addrText(bar) : '';
    const a = rowAddr(row);
    return (a.strasse || a.plz) ? addrText(a) : '';   // Ort allein steht schon im Projektnamen
  }
  // Bereits verwendete Kleinprojekte (Bezeichnung → Adresse) als Vorschläge
  function kleinKnown() {
    const map = new Map(), g = PLAN.groups.find(x => x.name === 'Projekte');
    for (const row of (g ? g.rows : [])) {
      if (!isKleinRow(row)) continue;
      for (const b of row.bars) {
        const label = (b.label || '').trim(); if (!label) continue;
        const key = label.toLowerCase(), had = map.get(key);
        if (!had || (!addrText(had) && addrText(b))) map.set(key, { label, strasse: b.strasse || '', plz: b.plz || '', ort: b.ort || '' });
      }
    }
    return map;
  }
  function fillKleinList() {
    const dl = document.getElementById('kleinList'); if (!dl) return new Map();
    const known = kleinKnown(); dl.innerHTML = '';
    for (const k of known.values()) { const o = document.createElement('option'); o.value = k.label; const a = addrText(k); if (a) o.label = a; dl.appendChild(o); }
    return known;
  }
  const weekName = (row, bar) => (isKleinRow(row) && bar && bar.label) ? bar.label : (row.site || row.label);

  // Leitet den Wocheninhalt LIVE aus dem Zeitplan ab: je (Person, Tag) die Projekte (aus Phasen),
  // Urlaub (interne Vacation-Balken) und Buchung (externe). Basis für Doppelbuchungs-Anzeige.
  function weekDerived() {
    const map = {};
    const get = (pid, ms) => { const k = akey(pid, isoStr(ms)); return (map[k] = map[k] || { projects: [], labels: [], addrs: [], ti: [], urlaub: false, booking: false, unconfirmed: false }); };
    const eachWorkday = (s, e, cb, weekend) => {
      for (let i = 0; i < 7; i++) { const ms = addDays(selMonday, i); const dow = new Date(ms).getUTCDay(); if (!weekend && (dow === 0 || dow === 6)) continue; if (parse(s) > ms || parse(e) < ms) continue; cb(ms); }
    };
    for (const m of PLAN.team) for (const bar of (m.bars || [])) {
      if (bar.cat !== 'vacation' && bar.cat !== 'booking') continue;
      eachWorkday(bar.start, bar.end, (ms) => { const c = get(m.id, ms); if (m.type === 'extern') c.booking = true; else c.urlaub = true; });
    }
    // Archivierte Projekte zählen nirgends mit; Schlüssel ist die Zeilen-ID (Bereiche einer Baustelle sind verschieden)
    for (const row of projRows()) {
      const name = row.id;
      for (const bar of row.bars) {
        const shown = weekName(row, bar);
        const at = addrOf(row, bar), addrLine = at ? '📍 ' + shown + ': ' + at : '';
        const phases = (bar.phases && bar.phases.length) ? bar.phases
          : (bar.crew ? [{ start: bar.crew.start || bar.start, end: bar.crew.end || bar.end, assigned: bar.crew.assigned }] : []);
        const unconf = effCat(row, bar) === 'preplanning';   // „Vorplanung / nicht bestätigt"
        // Ziel für das ✉ in der Zelle: Einladung des Gewerks (Phase), bei Bauleitung die der Montage / des Projekts
        const realPh = !!(bar.phases && bar.phases.length);
        // Mehrere Gewerke derselben Person im selben Fenster → EINE Einladung mit allen diesen Gewerken
        // (alle Phasen des Fensters, in denen die Person steht – so bleibt es an jedem Tag derselbe Entwurf)
        const phOf = {};
        if (realPh) phases.forEach((ph, i) => assignedRanges(ph).forEach(r => { const a = (phOf[r.id] = phOf[r.id] || []); if (a.indexOf(i) < 0) a.push(i); }));
        const addTi = (c, pid) => { if (!c.ti.some(x => x.bar === bar)) c.ti.push({ row, bar, phIdxs: pid ? (phOf[pid] || []) : [], shown }); };
        for (const ph of phases) for (const r of assignedRanges(ph)) {
          eachWorkday(r.start, r.end, (ms) => { const c = get(r.id, ms); addTi(c, r.id);
            if (bar.hotel && !c.hotel) c.hotel = bar.hotel;
            // Übernachtung als Vorgabe, wenn die Person am Folgetag in derselben Phase weiterarbeitet
            // (Zuordnungen können taggenau zerstückelt sein → über alle Bereiche der Person prüfen)
            const nx = addDays(ms, 1);
            if (ph.overnight && (ph.weekend || isWorkdayMs(nx)) && assignedRanges(ph).some(q => q.id === r.id && parse(q.start) <= nx && parse(q.end) >= nx)) c.nightDef = true; if (isHalf(ph) && isoStr(ms) === ph.end) c.half = true; if (c.projects.indexOf(name) < 0) c.projects.push(name); if (c.labels.indexOf(shown) < 0) c.labels.push(shown); if (addrLine && c.addrs.indexOf(addrLine) < 0) c.addrs.push(addrLine); if (unconf) c.unconfirmed = true; }, !!ph.weekend);
        }
        // Bauleitung: dem Bauleiter die Baustelle des Tages zuordnen
        for (const r of blRanges(bar)) {
          eachWorkday(r.start, r.end, (ms) => { const c = get(r.id, ms); addTi(c, null); if (c.projects.indexOf(name) < 0) c.projects.push(name); if (c.labels.indexOf(shown) < 0) c.labels.push(shown); if (addrLine && c.addrs.indexOf(addrLine) < 0) c.addrs.push(addrLine); if (unconf) c.unconfirmed = true; });
        }
      }
    }
    return map;
  }

  // Offener Bedarf: je Projekt-Phase und Werktag, wie viele Monteure des Gewerks gefordert (count)
  // aber noch NICHT zugeordnet sind. Basis für die Sektion „Offener Bedarf" in der Woche.
  function weekOpenDemand() {
    const wdays = weekDates(), out = [];
    for (const row of projRows()) {
      const name = row.site || row.label;
      for (const bar of row.bars) {
        const eff = (bar.phases && bar.phases.length) ? bar.phases
          : (bar.crew ? [{ trade: bar.crew.trade, start: bar.crew.start || bar.start, end: bar.crew.end || bar.end, count: bar.crew.count, assigned: bar.crew.assigned }] : []);
        eff.forEach((ph, idx) => {
          const need = +ph.count || 0; if (need <= 0) return;
          const ranges = assignedRanges(ph), days = {}; let anyOpen = false;
          for (let i = 0; i < 7; i++) {
            const ms = wdays[i]; const dow = new Date(ms).getUTCDay(); if (!ph.weekend && (dow === 0 || dow === 6)) continue;
            if (parse(ph.start) > ms || parse(ph.end) < ms) continue;   // Phase an dem Tag nicht aktiv
            const iso = isoStr(ms);
            // Zugeordnete an dem Tag, aber faktisch weg (überschrieben oder im Urlaub) zählen NICHT als besetzt
            const have = sumPersons(new Set(ranges.filter(r => parse(r.start) <= ms && parse(r.end) >= ms).map(r => r.id).filter(id => !unavailable(id, ms))));
            const open = need - have;
            if (open > 0) { days[isoStr(ms)] = open; anyOpen = true; }
          }
          if (anyOpen) out.push({ name: weekName(row, bar), trade: ph.trade || '', row, bar, idx, days });
        });
      }
    }
    return out;
  }

  // Überblick der BESTÄTIGTEN Montagen in der gewählten Woche: je Baustelle/Fenster und Werktag,
  // wie viele Monteure eingeplant sind. Tage ohne Monteur (auch: kein Gewerk vorgeplant) werden
  // als Lücke markiert – damit eine bestätigte Montage ohne Einsatzplanung sofort auffällt.
  function weekConfirmedSites() {
    const wdays = weekDates(), out = [];
    const w0 = selMonday, w1 = addDays(selMonday, 6);
    for (const row of projRows()) {
      for (const bar of row.bars) {
        // Bestätigte Fenster immer; andere Projekt-Fenster (z. B. Vorplanung) nur, wenn in der Woche Monteure eingeplant sind
        const ec = effCat(row, bar), confirmed = ec === 'confirmed';
        if (ec === 'vacation' || ec === 'booking' || ec === 'bauleitung') continue;
        if (parse(bar.start) > w1 || parse(bar.end) < w0) continue;
        const phases = (bar.phases && bar.phases.length) ? bar.phases
          : (bar.crew ? [{ start: bar.crew.start || bar.start, end: bar.crew.end || bar.end, assigned: bar.crew.assigned, weekend: false }] : []);
        const perDay = [], perDayIds = []; let anyGap = false, anyActive = false, anyPlanned = false, anyStaffed = false;
        for (let i = 0; i < 7; i++) {
          const ms = wdays[i], dow = new Date(ms).getUTCDay(), weekendDay = (dow === 0 || dow === 6);
          const inWindow = parse(bar.start) <= ms && parse(bar.end) >= ms;
          if (!inWindow) { perDay.push(null); continue; }
          const ids = new Set(); let phaseActive = false; perDayIds[i] = ids;
          for (const ph of phases) {
            if (parse(ph.start) <= ms && parse(ph.end) >= ms) {
              phaseActive = true;
              for (const r of assignedRanges(ph)) if (parse(r.start) <= ms && parse(r.end) >= ms && !unavailable(r.id, ms)) ids.add(r.id);
            }
          }
          // Wochenende nur zeigen, wenn dort tatsächlich ein (Wochenend-)Einsatz liegt – sonst keine Lücke melden.
          if (weekendDay && !phaseActive) { perDay.push(null); continue; }
          anyActive = true;
          // Fenster ohne Phase an dem Tag: kein Bedarf geplant → neutral, keine Warnung
          if (!phaseActive) { perDay.push('idle'); continue; }
          anyPlanned = true;
          const n = sumPersons(ids);   // Personen (inkl. Truppstärke), nicht nur Köpfe
          if (n > 0) anyStaffed = true;
          if (n === 0 && !confirmed) { perDay.push('idle'); continue; }   // unbestätigt: fehlende Besetzung ist noch keine Lücke
          if (n === 0) anyGap = true;
          perDay.push(n);
        }
        if (!confirmed && !anyStaffed) continue;
        if (anyActive) out.push({ name: weekName(row, bar), sub: isKleinRow(row) ? '' : (bar.label || ''), perDay, perDayIds, anyGap, anyPlanned, unconfirmed: !confirmed, row, bar });
      }
    }
    // Reine Fenster (in dieser Woche kein Einsatz geplant) ans Ende – oben stehen die laufenden Montagen
    return out.filter(o => o.anyPlanned).concat(out.filter(o => !o.anyPlanned));
  }

  // Kleines Auswahlmenü, um einen offenen Bedarf direkt in der Woche taggenau zu besetzen.
  let needMenu = null;
  function closeNeedMenu() { if (needMenu) { needMenu.remove(); needMenu = null; document.removeEventListener('mousedown', onNeedDocDown, true); } }
  function onNeedDocDown(e) { if (needMenu && !needMenu.contains(e.target)) closeNeedMenu(); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && needMenu) closeNeedMenu(); });
  document.getElementById('viewport').addEventListener('scroll', () => { if (needMenu) closeNeedMenu(); }, { passive: true });
  function openNeedPicker(cell, row, bar, idx, dISO, trade) {
    closeNeedMenu();
    // Phase mit definiertem Gewerk: direkt nutzen. Leerer Auto-Bedarf (kein Gewerk): erst beim
    // Zuordnen materialisieren – dann mit dem Gewerk des gewählten Monteurs (nicht pauschal Edelstahl).
    const ph = (trade && bar.phases && bar.phases[idx]) ? bar.phases[idx] : null;
    if (!ph && !bar.crew) return;
    const t = TRADES()[trade] || { label: '(Gewerk offen)' };
    const ms = parse(dISO);
    needMenu = el('div', 'need-menu');
    needMenu.appendChild(el('div', 'need-menu-head', t.label + ' · ' + WDAYS[(new Date(ms).getUTCDay() + 6) % 7] + ' ' + fmt(ms).slice(0, 6) + ' · ' + (row.site || row.label)));
    const cands = PLAN.team.filter(m => (!trade || qualifies(m, trade)) && (m.type !== 'extern' || bookedThisWeek(m)));
    if (!cands.length) needMenu.appendChild(el('div', 'need-menu-empty', 'Kein qualifizierter Monteur verfügbar'));
    const der = weekDerived();
    for (const m of cands) {
      const stt = der[akey(m.id, dISO)] || { projects: [], urlaub: false };
      const busy = stt.urlaub ? 'Urlaub' : ((stt.labels || []).length ? stt.labels.join(', ') : '');
      const b = el('button', 'need-menu-item' + (busy ? ' busy' : ''));
      b.appendChild(el('span', null, m.name + (m.type === 'extern' ? ' (ext)' : '')));
      if (busy) b.appendChild(el('span', 'need-menu-busy', busy));
      b.onclick = () => {
        const useTrade = trade || firstTradeOf(m);            // leerer Bedarf → Gewerk des Monteurs
        const target = ph || getOrCreatePhase(bar, useTrade);
        addToPhase(target, m.id, dISO);
        const pnm = row.site || row.label, tl = (TRADES()[useTrade] && TRADES()[useTrade].label) || useTrade || 'Gewerk';
        logChange(`${m.name} zugeordnet: ${pnm} · ${tl} am ${fmt(parse(dISO))}`, 'woche');
        save(); closeNeedMenu(); renderWeek();
      };
      needMenu.appendChild(b);
    }
    document.body.appendChild(needMenu);
    const r = cell.getBoundingClientRect();
    needMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - needMenu.offsetWidth - 8)) + 'px';
    needMenu.style.top = (r.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onNeedDocDown, true), 0);
  }

  // Kontextmenü an einer Personen-Namenszelle: ganze Woche (Mo–Fr) kopieren / einfügen
  function openPersonMenu(x, y, p) {
    closeNeedMenu();
    needMenu = el('div', 'need-menu');
    needMenu.appendChild(el('div', 'need-menu-head', p.name + ' · Woche'));
    const copyBtn = el('button', 'need-menu-item'); copyBtn.appendChild(el('span', null, 'Woche kopieren (Mo–Fr)'));
    copyBtn.onclick = () => { copyPersonWeek(p); closeNeedMenu(); };
    needMenu.appendChild(copyBtn);
    if (clip && clip.kind === 'personweek') {
      const pasteBtn = el('button', 'need-menu-item'); pasteBtn.appendChild(el('span', null, 'Woche einfügen von ' + clip.fromName));
      pasteBtn.onclick = () => { pastePersonWeek(p); closeNeedMenu(); };
      needMenu.appendChild(pasteBtn);
    }
    document.body.appendChild(needMenu);
    needMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - needMenu.offsetWidth - 8)) + 'px';
    needMenu.style.top = Math.max(8, Math.min(y + 4, window.innerHeight - needMenu.offsetHeight - 8)) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onNeedDocDown, true), 0);
  }
  function copyPersonWeek(p) {
    const der = weekDerived(), days = [];
    for (let i = 0; i < 5; i++) {
      const ms = addDays(selMonday, i), key = akey(p.id, isoStr(ms));
      const projects = dayEntries(p, ms, p.kind === 'bauleiter');
      const a = assignments[key];
      days.push({ projects, note: (a && a.type !== 'baustelle') ? { text: a.text, type: a.type } : null });
    }
    clip = { kind: 'personweek', fromName: p.name, fromKind: p.kind, days };
    toast('Woche von ' + p.name + ' kopiert – Rechtsklick auf Zielperson → „Woche einfügen"');
  }
  function pastePersonWeek(p) {
    if (!clip || clip.kind !== 'personweek') return;
    if ((clip.fromKind === 'bauleiter') !== (p.kind === 'bauleiter')) { toast('Woche einer Bauleitung lässt sich nur auf Bauleiter übertragen, die eines Monteurs nur auf Monteure.'); return; }
    const der = weekDerived();
    historyBatch(() => {
    for (let i = 0; i < 5; i++) {
      const ms = addDays(selMonday, i), dISO = isoStr(ms), key = akey(p.id, dISO);
      const targetProjects = (der[key] || { projects: [] }).projects.slice();
      removePersonDay(p.id, dISO, targetProjects);
      delete assignments[key];
      const day = clip.days[i] || { projects: [], note: null };
      for (const e of day.projects) { const row = projRows().find(r => r.id === e.rowId); if (!row) continue; if (e.bl) assignBauleitung(p.id, ms, row, e); else assignWeekProject(p.id, ms, row, e.gewerk, e); }
      if (day.note) assignments[key] = { text: day.note.text, type: day.note.type, auto: false };
    }
    logChange(`Woche von ${clip.fromName} auf ${p.name} übertragen`, 'woche');
    });
    renderWeek();
  }

  // Eingeklappte Bereiche der Woche (pro Browser gemerkt)
  const WK_COLLAPSE_KEY = 'montageplanung_wk_collapsed';
  const wkCollapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(WK_COLLAPSE_KEY)) || []; } catch (e) { return []; } })());
  function renderWeek() {
    const sl = weekShown ? viewport.scrollLeft : 0, st = viewport.scrollTop;   // erst beim Wechsel in die Woche links beginnen
    closeNeedMenu();
    const dates = weekDates();
    const kw = isoWeek(selMonday), year = new Date(selMonday).getUTCFullYear();
    document.getElementById('wkLabel').textContent = `KW ${kw} · ${fmt(selMonday)} – ${fmt(addDays(selMonday, 6))}  (${year})`;

    // Palette
    const pal = document.getElementById('wkPalette'); pal.innerHTML = '';
    for (const chip of weekPalette()) {
      const c = el('span', 'wk-chip t-' + chip.type, chip.text);
      c.draggable = true;
      c.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', JSON.stringify({ palette: chip })));
      pal.appendChild(c);
    }

    const grid = el('div', 'weekgrid');
    const today = todayMs();
    const dayCls = (i) => (i >= 5 ? ' weekend' : '') + (dates[i] === today ? ' today' : '');
    // Bereichs-Kopf über die ganze Breite; Klick klappt den Bereich ein/aus. Liefert true, wenn der Bereich offen ist.
    const addSection = (key, text, cls) => {
      const closed = wkCollapsed.has(key);
      const sep = el('div', 'wk-sep' + (cls ? ' ' + cls : '') + (closed ? ' closed' : ''));
      const inner = el('span', 'wk-sep-inner');
      inner.appendChild(el('span', 'wk-sep-arrow', closed ? '▸' : '▾'));
      inner.appendChild(document.createTextNode(text));
      sep.appendChild(inner);
      sep.title = closed ? 'Bereich aufklappen' : 'Bereich einklappen';
      sep.addEventListener('click', () => {
        if (closed) wkCollapsed.delete(key); else wkCollapsed.add(key);
        try { localStorage.setItem(WK_COLLAPSE_KEY, JSON.stringify([...wkCollapsed])); } catch (e) {}
        renderWeek();
      });
      grid.appendChild(sep);
      return !closed;
    };
    grid.appendChild(el('div', 'wk-corner', 'KW ' + kw));
    dates.forEach((ms, i) => {
      const h = el('div', 'wk-dayhead' + dayCls(i));
      h.innerHTML = `${WDAYS[i]} <small>${fmt(ms).slice(0, 6)}</small>`;
      grid.appendChild(h);
    });

    const derived = weekDerived();

    // Sektion „Bestätigte Montagen diese Woche" – Überblick + Warnung, wenn kein Monteur eingeplant ist
    const sites = weekConfirmedSites();
    if (sites.length) {
      const gaps = sites.filter(s => s.anyGap).length;
      const open = addSection('sites', 'Baustellen · Montagen diese Woche (' + sites.length + ')' + (gaps ? ' · ' + gaps + '× ohne Monteur' : ''), 'wk-sep-sites');
      for (const s of (open ? sites : [])) {
        const nameCell = el('div', 'wk-name wk-site-name' + (s.anyGap ? ' wk-site-gap' : '') + (s.anyPlanned ? '' : ' wk-site-idle-name') + (s.unconfirmed ? ' wk-site-unconf-name' : ''));
        if (s.anyGap) { const w = el('span', 'wk-warn', '⚠'); nameCell.appendChild(w); }
        nameCell.appendChild(el('span', 'wk-site-text', s.name + (s.sub ? ' · ' + s.sub : '')));
        // Termineinladung: Kleinprojekt → je Montage (eigener Entwurf), sonst der Projekt-Entwurf wie im Zeitplan
        const ti = el('span', 'wk-ti', '✉'); ti.title = 'Termineinladung erstellen';
        ti.addEventListener('click', (e) => { e.stopPropagation(); openTermineinladung(s.row, isKleinRow(s.row) ? s.bar : null); });
        nameCell.appendChild(ti);
        nameCell.title = s.name + (s.sub ? ' · ' + s.sub : '') + (s.unconfirmed ? '\nNoch nicht bestätigt (' + ((PLAN.categories[s.bar.cat] || {}).label || 'Vorplanung') + ') – Monteure sind aber schon eingeplant.' : '') + (addrOf(s.row, s.bar) ? '\n📍 ' + addrOf(s.row, s.bar) : '') + (s.anyGap ? '\n⚠ An mindestens einem Tag ist ein Einsatz geplant, aber kein Monteur zugeordnet.' : '') + (s.anyPlanned ? '' : '\nMontagefenster – in dieser Woche noch kein Einsatz geplant.') + '\nKlick: Einsatz bearbeiten';
        nameCell.addEventListener('click', () => openEditor(s.row, s.bar, false));
        grid.appendChild(nameCell);
        dates.forEach((ms, i) => {
          const n = s.perDay[i];
          const cell = el('div', 'wk-cell wk-site-cell' + dayCls(i));
          if (n === null) { /* außerhalb des Fensters – leer */ }
          else if (n === 'idle') {
            cell.classList.add('wk-site-idle');
            cell.title = 'Montagefenster – noch kein Einsatz geplant · klicken zum Bearbeiten';
            cell.addEventListener('click', () => openEditor(s.row, s.bar, false));
          }
          else if (n === 0) {
            cell.classList.add('wk-site-nostaff'); cell.textContent = '—';
            cell.title = 'Einsatz geplant, aber kein Monteur zugeordnet · klicken zum Bearbeiten';
            cell.addEventListener('click', () => openEditor(s.row, s.bar, false));
          } else {
            cell.classList.add('wk-site-ok'); cell.textContent = n + '×';
            // Übernachtungen dieser Baustelle in der Nacht nach dem Tag (= zu buchende Betten)
            const dIso = isoStr(ms), nn = [...(s.perDayIds[i] || [])].filter(id => effNight(akey(id, dIso), derived[akey(id, dIso)])).length;
            if (nn) { cell.appendChild(el('span', 'wk-site-night', '🌙 ' + nn)); }
            if (s.unconfirmed) cell.classList.add('wk-site-unconf');
            cell.title = n + ' Monteur' + (n > 1 ? 'e' : '') + ' eingeplant' + (nn ? ' · ' + nn + ' Übernachtung' + (nn > 1 ? 'en' : '') + (s.bar.hotel ? ' (' + s.bar.hotel + ')' : '') : '') + (s.unconfirmed ? ' – Termin noch nicht bestätigt' : '') + ' · klicken zum Bearbeiten';
            cell.addEventListener('click', () => openEditor(s.row, s.bar, false));
          }
          grid.appendChild(cell);
        });
      }
    }

    // Sektion „Offener Bedarf" – Gewerke, die im Zeitplan gefordert, aber noch nicht besetzt sind
    const needs = weekOpenDemand();
    if (needs.length) {
      const secOpen = addSection('need', 'Offener Bedarf – noch niemand zugeordnet (' + needs.length + ')', 'wk-sep-need');
      for (const nd of (secOpen ? needs : [])) {
        const t = TRADES()[nd.trade] || { label: '(Gewerk offen)', short: '', color: '#999' };
        const nameCell = el('div', 'wk-name wk-need-name');
        const dot = el('span', 'need-dot'); dot.style.background = t.color; nameCell.appendChild(dot);
        nameCell.appendChild(document.createTextNode(nd.name + ' · ' + t.label));
        nameCell.title = nd.name + ' · ' + t.label;
        grid.appendChild(nameCell);
        dates.forEach((ms, i) => {
          const dISO = isoStr(ms), open = nd.days[dISO] || 0;
          const cell = el('div', 'wk-cell wk-need-cell' + dayCls(i) + (open ? ' wk-need' : ''));
          if (open) {
            cell.textContent = open + '×' + (t.short ? ' ' + t.short : '');
            cell.style.setProperty('--need-col', t.color);
            cell.title = t.label + ' – ' + open + ' Monteur' + (open > 1 ? 'e' : '') + ' offen (' + nd.name + ') · klicken zum Bearbeiten';
            cell.addEventListener('click', () => openEditor(nd.row, nd.bar, false));   // volle Editor-Maske wie im Zeitplan
          }
          grid.appendChild(cell);
        });
      }
    }

    const occByDay = dates.map(ms => carOcc(isoStr(ms), derived));
    const people = weekPeople();
    const nBl = people.filter(p => p.kind === 'bauleiter').length;
    let lastSec = null, secOpen = true;
    for (const p of people) {
      const sec = p.kind === 'bauleiter' ? 'bl' : 'mont';
      if (sec !== lastSec) {
        lastSec = sec;
        secOpen = sec === 'bl' ? addSection('bl', 'Bauleitung (' + nBl + ')', 'wk-sep-bl')
          : addSection('mont', 'Monteure (' + (people.length - nBl) + ')', 'wk-sep-mont');
      }
      if (!secOpen) continue;
      const nameCell = el('div', 'wk-name wk-person' + (p.kind === 'extern' ? ' extern' : ''));
      nameCell.dataset.kind = p.kind;
      nameCell.appendChild(el('span', 'wk-person-name', p.name));
      // Gewerke des Monteurs als farbige Kürzel – hilft beim Besetzen von offenem Bedarf
      const ptr = (p.trades || []).filter(k => TRADES()[k]);
      if (ptr.length) nameCell.appendChild(tradeTags(ptr));
      nameCell.title = p.name + (p.kind === 'extern' ? ' (extern)' : '') + (ptr.length ? '\nGewerke: ' + ptr.map(k => TRADES()[k].label).join(', ') : '') + '\nRechtsklick: Woche kopieren / einfügen';
      nameCell.addEventListener('contextmenu', (e) => { e.preventDefault(); openPersonMenu(e.clientX, e.clientY, p); });
      grid.appendChild(nameCell);
      dates.forEach((ms, i) => {
        const dISO = isoStr(ms), key = akey(p.id, dISO);
        const der = derived[key] || { projects: [], urlaub: false, booking: false };
        const svc = svcDay(p.id, ms);
        const manualNote = (assignments[key] && assignments[key].type !== 'baustelle') ? assignments[key] : null;
        // Kundendienst-Termine verhalten sich wie ein Termin der Person (neben einer Baustelle möglich)
        const svcTxt = svc.map(x => 'Wartung ' + (x.s.kunde || '') + (x.s.ort ? ' ' + x.s.ort : '')).join(' / ');
        const note = svc.length ? { text: (manualNote ? manualNote.text + ' · ' : '') + svcTxt, type: manualNote && ABSENCE_TYPES.has(manualNote.type) ? manualNote.type : 'kundendienst', svc: true } : manualNote;
        const proj = der.projects;
        const disp = (der.labels && der.labels.length) ? der.labels : proj;   // Anzeige (Kleinprojekte: Bezeichnung der Montage)
        let text = '', type = '', conflict = false, title = '', unconfirmed = false, override = false, split = false, extra = '', extraType = '';
        const noteAbsence = note && ABSENCE_TYPES.has(note.type);
        if (note && proj.length && !noteAbsence) {
          // Kombinierter Tag: geplanter Einsatz UND manueller Termin bleiben beide bestehen (z. B. nur anteilig).
          type = 'baustelle'; split = disp.length > 1;
          text = disp.join(' / '); extra = note.text; extraType = note.type;
          if (der.unconfirmed) unconfirmed = true;
          title = 'Geplanter Einsatz: ' + disp.join(', ') + '\n+ Termin: ' + note.text + '\n(gleicher Tag – evtl. nur anteilig; beide bleiben bestehen)';
        } else if (note) {
          text = note.text; type = note.type;
          if (proj.length) { conflict = true; override = true; title = 'Überschreibt geplanten Einsatz: ' + disp.join(', ') + ' → dieser Einsatz ist jetzt offener Bedarf. (manuell hier: „' + note.text + '")'; }
        } else if (der.urlaub && proj.length) {
          conflict = true; type = 'nv'; text = 'frei + ' + disp.join(', '); title = 'Konflikt: als frei markiert, aber Einsatz geplant (' + disp.join(', ') + ')';
        } else if (der.urlaub) {
          type = 'urlaub'; text = 'frei';
        } else if (disp.length > 1) {
          // Mehrere Baustellen an einem Tag. Bei Monteuren „geteilter Tag" (blau gestreift); bei
          // Bauleitern bleibt es einfarbig violett (mehrere Baustellen sind für die Bauleitung normal).
          type = (p.kind === 'bauleiter') ? 'bauleitung' : 'baustelle'; split = (p.kind !== 'bauleiter'); text = disp.join(' / '); title = disp.length + ' Baustellen an diesem Tag: ' + disp.join(', ');
        } else if (proj.length) {
          type = (p.kind === 'bauleiter') ? 'bauleitung' : 'baustelle'; text = disp[0]; title = (p.kind === 'bauleiter' ? 'Bauleitung: ' : '') + disp[0];
          if (der.unconfirmed) { unconfirmed = true; title += ' — noch nicht bestätigt (Vorplanung)'; }
        }
        if (der.half && proj.length && type !== 'nv' && !(note && !extra)) { text += ' · ½ Tag'; title += (title ? '\n' : '') + 'Halber Montagetag'; }
        const cell = el('div', 'wk-cell' + dayCls(i) + (type ? ' t-' + type : '') + (conflict ? ' wk-conflict' : '') + (unconfirmed ? ' wk-unconfirmed' : '') + (override ? ' wk-override' : '') + (split ? ' wk-split' : ''));
        cell.dataset.key = key;
        if (text) cell.textContent = text;
        if (extra) {
          cell.classList.add('wk-combined');
          const chip = el('span', 'wk-extra' + (extraType ? ' t-' + extraType : ''), extra);
          cell.appendChild(chip);
        }
        if (proj.length && der.addrs && der.addrs.length) title += (title ? '\n' : '') + der.addrs.join('\n');
        // Fahrzeug des Tages (Stammfahrzeug oder gewählt); rot, wenn mehr Personen als Sitze
        const veh = effVeh(p.id, dISO, derived);
        if (veh) {
          const occ = occByDay[i][veh.id] || [], over = occ.length > (+veh.seats || 0);
          title += (title ? '\n' : '') + '🚐 ' + vehLabel(veh) + ' · ' + occ.length + '/' + veh.seats + ' Sitze: ' + occ.join(', ') + (over ? '\n⚠ Mehr Personen als Sitze!' : '');
        }
        const night = effNight(key, der) && (proj.length || (note && !noteAbsence));
        if (night) title += (title ? '\n' : '') + '🌙 Übernachtung nach diesem Tag' + (der.hotel ? ' · ' + der.hotel : '');
        if (title) cell.title = title;
        // Marken am rechten Zellenrand: 🌙 Übernachtung · Fahrzeug · ✉
        const badges = el('span', 'wk-badges');
        if (night) badges.appendChild(el('span', 'wk-night', '🌙'));
        if (veh) badges.appendChild(el('span', 'wk-car' + ((occByDay[i][veh.id] || []).length > (+veh.seats || 0) ? ' over' : ''), veh.name));
        // ✉ Termineinladung direkt aus der Zelle: für das Gewerk, in dem die Person an dem Tag eingeplant ist
        if (proj.length && der.ti && der.ti.length) {
          const openTi = (t) => openTermineinladung(t.row, (t.phIdxs.length || isKleinRow(t.row)) ? t.bar : null, t.phIdxs);
          const tiLabel = (t) => t.shown + (t.phIdxs.length ? ' · ' + tiTradeLabels(t.bar, t.phIdxs) : '');
          const ti = el('span', 'wk-cell-ti', '✉');
          ti.title = 'Termineinladung' + (der.ti.length === 1 ? ' · ' + tiLabel(der.ti[0]) : ' (Auswahl)');
          ti.addEventListener('click', (e) => {
            e.stopPropagation();
            if (der.ti.length === 1) { openTi(der.ti[0]); return; }
            closeNeedMenu();
            needMenu = el('div', 'need-menu');
            needMenu.appendChild(el('div', 'need-menu-head', 'Termineinladung für …'));
            for (const t of der.ti) { const b = el('button', 'need-menu-item'); b.appendChild(el('span', null, tiLabel(t))); b.onclick = () => { closeNeedMenu(); openTi(t); }; needMenu.appendChild(b); }
            document.body.appendChild(needMenu);
            needMenu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - needMenu.offsetWidth - 8)) + 'px';
            needMenu.style.top = Math.max(8, Math.min(e.clientY + 4, window.innerHeight - needMenu.offsetHeight - 8)) + 'px';
            setTimeout(() => document.addEventListener('mousedown', onNeedDocDown, true), 0);
          });
          badges.appendChild(ti);
        }
        if (badges.childNodes.length) {
          cell.classList.add('wk-has-badges');
          cell.style.paddingRight = (8 + (night ? 18 : 0) + (veh ? 46 : 0) + (badges.querySelector('.wk-cell-ti') ? 16 : 0)) + 'px';
          cell.appendChild(badges);
        }
        // Baustellen-Einsatz (aus dem Zeitplan) lässt sich taggenau auf eine andere Person/einen anderen Tag ziehen
        // (nur Monteure – Bauleitung wird nicht per Gewerk-Phase verschoben)
        if (proj.length && !note && !der.urlaub && p.kind !== 'bauleiter') {
          cell.draggable = true;
          const pj = proj.slice(), fd = dISO, fid = p.id;
          cell.addEventListener('dragstart', (e) => { cell.classList.add('dragging'); e.dataTransfer.setData('text/plain', JSON.stringify({ move: { fromId: fid, fromDate: fd, projects: pj } })); });
          cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
        } else if (manualNote && !svc.length) {
          // Manuelle Notiz (Büro/n.v./Urlaub/…) auf eine andere Zelle verschieben
          cell.draggable = true;
          const nk = key, ntext = note.text, ntype = note.type;
          cell.addEventListener('dragstart', (e) => { cell.classList.add('dragging'); e.dataTransfer.setData('text/plain', JSON.stringify({ noteMove: { fromKey: nk, text: ntext, type: ntype } })); });
          cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
        }
        // Manuelle Zusätze (Büro/n.v. …) per Palette-Drop; Baustellen-Einsätze per Zellen-Drag
        cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drop'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
        cell.addEventListener('drop', (e) => {
          e.preventDefault(); cell.classList.remove('drop');
          let data; try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (_) { return; }
          if (data.palette) {
            assignments[key] = { text: data.palette.text, type: data.palette.type, auto: false };
            logChange(`Notiz „${data.palette.text}" gesetzt (${p.name}, ${fmt(ms)})`, 'woche');
            save(); renderWeek();
          }
          else if (data.noteMove) {
            // Manuelle Notiz auf diese Zelle verschieben (aus der Quellzelle entfernen)
            if (data.noteMove.fromKey !== key) {
              delete assignments[data.noteMove.fromKey];
              assignments[key] = { text: data.noteMove.text, type: data.noteMove.type, auto: false };
              logChange(`Notiz „${data.noteMove.text}" verschoben → ${p.name}, ${fmt(ms)}`, 'woche');
              save(); renderWeek();
            }
          }
          else if (data.move && p.kind === 'bauleiter') { toast('Monteur-Einsätze lassen sich nicht auf die Bauleitung ziehen.'); }
          else if (data.move) {
            // andere Person = Übergabe dieses Tages; gleiche Person, anderer Tag = verschieben – sind im Einsatz noch
            // andere eingeplant, nachfragen: nur diese Person oder den ganzen Einsatz (sonst wandern alle mit)
            if (data.move.fromId !== p.id) { weekReassign(data.move.fromId, data.move.fromDate, p.id, dISO, data.move.projects); renderWeek(); }
            else if (data.move.fromDate !== dISO) {
              const D = parse(data.move.fromDate);
              let hit = null;
              for (const row of projRows()) if ((data.move.projects || []).indexOf(row.id) >= 0) for (const b of row.bars)
                if (!hit && (b.phases || []).some(ph => assignedRanges(ph).some(r => r.id === p.id && parse(r.start) <= D && parse(r.end) >= D))) hit = b;
              const others = hit ? [...new Set((hit.phases || []).flatMap(ph => assignedRanges(ph).map(r => r.id)))].filter(id => id !== p.id) : [];
              const dayTxt = WDAYS[(new Date(ms).getUTCDay() + 6) % 7] + ' ' + fmt(ms).slice(0, 6);
              if (!others.length) { weekShiftEinsatz(p.id, data.move.fromDate, dISO, data.move.projects); renderWeek(); }
              else {
                closeNeedMenu();
                needMenu = el('div', 'need-menu');
                needMenu.appendChild(el('div', 'need-menu-head', 'Verschieben auf ' + dayTxt));
                const b1 = el('button', 'need-menu-item'); b1.appendChild(el('span', null, 'Nur ' + p.name + ' verschieben'));
                b1.onclick = () => { closeNeedMenu(); weekReassign(p.id, data.move.fromDate, p.id, dISO, data.move.projects); renderWeek(); };
                const b2 = el('button', 'need-menu-item'); b2.appendChild(el('span', null, 'Ganzen Einsatz verschieben'));
                b2.appendChild(el('span', 'need-menu-busy', 'mit ' + others.map(monteurName).join(', ')));
                b2.onclick = () => { closeNeedMenu(); weekShiftEinsatz(p.id, data.move.fromDate, dISO, data.move.projects); renderWeek(); };
                const b3 = el('button', 'need-menu-item'); b3.appendChild(el('span', null, 'Abbrechen')); b3.onclick = () => closeNeedMenu();
                needMenu.appendChild(b1); needMenu.appendChild(b2); needMenu.appendChild(b3);
                document.body.appendChild(needMenu);
                needMenu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth - needMenu.offsetWidth - 8)) + 'px';
                needMenu.style.top = Math.max(8, Math.min(e.clientY + 4, window.innerHeight - needMenu.offsetHeight - 8)) + 'px';
                setTimeout(() => document.addEventListener('mousedown', onNeedDocDown, true), 0);
              }
            }
          }
        });
        cell.addEventListener('click', () => openCellEditor(key, p, ms));
        grid.appendChild(cell);
      });
    }
    // Bereich „Fahrzeuge": wer fährt an welchem Tag womit – freie Fahrzeuge und Überbelegung auf einen Blick
    if (vehicles().length && addSection('cars', 'Fahrzeuge (' + vehicles().length + ')', 'wk-sep-cars')) {
      for (const v of vehicles()) {
        const nameCell = el('div', 'wk-name wk-car-name');
        nameCell.appendChild(el('span', 'wk-person-name', vehLabel(v)));
        nameCell.appendChild(el('span', 'wk-car-seats', v.seats + ' Sitze'));
        nameCell.title = vehLabel(v) + ' · ' + v.seats + ' Sitze' + (v.driver ? '\nIn der Regel: ' + v.driver : '\nFrei verfügbar');
        grid.appendChild(nameCell);
        dates.forEach((ms, i) => {
          const occ = occByDay[i][v.id] || [], over = occ.length > (+v.seats || 0);
          const cell = el('div', 'wk-cell wk-car-cell' + dayCls(i) + (occ.length ? ' used' : '') + (over ? ' over' : ''));
          if (occ.length) { cell.textContent = occ.join(', ') + ' (' + occ.length + '/' + v.seats + ')'; cell.title = occ.join(', ') + (over ? '\n⚠ Mehr Personen als Sitze!' : ''); }
          grid.appendChild(cell);
        });
      }
    }
    viewport.innerHTML = '';
    viewport.appendChild(grid);
    viewport.scrollLeft = sl; viewport.scrollTop = st;
    weekShown = true;
  }

  // ---- Wochenplan der Monteure als Bild (zum Verschicken) ----
  // Liest die Monteur-Zeilen aus der gerenderten Woche und zeichnet sie auf ein Canvas – ohne die anderen Bereiche.
  function weekMonteurImage() {
    const wasClosed = wkCollapsed.has('mont');
    if (wasClosed) { wkCollapsed.delete('mont'); renderWeek(); }
    const rows = [];
    for (const n of viewport.querySelectorAll('.wk-name.wk-person')) {
      if (n.dataset.kind === 'bauleiter') continue;
      const cells = []; let e = n.nextElementSibling;
      for (let i = 0; i < 7 && e; i++, e = e.nextElementSibling) {
        const cs = getComputedStyle(e), unconf = e.classList.contains('wk-unconfirmed');
        const text = [...e.childNodes].filter(x => x.nodeType === 3).map(x => x.textContent).join('').trim();
        const ex = e.querySelector('.wk-extra'), car = e.querySelector('.wk-car');
        cells.push({ text, extra: ex ? ex.textContent : '', car: car ? car.textContent : '', carOver: !!(car && car.classList.contains('over')), night: !!e.querySelector('.wk-night'),
          bg: unconf ? '#fdecd9' : (e.classList.contains('wk-split') ? '#e6f0fb' : cs.backgroundColor), fg: unconf ? '#6b3e00' : cs.color, unconf, bold: +cs.fontWeight >= 600 });
      }
      rows.push({ name: n.querySelector('.wk-person-name').textContent, extern: n.classList.contains('extern'),
        tags: [...n.querySelectorAll('.trade-tag')].map(t => ({ t: t.textContent, c: t.style.background || '#888' })), cells });
    }
    if (wasClosed) { wkCollapsed.add('mont'); renderWeek(); }
    const dates = weekDates();
    const nDays = rows.some(r => r.cells.slice(5).some(c => c.text || c.extra)) ? 7 : 5;   // Sa/So nur, wenn belegt
    const S = 2, FONT = "'Roboto Condensed', Arial, sans-serif";
    const W_NAME = 190, W_DAY = 220, H_TITLE = 46, H_HEAD = 30, H_ROW = 36, PAD = 14;
    const W = PAD * 2 + W_NAME + W_DAY * nDays, H = PAD * 2 + H_TITLE + H_HEAD + H_ROW * rows.length;
    const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
    const g = cv.getContext('2d'); g.scale(S, S); g.textBaseline = 'middle';
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const fit = (t, max) => { if (g.measureText(t).width <= max) return t; while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; };
    const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    // Titel
    g.fillStyle = '#6b4310'; g.font = '700 19px ' + FONT;
    g.fillText('Wochenplan Monteure · KW ' + isoWeek(selMonday), PAD, PAD + 15);
    g.fillStyle = '#6b7177'; g.font = '400 13px ' + FONT;
    g.fillText(fmt(selMonday) + ' – ' + fmt(addDays(selMonday, nDays - 1)) + '   ·   Stand ' + fmt(todayMs()), PAD, PAD + 35);
    // Kopfzeile
    let y = PAD + H_TITLE;
    g.fillStyle = '#895612'; g.fillRect(PAD, y, W_NAME, H_HEAD);
    g.fillStyle = '#fff'; g.font = '700 13px ' + FONT; g.fillText('Monteur', PAD + 8, y + H_HEAD / 2);
    for (let i = 0; i < nDays; i++) {
      const x = PAD + W_NAME + i * W_DAY;
      g.fillStyle = i >= 5 ? '#eef1f4' : '#f4ece3'; g.fillRect(x, y, W_DAY, H_HEAD);
      g.fillStyle = '#23272b'; g.font = '700 13px ' + FONT; g.fillText(WDAYS[i], x + 8, y + H_HEAD / 2);
      g.fillStyle = '#7b8188'; g.font = '400 12px ' + FONT; g.fillText(fmt(dates[i]).slice(0, 6), x + 32, y + H_HEAD / 2);
    }
    y += H_HEAD;
    // Zeilen
    rows.forEach((r, ri) => {
      const ry = y + ri * H_ROW;
      g.fillStyle = '#fff'; g.fillRect(PAD, ry, W_NAME, H_ROW);
      let tx = PAD + W_NAME - 6;
      g.font = '700 10px ' + FONT;
      for (const t of r.tags.slice().reverse()) {
        const tw = g.measureText(t.t).width + 8; tx -= tw;
        g.fillStyle = t.c; rr(tx, ry + H_ROW / 2 - 8, tw, 16, 4); g.fill();
        g.fillStyle = '#fff'; g.fillText(t.t, tx + 4, ry + H_ROW / 2 + 0.5); tx -= 3;
      }
      g.fillStyle = r.extern ? '#1f97ad' : '#23272b'; g.font = (r.extern ? 'italic ' : '') + '400 14px ' + FONT;
      g.fillText(fit(r.name, tx - PAD - 12), PAD + 8, ry + H_ROW / 2);
      for (let i = 0; i < nDays; i++) {
        const c = r.cells[i] || {}, x = PAD + W_NAME + i * W_DAY;
        g.fillStyle = (c.text || c.extra) ? (c.bg && c.bg !== 'rgba(0, 0, 0, 0)' ? c.bg : '#fff') : (i >= 5 ? '#f6f8fa' : '#fff');
        g.fillRect(x, ry, W_DAY, H_ROW);
        if (c.unconf) { g.save(); g.strokeStyle = '#ec8a2b'; g.setLineDash([4, 3]); g.lineWidth = 1.2; g.strokeRect(x + 2, ry + 2, W_DAY - 4, H_ROW - 4); g.restore(); }
        let right = x + W_DAY - 6;
        if (c.car) {
          g.font = '700 10px ' + FONT; const cw = g.measureText(c.car).width + 10; right -= cw;
          g.fillStyle = c.carOver ? '#d0402e' : 'rgba(255,255,255,.9)'; rr(right, ry + H_ROW / 2 - 8, cw, 16, 8); g.fill();
          g.strokeStyle = 'rgba(0,0,0,.2)'; g.lineWidth = 1; g.stroke();
          g.fillStyle = c.carOver ? '#fff' : '#4a5057'; g.fillText(c.car, right + 5, ry + H_ROW / 2 + 0.5); right -= 5;
        }
        if (c.night) { g.font = '12px ' + FONT; right -= 15; g.fillStyle = '#23272b'; g.fillText('🌙', right, ry + H_ROW / 2 + 1); right -= 4; }
        const maxW = right - x - 8;
        g.fillStyle = c.fg || '#23272b';
        if (c.extra) {
          g.font = (c.bold ? '700 ' : '400 ') + '12px ' + FONT; g.fillText(fit(c.text + (c.unconf ? ' ?' : ''), maxW), x + 8, ry + 12);
          g.font = '700 10.5px ' + FONT; g.fillText(fit('+ ' + c.extra, maxW), x + 8, ry + 26);
        } else if (c.text) {
          g.font = (c.bold ? '700 ' : '400 ') + '13px ' + FONT; g.fillText(fit(c.text + (c.unconf ? ' ?' : ''), maxW), x + 8, ry + H_ROW / 2);
        }
      }
    });
    // Raster
    g.strokeStyle = '#d5d9de'; g.lineWidth = 1;
    for (let ri = 0; ri <= rows.length; ri++) { const ly = Math.round(y + ri * H_ROW) + 0.5; g.beginPath(); g.moveTo(PAD, ly); g.lineTo(W - PAD, ly); g.stroke(); }
    for (let i = 0; i <= nDays; i++) { const lx = Math.round(PAD + W_NAME + i * W_DAY) + 0.5; g.beginPath(); g.moveTo(lx, PAD + H_TITLE); g.lineTo(lx, H - PAD); g.stroke(); }
    g.strokeStyle = '#9aa0a6'; g.strokeRect(PAD + 0.5, PAD + H_TITLE + 0.5, W - PAD * 2 - 1, H - PAD * 2 - H_TITLE - 1);
    return cv;
  }
  function openWeekShot() {
    const run = () => {
      const cv = weekMonteurImage(), name = 'Wochenplan_Monteure_KW' + isoWeek(selMonday) + '_' + new Date(selMonday).getUTCFullYear() + '.png';
      const ov = el('div', 'overlay'), dlg = el('div', 'dialog shot-dialog');
      dlg.appendChild(el('h3', null, 'Wochenplan Monteure · KW ' + isoWeek(selMonday)));
      const img = document.createElement('img'); img.className = 'shot-img'; img.alt = 'Wochenplan der Monteure'; img.src = cv.toDataURL('image/png');
      const wrap = el('div', 'shot-wrap'); wrap.appendChild(img); dlg.appendChild(wrap);
      const act = el('div', 'dialog-actions');
      const copy = el('button', 'btn primary', 'In Zwischenablage kopieren'), dl = el('button', 'btn', 'Als Bild speichern'), close = el('button', 'btn', 'Schließen');
      const shut = () => ov.remove();
      copy.onclick = () => cv.toBlob(async (blob) => {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Bild kopiert – jetzt z. B. in Teams, WhatsApp oder eine Mail einfügen'); shut(); }
        catch (e) { toast('Kopieren nicht möglich – bitte „Als Bild speichern" verwenden'); }
      }, 'image/png');
      dl.onclick = () => { const a = document.createElement('a'); a.href = img.src; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
      close.onclick = shut;
      act.appendChild(copy); act.appendChild(dl); act.appendChild(el('div', 'spacer')); act.appendChild(close);
      dlg.appendChild(act); ov.appendChild(dlg);
      ov.addEventListener('click', (e) => { if (e.target === ov) shut(); });
      document.body.appendChild(ov);
    };
    // Schrift sicher geladen haben, sonst zeichnet das Canvas mit der Ersatzschrift
    if (document.fonts && document.fonts.load) Promise.all([document.fonts.load("400 13px 'Roboto Condensed'"), document.fonts.load("700 13px 'Roboto Condensed'")]).then(run, run); else run();
  }
  { const b = document.getElementById('wkShot'); if (b) b.onclick = openWeekShot; }

  function moveAssignment(fromKey, toKey) {
    if (fromKey === toKey) return;
    const src = assignments[fromKey], dst = assignments[toKey];
    if (dst) { dst.auto = false; assignments[fromKey] = dst; } else delete assignments[fromKey];
    if (src) src.auto = false;   // manuell verschoben → geschützt
    assignments[toKey] = src;
    save(); renderWeek();
  }
  // Automatisch erzeugbar (= darf beim Aktualisieren ersetzt werden): explizit auto ODER
  // ein Baustellen-Eintrag ohne Markierung (Alt-Einträge aus früheren Vorplanungen).
  // Geschützt (manuell): auto === false, oder Nicht-Baustelle (Büro/n.v./Urlaub/IBN).
  const isAutoCell = (a) => !!a && a.auto !== false && (a.auto === true || a.type === 'baustelle');
  // Baut die automatisch erzeugten Einträge dieser Woche neu auf.
  // fillOnly=true: nur leere Zellen füllen (Vorplanung). fillOnly=false: Auto-Einträge erst löschen (Aktualisieren).
  function vorplanung(fillOnly) {
    if (!fillOnly) {
      const w1 = addDays(selMonday, 6);
      for (const k of Object.keys(assignments)) {
        const d = k.split('|')[1];
        if (parse(d) >= selMonday && parse(d) <= w1 && isAutoCell(assignments[k])) delete assignments[k];
      }
    }
    let count = 0;
    const placeCell = (pid, s, e, entry) => {
      for (let i = 0; i < 7; i++) {
        const ms = addDays(selMonday, i);
        const dow = new Date(ms).getUTCDay(); if (dow === 0 || dow === 6) continue;
        if (parse(s) > ms || parse(e) < ms) continue;
        const key = akey(pid, isoStr(ms));
        if (!assignments[key]) { assignments[key] = Object.assign({ auto: true }, entry); count++; }
      }
    };
    // 1) Urlaub der internen Monteure zuerst (hat Vorrang vor Baustellen-Einsätzen)
    for (const m of PLAN.team) {
      if (m.type === 'extern') continue;
      for (const bar of (m.bars || [])) {
        if (bar.cat !== 'vacation') continue;
        placeCell(m.id, bar.start, bar.end, { text: 'frei', type: 'urlaub' });
      }
    }
    // 2) Baustellen-Einsätze je Phase
    const place = (assigned, s, e, name) => {
      for (const pid of (assigned || [])) placeCell(pid, s, e, { text: name, type: 'baustelle' });
    };
    for (const { row, bar } of barsOverlappingWeek()) {
      const name = row.site || row.label;
      if (bar.phases && bar.phases.length) {
        for (const ph of bar.phases) place(ph.assigned, ph.start, ph.end, name);
      } else if (bar.crew) {
        place(bar.crew.assigned, bar.crew.start || bar.start, bar.crew.end || bar.end, name);
      }
    }
    if (count) logChange(`Woche KW ${isoWeek(selMonday)} ${fillOnly ? 'vorbelegt' : 'aktualisiert'} (${count} Einträge)`, 'woche');
    save(); renderWeek();
    if (!count && fillOnly) alert('Keine zugeordneten Monteure in dieser Woche gefunden.\nOrdne im Zeitplan den Montage-Phasen Monteure zu (Fenster-Balken anklicken → Phase → Monteure), oder ziehe Baustellen aus der Palette in die Zellen.');
  }
  function scrollToWeek(monday) {
    // Ansicht BEGINNT mit dieser Montagewoche (Montag linksbündig, 1 Tag Vorlauf) –
    // nicht zentriert, sonst lägen mehrere vergangene Wochen links davor.
    const mondayIdx = dayIndex(monday, startMs);
    viewport.scrollLeft = Math.max(0, mondayIdx * dayWidth - dayWidth);
  }
  function scrollToToday() { if (viewMode === 'timeline') scrollToWeek(mondayMs(todayMs())); }   // nur im Zeitplan (Woche/Kundendienst haben eigene Spalten)

  // ---- Zellen-Editor (Wochenplan) ----
  const woverlay = document.getElementById('woverlay');
  const wText = document.getElementById('w-text');
  const wType = document.getElementById('w-type');
  const wProjects = document.getElementById('w-projects');
  let curCell = null, curCellCtx = null, curCellPerson = null, wProjectDraft = [], curCellIsBl = false;
  for (const key of Object.keys(CELL_TYPES)) { const o = el('option', null, CELL_TYPES[key].label); o.value = key; wType.appendChild(o); }
  const firstTradeOf = (person) => (person && (person.trades || []).find(k => TRADES()[k])) || Object.keys(TRADES())[0] || 'edelstahl';
  // Baustellen-Liste (mehrere Projekt-Einsätze je Person/Tag möglich). Bei Bauleitern: nur Baustelle, kein Gewerk.
  // Montagefenster einer Projektzeile, in dem die Person an dem Tag eingeplant ist (sonst das Fenster des Tages)
  function barOfPersonDay(row, pid, ms) {
    const on = (r) => r.id === pid && parse(r.start) <= ms && parse(r.end) >= ms;
    const bars = row.bars || [];
    return bars.find(b => (b.phases || []).some(ph => assignedRanges(ph).some(on)) || blRanges(b).some(on))
      || bars.find(b => parse(b.start) <= ms && parse(b.end) >= ms) || null;
  }
  function renderProjRows() {
    wProjects.innerHTML = '';
    wProjectDraft.forEach((entry, i) => {
      const rowEl = el('div', 'w-proj-row');
      const psel = document.createElement('select');
      for (const r of projRows()) { const o = el('option', null, r.site ? (r.site + ' · ' + r.label) : r.label); o.value = r.id; psel.appendChild(o); }
      psel.value = entry.rowId; psel.onchange = () => { entry.rowId = psel.value; delete entry.bar; entry.label = ''; setAddr(entry, null); renderProjRows(); };
      rowEl.appendChild(psel);
      if (!curCellIsBl) {   // Gewerk-Auswahl nur bei Monteuren
        const gsel = document.createElement('select'); gsel.className = 'w-proj-gewerk';
        for (const k of Object.keys(TRADES())) { const o = el('option', null, TRADES()[k].label); o.value = k; gsel.appendChild(o); }
        gsel.value = entry.gewerk; gsel.onchange = () => { entry.gewerk = gsel.value; };
        rowEl.appendChild(gsel);
      }
      // Termineinladung: Kleinprojekt → für die Montage dieses Tages, sonst der Projekt-Entwurf
      const tiRow = projRows().find(r => r.id === entry.rowId);
      const tiBarW = (tiRow && isKleinRow(tiRow)) ? (entry.bar || null) : null;   // neue, ungespeicherte Montage: noch kein Fenster
      if (tiRow && (!isKleinRow(tiRow) || tiBarW)) {
        const ti = el('span', 'w-proj-ti', '✉');
        ti.title = 'Termineinladung erstellen' + (tiBarW && tiBarW.label ? ' · ' + tiBarW.label : '') + '\n(nicht gespeicherte Änderungen in dieser Maske gehen verloren)';
        ti.onclick = () => { closeCellEditor(); openTermineinladung(tiRow, tiBarW); };
        rowEl.appendChild(ti);
      }
      const del = el('span', 'w-proj-del', '✕'); del.title = 'Baustelle entfernen';
      del.onclick = () => { wProjectDraft.splice(i, 1); renderProjRows(); };
      rowEl.appendChild(del);
      wProjects.appendChild(rowEl);
      // Kleinprojekte (Sammelzeile): Bezeichnung der einzelnen Montage – steht in der Woche statt „Kleinprojekte"
      if (tiRow && isKleinRow(tiRow)) {
        const lab = document.createElement('input'); lab.type = 'text'; lab.className = 'w-proj-label';
        lab.placeholder = 'Bezeichnung des Kleinprojekts (z. B. Kunde / Ort)';
        lab.title = 'Bezeichnung dieser Montage – gilt für das ganze Montagefenster im Zeitplan';
        lab.setAttribute('list', 'kleinList');
        const known = fillKleinList();
        const addr = el('div', 'w-proj-addr'), ains = {};
        for (const [k, ph] of [['strasse', 'Straße + Nr.'], ['plz', 'PLZ'], ['ort', 'Ort']]) {
          const a = document.createElement('input'); a.type = 'text'; a.placeholder = ph; a.className = 'w-addr-' + k; a.value = entry[k] || '';
          a.oninput = () => { entry[k] = a.value; }; ains[k] = a; addr.appendChild(a);
        }
        lab.value = entry.label || '';
        lab.oninput = () => {
          entry.label = lab.value;
          // Bekanntes Kleinprojekt → Adresse übernehmen (nur wenn noch keine eingetragen ist)
          const k = known.get(lab.value.trim().toLowerCase());
          if (k && ADDR_KEYS.every(key => !String(entry[key] || '').trim())) for (const key of ADDR_KEYS) { entry[key] = k[key] || ''; ains[key].value = entry[key]; }
        };
        // Schreibweise eines bekannten Kleinprojekts übernehmen (kein zweiter Eintrag nur wegen Groß-/Kleinschreibung)
        lab.onchange = () => { const k = known.get(lab.value.trim().toLowerCase()); if (k) { lab.value = k.label; entry.label = k.label; } };
        wProjects.appendChild(lab);
        wProjects.appendChild(addr);
      }
    });
    document.querySelector('#w-proj-section label').firstChild.textContent = curCellIsBl ? 'Baustelle(n) an diesem Tag (Bauleitung) ' : 'Baustellen an diesem Tag ';
    // Notiz-/Termin-Feld bleibt immer sichtbar – ein manueller Termin kann NEBEN dem Einsatz stehen.
    document.getElementById('w-note-fields').hidden = false;
  }
  document.getElementById('w-proj-add').onclick = () => {
    const first = projRows()[0]; if (!first) return;
    wProjectDraft.push(curCellIsBl ? { rowId: first.id, bl: true } : { rowId: first.id, gewerk: firstTradeOf(curCellPerson) });
    renderProjRows();
  };
  // Fenster für einen Woche-Eintrag finden/erzeugen: bestehendes Fenster am Tag, sonst angrenzendes
  // per Woche erzeugtes Fenster erweitern (zusammenhängend), sonst neues weekgen-Fenster.
  function weekBarFor(row, ms, forBl) {
    const dISO = isoStr(ms);
    const isEinsatz = (b) => b.cat !== 'vacation' && b.cat !== 'booking';
    const onDay = (b) => parse(b.start) <= ms && parse(b.end) >= ms && isEinsatz(b);
    // Bauleiter: bevorzugt ein Bauleitungs-Fenster des Tages. Monteure: nie in ein (festes) Bauleitungs-Fenster.
    let bar = forBl ? (row.bars.find(b => onDay(b) && b.cat === 'bauleitung') || row.bars.find(onDay))
      : row.bars.find(b => onDay(b) && (b.cat !== 'bauleitung' || b.weekgen));
    if (!bar) {
      const dayBefore = isoStr(addDays(ms, -1)), dayAfter = isoStr(addDays(ms, 1));
      bar = row.bars.find(b => b.weekgen && (b.end === dayBefore || b.start === dayAfter));
      if (bar) { if (bar.end === dayBefore) bar.end = dISO; else bar.start = dISO; }
      else { bar = { label: 'Montage', cat: 'confirmed', start: dISO, end: dISO, phases: [], weekgen: true }; row.bars.push(bar); }
    }
    return bar;
  }
  // Kleinprojekte: je Bezeichnung ein eigenes Fenster. Erst das Fenster des Eintrags (falls es den Tag
  // abdeckt), sonst ein gleichnamiges am Tag, sonst ein angrenzendes gleichnamiges Woche-Fenster erweitern, sonst neu.
  function kleinBarFor(row, ms, entry) {
    const bar = kleinBarFind(row, ms, entry);
    if (ADDR_KEYS.some(k => k in entry)) setAddr(bar, entry);   // Adresse aus der Maske auf die Montage schreiben
    return bar;
  }
  function kleinBarFind(row, ms, entry) {
    const label = (entry.label || '').trim();
    const origin = (entry.bar && row.bars.indexOf(entry.bar) >= 0) ? entry.bar : null;
    if (!label && !origin) return weekBarFor(row, ms);
    const dISO = isoStr(ms), want = (label || origin.label || '').toLowerCase();
    const covers = (b) => parse(b.start) <= ms && parse(b.end) >= ms;
    const same = (b) => b.cat !== 'vacation' && b.cat !== 'booking' && (b.label || '').trim().toLowerCase() === want;
    if (origin && covers(origin)) return origin;
    let bar = row.bars.find(b => same(b) && covers(b));
    if (!bar) {
      const dayBefore = isoStr(addDays(ms, -1)), dayAfter = isoStr(addDays(ms, 1));
      bar = row.bars.find(b => b.weekgen && same(b) && (b.end === dayBefore || b.start === dayAfter));
      if (bar) { if (bar.end === dayBefore) bar.end = dISO; else bar.start = dISO; }
      else { bar = { label: label || origin.label || 'Montage', cat: 'confirmed', start: dISO, end: dISO, phases: [], weekgen: true }; row.bars.push(bar); }
    }
    return bar;
  }
  const weekEntryBar = (row, ms, entry, forBl) => {
    if (entry && isKleinRow(row)) return kleinBarFor(row, ms, entry);
    const b = entry && entry.bar;
    if (b && row.bars.indexOf(b) >= 0 && parse(b.start) <= ms && parse(b.end) >= ms) return b;
    return weekBarFor(row, ms, forBl);
  };
  // Person an einem Tag einem Projekt/Gewerk zuordnen (schreibt in den Zeitplan)
  function assignWeekProject(pid, ms, row, gewerk, entry) {
    const dISO = isoStr(ms);
    const bar = weekEntryBar(row, ms, entry);
    if (bar.cat === 'bauleitung') { bar.cat = 'confirmed'; if (bar.label === 'Bauleitung') bar.label = 'Montage'; }   // Monteur dazu → wird zur Montage
    if (bar.crew) { if ((bar.crew.assigned || []).length || bar.crew.trade) phasesOf(bar); else delete bar.crew; }
    if (!bar.phases) bar.phases = [];
    const weekendDay = [0, 6].includes(new Date(ms).getUTCDay());
    const sameTrade = bar.phases.filter(p => (p.trade || 'edelstahl') === gewerk && (!weekendDay || p.weekend));
    const workBetween = (aMs, bMs, wk) => { let n = 0; for (let x = addDays(aMs, 1); x < bMs; x = addDays(x, 1)) if (wk || isWorkdayMs(x)) n++; return n; };
    // passende Phase: deckt den Tag ab, sonst eine direkt angrenzende (keine Arbeitstage dazwischen)
    let ph = sameTrade.find(p => parse(p.start) <= ms && parse(p.end) >= ms)
      || sameTrade.find(p => (ms > parse(p.end) && !workBetween(parse(p.end), ms, p.weekend)) || (ms < parse(p.start) && !workBetween(ms, parse(p.start), p.weekend)));
    if (!ph) { ph = { trade: gewerk, start: dISO, end: dISO, days: 1, weekend: weekendDay, count: 1, assigned: [] }; bar.phases.push(ph); }
    else { if (ms < parse(ph.start)) ph.start = dISO; if (ms > parse(ph.end)) ph.end = dISO; }
    const span = daysCount(ph.start, ph.end, !!ph.weekend);
    if (!(isHalf(ph) && Math.ceil(+ph.days) === span)) ph.days = span;   // halben Tag behalten, solange die Spanne passt
    addToPhase(ph, pid, dISO);
    save();
  }
  // Bauleiter an einem Tag einer Baustelle zuordnen (Bauleitung – ohne Gewerk; schreibt in den Zeitplan)
  function assignBauleitung(blId, ms, row, entry) {
    const before = row.bars.length;
    const bar = weekEntryBar(row, ms, entry, true);
    // Neu aus der Woche erzeugt: reiner Bauleitungs-Termin (kein Monteur-Bedarf, nicht unter „Bestätigte Montagen")
    if (row.bars.length > before) { bar.cat = 'bauleitung'; if (bar.label === 'Montage') bar.label = 'Bauleitung'; }
    addToBl(bar, blId, isoStr(ms));
    save();
  }
  // Leere, per Woche erzeugte Montagefenster (keine Monteure UND keine Bauleitung) entfernen – keine Fragmente.
  function pruneEmptyWeekBars() {
    const g = PLAN.groups.find(x => x.name === 'Projekte'); if (!g) return;
    for (const row of g.rows) {
      if (!row.bars) continue;
      row.bars = row.bars.filter(b => !(b.weekgen && !(b.phases || []).some(p => (p.assigned || []).length) && !((b.bl || []).length)));
    }
  }
  // Typ gewählt → Textfeld passend füllen (wenn leer oder ein Standardtext), damit der Eintrag speicherbar ist
  wType.addEventListener('change', () => {
    const cur = wText.value.trim();
    if (!cur || CELL_TYPE_TEXT_SET.has(cur)) wText.value = CELL_TYPE_TEXT[wType.value] || '';
  });
  // Alle Einsätze einer Person an einem Tag – je Montagefenster und Gewerk ein Eintrag (mit Verweis aufs Fenster),
  // damit Bereiche einer Baustelle, mehrere Gewerke und Kleinprojekte beim Speichern erhalten bleiben.
  function dayEntries(person, ms, isBl) {
    const out = [], on = (r) => r.id === person.id && parse(r.start) <= ms && parse(r.end) >= ms;
    for (const row of projRows()) for (const b of row.bars) {
      const extra = isKleinRow(row) ? { label: b.label || '', strasse: b.strasse || '', plz: b.plz || '', ort: b.ort || '' } : {};
      if (isBl) { if (blRanges(b).some(on)) out.push(Object.assign({ rowId: row.id, bl: true, bar: b }, extra)); continue; }
      const workday = isWorkdayMs(ms);
      for (const ph of (b.phases || [])) if ((workday || ph.weekend) && assignedRanges(ph).some(on))
        out.push(Object.assign({ rowId: row.id, gewerk: (ph.trade && TRADES()[ph.trade]) ? ph.trade : firstTradeOf(person), bar: b }, extra));
      // Altdaten: Bedarf ohne Phasen (crew) – sonst ginge die Zuordnung beim Speichern verloren
      if (!(b.phases || []).length && b.crew && workday && (b.crew.assigned || []).some(a => idOf(a) === person.id) && parse(b.crew.start || b.start) <= ms && parse(b.crew.end || b.end) >= ms)
        out.push(Object.assign({ rowId: row.id, gewerk: (b.crew.trade && TRADES()[b.crew.trade]) ? b.crew.trade : firstTradeOf(person), bar: b }, extra));
    }
    return out;
  }
  function openCellEditor(key, person, ms) {
    curCell = key; curCellPerson = person; curCellIsBl = person.kind === 'bauleiter';
    const der = weekDerived()[key] || { projects: [], urlaub: false };
    curCellCtx = { key, pid: person.id, dISO: isoStr(ms), projects: der.projects.slice() };
    // Manueller Termin/Notiz (kein Baustellen-Mirror) – kann NEBEN dem Einsatz stehen
    const note = (assignments[key] && assignments[key].type !== 'baustelle') ? assignments[key] : null;
    document.getElementById('wTitle').textContent = `${person.name} · ${WDAYS[(new Date(ms).getUTCDay() + 6) % 7]} ${fmt(ms).slice(0, 6)}`;
    // Baustellen vorbelegen: alle abgeleiteten Projekte des Tages (mehrere möglich), je mit Gewerk – IMMER,
    // damit ein geplanter Einsatz auch dann bearbeitbar ist, wenn zusätzlich eine Notiz auf dem Tag liegt.
    wProjectDraft = dayEntries(person, ms, curCellIsBl);
    renderProjRows();
    let wsv = document.getElementById('w-svc');
    if (!wsv) { wsv = el('div', 'w-svc'); wsv.id = 'w-svc'; document.getElementById('w-note-fields').before(wsv); }
    wsv.innerHTML = '';
    const svcHere = svcDay(person.id, ms);
    for (const x of svcHere) {
      const b = el('button', 'btn w-svc-btn', '🔧 Wartung ' + svcName(x.s) + ' – im Kundendienst bearbeiten');
      b.onclick = () => { closeCellEditor(); openServiceDialog(x.s); };
      wsv.appendChild(b);
    }
    wsv.hidden = !svcHere.length;
    wType.value = note ? note.type : (curCellIsBl ? 'bauleitung' : CELL_TYPE_DEFAULT);   // Bauleiter: Standardtyp Bauleitung (nicht Montage)
    // Leere, freie Zelle: Text mit dem Standardtext des Typs vorbelegen (sonst würde „Speichern" nichts speichern)
    // Fahrzeug-Auswahl: Standard (Stammfahrzeug an Einsatztagen), keines, oder ein bestimmtes – mit Belegung des Tages
    const wCar = document.getElementById('w-car'), iso = isoStr(ms), allDer = weekDerived(), occ = carOcc(iso, allDer);
    const def = defaultVehOf(person.id);
    wCar.innerHTML = '';
    const addOpt = (v, t) => { const o = el('option', null, t); o.value = v; wCar.appendChild(o); };
    addOpt('none', 'kein Fahrzeug');
    for (const v of vehicles()) {
      const others = (occ[v.id] || []).filter(n => n !== person.name);
      addOpt(v.id, vehLabel(v) + ' · ' + v.seats + ' Sitze' + (others.length ? ' · mit ' + others.join(', ') : ' · frei'));
    }
    // Vorauswahl: die gespeicherte Wahl, sonst das Stammfahrzeug. Gespeichert wird nur, was davon abweicht.
    const noteNow = (assignments[key] && assignments[key].type !== 'baustelle') ? assignments[key] : null;
    const defApplies = def && (carActive(person.id, iso, allDer) || (!der.projects.length && !noteNow));   // leere Zelle → Stammfahrzeug vorschlagen
    wCar.value = (PLAN.cars || {})[key] || (defApplies ? def.id : 'none');
    curCellCtx.carInit = wCar.value;
    document.getElementById('w-car-wrap').style.display = vehicles().length ? '' : 'none';
    document.getElementById('w-night').checked = effNight(key, allDer[key]);
    const blank = !note && !der.projects.length && !der.urlaub;
    wText.value = note ? note.text : (blank ? (CELL_TYPE_TEXT[wType.value] || '') : '');
    // Löschen anzeigen, wenn es eine manuelle Notiz ODER einen Zeitplan-Einsatz zum Entfernen gibt
    document.getElementById('w-delete').style.display = (assignments[key] || der.projects.length) ? '' : 'none';
    document.getElementById('w-paste').hidden = !(clip && clip.kind === 'cell');   // Einfügen nur, wenn eine Zelle kopiert wurde
    woverlay.hidden = false;
  }
  function closeCellEditor() { woverlay.hidden = true; curCell = null; curCellCtx = null; }
  const cellPersonName = () => (curCellPerson && curCellPerson.name) || (curCellCtx && monteurName(curCellCtx.pid)) || '?';
  // Geänderte Bezeichnung eines Kleinprojekts auf sein Montagefenster schreiben (gilt für alle dort Eingeplanten)
  function renameKleinBars() {
    const out = [];
    for (const e of wProjectDraft) {
      const label = (e.label || '').trim();
      if (!e.bar || !label || label === (e.bar.label || '')) continue;
      out.push(`Bezeichnung „${e.bar.label || ''}" → „${label}"`);
      e.bar.label = label;
    }
    return out;
  }
  // Neue Kleinprojekt-Einträge brauchen eine Bezeichnung – sonst landete die Person im Fenster eines anderen Kunden
  function kleinLabelMissing() {
    const miss = wProjectDraft.some(e => { const r = projRows().find(x => x.id === e.rowId); return r && isKleinRow(r) && !e.bar && !(e.label || '').trim(); });
    if (miss) alert('Bitte für das Kleinprojekt eine Bezeichnung eintragen (z. B. Kunde / Ort).');
    return miss;
  }
  document.getElementById('w-save').onclick = () => {
    if (!curCell || !curCellCtx) return;
    if (kleinLabelMissing()) return;
    historyBatch(saveCellNow);
    renderWeek(); closeCellEditor();
  };
  function saveCellNow() {
    const who = cellPersonName(), day = fmt(parse(curCellCtx.dISO));
    const parts = [];
    // 1) Baustellen des Tages neu setzen (leer = alle für den Tag entfernen). Bauleiter → Bauleitung, sonst Einsatz.
    const renamed = renameKleinBars();
    removePersonDay(curCellCtx.pid, curCellCtx.dISO, curCellCtx.projects);
    for (const e of wProjectDraft) { const row = projRows().find(r => r.id === e.rowId); if (!row) continue; if (curCellIsBl) assignBauleitung(curCellCtx.pid, parse(curCellCtx.dISO), row, e); else assignWeekProject(curCellCtx.pid, parse(curCellCtx.dISO), row, e.gewerk, e); }
    for (const t of renamed) parts.push(t);
    if (wProjectDraft.length) parts.push((curCellIsBl ? 'Bauleitung: ' : 'Einsatz: ') + [...new Set(wProjectDraft.map(e => { const r = projRows().find(x => x.id === e.rowId); return r ? ((isKleinRow(r) && (e.label || '').trim()) || (r.site ? r.site + ' · ' + r.label : r.label)) + (e.gewerk && TRADES()[e.gewerk] ? ' (' + TRADES()[e.gewerk].label + ')' : '') : '?'; }))].join(', '));
    else if (curCellCtx.projects.length) parts.push(curCellIsBl ? 'Bauleitung entfernt' : 'Einsatz entfernt');
    // 2) Manueller Termin/Notiz – UNABHÄNGIG vom Einsatz (beide können nebeneinander stehen).
    //    Reinen Auto-Standardtext (z. B. „Montage") NICHT als Notiz neben einer Baustelle speichern.
    let text = wText.value.trim();
    if (wProjectDraft.length && CELL_TYPE_TEXT_SET.has(text)) text = '';
    if (!text) { if (assignments[curCell] && assignments[curCell].type !== 'baustelle') parts.push('Notiz entfernt'); delete assignments[curCell]; }
    else { assignments[curCell] = { text, type: wType.value, auto: false }; parts.push('Termin: „' + text + '"'); }
    // 3) Fahrzeug des Tages – nur wenn die Auswahl aktiv geändert wurde
    const carOld = (PLAN.cars || {})[curCell] || '', carVal = document.getElementById('w-car').value;
    if (carVal !== curCellCtx.carInit) setCar(curCellCtx.pid, curCellCtx.dISO, carVal, weekDerived());
    const carNew = (PLAN.cars || {})[curCell] || '';
    // 4) Übernachtung nach diesem Tag (Vorgabe kommt aus der Phase; gespeichert wird nur die Abweichung)
    const nOld = effNight(curCell, weekDerived()[curCell]);   // nach dem Neusetzen der Baustellen
    const nNew = document.getElementById('w-night').checked;
    setNight(curCell, nNew, weekDerived()[curCell]);
    if (nNew !== nOld) parts.push(nNew ? 'Übernachtung' : 'keine Übernachtung');
    if (carNew !== carOld) parts.push('Fahrzeug: ' + (carNew === 'none' ? 'keines' : carNew ? (vehById(carNew) || {}).name : 'Stammfahrzeug'));
    logChange(`${who} am ${day} – ${parts.length ? parts.join(' · ') : 'keine Änderung'}`, 'woche');
  }
  document.getElementById('w-delete').onclick = () => {
    const who = cellPersonName(), day = curCellCtx ? fmt(parse(curCellCtx.dISO)) : '';
    historyBatch(() => {
      if (curCell) { delete assignments[curCell]; if (PLAN.cars) delete PLAN.cars[curCell]; if (PLAN.nights) delete PLAN.nights[curCell]; }
      // Zeitplan-Einsatz dieses Tages ebenfalls entfernen (schreibt in die Phasen zurück)
      if (curCellCtx && curCellCtx.projects.length) removePersonDay(curCellCtx.pid, curCellCtx.dISO, curCellCtx.projects);
      logChange(`Eintrag gelöscht (${who}, ${day})`, 'woche');
    });
    renderWeek(); closeCellEditor();
  };
  // Eintrag auf alle Werktage (Mo–Fr) dieser Person übertragen – schnelles Kopieren, z. B. für Bauleiter
  document.getElementById('w-week').onclick = () => {
    if (!curCellCtx) return;
    let text = wText.value.trim();
    if (wProjectDraft.length && CELL_TYPE_TEXT_SET.has(text)) text = '';   // Auto-Standardtext nicht mitschreiben
    if (!wProjectDraft.length && !text) { alert('Bitte zuerst einen Text eingeben oder ein Projekt wählen, das auf die ganze Woche übertragen werden soll.'); return; }
    if (kleinLabelMissing()) return;
    const carVal = document.getElementById('w-car').value, carChanged = carVal !== curCellCtx.carInit;
    historyBatch(() => {
    renameKleinBars();
    // heutiger Tag: in der Maske entfernte Baustellen auch wirklich entfernen
    removePersonDay(curCellCtx.pid, curCellCtx.dISO, curCellCtx.projects);
    const nightDays = [];
    for (let i = 0; i < 5; i++) {
      const ms = addDays(selMonday, i);
      // Baustellen auf jeden Werktag übertragen (Bauleiter → Bauleitung, sonst Einsatz)
      for (const e of wProjectDraft) { const row = projRows().find(r => r.id === e.rowId); if (!row) continue; if (curCellIsBl) assignBauleitung(curCellCtx.pid, ms, row, e); else assignWeekProject(curCellCtx.pid, ms, row, e.gewerk, e); }
      // Manuellen Termin/Notiz zusätzlich auf jeden Werktag übertragen
      if (text) assignments[akey(curCellCtx.pid, isoStr(ms))] = { text, type: wType.value, auto: false };
      nightDays.push(i);
    }
    // Übernachtung: Nächte Mo–Do wie angehakt, Freitag nie (Heimfahrt); Fahrzeug nur, wenn aktiv geändert
    const derW = weekDerived(), nOn = document.getElementById('w-night').checked;
    for (const i of nightDays) {
      const iso = isoStr(addDays(selMonday, i)), k = akey(curCellCtx.pid, iso);
      setNight(k, i < 4 && nOn, derW[k]);
      if (carChanged) setCar(curCellCtx.pid, iso, carVal, derW);
    }
    const who = cellPersonName();
    logChange(`${who}: auf ganze Woche übertragen${wProjectDraft.length ? ' · Einsatz' : ''}${text ? ' · Termin „' + text + '"' : ''}`, 'woche');
    });
    renderWeek(); closeCellEditor();
  };
  // Zelle kopieren: aktuellen Editor-Inhalt (Baustellen + Notiz) in die Zwischenablage
  document.getElementById('w-copy').onclick = () => {
    if (!curCellCtx) return;
    const text = wText.value.trim();
    clip = {
      kind: 'cell',
      projects: wProjectDraft.map(e => { const c = { rowId: e.rowId, gewerk: e.gewerk, label: e.label || '' }; for (const k of ADDR_KEYS) if (k in e) c[k] = e[k]; return c; }),
      note: text ? { text, type: wType.value } : null,
      car: document.getElementById('w-car').value !== curCellCtx.carInit ? document.getElementById('w-car').value : null,
      night: document.getElementById('w-night').checked,
    };
    toast('Eintrag kopiert – Zielzelle öffnen und „Einfügen"');
    closeCellEditor();
  };
  // Kopierten Eintrag in die aktuell geöffnete Zelle einfügen (Felder füllen + speichern)
  document.getElementById('w-paste').onclick = () => {
    if (!curCellCtx || !clip || clip.kind !== 'cell') return;
    wProjectDraft = clip.projects.map(e => Object.assign({}, e));
    renderProjRows();
    if (clip.car != null) document.getElementById('w-car').value = clip.car;
    if (clip.night != null) document.getElementById('w-night').checked = !!clip.night;
    if (clip.note) { wText.value = clip.note.text; wType.value = clip.note.type; }
    else { wText.value = ''; }
    document.getElementById('w-save').click();
  };
  document.getElementById('w-cancel').onclick = () => closeCellEditor();
  woverlay.addEventListener('click', (e) => { if (e.target === woverlay) closeCellEditor(); });
  woverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCellEditor();
    if (e.key === 'Enter') document.getElementById('w-save').click();
  });

  // ---- Änderungsverlauf: Dialog verdrahten ----
  document.getElementById('historyBtn').onclick = () => openChangelog();
  document.getElementById('h-close').onclick = () => closeChangelog();
  const hoverlay = document.getElementById('hoverlay');
  hoverlay.addEventListener('click', (e) => { if (e.target === hoverlay) closeChangelog(); });
  hoverlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChangelog(); });
  hoverlay.querySelectorAll('.hist-filter .btn').forEach(btn => {
    btn.onclick = () => {
      logFilter = btn.dataset.hfilter;
      hoverlay.querySelectorAll('.hist-filter .btn').forEach(b => b.classList.toggle('active', b === btn));
      renderChangelog();
    };
  });

  // ================= KUNDENDIENST (Wartungsverträge) =================
  // PLAN.service = [{ id, ort, kunde, pnr, vnr, intervall (Wartungen/Jahr, 0 = frei), faellig 'YYYY-MM', faelligText,
  //   preis, bearbeiter, abnahme, gewende, doku, notiz, history:[{date,text}], angebote:[{firma,datum,preis}],
  //   termine:[{id,start,end,wer:[personIds],firma,notiz,erledigt}] }]
  // Termine mit eigenen Technikern laufen in der Woche bei der Person zusammen (Typ Kundendienst).
  // Freigabe: die Ansicht gibt es vorerst nur für diese Logins. Die Daten liegen NICHT im gemeinsamen Plan,
  // sondern in einer eigenen Datei der Site (Kundendienst/wartungsvertraege.json) und werden nur hier geladen.
  // Anmeldename im Microsoft-Konto ist „wahlj@…" (so steht er auch im Verlauf); die Mailadresse zur Sicherheit mit
  const KD_USERS = ['wahlj', 'johannes.wahl', 'wahlc', 'carolin.wahl'];
  const KD_FOLDER = 'Kundendienst', KD_FILE = 'wartungsvertraege.json', KD_LOCAL = 'montageplanung_kundendienst';
  const kdLocalDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);   // lokale Entwicklung ohne Anmeldung
  function kdAllowed() {
    if (window.Cloud && Cloud.isReady()) { const a = String(Cloud.account() || '').toLowerCase().split('@')[0]; return KD_USERS.includes(a); }
    return kdLocalDev;
  }
  const svcList = () => kdData;
  let kdSaveTimer = null;
  // Mehrere Freigegebene schreiben dieselbe Datei: vor dem Speichern den Stand vom Server holen und per
  // 3-Wege-Merge (Basis = zuletzt geladener Stand) zusammenführen, statt die Änderungen der anderen zu überschreiben.
  let kdBase = [];
  async function kdSync(save) {
    if (!(window.Cloud && Cloud.isReady())) { if (save) { try { localStorage.setItem(KD_LOCAL, JSON.stringify(kdData)); } catch (e) {} } return; }
    const f = await Cloud.loadFile(KD_FOLDER, KD_FILE);
    const remote = (f && Array.isArray(f.service)) ? f.service : [];
    const merged = Cloud.merge3(kdBase, kdData, remote);
    const changedLocal = JSON.stringify(merged) !== JSON.stringify(remote);
    if (save || changedLocal) {
      if (changedLocal) await Cloud.saveFile(KD_FOLDER, KD_FILE, { version: 1, updated: new Date().toISOString(), by: Cloud.account(), service: merged });
    }
    kdBase = JSON.parse(JSON.stringify(merged));
    if (JSON.stringify(merged) !== JSON.stringify(kdData)) {
      kdData = JSON.parse(JSON.stringify(merged));
      if (viewMode === 'service' && soverlay.hidden) renderService();
    }
  }
  function kdSave() {
    clearTimeout(kdSaveTimer);
    kdSaveTimer = setTimeout(async () => {
      try { await kdSync(true); } catch (e) { toast('Kundendienst: Speichern fehlgeschlagen – ' + (e && e.message || e)); }
    }, 600);
  }
  async function kdInit() {
    const ok = kdAllowed();
    document.getElementById('viewService').hidden = !ok;
    if (!ok) { kdData = []; if (viewMode === 'service') setView('timeline'); return; }
    try {
      if (window.Cloud && Cloud.isReady()) { const f = await Cloud.loadFile(KD_FOLDER, KD_FILE); kdData = (f && Array.isArray(f.service)) ? f.service : []; kdBase = JSON.parse(JSON.stringify(kdData)); }
      else kdData = JSON.parse(localStorage.getItem(KD_LOCAL) || '[]');
      if (kdData.map(svcNormalize).some(Boolean)) kdSave();   // Stand/aktiv einmalig aus den Notizen ableiten
    } catch (e) { toast('Kundendienst: Laden fehlgeschlagen – ' + (e && e.message || e)); }
    render();
  }
  const ymOf = (ms) => isoStr(ms).slice(0, 7);
  const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return isoStr(d.getTime()).slice(0, 7); };
  const SVC_MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const ymLabel = (ym) => SVC_MONTHS[+ym.slice(5, 7) - 1] + ' ' + ym.slice(2, 4);
  const svcName = (s) => (s.kunde || '') + (s.ort ? ' (' + s.ort + ')' : '');
  // Termin in der Woche: Personen (eigene Techniker) je Tag
  function svcDay(pid, ms) {
    const out = [];
    for (const s of svcList()) for (const t of (s.termine || [])) {
      if (!t.start || !(t.wer || []).includes(pid)) continue;
      if (parse(t.start) <= ms && parse(t.end || t.start) >= ms) out.push({ s, t });
    }
    return out;
  }
  // Ampel der Fälligkeit: überfällig / bald fällig (≤ 1 Monat) / später; geplant = offener Termin vorhanden
  function svcState(s) {
    const now = ymOf(todayMs());
    const planned = (s.termine || []).some(t => !t.erledigt && t.start);
    if (planned) return 'planned';
    if (!s.faellig) return 'none';
    if (s.faellig < now) return 'over';
    if (s.faellig <= ymAdd(now, 1)) return 'soon';
    return 'ok';
  }

  const S = (id) => document.getElementById(id);
  // ---- Status, aktiv, Lücken, Gruppen ----
  // Bearbeitungsstand vor dem Termin (s.anfrage): '' (offen) → anfragen → angefragt → beauftragt; ein offener Termin = terminiert.
  const SVC_ST = { offen: 'offen', anfragen: 'anfragen', angefragt: 'angefragt', beauftragt: 'beauftragt', terminiert: 'terminiert' };
  const SVC_INACTIVE = /gekünd|beendet|abgelehnt|kein auftrag/i;
  function svcNormalize(s) {   // nach dem Import einmalig: Stand und aktiv aus dem Freitext ableiten
    let ch = false;
    if (s.anfrage === undefined) { const n = (s.notiz || '').toLowerCase(); s.anfrage = /beauftragt/.test(n) ? 'beauftragt' : /angefragt/.test(n) ? 'angefragt' : /anfragen/.test(n) ? 'anfragen' : ''; ch = true; }
    if (s.aktiv === undefined) { s.aktiv = !SVC_INACTIVE.test(s.faelligText || ''); ch = true; }
    return ch;
  }
  const svcStatus = (s) => (s.termine || []).some(t => !t.erledigt && t.start) ? 'terminiert' : (s.anfrage || 'offen');
  const svcGaps = (s) => { const g = []; if (!s.intervall) g.push('Intervall'); if (!s.faellig) g.push('nächste Wartung'); return g; };
  const svcLast = (s) => (s.history || []).map(h => h.date).filter(Boolean).sort().pop() || '';
  const shortDate = (iso) => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(2, 4) : '';
  const svcGroupKey = (s) => (s.ort || '').trim().toLowerCase() + '|' + (s.pnr ? 'p' + String(s.pnr).trim() : 'k' + (s.kunde || '').trim().toLowerCase());
  function svcGroupLabel(items) {
    if (items.length === 1) return svcName(items[0]);
    const names = items.map(s => s.kunde || '');
    let p = names[0]; for (const n of names) { let i = 0; while (i < p.length && i < n.length && p[i] === n[i]) i++; p = p.slice(0, i); }
    p = p.replace(/[\s\-–(:,]+$/, '').trim();
    if (p.length < 4) p = names[0].split(/\s[-–]\s|\s\(/)[0];
    return p + (items[0].ort ? ' (' + items[0].ort + ')' : '');
  }
  const SVC_RANK = { over: 0, soon: 1, none: 2, planned: 3, ok: 4 };
  const worst = (items) => items.map(svcState).sort((a, b) => SVC_RANK[a] - SVC_RANK[b])[0];
  // Termin erledigt: Historie, nächste Fälligkeit nach Intervall, Stand zurück auf offen
  function svcMarkDone(d, t) {
    t.erledigt = true;
    if (!(d.history || []).some(h => h.date === t.start)) (d.history = d.history || []).push({ date: t.start, text: (t.wer || []).map(monteurName).join(', ') || t.firma || '' });
    if (d.intervall) { const nx = ymAdd(t.start.slice(0, 7), Math.round(12 / d.intervall)); if (!d.faellig || d.faellig <= nx) d.faellig = nx; }
    d.anfrage = '';
  }
  const KD_OPEN_KEY = 'montageplanung_kd_open', KD_TODO_KEY = 'montageplanung_kd_todo';
  const kdOpen = new Set((() => { try { return JSON.parse(localStorage.getItem(KD_OPEN_KEY)) || []; } catch (e) { return []; } })());
  let kdTodoOpen = (() => { try { return localStorage.getItem(KD_TODO_KEY) !== '0'; } catch (e) { return true; } })();

  // ---- Ansicht ----
  let svcMonthStart = null;
  function renderService() {
    const now = ymOf(todayMs());
    if (!svcMonthStart) svcMonthStart = ymAdd(now, -2);
    const months = []; for (let i = 0; i < 16; i++) months.push(ymAdd(svcMonthStart, i));
    const q = (S('svcSearch').value || '').trim().toLowerCase();
    const flt = S('svcFilter').value;
    const base = svcList().filter(s => {
      if (q && !((s.kunde || '') + ' ' + (s.ort || '') + ' ' + (s.pnr || '')).toLowerCase().includes(q)) return false;
      return flt === 'inactive' ? s.aktiv === false : s.aktiv !== false;
    });
    const isTodo = (s) => { const st = svcState(s); return (st === 'over' || st === 'soon'); };
    const list = base.filter(s => {
      const st = svcState(s);
      if (flt === 'todo' || flt === 'due') return isTodo(s);
      if (flt === 'planned') return st === 'planned';
      if (flt === 'open') return st !== 'planned';
      if (flt === 'gaps') return svcGaps(s).length > 0;
      if (flt.startsWith('st:')) return svcStatus(s) === flt.slice(3);
      return true;
    });
    const wrap = el('div', 'svc-wrap');
    // Arbeitsliste: fällig/überfällig ohne Termin, älteste zuerst
    const todo = base.filter(isTodo).sort((a, b) => (a.faellig || '').localeCompare(b.faellig || '') || svcName(a).localeCompare(svcName(b), 'de'));
    const panel = el('div', 'svc-todo' + (kdTodoOpen ? '' : ' closed'));
    const ph = el('div', 'svc-todo-head');
    ph.appendChild(el('span', 'wk-sep-arrow', kdTodoOpen ? '▾' : '▸'));
    ph.appendChild(el('b', null, 'Zu tun (' + todo.length + ')'));
    ph.appendChild(el('span', 'svc-todo-sub', 'überfällig oder bald fällig – noch ohne Termin'));
    ph.onclick = () => { kdTodoOpen = !kdTodoOpen; try { localStorage.setItem(KD_TODO_KEY, kdTodoOpen ? '1' : '0'); } catch (e) {} renderService(); };
    panel.appendChild(ph);
    if (kdTodoOpen) {
      const ul = el('div', 'svc-todo-list');
      if (!todo.length) ul.appendChild(el('div', 'phase-hint', 'Nichts offen. 👍'));
      for (const s of todo) {
        const it = el('div', 'svc-todo-item');
        it.appendChild(el('span', 'sv-dot sv-' + svcState(s)));
        it.appendChild(el('span', 'svc-todo-name', svcName(s)));
        it.appendChild(el('span', 'svc-todo-due', s.faellig ? (s.faellig < now ? 'seit ' : '') + ymLabel(s.faellig) : ''));
        const stb = el('span', 'svc-st st-' + svcStatus(s), SVC_ST[svcStatus(s)]); it.appendChild(stb);
        it.onclick = () => openServiceDialog(s);
        ul.appendChild(it);
      }
      panel.appendChild(ul);
    }
    wrap.appendChild(panel);

    const grid = el('div', 'svcgrid');
    grid.style.gridTemplateColumns = '300px 96px 74px 74px repeat(' + months.length + ', minmax(62px, 1fr))';
    grid.appendChild(el('div', 'wk-corner', list.length + ' Anlagen'));
    ['Stand', 'Letzte', 'Nächste'].forEach(t => grid.appendChild(el('div', 'wk-dayhead svc-colhead', t)));
    months.forEach((ym, i) => {
      const h = el('div', 'wk-dayhead' + (ym === now ? ' today' : ''));
      const due = list.filter(s => s.faellig === ym).length, pl = list.reduce((n, s) => n + (s.termine || []).filter(t => !t.erledigt && t.start && t.start.slice(0, 7) === ym).length, 0);
      h.appendChild(el('div', null, ymLabel(ym)));
      h.appendChild(el('div', 'svc-mcount', (due ? due + ' fällig' : '') + (due && pl ? ' · ' : '') + (pl ? pl + ' Term.' : '')));
      if (i === 0) { const p = el('button', 'svc-nav', '‹'); p.title = 'früher'; p.onclick = () => { svcMonthStart = ymAdd(svcMonthStart, -3); renderService(); }; h.prepend(p); }
      if (i === months.length - 1) { const n = el('button', 'svc-nav', '›'); n.title = 'später'; n.onclick = () => { svcMonthStart = ymAdd(svcMonthStart, 3); renderService(); }; h.appendChild(n); }
      grid.appendChild(h);
    });
    if (!svcList().length) { const e = el('div', 'svc-empty', 'Noch keine Wartungen. Über „Excel importieren" die bestehende Wartungsliste übernehmen oder mit „+ Vertrag" anlegen.'); e.style.gridColumn = '1 / -1'; grid.appendChild(e); }
    // Monatszellen einer Anlage bzw. einer Gruppe (zusammengefasst)
    const monthCells = (items, isGroup, s0) => months.forEach((ym, i) => {
      const c = el('div', 'wk-cell svc-cell' + (ym === now ? ' today' : '') + (isGroup ? ' grp' : ''));
      let done = 0, open = 0, ext = 0, dueN = 0, dueSt = null;
      for (const s of items) {
        const st = svcState(s);
        const terms = (s.termine || []).filter(t => t.start && t.start.slice(0, 7) === ym);
        if (!isGroup) {
          (s.history || []).filter(h => h.date && h.date.slice(0, 7) === ym).forEach(h => { const d = el('span', 'sv-done', '✓ ' + h.date.slice(8, 10) + '.'); d.title = 'durchgeführt ' + fmt(parse(h.date)) + (h.text ? ' – ' + h.text : ''); c.appendChild(d); });
          for (const t of terms) {
            const who = (t.wer || []).map(monteurName).join(', ') || t.firma || 'noch niemand';
            const ch = el('span', 'sv-chip' + (t.erledigt ? ' done' : '') + ((t.wer || []).length ? '' : ' ext'), t.start.slice(8, 10) + '.');
            ch.title = 'Termin ' + fmt(parse(t.start)) + (t.end && t.end !== t.start ? '–' + fmt(parse(t.end)) : '') + ' · ' + who + (t.notiz ? '\n' + t.notiz : '');
            c.appendChild(ch);
          }
          if (i === 0 && s.faellig && s.faellig < ym && st === 'over') { const d = el('span', 'sv-due sv-over'); d.title = 'überfällig seit ' + ymLabel(s.faellig); c.appendChild(d); c.appendChild(el('span', 'sv-since', '« ' + ymLabel(s.faellig))); }
          if (s.faellig === ym && st !== 'planned') { const d = el('span', 'sv-due sv-' + st); d.title = 'fällig ' + ymLabel(ym); c.appendChild(d); }   // mit offenem Termin ist die Fälligkeit abgedeckt
        } else {
          done += (s.history || []).filter(h => h.date && h.date.slice(0, 7) === ym).length;
          open += terms.filter(t => !t.erledigt && (t.wer || []).length).length; ext += terms.filter(t => !t.erledigt && !(t.wer || []).length).length;
          if ((s.faellig === ym && st !== 'planned') || (i === 0 && st === 'over' && s.faellig && s.faellig < ym)) { dueN++; if (!dueSt || SVC_RANK[st] < SVC_RANK[dueSt]) dueSt = st; }
        }
      }
      if (isGroup) {
        if (done) c.appendChild(el('span', 'sv-done', '✓' + (done > 1 ? done : '')));
        if (open) c.appendChild(el('span', 'sv-chip', open > 1 ? open + '×' : 'T'));
        if (ext) c.appendChild(el('span', 'sv-chip ext', ext > 1 ? ext + '×' : 'T'));
        if (dueN) { const d = el('span', 'sv-due sv-' + (dueSt === 'planned' ? 'ok' : dueSt) + (dueN > 1 ? ' n' : ''), dueN > 1 ? String(dueN) : ''); d.title = dueN + ' fällig'; c.appendChild(d); }
        c.onclick = () => openGroupDialog(items, ym);
      } else c.onclick = () => openServiceDialog(s0, ym);
      grid.appendChild(c);
    });
    const contractRow = (s, indent) => {
      const st = svcState(s), gaps = svcGaps(s);
      const nm = el('div', 'wk-name svc-name' + (indent ? ' sub' : '') + (s.aktiv === false ? ' inactive' : ''));
      nm.appendChild(el('span', 'sv-dot sv-' + st));
      nm.appendChild(el('span', 'wk-person-name', indent ? (s.kunde || '') : svcName(s)));
      if (gaps.length) { const w = el('span', 'svc-gap', '⚠'); w.title = 'fehlt: ' + gaps.join(', '); nm.appendChild(w); }
      nm.title = svcName(s) + (s.pnr ? '\nPNr ' + s.pnr : '') + '\n' + (s.intervall ? s.intervall + '× jährlich' : 'ohne Intervall') + (s.notiz ? '\n' + s.notiz : '') + '\nKlick: bearbeiten';
      nm.onclick = () => openServiceDialog(s);
      grid.appendChild(nm);
      grid.appendChild(el('div', 'wk-cell svc-stc', '')).appendChild(el('span', 'svc-st st-' + svcStatus(s), SVC_ST[svcStatus(s)]));
      grid.appendChild(el('div', 'wk-cell svc-small', shortDate(svcLast(s)) || '–'));
      const nx = el('div', 'wk-cell svc-small' + (st === 'over' ? ' over' : st === 'soon' ? ' soon' : ''), s.faellig ? ymLabel(s.faellig) : (s.faelligText || '–'));
      grid.appendChild(nx);
      monthCells([s], false, s);
    };
    // Gruppen: Anlagen desselben Objekts (Ort + PNr) zusammen
    const groups = new Map();
    for (const s of list) { const k = svcGroupKey(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    const glist = [...groups.entries()].map(([k, items]) => ({ k, items, label: svcGroupLabel(items) }))
      .sort((a, b) => (a.items[0].ort || '').localeCompare(b.items[0].ort || '', 'de') || a.label.localeCompare(b.label, 'de'));
    for (const g of glist) {
      if (g.items.length === 1) { contractRow(g.items[0], false); continue; }
      const open = kdOpen.has(g.k) || !!q;
      const gst = worst(g.items);
      const nm = el('div', 'wk-name svc-name grp');
      nm.appendChild(el('span', 'wk-sep-arrow', open ? '▾' : '▸'));
      nm.appendChild(el('span', 'sv-dot sv-' + gst));
      nm.appendChild(el('span', 'wk-person-name', g.label));
      nm.appendChild(el('span', 'svc-bearb', g.items.length + ' Anlagen'));
      const add = el('button', 'svc-grp-add', '+ Termin'); add.title = 'Ein Termin für mehrere Anlagen dieses Objekts';
      add.onclick = (e) => { e.stopPropagation(); openGroupDialog(g.items); };
      nm.appendChild(add);
      nm.onclick = () => { if (kdOpen.has(g.k)) kdOpen.delete(g.k); else kdOpen.add(g.k); try { localStorage.setItem(KD_OPEN_KEY, JSON.stringify([...kdOpen])); } catch (e) {} renderService(); };
      grid.appendChild(nm);
      const cnt = {}; g.items.forEach(s => { const x = svcStatus(s); cnt[x] = (cnt[x] || 0) + 1; });
      grid.appendChild(el('div', 'wk-cell svc-small grp', Object.entries(cnt).map(([k2, n]) => n + ' ' + k2).join(' · ')));
      grid.appendChild(el('div', 'wk-cell svc-small grp', shortDate(g.items.map(svcLast).filter(Boolean).sort().pop()) || '–'));
      const nxt = g.items.map(s => s.faellig).filter(Boolean).sort()[0];
      grid.appendChild(el('div', 'wk-cell svc-small grp' + (gst === 'over' ? ' over' : gst === 'soon' ? ' soon' : ''), nxt ? ymLabel(nxt) : '–'));
      monthCells(g.items, true);
      if (open) g.items.forEach(s => contractRow(s, true));
    }
    wrap.appendChild(grid);
    const sl = svcShown ? viewport.scrollLeft : 0, stp = svcShown ? viewport.scrollTop : 0;
    viewport.innerHTML = '';
    viewport.appendChild(wrap);
    viewport.scrollLeft = sl; viewport.scrollTop = stp;
    svcShown = true;
  }

  // ---- Sammeltermin für mehrere Anlagen eines Objekts ----
  function openGroupDialog(items, ym) {
    const ov = el('div', 'overlay'), dlg = el('div', 'dialog svc-dialog');
    dlg.appendChild(el('h3', null, 'Termin für mehrere Anlagen · ' + svcGroupLabel(items)));
    const listBox = el('div', 'svc-glist'), picks = new Map();
    for (const s of items) {
      const st = svcState(s);
      const lab = el('label', 'w-check');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = st !== 'planned' && s.aktiv !== false; picks.set(s, cb);
      lab.appendChild(cb); lab.appendChild(el('span', 'sv-dot sv-' + st));
      lab.appendChild(el('span', null, (s.kunde || '') + (s.faellig ? ' · fällig ' + ymLabel(s.faellig) : '') + ' · ' + SVC_ST[svcStatus(s)]));
      listBox.appendChild(lab);
    }
    dlg.appendChild(el('div', 'assign-title', 'Anlagen')); dlg.appendChild(listBox);
    const r = el('div', 'phase-row2');
    let d0 = parse((ym || ymOf(todayMs())) + '-01'); if (ym) { while (!isWorkdayMs(d0)) d0 = addDays(d0, 1); } else d0 = todayMs();
    const von = document.createElement('input'); von.type = 'date'; von.value = isoStr(d0);
    const bis = document.createElement('input'); bis.type = 'date'; bis.value = isoStr(d0);
    von.onchange = () => { if (!bis.value || bis.value < von.value || bis.dataset.touched !== '1') bis.value = von.value; };
    bis.onchange = () => { bis.dataset.touched = '1'; if (bis.value < von.value) bis.value = von.value; };
    const firma = document.createElement('input'); firma.type = 'text'; firma.placeholder = 'oder Servicefirma';
    const L = (t, inp) => { const l = el('label', 'phase-fld', t); l.appendChild(inp); return l; };
    r.appendChild(L('Von', von)); r.appendChild(L('Bis', bis)); r.appendChild(L('Servicefirma', firma));
    dlg.appendChild(r);
    const wer = new Set(), chips = el('div', 'f-bl-chips');
    const drawChips = () => { chips.innerHTML = ''; for (const m of PLAN.team) { const on = wer.has(m.id), c = el('span', 'trade-chip' + (on ? ' on' : ''), m.name); if (on) c.style.background = '#2f9e8f'; c.onclick = () => { if (on) wer.delete(m.id); else wer.add(m.id); drawChips(); }; chips.appendChild(c); } };
    drawChips();
    dlg.appendChild(el('div', 'assign-title', 'Eigene Techniker')); dlg.appendChild(chips);
    const notiz = document.createElement('input'); notiz.type = 'text'; notiz.placeholder = 'Notiz zum Termin'; notiz.className = 'svc-tnotiz'; dlg.appendChild(notiz);
    // offene Termine dieses Objekts gemeinsam abhaken
    const openDates = [...new Set(items.flatMap(s => (s.termine || []).filter(t => !t.erledigt && t.start).map(t => t.start)))].sort();
    if (openDates.length) {
      dlg.appendChild(el('div', 'assign-title', 'Offene Termine erledigen'));
      const box = el('div', 'f-bl-chips');
      for (const d of openDates) {
        const b = el('button', 'btn', '✓ alle am ' + fmt(parse(d)) + ' erledigt');
        b.onclick = () => { for (const s0 of items) { const s = kdData.find(x => x.id === s0.id) || s0; for (const t of (s.termine || [])) if (!t.erledigt && t.start === d) svcMarkDone(s, t); } kdSave(); ov.remove(); renderService(); };
        box.appendChild(b);
      }
      dlg.appendChild(box);
    }
    const act = el('div', 'dialog-actions');
    const cancel = el('button', 'btn', 'Abbrechen'), ok = el('button', 'btn primary', 'Termin anlegen');
    cancel.onclick = () => ov.remove();
    ok.onclick = () => {
      const sel = items.filter(s => picks.get(s).checked).map(s => kdData.find(x => x.id === s.id) || s);
      if (!sel.length) { alert('Bitte mindestens eine Anlage auswählen.'); return; }
      if (!von.value) { von.focus(); return; }
      const gid = 'sg' + Date.now().toString(36);
      sel.forEach((s, i) => (s.termine = s.termine || []).push({ id: gid + '-' + i, start: von.value, end: bis.value || von.value, wer: [...wer], firma: firma.value.trim(), notiz: notiz.value.trim(), erledigt: false }));
      kdSave(); ov.remove(); renderService();
    };
    act.appendChild(el('div', 'spacer')); act.appendChild(cancel); act.appendChild(ok);
    dlg.appendChild(act); ov.appendChild(dlg);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }
  let svcShown = false;
  ['svcSearch', 'svcFilter'].forEach(id => { const e = document.getElementById(id); e.addEventListener(id === 'svcSearch' ? 'input' : 'change', () => renderService()); });

  // ---- Dialog ----
  const soverlay = document.getElementById('soverlay');
  let curSvc = null, svcDraft = null;
  function openServiceDialog(s, ym) {
    curSvc = s || null;
    svcDraft = JSON.parse(JSON.stringify(s || { ort: '', kunde: '', intervall: 1, history: [], angebote: [], termine: [] }));
    svcDraft.termine = svcDraft.termine || []; svcDraft.angebote = svcDraft.angebote || []; svcDraft.history = svcDraft.history || [];
    S('sTitle').textContent = s ? 'Wartungsvertrag · ' + svcName(s) : 'Neuer Wartungsvertrag';
    S('s-ort').value = svcDraft.ort || ''; S('s-kunde').value = svcDraft.kunde || ''; S('s-pnr').value = svcDraft.pnr || ''; S('s-vnr').value = svcDraft.vnr || '';
    S('s-intervall').value = String(svcDraft.intervall || 0); S('s-faellig').value = svcDraft.faellig || ''; S('s-preis').value = svcDraft.preis != null && svcDraft.preis !== '' ? String(svcDraft.preis).replace('.', ',') : '';
    S('s-abnahme').value = svcDraft.abnahme || ''; S('s-gewende').value = svcDraft.gewende || ''; S('s-doku').value = svcDraft.doku || '';
    S('s-notiz').value = [svcDraft.notiz, svcDraft.faelligText].filter(Boolean).join(' · ');
    S('s-status').value = svcDraft.anfrage || ''; S('s-inaktiv').checked = svcDraft.aktiv === false;
    S('s-delete').style.display = s ? '' : 'none';
    if (ym && s && !svcDraft.termine.some(t => t.start && t.start.slice(0, 7) === ym)) svcPendingYm = ym; else svcPendingYm = null;
    renderSvcTermine(); renderSvcAngebote(); renderSvcHistory();
    soverlay.hidden = false;
  }
  let svcPendingYm = null;
  function renderSvcTermine() {
    const box = S('s-termine'); box.innerHTML = '';
    if (!svcDraft.termine.length) box.appendChild(el('div', 'phase-hint', 'Noch kein Termin.' + (svcPendingYm ? ' „+ Termin" legt ihn in ' + ymLabel(svcPendingYm) + ' an.' : '')));
    svcDraft.termine.forEach((t, i) => {
      const card = el('div', 'svc-termin' + (t.erledigt ? ' done' : ''));
      const r1 = el('div', 'phase-row2');
      const von = document.createElement('input'); von.type = 'date'; von.value = t.start || ''; von.onchange = () => { const single = !t.end || t.end === t.start; t.start = von.value; if (single || t.end < t.start) { t.end = t.start; bis.value = t.end; } };
      const bis = document.createElement('input'); bis.type = 'date'; bis.value = t.end || t.start || ''; bis.onchange = () => { t.end = bis.value < t.start ? t.start : bis.value; bis.value = t.end; };
      const firma = document.createElement('input'); firma.type = 'text'; firma.placeholder = 'oder Servicefirma'; firma.value = t.firma || ''; firma.oninput = () => { t.firma = firma.value; };
      const ok = document.createElement('input'); ok.type = 'checkbox'; ok.checked = !!t.erledigt; ok.onchange = () => { t.erledigt = ok.checked; card.classList.toggle('done', ok.checked); };
      const del = el('span', 'phase-del', '✕'); del.title = 'Termin entfernen'; del.onclick = () => { svcDraft.termine.splice(i, 1); renderSvcTermine(); };
      const L = (t1, inp, cls) => { const l = el('label', 'phase-fld' + (cls ? ' ' + cls : ''), t1); l.appendChild(inp); return l; };
      r1.appendChild(L('Von', von)); r1.appendChild(L('Bis', bis)); r1.appendChild(L('Servicefirma', firma)); r1.appendChild(L('erledigt', ok, 'phase-wk')); r1.appendChild(del);
      card.appendChild(r1);
      // eigene Techniker (Chips)
      const chips = el('div', 'f-bl-chips');
      for (const m of PLAN.team) {
        const on = (t.wer || []).includes(m.id), chip = el('span', 'trade-chip' + (on ? ' on' : ''), m.name);
        if (on) chip.style.background = '#2f9e8f';
        chip.onclick = () => { t.wer = t.wer || []; if (on) t.wer = t.wer.filter(x => x !== m.id); else t.wer.push(m.id); renderSvcTermine(); };
        chips.appendChild(chip);
      }
      card.appendChild(el('div', 'assign-title', 'Eigene Techniker'));
      card.appendChild(chips);
      const notiz = document.createElement('input'); notiz.type = 'text'; notiz.placeholder = 'Notiz zum Termin (z. B. DGUV V3, nur Spülmaschine)'; notiz.value = t.notiz || ''; notiz.oninput = () => { t.notiz = notiz.value; };
      notiz.className = 'svc-tnotiz'; card.appendChild(notiz);
      box.appendChild(card);
    });
  }
  S('s-termin-add').onclick = () => {
    const ym = svcPendingYm || S('s-faellig').value || ymOf(todayMs());
    let d = parse(ym + '-01'); while (!isWorkdayMs(d)) d = addDays(d, 1);
    svcDraft.termine.push({ id: 'st' + Date.now().toString(36), start: isoStr(d), end: isoStr(d), wer: [], firma: '', notiz: '', erledigt: false });
    svcPendingYm = null; renderSvcTermine();
  };
  function renderSvcAngebote() {
    const box = S('s-angebote'); box.innerHTML = '';
    svcDraft.angebote.forEach((a, i) => {
      const r = el('div', 'phase-row2');
      const mk = (k, ph, w) => { const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = ph; inp.value = a[k] || ''; inp.oninput = () => { a[k] = inp.value; }; inp.style.flex = w; return inp; };
      r.appendChild(mk('firma', 'Firma', '2')); r.appendChild(mk('datum', 'Datum', '1')); r.appendChild(mk('preis', 'Preis / Stand', '1'));
      const del = el('span', 'phase-del', '✕'); del.onclick = () => { svcDraft.angebote.splice(i, 1); renderSvcAngebote(); }; r.appendChild(del);
      box.appendChild(r);
    });
  }
  S('s-angebot-add').onclick = () => { svcDraft.angebote.push({ firma: '', datum: '', preis: '' }); renderSvcAngebote(); };
  function renderSvcHistory() {
    const box = S('s-history'); box.innerHTML = '';
    const h = svcDraft.history.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!h.length) { box.appendChild(el('div', 'phase-hint', 'Noch keine durchgeführten Wartungen eingetragen.')); return; }
    for (const e of h) box.appendChild(el('div', 'svc-hrow', (e.date ? fmt(parse(e.date)) : '—') + (e.text && e.text !== (e.date ? fmt(parse(e.date)) : '') ? '  ·  ' + e.text : '')));
  }
  function closeServiceDialog() { soverlay.hidden = true; curSvc = null; svcDraft = null; }
  S('s-cancel').onclick = closeServiceDialog;
  soverlay.addEventListener('click', (e) => { if (e.target === soverlay) closeServiceDialog(); });
  S('s-save').onclick = () => {
    const d = svcDraft; if (!d) return;
    d.ort = S('s-ort').value.trim(); d.kunde = S('s-kunde').value.trim();
    if (!d.kunde) { S('s-kunde').focus(); return; }
    d.pnr = S('s-pnr').value.trim(); d.vnr = S('s-vnr').value.trim(); d.intervall = +S('s-intervall').value || 0;
    d.faellig = S('s-faellig').value || ''; if (d.faellig) delete d.faelligText;
    const pr = S('s-preis').value.trim().replace(/\./g, '').replace(',', '.'); d.preis = pr === '' ? '' : (isNaN(+pr) ? S('s-preis').value.trim() : +pr);
    d.abnahme = S('s-abnahme').value.trim(); d.gewende = S('s-gewende').value.trim(); d.doku = S('s-doku').value.trim();
    d.notiz = S('s-notiz').value.trim(); delete d.faelligText;
    d.anfrage = S('s-status').value; d.aktiv = !S('s-inaktiv').checked;
    // neu erledigte Termine → Historie + nächste Fälligkeit nach Intervall
    const before = curSvc ? (curSvc.termine || []) : [];
    const parts = [];
    for (const t of d.termine) {
      if (!t.start) continue;
      const was = before.find(b => b.id === t.id);
      if (t.erledigt && !(was && was.erledigt)) {
        svcMarkDone(d, t);
        parts.push('erledigt ' + fmt(parse(t.start)));
      } else if (!was) parts.push('Termin ' + fmt(parse(t.start)) + ((t.wer || []).length ? ' (' + t.wer.map(monteurName).join(', ') + ')' : t.firma ? ' (' + t.firma + ')' : ''));
    }
    const target = curSvc && (kdData.find(x => x.id === curSvc.id) || curSvc);
    if (target) { Object.keys(target).forEach(k => delete target[k]); Object.assign(target, d); if (kdData.indexOf(target) < 0) kdData.push(target); }
    else { d.id = 'sv' + Date.now().toString(36); svcList().push(d); }
    kdSave();
    closeServiceDialog(); render();
  };
  S('s-delete').onclick = () => {
    if (!curSvc || !confirm(`Wartungsvertrag „${svcName(curSvc)}" löschen?`)) return;
    const s = curSvc;
    kdData = kdData.filter(x => x !== s); kdSave();
    closeServiceDialog(); render();
  };
  S('svcAdd').onclick = () => openServiceDialog(null);

  // ---- Einmaliger Import der Excel-Wartungsliste (im Browser gelesen, nichts wird hochgeladen außer in den Plan) ----
  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((ok, fail) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; sc.onload = ok; sc.onerror = () => fail(new Error('Excel-Leser konnte nicht geladen werden (Internet?)')); document.head.appendChild(sc); });
  }
  const p2s = (n) => String(n).padStart(2, '0');
  function parseDates(txt) {   // alle Datumsangaben aus einem Freitext (dd.mm.yyyy, dd.+dd.mm.yy, yyyy-mm-dd)
    const out = [];
    const s = String(txt || '');
    for (const m of s.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) out.push(m[1] + '-' + m[2] + '-' + m[3]);
    for (const m of s.matchAll(/(\d{1,2})\.\s*(?:\+\s*\d{1,2}\.\s*)?(\d{1,2})\.\s*(\d{2,4})/g)) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; out.push(y + '-' + p2s(m[2]) + '-' + p2s(m[1])); }
    return out.filter(d => !isNaN(parse(d)));
  }
  function importServiceWorkbook(wb) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const ref = XLSX.utils.decode_range(ws['!ref']);
    const cellTxt = (r, c) => { const x = ws[XLSX.utils.encode_cell({ r, c })]; if (!x) return ''; if (x.t === 'd' && x.v instanceof Date) return isoStr(Date.UTC(x.v.getFullYear(), x.v.getMonth(), x.v.getDate())); return String(x.w != null ? x.w : x.v).trim(); };
    const hdr = []; for (let c = ref.s.c; c <= ref.e.c; c++) hdr[c] = cellTxt(0, c).replace(/\s+/g, ' ').toLowerCase();
    const col = (re) => hdr.findIndex(h => h && re.test(h));
    const C = { ort: col(/^ort/), kunde: col(/^kunde/), vnr: col(/wartungsvertrag/), pnr: col(/^pnr/), abn: col(/abnahme/), gew: col(/gewährleistungsende/), iv: col(/intervall/), next: col(/nächste wartung/), preis: col(/€/), bearb: col(/bearbeiter/), doku: col(/dokumentation/) };
    const termCols = hdr.map((h, c) => (h && /termin\s*\d+\.\s*wartung/.test(h) ? c : -1)).filter(c => c >= 0);
    const firmCols = hdr.map((h, c) => (h && /servicefirma/.test(h) ? c : -1)).filter(c => c >= 0);
    const lastTerm = Math.max(...termCols), firstFirm = firmCols.length ? Math.min(...firmCols) : ref.e.c + 1;
    const out = []; let lastOrt = '';
    for (let r = 1; r <= ref.e.r; r++) {
      const kunde = cellTxt(r, C.kunde); if (!kunde) continue;
      const ort = cellTxt(r, C.ort) || lastOrt; lastOrt = ort;
      const ivTxt = cellTxt(r, C.iv), iv = /2/.test(ivTxt) ? 2 : /1/.test(ivTxt) ? 1 : 0;
      const nx = cellTxt(r, C.next); let faellig = '', faelligText = '';
      const m = nx.match(/^(\d{4})\s*\/?\s*(\d{1,2})/); if (m && +m[2] >= 1 && +m[2] <= 12) faellig = m[1] + '-' + p2s(m[2]); else if (/^\d{4}-\d{2}/.test(nx)) faellig = nx.slice(0, 7); else faelligText = nx;
      const history = [];
      for (const c of termCols) {
        const t = cellTxt(r, c); if (!t) continue;
        const ds = parseDates(t);
        if (!ds.length) { history.push({ date: '', text: t.replace(/\s+/g, ' ') }); continue; }
        const pure = /^\s*[\d.\-+\s]*$/.test(t);
        ds.forEach((d, i) => history.push({ date: d, text: i === 0 && !pure ? t.replace(/\s+/g, ' ') : '' }));
      }
      const notes = []; for (let c = lastTerm + 1; c < firstFirm; c++) { if (c === C.bearb) continue; const t = cellTxt(r, c); if (t) notes.push(t.replace(/\s+/g, ' ')); }
      const angebote = []; for (const c of firmCols) { const f = cellTxt(r, c); if (!f) continue; const dt = cellTxt(r, c + 1), pr = cellTxt(r, c + 2); angebote.push({ firma: f.replace(/\s+/g, ' '), datum: (parseDates(dt)[0] ? fmt(parse(parseDates(dt)[0])) : '') + (dt && !/^\d{4}-\d{2}-\d{2}$/.test(dt) && !/^[\d.]+$/.test(dt) ? ' ' + dt.replace(/\s+/g, ' ') : ''), preis: pr.replace(/\s+/g, ' ') }); }
      const px = ws[XLSX.utils.encode_cell({ r, c: C.preis })], preisTxt = px && px.t === 'n' ? px.v : cellTxt(r, C.preis), preisNum = typeof preisTxt === 'number' ? preisTxt : +String(preisTxt).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
      out.push({ id: 'sv' + r + '~' + (kunde + ort).replace(/[^A-Za-z0-9]/g, '').slice(0, 16), ort, kunde, vnr: cellTxt(r, C.vnr), pnr: cellTxt(r, C.pnr), abnahme: cellTxt(r, C.abn), gewende: cellTxt(r, C.gew),
        intervall: iv, faellig, faelligText, preis: preisTxt === '' ? '' : (isNaN(preisNum) ? preisTxt : preisNum), bearbeiter: cellTxt(r, C.bearb), doku: cellTxt(r, C.doku),
        notiz: [ivTxt && !iv ? ivTxt : '', ...notes].filter(Boolean).join(' · '), history, angebote, termine: [] });
    }
    return out;
  }
  S('svcImport').onclick = () => {
    if (svcList().length && !confirm('Es gibt bereits ' + svcList().length + ' Wartungsverträge.\nBeim Import werden neue Verträge ergänzt; vorhandene mit gleichem Kunden + Ort bleiben unverändert. Fortfahren?')) return;
    S('svcFile').value = ''; S('svcFile').click();
  };
  S('svcFile').onchange = async () => {
    const f = S('svcFile').files[0]; if (!f) return;
    try {
      await loadSheetJs();
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const rows = importServiceWorkbook(wb);
      const key = (s) => (s.kunde + '|' + s.ort).toLowerCase().replace(/\s+/g, ' ').trim();
      const have = new Set(svcList().map(key)), add = rows.filter(s => !have.has(key(s)));
      if (!confirm(rows.length + ' Verträge in der Liste gefunden, davon ' + add.length + ' neu.\nJetzt übernehmen?')) return;
      add.forEach(svcNormalize); svcList().push(...add); kdSave();
      toast(add.length + ' Wartungsverträge übernommen');
      render();
    } catch (e) { alert('Import fehlgeschlagen: ' + (e && e.message || e)); }
  };

  // ---- Ansicht umschalten & Wochen-Navigation ----
  function setView(mode) {
    const fromWeek = viewMode === 'week' && mode === 'timeline';
    viewMode = mode;
    document.getElementById('viewTimeline').classList.toggle('active', mode === 'timeline');
    document.getElementById('viewWeek').classList.toggle('active', mode === 'week');
    document.getElementById('viewService').classList.toggle('active', mode === 'service');
    document.getElementById('hint').style.display = mode === 'timeline' ? '' : 'none';
    document.getElementById('weekbar').hidden = mode !== 'week';
    document.getElementById('svcbar').hidden = mode !== 'service';
    document.querySelectorAll('.timeline-only').forEach(elm => { elm.style.display = mode === 'timeline' ? '' : 'none'; });
    if (mode !== 'week') weekShown = false;
    if (mode !== 'service') svcShown = false;
    render();
    // Zurück aus der Woche: Zeitplan auf die dort gezeigte Woche stellen (statt an den Planbeginn zu springen)
    if (fromWeek) { scrollTodayPending = false; requestAnimationFrame(() => scrollToWeek(selMonday)); }
  }
  document.getElementById('viewTimeline').onclick = () => setView('timeline');
  document.getElementById('viewService').onclick = () => { setView('service'); kdSync(false).catch(() => {}); };   // beim Öffnen Stand der anderen holen
  document.getElementById('viewWeek').onclick = () => setView('week');
  document.getElementById('wkPrev').onclick = () => { selMonday = addDays(selMonday, -7); renderWeek(); };
  document.getElementById('wkNext').onclick = () => { selMonday = addDays(selMonday, 7); renderWeek(); };
  document.getElementById('wkToday').onclick = () => { selMonday = mondayMs(todayMs()); renderWeek(); };

  document.getElementById('zoomIn').onclick = () => { dayWidth = Math.min(48, dayWidth + 4); render(); };
  document.getElementById('zoomOut').onclick = () => { dayWidth = Math.max(6, dayWidth - 4); render(); };
  document.getElementById('today').onclick = () => scrollToToday();
  function updateLanesToggle() {
    const b = document.getElementById('toggleLanes'); if (!b) return;
    b.textContent = (lanesCollapsed ? '▸' : '▾') + ' Monteure';
    b.classList.toggle('active', !lanesCollapsed);
    b.title = lanesCollapsed ? 'Monteur-Zeilen ausklappen (Details je Fenster)' : 'Monteur-Zeilen einklappen (Gesamtüberblick)';
  }
  document.getElementById('toggleLanes').onclick = () => { lanesCollapsed = !lanesCollapsed; updateLanesToggle(); render(); };
  updateLanesToggle();
  function archivedCount() { const g = PLAN.groups.find(x => x.name === 'Projekte'); return g ? g.rows.filter(r => r.archived).length : 0; }
  function updateArchiveToggle() {
    const b = document.getElementById('toggleArchive'); if (!b) return;
    const n = archivedCount();
    b.hidden = (n === 0 && !showArchived);   // Button nur zeigen, wenn es Archiv gibt (oder gerade aktiv)
    b.textContent = (showArchived ? '▾ ' : '') + 'Archiv' + (n ? ' (' + n + ')' : '');
    b.classList.toggle('active', showArchived);
    b.title = showArchived ? 'Archivierte Projekte ausblenden' : 'Archivierte (abgeschlossene) Projekte anzeigen';
  }
  document.getElementById('toggleArchive').onclick = () => { showArchived = !showArchived; updateArchiveToggle(); render(); };
  document.getElementById('addProject').onclick = () => openProjectDialog(null);
  document.getElementById('addResource').onclick = () => openResourceDialog(null, 'resource');
  document.getElementById('search').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render(); };
  document.getElementById('undoBtn').onclick = () => undo();
  document.getElementById('redoBtn').onclick = () => redo();
  // Tastenkürzel: Strg/Cmd+Z = Rückgängig, Strg/Cmd+Umschalt+Z oder Strg+Y = Wiederholen (nicht beim Tippen)
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (document.querySelector('.overlay:not([hidden])') || !tiView.hidden) return;   // Dialog offen: Daten nicht unter der Maske austauschen
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });

  const legend = document.getElementById('legend');
  function buildLegend() {
    legend.innerHTML = '';
    for (const key of Object.keys(PLAN.categories)) {
      const c = PLAN.categories[key];
      const item = el('div', 'item'); item.style.cursor = 'pointer';
      item.style.opacity = hiddenCats.has(key) ? .4 : 1; item.title = 'Klicken zum Ein-/Ausblenden';
      const sw = el('span', 'swatch'); sw.style.background = c.fill;
      item.appendChild(sw); item.appendChild(el('span', null, c.label));
      item.onclick = () => { hiddenCats.has(key) ? hiddenCats.delete(key) : hiddenCats.add(key); buildLegend(); render(); };
      legend.appendChild(item);
    }
  }

  // ---- Termineinladung (eingebetteter Generator + SharePoint-Zwischenspeicher pro Projekt) ----
  const tiView = document.getElementById('tiView');
  const tiFrame = document.getElementById('tiFrame');
  const tiTitle = document.getElementById('tiTitle');
  const tiStatus = document.getElementById('tiStatus');
  let tiProject = null, tiBar = null, tiPhase = [], tiReady = false, tiFresh = false;   // tiPhase: Phasen-Indizes (leer = ganze Montage / Projekt)
  const TI_SRC = 'termineinladung.html?v=58';
  // Phasen-Auswahl normalisieren: einzelner Index oder Liste → gültige, sortierte Indizes
  const tiIdxs = (bar, x) => (!bar || !bar.phases) ? [] : [...new Set([].concat(x == null ? [] : x))].filter(i => i >= 0 && bar.phases[i]).sort((a, b) => a - b);
  const tiTradeLabels = (bar, x) => [...new Set(tiIdxs(bar, x).map(i => (TRADES()[bar.phases[i].trade] || {}).label || 'Gewerk'))].join(' + ');
  // Gewerk → Vorbelegung in der Einladung (Tätigkeit bzw. Eintransport-Option)
  const TI_TRADE = { edelstahl: { taet: ['edelstahl'] }, elektrik: { art: 'anschluss_elektro', taet: ['elektro'] }, sanitaer: { art: 'anschluss_sanitaer', taet: ['sanitaer'] }, sanitaer_klein: { art: 'anschluss_sanitaer', taet: ['sanitaer'] }, eintransporthelfer: { et: [3] }, lagerist: {} };
  // Schlüssel der Phase für den Entwurf: Gewerk (+ laufende Nummer bei mehreren Phasen desselben Gewerks)
  const tiHash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); };
  // Phase über ihre feste ID (pid) – bleibt gleich, wenn andere Phasen gelöscht/umsortiert werden
  const tiPhaseId = (bar, idx) => { const ph = bar.phases[idx]; return ph.pid ? 'p' + tiHash(ph.pid) : tiPhaseKey(bar, idx); };
  function tiPhaseKey(bar, idx) {
    const ph = bar.phases[idx], t = ph.trade || 'gewerk';
    const nth = bar.phases.slice(0, idx).filter(p => (p.trade || 'gewerk') === t).length;
    return t + (nth ? (nth + 1) : '');
  }
  function tiDraftName(row, bar, phIdx, legacy) {
    const name = bar ? (bar.label || row.site || row.label || '') : (row.site || row.label || '');
    const base = ((row.nummer ? row.nummer + ' ' : '') + name)
      .replace(/[^0-9A-Za-zÄÖÜäöüß ._-]/g, '').trim().slice(0, 50).replace(/\s+/g, '_');
    const idxs = tiIdxs(bar, phIdx);
    if (legacy) {   // Benennung bis v112 (zum Wiederfinden alter Entwürfe)
      const barKey = bar ? '__' + String(bar.bid || bar.start || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 24) : '';
      return (base || 'projekt') + '__' + row.id + barKey + (idxs.length ? '__' + idxs.map(i => tiPhaseKey(bar, i)).join('-') : '') + '.json';
    }
    const barKey = bar ? '__b' + tiHash(String(bar.bid || bar.start || '')) : '';
    return (base || 'projekt') + '__' + row.id + barKey + (idxs.length ? '__' + idxs.map(i => tiPhaseId(bar, i)).join('-') : '') + '.json';
  }
  const tiKey = () => tiProject ? tiProject.id + (tiBar ? '~' + (tiBar.bid || '') : '') + tiIdxs(tiBar, tiPhase).map(i => '~' + tiPhaseId(tiBar, i)).join('') : '';
  // Nach einem Abgleich sind Zeile/Fenster neue Objekte → über die IDs wiederfinden, bevor etwas geschrieben wird
  function tiResolve() {
    const g = PLAN.groups.find(x => x.name === 'Projekte');
    const row = (g && tiProject && g.rows.find(r => r.id === tiProject.id)) || tiProject;
    const bar = tiBar ? ((row && row.bars.find(b => b === tiBar || (tiBar.bid && b.bid === tiBar.bid))) || tiBar) : null;
    tiProject = row; tiBar = bar;
  }
  // ---- Gemeinsame Projektdaten für alle Einladungen eines Projekts (Adresse, Ansprechpartner, Zugang, OneDrive) ----
  // Projekt: Straße/PLZ an der Zeile, der Rest in row.ti. Kleinprojekt: alles an der einzelnen Montage (bar / bar.ti).
  const TI_SHARED_KEYS = ['pb_name', 'pb_tel', 'pb_mail', 'bl_name', 'bl_tel', 'bl_mail', 'vorort', 'anmeldung', 'zugang', 'parken', 'plan_onedrive'];
  const tiSharedHost = (row, bar) => isKleinRow(row) ? (bar || null) : row;
  function tiSharedOf(row, bar) {
    const host = tiSharedHost(row, bar); if (!host) return {};
    let blob = host.ti;
    if (!blob && host === row && row.site) {   // Bereiche einer Baustelle teilen sich die Angaben
      const g = PLAN.groups.find(x => x.name === 'Projekte'), sib = g && g.rows.find(r => r.site === row.site && r.ti);
      if (sib) blob = sib.ti;
    }
    const a = host === row ? rowAddr(row) : { strasse: host.strasse || '', plz: host.plz || '', ort: host.ort || '' };
    return Object.assign({}, blob || {}, { strasse: a.strasse, plz: a.plz, ort: (blob && blob.ort) || a.ort, _authoritative: !!blob });
  }
  function tiStoreShared(fields) {
    tiResolve();
    const row = tiProject, host = row && tiSharedHost(row, tiBar); if (!host || !fields) return;
    const before = JSON.stringify([host.strasse, host.plz, host.ort, host.ti]);
    const blob = {};
    for (const k of TI_SHARED_KEYS) { const v = String(fields[k] || '').trim(); if (v) blob[k] = v; }
    if (host === row) {
      const str = String(fields.strasse || '').trim() || undefined, plz = String(fields.plz || '').trim() || undefined, ort = String(fields.ort || '').trim();
      if (ort && ort !== (row.ort || '')) blob.ort = ort;   // Ort der Zeile steckt im Projektnamen → Abweichung nur für die Einladung merken
      const g = PLAN.groups.find(x => x.name === 'Projekte');
      const rows = row.site && g ? g.rows.filter(r => r.site === row.site) : [row];
      for (const r of rows) { r.strasse = str; r.plz = plz; if (Object.keys(blob).length) r.ti = Object.assign({}, blob); else delete r.ti; }
    } else {
      setAddr(host, fields);
      if (Object.keys(blob).length) host.ti = blob; else delete host.ti;
    }
    if (JSON.stringify([host.strasse, host.plz, host.ort, host.ti]) !== before) save();
  }
  function tiPrefill(row, bar, phIdx) {
    const phs = tiIdxs(bar, phIdx).map(i => bar.phases[i]);
    let datum = '', zeitraum = '', objektname = row.site || row.label || '';
    const span = (s, e) => { datum = s; zeitraum = s === e ? '' : fmt(parse(s)) + '–' + fmt(parse(e)); };   // Datum = erster Tag (auch bei Einsatzart ohne Zeitraum sichtbar)
    if (phs.length) {
      // Einladung für ein Gewerk (oder mehrere derselben Person): Zeitraum der Phase(n); Bezeichnung nur bei Kleinprojekten aus dem Balken
      if (isKleinRow(row)) objektname = bar.label || objektname;
      span(phs.map(p => p.start).sort()[0], phs.map(p => p.end).sort().pop());
    } else if (bar) {
      // Einzelne Montage (z. B. ein Kleinprojekt): Bezeichnung + Zeitraum aus dem Balken
      objektname = bar.label || objektname;
      span(bar.start, bar.end);
    } else {
      const bars = (row.bars || []).slice().sort((a, b) => parse(a.start) - parse(b.start));
      if (bars.length) span(bars[0].start, bars[0].end);
    }
    const a = (bar && isKleinRow(row)) ? { strasse: bar.strasse || '', plz: bar.plz || '', ort: bar.ort || '' } : rowAddr(row);
    const pf = { objektname, projektnummer: row.nummer || '', ort: a.ort || row.ort || '', strasse: a.strasse, plz: a.plz, datum, zeitraum };
    if (phs.length) {
      const maps = phs.map(p => TI_TRADE[p.trade] || {}), uniq = (arr) => [...new Set(arr)];
      pf.arten = uniq(maps.map(m => m.art || 'montage'));
      pf.taetigkeiten = uniq(maps.flatMap(m => m.taet || [])); pf.eintransport = uniq(maps.flatMap(m => m.et || []));
      pf.mitfahrer = uniq(phs.flatMap(p => (p.assigned || []).map(idOf))).map(monteurName).join(', ');
      const bl = [...new Set(blRanges(bar).map(r => r.id))].map(monteurName);
      if (bl.length) pf.bl_name = bl[0];
    }
    // Aus der Planung als Vorauswahl: Monteure, Fahrzeuge mit Insassen, Übernachtung. Gilt für Gewerk-Einladungen
    // und für die Einladung einer einzelnen Montage (dann alle Phasen des Fensters).
    const planPhs = phs.length ? phs : ((bar && bar.phases) || []);
    if (bar && planPhs.length) {
      const uniq = (arr) => [...new Set(arr)];
      const pids = uniq(planPhs.flatMap(p => assignedRanges(p).map(r => r.id)));
      pf.mitfahrer = pids.map(monteurName).join(', ');
      // Übernachtung: tatsächlich geplante Nächte (Vorgabe der Phase abzüglich abgewählter + einzeln gesetzte)
      let nights = 0;
      for (const ph of planPhs) for (const r of assignedRanges(ph)) for (let ms = parse(r.start); ms <= parse(r.end); ms = addDays(ms, 1)) {
        const nx = addDays(ms, 1), x = (PLAN.nights || {})[akey(r.id, isoStr(ms))];
        const def = !!ph.overnight && (ph.weekend || isWorkdayMs(nx)) && assignedRanges(ph).some(q => q.id === r.id && parse(q.start) <= nx && parse(q.end) >= nx);
        if (x === 1 || (x !== 0 && def)) nights++;
      }
      pf.uebernachtung = nights ? 'Ja' : 'Nein';
      // Fahrzeuge am ersten Einsatztag, je Fahrzeug mit allen Insassen (auch Mitfahrer anderer Gewerke / Bauleitung)
      const first = planPhs.slice().sort((x, y) => parse(x.start) - parse(y.start))[0];
      const d0 = first.weekend ? first.start : snapWorkday(first.start);
      const keepMonday = selMonday;
      try {
        selMonday = mondayMs(parse(d0));
        const der = weekDerived(), occ = carOcc(d0, der);
        const used = uniq(pids.map(id => { const v = effVeh(id, d0, der); return v ? v.id : null; }).filter(Boolean));
        pf.fahrzeug = '' + used.map(id => vehLabel(vehById(id)) + ': ' + (occ[id] || []).join(', ')).join(' · ');
      } finally { selMonday = keepMonday; }
    }
    pf.shared = tiSharedOf(row, bar);   // überschreibt auch einen geladenen Entwurf – diese Angaben sind projektweit gleich
    return pf;
  }
  let tiSeq = 0;
  const TI_ORIGIN = (location.origin && location.origin !== 'null') ? location.origin : '*';
  async function tiSendInit() {
    if (!tiProject || !tiReady || !tiFrame.contentWindow) return;
    const seq = ++tiSeq;   // wird inzwischen eine andere Einladung geöffnet, gehört diese Antwort nicht mehr dazu
    let state = null;
    const fresh = tiFresh; tiFresh = false;   // „Formular leeren": Entwurf nicht wieder laden
    if (!fresh && window.Cloud && Cloud.isReady()) {
      tiStatus.textContent = 'lade Zwischenstand …';
      try {
        state = await Cloud.loadDraft(tiDraftName(tiProject, tiBar, tiPhase));
        if (!state && seq === tiSeq) state = await Cloud.loadDraft(tiDraftName(tiProject, tiBar, tiPhase, true));
        if (state && state.__cleared) state = null;   // bewusst geleert
      } catch (e) { /* kein Draft / offline */ }
    }
    if (seq !== tiSeq || !tiReady) return;
    tiStatus.textContent = state ? 'Zwischenstand geladen'
      : (window.Cloud && Cloud.isReady()) ? 'neu · aus Projektdaten vorbefüllt'
      : 'nicht angemeldet – kein SharePoint-Speichern';
    tiFrame.contentWindow.postMessage({ type: 'ti-init', projectKey: tiKey(), prefill: tiPrefill(tiProject, tiBar, tiPhase), state: state || null }, TI_ORIGIN);
  }
  // Formular frisch laden – sonst blieben Eingaben der zuvor geöffneten Einladung stehen
  function tiReload() {
    tiReady = false;
    if (!tiFrame.getAttribute('src')) tiFrame.setAttribute('src', TI_SRC);  // lädt → sendet ti-ready → tiSendInit
    else { try { tiFrame.contentWindow.location.reload(); } catch (e) { tiFrame.setAttribute('src', TI_SRC); } }
  }
  function openTermineinladung(row, bar, phIdx) {
    tiSeq++;
    tiProject = row; tiBar = bar || null; tiPhase = tiIdxs(tiBar, phIdx);
    const tl = tiPhase.length ? ' · ' + tiTradeLabels(tiBar, tiPhase) : '';
    tiTitle.textContent = 'Termineinladung · ' + ((bar && bar.label) || row.site || row.label || '') + tl;
    tiStatus.textContent = '';
    document.getElementById('tiBack').textContent = viewMode === 'week' ? '← Zurück zur Woche' : '← Zurück zum Zeitplan';
    tiView.hidden = false;
    tiReload();
  }
  document.getElementById('tiBack').onclick = () => { tiView.hidden = true; };
  window.addEventListener('message', async (e) => {
    if (!tiFrame || e.source !== tiFrame.contentWindow) return;
    const m = e.data || {};
    if (m.type !== 'ti-ready' && m.key && m.key !== tiKey()) return;   // Nachricht einer zuvor geöffneten Einladung
    if (m.type === 'ti-ready') { tiReady = true; tiSendInit(); }
    else if (m.type === 'ti-save') {
      if (!(window.Cloud && Cloud.isReady())) { tiFrame.contentWindow.postMessage({ type: 'ti-save-error', msg: 'nicht angemeldet' }, TI_ORIGIN); tiStatus.textContent = 'nicht gespeichert – bitte anmelden'; return; }
      tiStatus.textContent = 'speichere …';
      try { await Cloud.saveDraft(tiDraftName(tiProject, tiBar, tiPhase), m.state); tiFrame.contentWindow.postMessage({ type: 'ti-saved' }, TI_ORIGIN); tiStatus.textContent = 'in SharePoint gespeichert'; }
      catch (err) { tiFrame.contentWindow.postMessage({ type: 'ti-save-error', msg: (err && err.message) || '' }, TI_ORIGIN); tiStatus.textContent = 'Speichern fehlgeschlagen'; }
    }
    else if (m.type === 'ti-shared') { tiStoreShared(m.fields); }
    else if (m.type === 'ti-reset') {
      // „Formular leeren": auch den gespeicherten Entwurf leeren, sonst käme er beim nächsten Öffnen zurück
      if (window.Cloud && Cloud.isReady()) Cloud.saveDraft(tiDraftName(tiProject, tiBar, tiPhase), { __cleared: true }).catch(() => {});
      tiFresh = true; tiReload();
    }
  });

  // ---- Cloud-Sync (Microsoft-Login + SharePoint), optional ----
  const cloudStatusEl = document.getElementById('cloudStatus');
  const cloudLoginBtn = document.getElementById('cloudLogin');
  const cloudReloadBtn = document.getElementById('cloudReload');
  const loginNotice = document.getElementById('loginNotice');
  const loginNoticeErr = document.getElementById('loginNoticeErr');
  const gateHint = document.getElementById('gateHint');
  const gateLoginBtn = document.getElementById('gateLogin');
  const gateErr = document.getElementById('gateErr');
  function revealApp() {
    document.body.classList.add('authed');
    // App ist jetzt sichtbar (Breite bekannt) → zuverlässig auf die aktuelle Woche springen
    scrollTodayPending = false;
    requestAnimationFrame(scrollToToday);
  }
  function showGateLogin() {
    document.body.classList.remove('authed');
    const inPopup = !!(window.Cloud && Cloud.inPopup && Cloud.inPopup());
    if (inPopup) {
      if (gateHint) gateHint.textContent = 'Diese Ansicht läuft in einem eingebetteten Fenster – bitte im normalen Browser-Tab öffnen:';
      if (gateLoginBtn) gateLoginBtn.hidden = true;   // Link in #gateErr zeigt den Weg
    } else {
      if (gateHint) gateHint.textContent = 'Bitte mit deinem Microsoft-Konto anmelden, um den gemeinsamen Plan zu sehen.';
      if (gateLoginBtn) gateLoginBtn.hidden = false;
    }
  }
  function updateCloudUI(text, cls) {
    if (cloudStatusEl) { cloudStatusEl.textContent = text; cloudStatusEl.className = 'cloud-status ' + (cls || ''); }
    const ready = !!(window.Cloud && Cloud.isReady());
    const relog = !!(window.Cloud && Cloud.needsLogin && Cloud.needsLogin());   // Sitzung abgelaufen
    if (cloudLoginBtn) { cloudLoginBtn.textContent = relog ? 'Neu anmelden' : ready ? 'Abmelden' : 'Anmelden'; cloudLoginBtn.classList.toggle('primary', relog); }
    if (loginNotice) loginNotice.hidden = ready;   // nur zeigen, solange nicht angemeldet
    const isErr = cls === 'warn' && !ready;
    // Fehler direkt sichtbar machen – im In-App-Banner UND im Login-Gate (Link von showOpenInMainWindow nicht überschreiben)
    if (loginNoticeErr) {
      loginNoticeErr.hidden = !isErr;
      if (isErr && !loginNoticeErr.querySelector('a')) loginNoticeErr.textContent = '✕ ' + text + ' — bitte diesen Text an die IT / Johannes weitergeben.';
      else if (!isErr) loginNoticeErr.textContent = '';
    }
    if (gateErr && !gateErr.querySelector('a')) {
      gateErr.hidden = !isErr;
      gateErr.textContent = isErr ? '✕ ' + text : '';
    }
  }
  if (cloudLoginBtn) cloudLoginBtn.onclick = () => {
    if (!window.Cloud) return;
    if (Cloud.needsLogin && Cloud.needsLogin()) { Cloud.login(); return; }
    if (Cloud.isReady()) { Promise.resolve(Cloud.logout()).then(showGateLogin); } else Cloud.login();
  };
  const loginNoticeBtn = document.getElementById('loginNoticeBtn');
  if (loginNoticeBtn) loginNoticeBtn.onclick = () => { if (window.Cloud) Cloud.login(); };
  if (gateLoginBtn) gateLoginBtn.onclick = () => { if (window.Cloud) Cloud.login(); };
  if (cloudReloadBtn) cloudReloadBtn.onclick = () => { if (window.Cloud) Cloud.reload(); };

  load();
  migrateTeamResources();
  seedCrew();
  fitWindows();
  ensureIds();
  saveLocal();
  buildLegend();
  render();
  scrollToToday();
  histReset();   // Ausgangszustand als Historie-Basis (erste Aktion wird rückgängig-fähig)

  // ---- Immer die neueste Version: beim Start, bei Rückkehr in den Tab und alle 5 Minuten nachsehen ----
  // Die laufende Version steht im ?v= der eingebundenen app.js; die aktuelle in der index.html auf dem Server
  // (ohne Cache abgerufen). Ist sie neuer: sofort neu laden, wenn gefahrlos möglich – sonst Hinweis mit Knopf.
  (function versionWatch() {
    const runSrc = (document.querySelector('script[src*="app.js"]') || {}).src || '';
    const running = +((runSrc.match(/[?&]v=(\d+)/) || [])[1] || 0);
    if (!running || location.protocol === 'file:') return;
    let banner = null;
    const freshUrl = (v) => location.pathname + '?v=' + v;   // eigene URL → kein zwischengespeichertes index.html
    const safe = () => !document.querySelector('.overlay:not([hidden])') && tiView.hidden && !(window.Cloud && Cloud.busy && Cloud.busy());
    function showBanner(v) {
      if (banner) return;
      banner = el('div', 'update-banner');
      banner.appendChild(el('span', null, 'Eine neue Version der Montageplanung ist verfügbar.'));
      const b = el('button', 'btn primary', 'Jetzt neu laden'); b.onclick = () => { location.href = freshUrl(v); };
      banner.appendChild(b);
      document.body.appendChild(banner);
    }
    async function check(atStart) {
      try {
        const r = await fetch(location.pathname + '?nocache=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return;
        const latest = +(((await r.text()).match(/app\.js\?v=(\d+)/) || [])[1] || 0);
        if (!(latest > running)) return;
        // Schleifenschutz: wurde für diese Version schon einmal neu geladen und läuft trotzdem die alte → nur Hinweis
        let tried = ''; try { tried = sessionStorage.getItem('montageplanung_upd') || ''; } catch (e) {}
        const loginReturn = /[#&](code|error|state)=/.test(location.hash);   // gerade von der Microsoft-Anmeldung zurück → nicht wegnavigieren
        if (tried !== String(latest) && !loginReturn && (atStart || (document.visibilityState === 'visible' && safe()))) {
          try { sessionStorage.setItem('montageplanung_upd', String(latest)); } catch (e) {}
          location.href = freshUrl(latest);
        } else showBanner(latest);
      } catch (e) { /* offline → später wieder */ }
    }
    check(true);
    setInterval(() => check(false), 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(false); });
  })();

  if (window.Cloud) {
    Cloud.onStatus(updateCloudUI);
    Cloud.onSnapshot(() => snapshot());   // liefert cloud.js den aktuellen lokalen Stand fürs Zusammenführen
    // Stand aus der Cloud anwenden (Erststand ODER Hintergrund-Merge). Bei Merge bleibt der Undo-Verlauf bestehen.
    Cloud.onApply((data, mode) => {
      applySnapshot(data); migrateTeamResources(); seedCrew(); fitWindows(); ensureIds();
      if (mode !== 'merge') scrollTodayPending = true;   // Erststand aus der Cloud → auf aktuelle Woche springen
      saveLocal(); buildLegend(); render();
      if (mode === 'merge') { histSync(); updateUndoUI(); } else { histReset(); revealApp(); }   // Abgleich im Hintergrund: Ansicht nicht verspringen
    });
    // Solange ein Dialog/die Termineinladung offen ist, nicht abgleichen – die Maske hält Verweise auf die Daten
    Cloud.onCanSync(() => !['overlay', 'poverlay', 'roverlay', 'moverlay', 'bloverlay', 'woverlay', 'soverlay'].some(id => { const o = document.getElementById(id); return o && !o.hidden; }) && (!tiView || tiView.hidden));
    // Login-Gate: erst nach erfolgreicher Anmeldung die App zeigen (keine Demodaten für Unangemeldete)
    Promise.resolve(Cloud.init()).then((authed) => { if (authed) revealApp(); else showGateLogin(); kdInit(); });
  } else {
    revealApp(); // ohne Cloud-Modul kein Gate möglich
    kdInit();
  }
})();
