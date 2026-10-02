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
  const endMs = parse(PLAN.rangeEnd);
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
    const groups = PLAN.groups.map(g => ({ name: g.name, rows: g.rows.map(r => ({ id: r.id, label: r.label, site: r.site, nummer: r.nummer, ort: r.ort, name: r.name, strasse: r.strasse, plz: r.plz, archived: r.archived, capRole: r.capRole, bars: r.bars })) }));
    return { groups, team: PLAN.team, assignments, changelog: (PLAN.changelog || []) };
  }
  function applySnapshot(data) {
    if (data && Array.isArray(data.groups) && data.groups.length) PLAN.groups = data.groups;
    if (data && Array.isArray(data.team) && data.team.length) PLAN.team = data.team;
    if (data && data.assignments) assignments = data.assignments;
    // Changelog (Änderungsverlauf) – geteilt über den 3-Wege-Merge (Array-Vereinigung über id)
    if (data && Array.isArray(data.changelog)) PLAN.changelog = data.changelog;
    else PLAN.changelog = PLAN.changelog || [];
  }
  function saveLocal() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); } catch (e) {} }
  // ---- Undo/Redo: Verlauf lokaler Änderungen als Snapshot-Historie ----
  const undoStack = [], redoStack = [], MAX_HIST = 80;
  let histPrev = null, suppressHistory = false;
  function updateUndoUI() {
    const u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
  }
  function histReset() { histPrev = JSON.stringify(snapshot()); undoStack.length = 0; redoStack.length = 0; updateUndoUI(); }
  function applyHistState(json) {
    histPrev = json;
    const keepLog = PLAN.changelog;        // Änderungsverlauf ist append-only – nicht mit zurückrollen
    applySnapshot(JSON.parse(json));
    PLAN.changelog = keepLog;
    suppressHistory = true; saveLocal(); if (window.Cloud) Cloud.scheduleSave(snapshot()); suppressHistory = false;
    buildLegend(); render(); updateUndoUI();
  }
  function undo() { if (!undoStack.length) return; logChange('Änderung rückgängig gemacht'); redoStack.push(histPrev); applyHistState(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; logChange('Änderung wiederholt'); undoStack.push(histPrev); applyHistState(redoStack.pop()); }
  function save() {
    pruneEmptyWeekBars();   // leere Woche-Fragmente entfernen
    ensureIds();   // neue Balken/Phasen bekommen stabile IDs vor dem Sync (fürs Zusammenführen)
    saveLocal();
    const snap = snapshot(), json = JSON.stringify(snap);
    if (json !== histPrev) {
      if (!suppressHistory && histPrev !== null) { undoStack.push(histPrev); if (undoStack.length > MAX_HIST) undoStack.shift(); redoStack.length = 0; }
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
      view: view || (viewMode === 'week' ? 'woche' : 'zeitplan'),
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
      rowEl.appendChild(el('span', 'hist-badge hb-' + (e.view || 'zeitplan'), e.view === 'woche' ? 'Woche' : 'Zeitplan'));
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
    const proj = PLAN.groups.find(g => g.name === 'Projekte');
    if (!proj) return;
    for (const row of proj.rows) (row.bars || []).forEach((bar, bi) => {
      if (!bar.bid) bar.bid = 'b~' + row.id + '~' + (bar.start || '') + '~' + (bar.end || '') + '~' + bi;
      (bar.phases || []).forEach((ph, pi) => {
        if (!ph.pid) ph.pid = bar.bid + '~p' + pi + '~' + (ph.trade || '');
        normalizePhase(ph);   // Altdaten: days/weekend nachziehen, end konsistent zu start+days
      });
    });
  }

  // Einmalige Migration: die alten Sammelzeilen (Monteure Urlaub / Urlaub / ext. Monteure …)
  // auf die jeweiligen Monteure der Liste verteilen. Verlustfrei: nicht zuordenbare
  // Urlaube landen in einer Zeile „Urlaub (nicht zugeordnet)". Läuft nur, solange es noch
  // Sammelzeilen gibt (danach automatisch inaktiv).
  function migrateTeamResources() {
    const g = PLAN.groups.find(x => x.name === 'Ressourcen / Monteure');
    if (!g) return;
    const keep = /steinacker|schulung|nicht zugeordnet/i;
    const generic = g.rows.filter(r => !keep.test(r.label || ''));
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
    g.rows = g.rows.filter(r => keep.test(r.label || ''));
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
    const byMonteur = {};
    const add = (id, s, e, bar) => { (byMonteur[id] = byMonteur[id] || []).push({ x0: dayIndex(parse(s), startMs), x1: dayIndex(parse(e), startMs), bar }); };
    for (const g of PLAN.groups) for (const r of g.rows) {
      if (r.archived) continue;
      for (const bar of r.bars) {
      if (bar.phases && bar.phases.length) {
        for (const ph of bar.phases) for (const rg of assignedRanges(ph)) add(rg.id, rg.start, rg.end, bar);
      } else if (bar.crew) {
        for (const id of (bar.crew.assigned || [])) add(id, bar.crew.start || bar.start, bar.crew.end || bar.end, bar);
      }
      }
    }
    const conflict = new Set();
    for (const id in byMonteur) {
      const list = byMonteur[id].sort((a, z) => a.x0 - z.x0);
      for (let i = 1; i < list.length; i++) {
        if (list[i].x0 <= list[i-1].x1) { conflict.add(list[i].bar); conflict.add(list[i-1].bar); }
      }
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
  const projRows = () => { const g = PLAN.groups.find(x => x.name === 'Projekte'); return g ? g.rows.filter(r => !r.archived) : []; };
  // Verschiebt einen Tages-Einsatz von (fromId, fromDate) auf (toId, toDate) und schreibt es in den Zeitplan zurück.
  function weekReassign(fromId, fromDate, toId, toDate, projectNames) {
    if (fromId === toId && fromDate === toDate) return;
    const names = projectNames || [], D = parse(fromDate);
    for (const row of projRows()) {
      const nm = row.site || row.label;
      if (names.length && names.indexOf(nm) < 0) continue;
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
  function weekShiftEinsatz(pid, fromDate, toDate, projectNames) {
    const delta = Math.round((parse(toDate) - parse(fromDate)) / MS_DAY);
    if (!delta) return;
    const names = projectNames || [], D = parse(fromDate);
    const sh = (iso) => isoStr(addDays(parse(iso), delta));
    for (const row of projRows()) {
      const nm = row.site || row.label;
      if (names.length && names.indexOf(nm) < 0) continue;
      for (const bar of row.bars) {
        const phs = phasesOf(bar);
        const hit = phs.some(ph => assignedRanges(ph).some(r => r.id === pid && parse(r.start) <= D && parse(r.end) >= D));
        if (!hit) continue;
        bar.start = sh(bar.start); bar.end = sh(bar.end);
        for (const ph of phs) {
          const oldStart = ph.start;
          if (!(+ph.days > 0)) ph.days = daysCount(oldStart, ph.end || oldStart, ph.weekend);
          let ns = sh(oldStart);
          if (!ph.weekend) ns = snapWorkday(ns);
          const pdelta = Math.round((parse(ns) - parse(oldStart)) / MS_DAY);
          const psh = (iso) => isoStr(addDays(parse(iso), pdelta));
          ph.start = ns; ph.end = endFromDays(ns, ph.days, ph.weekend);
          const nsMs = parse(ns), neMs = parse(ph.end);
          ph.assigned = (ph.assigned || []).map(a => {
            if (typeof a === 'string') return a;
            let rs = parse(psh(a.start)), re = parse(psh(a.end));
            if (rs < nsMs) rs = nsMs; if (re > neMs) re = neMs;
            if (rs > re) return null;
            return { id: a.id, start: isoStr(rs), end: isoStr(re) };
          }).filter(Boolean);
        }
        logChange(`Einsatz „${bar.label || nm}" (${nm}, ${monteurName(pid)}) verschoben → ${fmt(parse(bar.start))}–${fmt(parse(bar.end))}`, 'woche');
        save();
        return;   // nur den einen (getroffenen) Einsatz verschieben
      }
    }
  }
  // Entfernt Person an genau einem Tag aus allen (genannten) Projekten.
  function removePersonDay(pid, dayISO, projectNames) {
    const names = projectNames || [];
    for (const row of projRows()) {
      const nm = row.site || row.label;
      if (names.length && names.indexOf(nm) < 0) continue;
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
        if (dow !== 0 && dow !== 6) {
          const have = sumPersons(new Set(ranges.filter(r => parse(r.start) <= d && parse(r.end) >= d).map(r => r.id)));
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
            group.rows.splice(group.rows.indexOf(row), 1); save(); render();
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
          bar.start = isoStr(addDays(startMs, nx0));
          bar.end = isoStr(addDays(startMs, nx1));
          // Beim Verschieben (nicht Resize) wandern die Gewerke/Phasen + Zuordnungen mit.
          if (mode === 'move') {
            const delta = nx0 - ox0;
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
          }
          const rowNm = b._row.site || b._row.label, barNm = bar.label || '(ohne Bezeichnung)';
          const verb = mode === 'move' ? 'verschoben' : 'Dauer geändert';
          logChange(`Einsatz „${barNm}" (${rowNm}) ${verb} → ${fmt(parse(bar.start))}–${fmt(parse(bar.end))}`, 'zeitplan');
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
  function applyCatMode() {
    if (!current) return;
    const proj = current.row.capRole !== 'extern' && current.row.capRole !== 'monteur';
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
      const refreshEnd = () => {
        if (!ph.weekend) { ph.start = snapWorkday(ph.start); von.value = ph.start; }
        ph.end = endFromDays(ph.start, ph.days, ph.weekend);
        endHint.textContent = '→ endet ' + wdShort(ph.end) + ' ' + fmt(parse(ph.end)) + (isHalf(ph) ? (+ph.days < 1 ? ' · halber Tag' : ' · letzter Tag halb') : '') + (ph.weekend ? ' · inkl. Wochenende' : '');
      };
      von.onchange = () => { ph.start = von.value || ph.start; refreshEnd(); };
      dur.oninput = () => { ph.days = halfDays(String(dur.value).replace(',', '.')); refreshEnd(); };
      wkc.onchange = () => { ph.weekend = wkc.checked; refreshEnd(); };
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
      const cntL = el('label', 'phase-fld phase-cnt', 'Pers.'); cntL.appendChild(cnt);
      line2.appendChild(vonL); line2.appendChild(durL); line2.appendChild(wkL); line2.appendChild(cntL); line2.appendChild(pti); line2.appendChild(del);
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
          cb.onchange = () => {
            ph.assigned = (ph.assigned || []).filter(a => idOf(a) !== m.id);  // vorhandene (Teil-)Bereiche der Person entfernen
            if (cb.checked) ph.assigned.push(m.id);                            // anhaken = ganze Phase
            const n = new Set(ph.assigned.map(idOf)).size;
            if (n > (+ph.count || 0)) { ph.count = n; cnt.value = ph.count; }
          };
          const span = el('span', m.type === 'extern' ? 'ext' : null, m.name + (m.type === 'extern' ? ' (ext)' : ''));
          lab.appendChild(cb); lab.appendChild(span); lab.appendChild(tradeTags(m.trades));
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
    applyCatMode();   // Montage-Phasen nur bei Projekten (nicht bei Kategorie „Bauleitung"), Bauleitung nur bei Projekten
    document.getElementById('f-cat-wrap').style.display = (isExtern || isMonteur) ? 'none' : '';    // Kategorie/Farbe ergibt sich bei Monteuren aus intern/extern
    document.getElementById('f-size-wrap').style.display = isExtern ? '' : 'none';                  // Truppstärke nur bei externen Buchungen
    document.getElementById('f-ti').style.display = (isExtern || isMonteur) ? 'none' : '';          // Termineinladung nur bei Projekt-Montagen
    document.getElementById('f-size').value = bar.size || (row._member && row._member.size) || 1;
    // Phasen laden – bestehender Sammelbedarf (crew) wird verlustfrei als erste Phase übernommen
    const cloneAssigned = (arr) => (arr || []).map(a => (typeof a === 'string' ? a : { id: a.id, start: a.start, end: a.end }));
    if (bar.phases && bar.phases.length) {
      phaseDraft = bar.phases.map(p => {
        const weekend = !!p.weekend;
        const daysN = +p.days > 0 ? p.days : daysCount(p.start, p.end || p.start, weekend);
        return { trade: p.trade || 'edelstahl', start: p.start, days: daysN, weekend, end: p.end, count: p.count || 1, assigned: cloneAssigned(p.assigned) };
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
    const blOnly = !row.capRole && fCat.value === 'bauleitung';
    if (blOnly && phaseDraft.some(p => (p.assigned || []).length)
      && !confirm('Kategorie „Bauleitung": Diesem Termin werden keine Monteure zugeordnet.\nDie vorhandenen Monteur-Phasen werden entfernt. Fortfahren?')) return;
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
      bar.phases = (phaseDraft.length && !blOnly)
        ? phaseDraft.map(p => {
            const weekend = !!p.weekend;
            const daysN = halfDays(p.days);
            const s = weekend ? p.start : snapWorkday(p.start);   // Werktags-Einsatz beginnt an einem Werktag
            const e = endFromDays(s, daysN, weekend);             // Ende = Start + Montagetage (Wochenende ggf. übersprungen)
            const asg = (p.assigned || []).map(a => {
              if (typeof a === 'string') return a;                         // ganze Phase
              // Teilbereich auf das (evtl. geänderte) Phasenfenster begrenzen
              let rs = a.start > s ? a.start : s, re = a.end < e ? a.end : e;
              if (rs > re) return null;
              return (rs === s && re === e) ? a.id : { id: a.id, start: rs, end: re };
            }).filter(Boolean);
            return { trade: p.trade, start: s, days: daysN, weekend, end: e, count: Math.max(1, +p.count || 1), assigned: asg };
          })
        : undefined;
      delete bar.crew;
      // Bauleitung: abgewählte entfernen, taggenaue Bereiche (aus der Woche) aufs Fenster begrenzen, neue = ganzes Fenster
      const bl = [];
      for (const id of blDraft) {
        const had = (bar.bl || []).filter(a => idOf(a) === id).map(a => {
          if (typeof a === 'string') return a;
          const rs = a.start > s ? a.start : s, re = a.end < e ? a.end : e;
          return rs > re ? null : { id, start: rs, end: re };
        }).filter(Boolean);
        if (had.length) bl.push(...had); else bl.push(id);
      }
      if (bl.length) bar.bl = bl; else delete bar.bl;
    }
    const rowNm = row.site || row.label, barNm = bar.label || '(ohne Bezeichnung)';
    const asgNames = (bar.phases || []).flatMap(ph => (ph.assigned || []).map(idOf)).filter((v, i, a) => a.indexOf(v) === i).map(monteurName);
    const blNames = [...new Set(blRanges(bar).map(r => r.id))].map(monteurName);
    const who = (asgNames.length ? ' · Monteure: ' + asgNames.join(', ') : '') + (blNames.length ? ' · Bauleitung: ' + blNames.join(', ') : '');
    logChange(`Termin „${barNm}" (${rowNm}) ${current.isNew ? 'angelegt' : 'bearbeitet'} → ${fmt(parse(bar.start))}–${fmt(parse(bar.end))}${who}`, 'zeitplan');
    save(); render(); closeEditor();
  };
  document.getElementById('f-delete').onclick = () => {
    if (!current) return;
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
    const sh = (iso) => isoStr(addDays(parse(iso), delta));
    clone.start = ns; clone.end = isoStr(addDays(parse(ns), len));
    (clone.phases || []).forEach(p => {
      delete p.pid;
      p.start = sh(p.start); p.end = sh(p.end);
      p.assigned = (p.assigned || []).map(a => (typeof a === 'string' ? a : { id: a.id, start: sh(a.start), end: sh(a.end) }));
    });
    if (clone.crew && clone.crew.start) { clone.crew.start = sh(clone.crew.start); clone.crew.end = sh(clone.crew.end || clone.crew.start); }
    clone.label = bar.label ? bar.label + ' (Kopie)' : 'Kopie';
    row.bars.push(clone);
    logChange(`Montagefenster „${bar.label || ''}" (${row.site || row.label}) dupliziert → ${fmt(parse(clone.start))}–${fmt(parse(clone.end))}`, 'zeitplan');
    save(); render(); closeEditor(); openEditor(row, clone, false);
  };
  // Termineinladung für genau diese Montage (nützlich bei „Kleinprojekte" mit vielen Einzelmontagen)
  document.getElementById('f-ti').onclick = () => {
    if (!current) return;
    const { row, bar } = current;
    closeEditor();
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
    for (const g of PLAN.groups) { const i = g.rows.indexOf(curResource); if (i >= 0) g.rows.splice(i, 1); }
    save(); render(); closeResourceDialog();
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
      name.addEventListener('input', () => { m.name = name.value; save(); });
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
        m.type = sel.value;
        if (m.type === 'extern' && !m.size) m.size = 1;
        sizeWrap.style.display = m.type === 'extern' ? '' : 'none';
        save(); render(); refreshCapInfo();
      });
      const del = el('span', 'm-del', '✕'); del.title = 'Monteur entfernen';
      del.onclick = () => {
        if (!confirm(`„${m.name}" wirklich entfernen?`)) return;
        PLAN.team.splice(PLAN.team.indexOf(m), 1);
        save(); render(); renderTeamList();
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
  document.getElementById('m-close').onclick = () => { moverlay.hidden = true; };
  moverlay.addEventListener('click', (e) => { if (e.target === moverlay) moverlay.hidden = true; });

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
      name.addEventListener('input', () => { row.label = name.value; save(); render(); });
      const del = el('span', 'm-del', '✕'); del.title = 'Bauleiter entfernen';
      del.onclick = () => {
        if (!confirm(`„${row.label || 'Bauleiter'}" wirklich entfernen?`)) return;
        g.rows.splice(g.rows.indexOf(row), 1); save(); render(); renderBauleiterList();
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
  document.getElementById('bl-close').onclick = () => { bloverlay.hidden = true; };
  bloverlay.addEventListener('click', (e) => { if (e.target === bloverlay) bloverlay.hidden = true; });

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
    const pa = row ? rowAddr(row) : { strasse: '', plz: '' };
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
    if (site) {   // Adresse gilt für die ganze Baustelle → auf alle Bereiche übertragen
      const pg = PLAN.groups.find(x => x.name === 'Projekte');
      for (const r of (pg ? pg.rows : [])) if (r.site === site) { r.strasse = fields.strasse; r.plz = fields.plz; }
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
    for (const g of PLAN.groups) { const i = g.rows.indexOf(curProject); if (i >= 0) g.rows.splice(i, 1); }
    save(); render(); closeProjectDialog();
  };
  document.getElementById('p-cancel').onclick = () => closeProjectDialog();
  poverlay.addEventListener('click', (e) => { if (e.target === poverlay) closeProjectDialog(); });
  poverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProjectDialog();
    if (e.key === 'Enter') document.getElementById('p-save').click();
  });

  // ---- Render & Steuerung ----
  const viewport = document.getElementById('viewport');
  function render() { viewMode === 'week' ? renderWeek() : renderTimeline(); if (typeof updateArchiveToggle === 'function') updateArchiveToggle(); }
  function renderTimeline() {
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
    const eachWorkday = (s, e, cb) => {
      for (let i = 0; i < 7; i++) { const ms = addDays(selMonday, i); const dow = new Date(ms).getUTCDay(); if (dow === 0 || dow === 6) continue; if (parse(s) > ms || parse(e) < ms) continue; cb(ms); }
    };
    for (const m of PLAN.team) for (const bar of (m.bars || [])) {
      if (bar.cat !== 'vacation' && bar.cat !== 'booking') continue;
      eachWorkday(bar.start, bar.end, (ms) => { const c = get(m.id, ms); if (m.type === 'extern') c.booking = true; else c.urlaub = true; });
    }
    const proj = PLAN.groups.find(g => g.name === 'Projekte');
    if (proj) for (const row of proj.rows) {
      const name = row.site || row.label;
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
          eachWorkday(r.start, r.end, (ms) => { const c = get(r.id, ms); addTi(c, r.id); if (isHalf(ph) && isoStr(ms) === ph.end) c.half = true; if (c.projects.indexOf(name) < 0) c.projects.push(name); if (c.labels.indexOf(shown) < 0) c.labels.push(shown); if (addrLine && c.addrs.indexOf(addrLine) < 0) c.addrs.push(addrLine); if (unconf) c.unconfirmed = true; });
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
            const ms = wdays[i]; const dow = new Date(ms).getUTCDay(); if (dow === 0 || dow === 6) continue;
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
        const perDay = []; let anyGap = false, anyActive = false, anyPlanned = false, anyStaffed = false;
        for (let i = 0; i < 7; i++) {
          const ms = wdays[i], dow = new Date(ms).getUTCDay(), weekendDay = (dow === 0 || dow === 6);
          const inWindow = parse(bar.start) <= ms && parse(bar.end) >= ms;
          if (!inWindow) { perDay.push(null); continue; }
          const ids = new Set(); let phaseActive = false;
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
        if (anyActive) out.push({ name: weekName(row, bar), sub: isKleinRow(row) ? '' : (bar.label || ''), perDay, anyGap, anyPlanned, unconfirmed: !confirmed, row, bar });
      }
    }
    // Reine Fenster (in dieser Woche kein Einsatz geplant) ans Ende – oben stehen die laufenden Montagen
    return out.filter(o => o.anyPlanned).concat(out.filter(o => !o.anyPlanned));
  }

  // Kleines Auswahlmenü, um einen offenen Bedarf direkt in der Woche taggenau zu besetzen.
  let needMenu = null;
  function closeNeedMenu() { if (needMenu) { needMenu.remove(); needMenu = null; document.removeEventListener('mousedown', onNeedDocDown, true); } }
  function onNeedDocDown(e) { if (needMenu && !needMenu.contains(e.target)) closeNeedMenu(); }
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
      const busy = stt.urlaub ? 'Urlaub' : (stt.projects.length ? stt.projects.join(', ') : '');
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
    needMenu.style.top = (y + 4) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onNeedDocDown, true), 0);
  }
  function copyPersonWeek(p) {
    const der = weekDerived(), days = [];
    for (let i = 0; i < 5; i++) {
      const ms = addDays(selMonday, i), key = akey(p.id, isoStr(ms));
      const d = der[key] || { projects: [] }, projects = [];
      for (const name of d.projects) { const dp = derivedProjectOf(p.id, ms, [name]); if (!dp.rowId) continue;
        const e = dp.bl ? { rowId: dp.rowId, bl: true } : { rowId: dp.rowId, gewerk: (dp.gewerk && TRADES()[dp.gewerk]) ? dp.gewerk : firstTradeOf(p) };
        // Kleinprojekt: Bezeichnung der Montage mitnehmen, damit die Zielperson im selben Fenster landet
        const krow = projRows().find(r => r.id === dp.rowId), kb = (krow && isKleinRow(krow)) ? barOfPersonDay(krow, p.id, ms) : null;
        if (kb) { e.label = kb.label || ''; for (const k of ADDR_KEYS) e[k] = kb[k] || ''; }
        projects.push(e);
      }
      const a = assignments[key];
      days.push({ projects, note: (a && a.type !== 'baustelle') ? { text: a.text, type: a.type } : null });
    }
    clip = { kind: 'personweek', fromName: p.name, days };
    toast('Woche von ' + p.name + ' kopiert – Rechtsklick auf Zielperson → „Woche einfügen"');
  }
  function pastePersonWeek(p) {
    if (!clip || clip.kind !== 'personweek') return;
    const der = weekDerived();
    suppressHistory = true;
    for (let i = 0; i < 5; i++) {
      const ms = addDays(selMonday, i), dISO = isoStr(ms), key = akey(p.id, dISO);
      const targetProjects = (der[key] || { projects: [] }).projects.slice();
      removePersonDay(p.id, dISO, targetProjects);
      delete assignments[key];
      const day = clip.days[i] || { projects: [], note: null };
      for (const e of day.projects) { const row = projRows().find(r => r.id === e.rowId); if (!row) continue; if (e.bl) assignBauleitung(p.id, ms, row, e); else assignWeekProject(p.id, ms, row, e.gewerk, e); }
      if (day.note) assignments[key] = { text: day.note.text, type: day.note.type, auto: false };
    }
    suppressHistory = false;
    logChange(`Woche von ${clip.fromName} auf ${p.name} übertragen`, 'woche');
    save(); renderWeek();
  }

  // Eingeklappte Bereiche der Woche (pro Browser gemerkt)
  const WK_COLLAPSE_KEY = 'montageplanung_wk_collapsed';
  const wkCollapsed = new Set((() => { try { return JSON.parse(localStorage.getItem(WK_COLLAPSE_KEY)) || []; } catch (e) { return []; } })());
  function renderWeek() {
    const sl = 0, st = viewport.scrollTop;
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
            if (s.unconfirmed) cell.classList.add('wk-site-unconf');
            cell.title = n + ' Monteur' + (n > 1 ? 'e' : '') + ' eingeplant' + (s.unconfirmed ? ' – Termin noch nicht bestätigt' : '') + ' · klicken zum Bearbeiten';
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
        const note = (assignments[key] && assignments[key].type !== 'baustelle') ? assignments[key] : null;
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
        if (title) cell.title = title;
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
            needMenu.style.top = (e.clientY + 4) + 'px';
            setTimeout(() => document.addEventListener('mousedown', onNeedDocDown, true), 0);
          });
          cell.classList.add('wk-has-ti');
          cell.appendChild(ti);
        }
        // Baustellen-Einsatz (aus dem Zeitplan) lässt sich taggenau auf eine andere Person/einen anderen Tag ziehen
        // (nur Monteure – Bauleitung wird nicht per Gewerk-Phase verschoben)
        if (proj.length && !note && !der.urlaub && p.kind !== 'bauleiter') {
          cell.draggable = true;
          const pj = proj.slice(), fd = dISO, fid = p.id;
          cell.addEventListener('dragstart', (e) => { cell.classList.add('dragging'); e.dataTransfer.setData('text/plain', JSON.stringify({ move: { fromId: fid, fromDate: fd, projects: pj } })); });
          cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
        } else if (note) {
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
          else if (data.move) {
            // gleiche Person, anderer Tag = ganzen Einsatz verschieben; andere Person = Übergabe dieses Tages
            if (data.move.fromId === p.id) weekShiftEinsatz(p.id, data.move.fromDate, dISO, data.move.projects);
            else weekReassign(data.move.fromId, data.move.fromDate, p.id, dISO, data.move.projects);
            renderWeek();
          }
        });
        cell.addEventListener('click', () => openCellEditor(key, p, ms));
        grid.appendChild(cell);
      });
    }
    viewport.innerHTML = '';
    viewport.appendChild(grid);
    viewport.scrollLeft = sl; viewport.scrollTop = st;
  }

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
  function scrollToToday() { scrollToWeek(mondayMs(todayMs())); }

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
  const weekEntryBar = (row, ms, entry, forBl) => (entry && isKleinRow(row)) ? kleinBarFor(row, ms, entry) : weekBarFor(row, ms, forBl);
  // Person an einem Tag einem Projekt/Gewerk zuordnen (schreibt in den Zeitplan)
  function assignWeekProject(pid, ms, row, gewerk, entry) {
    const dISO = isoStr(ms);
    const bar = weekEntryBar(row, ms, entry);
    if (bar.cat === 'bauleitung') { bar.cat = 'confirmed'; if (bar.label === 'Bauleitung') bar.label = 'Montage'; }   // Monteur dazu → wird zur Montage
    if (bar.crew) { if ((bar.crew.assigned || []).length || bar.crew.trade) phasesOf(bar); else delete bar.crew; }
    if (!bar.phases) bar.phases = [];
    const weekendDay = [0, 6].includes(new Date(ms).getUTCDay());
    let ph = bar.phases.find(p => (p.trade || 'edelstahl') === gewerk);
    if (!ph) { ph = { trade: gewerk, start: bar.start, end: bar.end, days: 1, weekend: weekendDay, count: 1, assigned: [] }; bar.phases.push(ph); }
    else {
      // Phasenfenster an das (evtl. erweiterte) Balkenfenster anpassen und days konsistent halten
      if (parse(bar.start) < parse(ph.start)) ph.start = bar.start;
      if (parse(bar.end) > parse(ph.end)) ph.end = bar.end;
      if (weekendDay) ph.weekend = true;
    }
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
  // Zu einer abgeleiteten Projekt-Zelle das Zeitplan-Projekt (Zeile) + Gewerk der Person an dem Tag finden
  function derivedProjectOf(pid, ms, projectNames) {
    if (!projectNames || !projectNames.length) return { rowId: '', gewerk: '' };
    const prow = projRows().find(r => (r.site || r.label) === projectNames[0]);
    if (!prow) return { rowId: '', gewerk: '' };
    for (const b of prow.bars) for (const ph of (b.phases || [])) {
      if (assignedRanges(ph).some(rg => rg.id === pid && parse(rg.start) <= ms && parse(rg.end) >= ms)) return { rowId: prow.id, gewerk: ph.trade || '' };
    }
    for (const b of prow.bars) if (blRanges(b).some(rg => rg.id === pid && parse(rg.start) <= ms && parse(rg.end) >= ms)) return { rowId: prow.id, gewerk: '', bl: true };
    return { rowId: prow.id, gewerk: '' };
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
    wProjectDraft = [];
    for (const name of der.projects) {
      const dp = derivedProjectOf(person.id, ms, [name]);
      const krow = dp.rowId ? projRows().find(r => r.id === dp.rowId) : null;
      if (krow && isKleinRow(krow)) {
        // Sammelzeile: je Montage (Fenster), in der die Person an dem Tag steht, ein eigener Eintrag mit Bezeichnung
        const on = (r) => r.id === person.id && parse(r.start) <= ms && parse(r.end) >= ms;
        for (const b of krow.bars) {
          if (curCellIsBl) { if (blRanges(b).some(on)) wProjectDraft.push({ rowId: krow.id, bl: true, bar: b, label: b.label || '', strasse: b.strasse || '', plz: b.plz || '', ort: b.ort || '' }); continue; }
          for (const ph of (b.phases || [])) if (assignedRanges(ph).some(on))
            wProjectDraft.push({ rowId: krow.id, gewerk: (ph.trade && TRADES()[ph.trade]) ? ph.trade : firstTradeOf(person), bar: b, label: b.label || '', strasse: b.strasse || '', plz: b.plz || '', ort: b.ort || '' });
        }
        if (wProjectDraft.some(e => e.rowId === krow.id)) continue;
      }
      if (dp.rowId) wProjectDraft.push(curCellIsBl ? { rowId: dp.rowId, bl: true } : { rowId: dp.rowId, gewerk: (dp.gewerk && TRADES()[dp.gewerk]) ? dp.gewerk : firstTradeOf(person) });
    }
    renderProjRows();
    wType.value = note ? note.type : (curCellIsBl ? 'bauleitung' : CELL_TYPE_DEFAULT);   // Bauleiter: Standardtyp Bauleitung (nicht Montage)
    // Leere, freie Zelle: Text mit dem Standardtext des Typs vorbelegen (sonst würde „Speichern" nichts speichern)
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
  document.getElementById('w-save').onclick = () => {
    if (!curCell || !curCellCtx) return;
    const who = cellPersonName(), day = fmt(parse(curCellCtx.dISO));
    const parts = [];
    // 1) Baustellen des Tages neu setzen (leer = alle für den Tag entfernen). Bauleiter → Bauleitung, sonst Einsatz.
    const renamed = renameKleinBars();
    removePersonDay(curCellCtx.pid, curCellCtx.dISO, curCellCtx.projects);
    for (const e of wProjectDraft) { const row = projRows().find(r => r.id === e.rowId); if (!row) continue; if (curCellIsBl) assignBauleitung(curCellCtx.pid, parse(curCellCtx.dISO), row, e); else assignWeekProject(curCellCtx.pid, parse(curCellCtx.dISO), row, e.gewerk, e); }
    for (const t of renamed) parts.push(t);
    if (wProjectDraft.length) parts.push((curCellIsBl ? 'Bauleitung: ' : 'Einsatz: ') + wProjectDraft.map(e => { const r = projRows().find(x => x.id === e.rowId); return r ? ((isKleinRow(r) && (e.label || '').trim()) || r.site || r.label) : '?'; }).join(', '));
    else if (curCellCtx.projects.length) parts.push(curCellIsBl ? 'Bauleitung entfernt' : 'Einsatz entfernt');
    // 2) Manueller Termin/Notiz – UNABHÄNGIG vom Einsatz (beide können nebeneinander stehen).
    //    Reinen Auto-Standardtext (z. B. „Montage") NICHT als Notiz neben einer Baustelle speichern.
    let text = wText.value.trim();
    if (wProjectDraft.length && CELL_TYPE_TEXT_SET.has(text)) text = '';
    if (!text) { if (assignments[curCell] && assignments[curCell].type !== 'baustelle') parts.push('Notiz entfernt'); delete assignments[curCell]; }
    else { assignments[curCell] = { text, type: wType.value, auto: false }; parts.push('Termin: „' + text + '"'); }
    logChange(`${who} am ${day} – ${parts.length ? parts.join(' · ') : 'keine Änderung'}`, 'woche');
    save(); renderWeek(); closeCellEditor();
  };
  document.getElementById('w-delete').onclick = () => {
    const who = cellPersonName(), day = curCellCtx ? fmt(parse(curCellCtx.dISO)) : '';
    if (curCell) delete assignments[curCell];
    // Zeitplan-Einsatz dieses Tages ebenfalls entfernen (schreibt in die Phasen zurück)
    if (curCellCtx && curCellCtx.projects.length) removePersonDay(curCellCtx.pid, curCellCtx.dISO, curCellCtx.projects);
    logChange(`Eintrag gelöscht (${who}, ${day})`, 'woche');
    save(); renderWeek(); closeCellEditor();
  };
  // Eintrag auf alle Werktage (Mo–Fr) dieser Person übertragen – schnelles Kopieren, z. B. für Bauleiter
  document.getElementById('w-week').onclick = () => {
    if (!curCellCtx) return;
    let text = wText.value.trim();
    if (wProjectDraft.length && CELL_TYPE_TEXT_SET.has(text)) text = '';   // Auto-Standardtext nicht mitschreiben
    if (!wProjectDraft.length && !text) { alert('Bitte zuerst einen Text eingeben oder ein Projekt wählen, das auf die ganze Woche übertragen werden soll.'); return; }
    renameKleinBars();
    for (let i = 0; i < 5; i++) {
      const ms = addDays(selMonday, i);
      // Baustellen auf jeden Werktag übertragen (Bauleiter → Bauleitung, sonst Einsatz)
      for (const e of wProjectDraft) { const row = projRows().find(r => r.id === e.rowId); if (!row) continue; if (curCellIsBl) assignBauleitung(curCellCtx.pid, ms, row, e); else assignWeekProject(curCellCtx.pid, ms, row, e.gewerk, e); }
      // Manuellen Termin/Notiz zusätzlich auf jeden Werktag übertragen
      if (text) assignments[akey(curCellCtx.pid, isoStr(ms))] = { text, type: wType.value, auto: false };
    }
    const who = cellPersonName();
    logChange(`${who}: auf ganze Woche übertragen${wProjectDraft.length ? ' · Einsatz' : ''}${text ? ' · Termin „' + text + '"' : ''}`, 'woche');
    save(); renderWeek(); closeCellEditor();
  };
  // Zelle kopieren: aktuellen Editor-Inhalt (Baustellen + Notiz) in die Zwischenablage
  document.getElementById('w-copy').onclick = () => {
    if (!curCellCtx) return;
    const text = wText.value.trim();
    clip = {
      kind: 'cell',
      projects: wProjectDraft.map(e => { const c = { rowId: e.rowId, gewerk: e.gewerk, label: e.label || '' }; for (const k of ADDR_KEYS) if (k in e) c[k] = e[k]; return c; }),
      note: text ? { text, type: wType.value } : null,
    };
    toast('Eintrag kopiert – Zielzelle öffnen und „Einfügen"');
    closeCellEditor();
  };
  // Kopierten Eintrag in die aktuell geöffnete Zelle einfügen (Felder füllen + speichern)
  document.getElementById('w-paste').onclick = () => {
    if (!curCellCtx || !clip || clip.kind !== 'cell') return;
    wProjectDraft = clip.projects.map(e => Object.assign({}, e));
    renderProjRows();
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

  // ---- Ansicht umschalten & Wochen-Navigation ----
  function setView(mode) {
    const fromWeek = viewMode === 'week' && mode === 'timeline';
    viewMode = mode;
    document.getElementById('viewTimeline').classList.toggle('active', mode === 'timeline');
    document.getElementById('viewWeek').classList.toggle('active', mode === 'week');
    document.getElementById('hint').style.display = mode === 'week' ? 'none' : '';
    document.getElementById('weekbar').hidden = mode !== 'week';
    document.querySelectorAll('.timeline-only').forEach(elm => { elm.style.display = mode === 'week' ? 'none' : ''; });
    render();
    // Zurück aus der Woche: Zeitplan auf die dort gezeigte Woche stellen (statt an den Planbeginn zu springen)
    if (fromWeek) { scrollTodayPending = false; requestAnimationFrame(() => scrollToWeek(selMonday)); }
  }
  document.getElementById('viewTimeline').onclick = () => setView('timeline');
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
  const TI_SRC = 'termineinladung.html?v=49';
  // Phasen-Auswahl normalisieren: einzelner Index oder Liste → gültige, sortierte Indizes
  const tiIdxs = (bar, x) => (!bar || !bar.phases) ? [] : [...new Set([].concat(x == null ? [] : x))].filter(i => i >= 0 && bar.phases[i]).sort((a, b) => a - b);
  const tiTradeLabels = (bar, x) => [...new Set(tiIdxs(bar, x).map(i => (TRADES()[bar.phases[i].trade] || {}).label || 'Gewerk'))].join(' + ');
  // Gewerk → Vorbelegung in der Einladung (Tätigkeit bzw. Eintransport-Option)
  const TI_TRADE = { edelstahl: { taet: ['edelstahl'] }, elektrik: { art: 'anschluss_elektro', taet: ['elektro'] }, sanitaer: { art: 'anschluss_sanitaer', taet: ['sanitaer'] }, sanitaer_klein: { art: 'anschluss_sanitaer', taet: ['sanitaer'] }, eintransporthelfer: { et: [3] }, lagerist: {} };
  // Schlüssel der Phase für den Entwurf: Gewerk (+ laufende Nummer bei mehreren Phasen desselben Gewerks)
  function tiPhaseKey(bar, idx) {
    const ph = bar.phases[idx], t = ph.trade || 'gewerk';
    const nth = bar.phases.slice(0, idx).filter(p => (p.trade || 'gewerk') === t).length;
    return t + (nth ? (nth + 1) : '');
  }
  function tiDraftName(row, bar, phIdx) {
    const name = bar ? (bar.label || row.site || row.label || '') : (row.site || row.label || '');
    const base = ((row.nummer ? row.nummer + ' ' : '') + name)
      .replace(/[^0-9A-Za-zÄÖÜäöüß ._-]/g, '').trim().slice(0, 50).replace(/\s+/g, '_');
    const barKey = bar ? '__' + String(bar.bid || bar.start || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 24) : '';
    const idxs = tiIdxs(bar, phIdx), phKey = idxs.length ? '__' + idxs.map(i => tiPhaseKey(bar, i)).join('-') : '';
    return (base || 'projekt') + '__' + row.id + barKey + phKey + '.json';
  }
  function tiPrefill(row, bar, phIdx) {
    const phs = tiIdxs(bar, phIdx).map(i => bar.phases[i]);
    let datum = '', zeitraum = '', objektname = row.site || row.label || '';
    const span = (s, e) => { if (s === e) datum = s; else zeitraum = fmt(parse(s)) + '–' + fmt(parse(e)); };
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
    return pf;
  }
  async function tiSendInit() {
    if (!tiProject || !tiReady || !tiFrame.contentWindow) return;
    let state = null;
    const fresh = tiFresh; tiFresh = false;   // „Formular leeren": Entwurf nicht wieder laden
    if (!fresh && window.Cloud && Cloud.isReady()) {
      tiStatus.textContent = 'lade Zwischenstand …';
      try { state = await Cloud.loadDraft(tiDraftName(tiProject, tiBar, tiPhase)); } catch (e) { /* kein Draft / offline */ }
    }
    tiStatus.textContent = state ? 'Zwischenstand geladen'
      : (window.Cloud && Cloud.isReady()) ? 'neu · aus Projektdaten vorbefüllt'
      : 'nicht angemeldet – kein SharePoint-Speichern';
    tiFrame.contentWindow.postMessage({ type: 'ti-init', projectKey: tiProject.id + (tiBar ? '~' + (tiBar.bid || '') : '') + tiIdxs(tiBar, tiPhase).map(i => '~' + tiPhaseKey(tiBar, i)).join(''), prefill: tiPrefill(tiProject, tiBar, tiPhase), state: state || null }, '*');
  }
  // Formular frisch laden – sonst blieben Eingaben der zuvor geöffneten Einladung stehen
  function tiReload() {
    tiReady = false;
    if (!tiFrame.getAttribute('src')) tiFrame.setAttribute('src', TI_SRC);  // lädt → sendet ti-ready → tiSendInit
    else { try { tiFrame.contentWindow.location.reload(); } catch (e) { tiFrame.setAttribute('src', TI_SRC); } }
  }
  function openTermineinladung(row, bar, phIdx) {
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
    if (m.type === 'ti-ready') { tiReady = true; tiSendInit(); }
    else if (m.type === 'ti-save') {
      if (!(window.Cloud && Cloud.isReady())) { tiFrame.contentWindow.postMessage({ type: 'ti-save-error', msg: 'nicht angemeldet' }, '*'); tiStatus.textContent = 'nicht gespeichert – bitte anmelden'; return; }
      tiStatus.textContent = 'speichere …';
      try { await Cloud.saveDraft(tiDraftName(tiProject, tiBar, tiPhase), m.state); tiFrame.contentWindow.postMessage({ type: 'ti-saved' }, '*'); tiStatus.textContent = 'in SharePoint gespeichert'; }
      catch (err) { tiFrame.contentWindow.postMessage({ type: 'ti-save-error', msg: (err && err.message) || '' }, '*'); tiStatus.textContent = 'Speichern fehlgeschlagen'; }
    }
    else if (m.type === 'ti-reset') { tiFresh = true; tiReload(); }
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
    if (cloudLoginBtn) cloudLoginBtn.textContent = ready ? 'Abmelden' : 'Anmelden';
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
    if (Cloud.isReady()) { Promise.resolve(Cloud.logout()).then(showGateLogin); } else Cloud.login();
  };
  const loginNoticeBtn = document.getElementById('loginNoticeBtn');
  if (loginNoticeBtn) loginNoticeBtn.onclick = () => { if (window.Cloud) Cloud.login(); };
  if (gateLoginBtn) gateLoginBtn.onclick = () => { if (window.Cloud) Cloud.login(); };
  if (cloudReloadBtn) cloudReloadBtn.onclick = () => { if (window.Cloud) Cloud.reload(); };

  load();
  migrateTeamResources();
  seedCrew();
  ensureIds();
  saveLocal();
  buildLegend();
  render();
  scrollToToday();
  histReset();   // Ausgangszustand als Historie-Basis (erste Aktion wird rückgängig-fähig)

  if (window.Cloud) {
    Cloud.onStatus(updateCloudUI);
    Cloud.onSnapshot(() => snapshot());   // liefert cloud.js den aktuellen lokalen Stand fürs Zusammenführen
    // Stand aus der Cloud anwenden (Erststand ODER Hintergrund-Merge). Bei Merge bleibt der Undo-Verlauf bestehen.
    Cloud.onApply((data, mode) => {
      applySnapshot(data); migrateTeamResources(); seedCrew(); ensureIds();
      if (mode !== 'merge') scrollTodayPending = true;   // Erststand aus der Cloud → auf aktuelle Woche springen
      saveLocal(); buildLegend(); render();
      if (mode === 'merge') updateUndoUI(); else histReset();
      revealApp();
    });
    // Login-Gate: erst nach erfolgreicher Anmeldung die App zeigen (keine Demodaten für Unangemeldete)
    Promise.resolve(Cloud.init()).then((authed) => { if (authed) revealApp(); else showGateLogin(); });
  } else {
    revealApp(); // ohne Cloud-Modul kein Gate möglich
  }
})();
