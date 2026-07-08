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
  let assignments = {}; // Wochen-Einsatzplan: 'personId|YYYY-MM-DD' -> { text, type }

  // ---- Persistenz (Gruppen/Zeilen + Monteure-Team) ----
  function snapshot() {
    const groups = PLAN.groups.map(g => ({ name: g.name, rows: g.rows.map(r => ({ id: r.id, label: r.label, site: r.site, nummer: r.nummer, ort: r.ort, name: r.name, capRole: r.capRole, bars: r.bars })) }));
    return { groups, team: PLAN.team, assignments };
  }
  function applySnapshot(data) {
    if (data && Array.isArray(data.groups) && data.groups.length) PLAN.groups = data.groups;
    if (data && Array.isArray(data.team) && data.team.length) PLAN.team = data.team;
    if (data && data.assignments) assignments = data.assignments;
  }
  function saveLocal() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); } catch (e) {} }
  function save() { saveLocal(); if (window.Cloud) Cloud.scheduleSave(snapshot()); }
  function load() {
    let raw; try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return; }
    if (!raw) return;
    try { applySnapshot(JSON.parse(raw)); } catch (e) {}
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
  function seedCrew() {
    for (const g of PLAN.groups) {
      if (g.name !== 'Projekte') continue;
      for (const row of g.rows) for (const bar of row.bars) {
        if (bar.crew || (bar.phases && bar.phases.length) || bar.cat === 'vacation' || bar.cat === 'subcontractor') continue;
        bar.crew = { count: bar.cat === 'preplanning' ? 2 : 1, start: bar.start, end: bar.end, assigned: [] };
      }
    }
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
      for (const r of g.rows) for (const bar of r.bars) {
        if (bar.cat === 'vacation' || bar.cat === 'subcontractor') continue;
        if (bar.phases && bar.phases.length) {
          // Gewerk-Phasen: jede Phase belegt ihre eigenen Arbeitstage mit ihrer Personenzahl (feste Lage)
          for (const ph of bar.phases) {
            const count = +ph.count || 0; if (count <= 0) continue;
            const x0 = clamp(dayIndex(parse(ph.start), startMs), 0, totalDays-1);
            const x1 = clamp(dayIndex(parse(ph.end), startMs), 0, totalDays-1);
            const slots = []; for (let i = x0; i <= x1; i++) if (days[i].work) slots.push(i);
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
      }
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
    for (const g of PLAN.groups) for (const r of g.rows) for (const bar of r.bars) {
      if (bar.phases && bar.phases.length) {
        for (const ph of bar.phases) for (const rg of assignedRanges(ph)) add(rg.id, rg.start, rg.end, bar);
      } else if (bar.crew) {
        for (const id of (bar.crew.assigned || [])) add(id, bar.crew.start || bar.start, bar.crew.end || bar.end, bar);
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
  const monteurName = (id) => { const m = PLAN.team.find(t => t.id === id); return m ? m.name : id; };
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
  // Wandelt einen alten Sammelbedarf (crew) verlustfrei in eine Phase um – Voraussetzung fürs taggenaue Bearbeiten.
  function phasesOf(bar) {
    if (bar.phases && bar.phases.length) return bar.phases;
    if (bar.crew) {
      bar.phases = [{ trade: bar.crew.trade || 'edelstahl', start: bar.crew.start || bar.start, end: bar.crew.end || bar.end, count: +bar.crew.count || 1, assigned: (bar.crew.assigned || []).slice() }];
      delete bar.crew; return bar.phases;
    }
    return [];
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
  const projRows = () => { const g = PLAN.groups.find(x => x.name === 'Projekte'); return g ? g.rows : []; };
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
    save();
  }
  // Entfernt Person an genau einem Tag aus allen (genannten) Projekten.
  function removePersonDay(pid, dayISO, projectNames) {
    const names = projectNames || [];
    for (const row of projRows()) {
      const nm = row.site || row.label;
      if (names.length && names.indexOf(nm) < 0) continue;
      for (const bar of row.bars) for (const ph of phasesOf(bar)) removeFromPhase(ph, pid, dayISO);
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
    b.appendChild(el('div', 'h h-l'));
    b.appendChild(el('div', 'h h-r'));
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
    if (!bar.phases || !bar.phases.length) return lanes;
    for (const ph of bar.phases) {
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
          const have = new Set(ranges.filter(r => parse(r.start) <= d && parse(r.end) >= d).map(r => r.id)).size;
          open = have < need;
        }
        if (open) { const iso = isoStr(d); if (!cur) cur = { start: iso, end: iso }; else cur.end = iso; }
        else if (cur) { openSegs.push(cur); cur = null; }
      }
      if (cur) openSegs.push(cur);
      if (openSegs.length) lanes.push({ trade: ph.trade, name: '(offen)', open: true, segments: openSegs });
    }
    return lanes;
  }
  function renderLanes(track, row, windowBar, lanes) {
    lanes.forEach((lane, li) => {
      const t = TRADES()[lane.trade] || { color: '#9aa0a6', short: '?', label: lane.trade || 'Gewerk' };
      const top = 25 + li * 15;
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
      const lab = el('div', 'lane-lbl' + (lane.open ? ' lane-lbl-open' : ''), lane.open ? t.short + ' (offen)' : t.short + ' ' + lane.name);
      lab.style.left = (minX * dayWidth + 5) + 'px';
      lab.style.top = (top + 1) + 'px';
      if (lane.open) lab.style.color = t.color;
      track.appendChild(lab);
    });
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
      const r = el('div', 'row' + (idx % 2 ? ' alt' : ''));
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
          : { start: s, end: s, label: '', cat: 'preplanning', crew: { count: 1, days: 1, assigned: [] } };
        row.bars.push(bar);
        openEditor(row, bar, true);
      });
      // Monteur-Lanes unter dem Fensterbalken – Höhe wächst mit der Zahl der Lanes
      const laneMap = new Map();
      for (const bar of row.bars) { if (!hiddenCats.has(effCat(row, bar))) laneMap.set(bar, phaseLanes(bar)); }
      const lanes = Math.max(0, ...[...laneMap.values()].map(l => l.length));
      if (lanes > 0) r.style.height = (28 + lanes * 15) + 'px';
      for (const bar of row.bars) {
        if (hiddenCats.has(effCat(row, bar))) continue;
        const wb = makeBar(row, bar, flags);
        const bl = laneMap.get(bar) || [];
        if (bl.length) wb.style.height = '20px';   // Fenster kompakt halten, Lanes darunter
        track.appendChild(wb);
        renderLanes(track, row, bar, bl);
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

    function makeGroupRow(name) {
      const gr = el('div', 'group-row');
      gr.style.width = 'calc(var(--label-w) + ' + trackW + 'px)';
      gr.appendChild(el('div', 'group-row-label', name));
      return gr;
    }

    for (const group of PLAN.groups) {
      const rows = group.rows.filter(matches);
      const isRes = group.name === 'Ressourcen / Monteure';
      if (!rows.length && !(isRes && PLAN.team.length)) continue;
      body.appendChild(makeGroupRow(group.name));
      let idx = 0;
      if (isRes) {
        // Eine Zeile pro Monteur aus der Liste (Team): intern = Urlaub, extern = Buchung/Truppstärke
        const teamRows = PLAN.team.map(m => ({
          _member: m, id: 'mon-' + m.id, label: m.name || '(ohne Name)',
          capRole: m.type === 'extern' ? 'extern' : 'monteur',
          bars: (m.bars = m.bars || [])
        })).filter(matches);
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
  const fCat = document.getElementById('f-cat');
  const fStart = document.getElementById('f-start');
  const fEnd = document.getElementById('f-end');
  let current = null;

  for (const key of Object.keys(PLAN.categories)) {
    const o = el('option', null, PLAN.categories[key].label); o.value = key; fCat.appendChild(o);
  }

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
      // Zeitraum / Anzahl / Löschen
      const von = document.createElement('input'); von.type = 'date'; von.value = ph.start;
      const bis = document.createElement('input'); bis.type = 'date'; bis.value = ph.end;
      const cnt = document.createElement('input'); cnt.type = 'number'; cnt.min = '1'; cnt.step = '1'; cnt.value = ph.count || 1; cnt.title = 'Anzahl Personen';
      von.onchange = () => { ph.start = von.value; if (parse(ph.end) < parse(ph.start)) { ph.end = ph.start; bis.value = ph.end; } };
      bis.onchange = () => { ph.end = bis.value; if (parse(ph.end) < parse(ph.start)) { ph.end = ph.start; bis.value = ph.end; } };
      cnt.oninput = () => { ph.count = Math.max(1, +cnt.value || 1); };
      const del = el('span', 'phase-del', '✕'); del.title = 'Phase entfernen'; del.onclick = () => { phaseDraft.splice(i, 1); renderPhaseList(); };
      const line2 = el('div', 'phase-row2');
      const vonL = el('label', 'phase-fld', 'Von'); vonL.appendChild(von);
      const bisL = el('label', 'phase-fld', 'Bis'); bisL.appendChild(bis);
      const cntL = el('label', 'phase-fld phase-cnt', 'Anz.'); cntL.appendChild(cnt);
      line2.appendChild(vonL); line2.appendChild(bisL); line2.appendChild(cntL); line2.appendChild(del);
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
      card.appendChild(gwL); card.appendChild(line2); card.appendChild(asgTitle); card.appendChild(asg);
      fPhases.appendChild(card);
    });
  }
  document.getElementById('f-phase-add').onclick = () => {
    const b = current && current.bar;
    const last = phaseDraft[phaseDraft.length - 1];
    // Neue Phase erbt den Zeitraum der vorherigen (z. B. Elektro analog Edelstahl); Gewerk = nächstes noch nicht genutztes
    const used = new Set(phaseDraft.map(p => p.trade));
    const trade = last ? (Object.keys(TRADES()).find(k => !used.has(k)) || last.trade) : 'edelstahl';
    phaseDraft.push({
      trade,
      start: last ? last.start : ((b && b.start) || fStart.value),
      end: last ? last.end : ((b && b.end) || fEnd.value),
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
    // Kontextabhängige Felder
    document.getElementById('f-crew-wrap').style.display = (isExtern || isMonteur) ? 'none' : '';   // Montage-Phasen nur bei Projekten
    document.getElementById('f-cat-wrap').style.display = (isExtern || isMonteur) ? 'none' : '';    // Kategorie/Farbe ergibt sich bei Monteuren aus intern/extern
    document.getElementById('f-size-wrap').style.display = isExtern ? '' : 'none';                  // Truppstärke nur bei externen Buchungen
    document.getElementById('f-size').value = bar.size || (row._member && row._member.size) || 1;
    // Phasen laden – bestehender Sammelbedarf (crew) wird verlustfrei als erste Phase übernommen
    const cloneAssigned = (arr) => (arr || []).map(a => (typeof a === 'string' ? a : { id: a.id, start: a.start, end: a.end }));
    if (bar.phases && bar.phases.length) {
      phaseDraft = bar.phases.map(p => ({ trade: p.trade || 'edelstahl', start: p.start, end: p.end, count: p.count || 1, assigned: cloneAssigned(p.assigned) }));
    } else if (bar.crew && (+bar.crew.count > 0)) {
      phaseDraft = [{ trade: bar.crew.trade || 'edelstahl', start: bar.crew.start || bar.start, end: bar.crew.end || bar.end, count: +bar.crew.count || 1, assigned: cloneAssigned(bar.crew.assigned) }];
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
    bar.label = fLabel.value.trim();
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
      bar.phases = phaseDraft.length
        ? phaseDraft.map(p => {
            const s = p.start, e = p.end;
            const asg = (p.assigned || []).map(a => {
              if (typeof a === 'string') return a;                         // ganze Phase
              // Teilbereich auf das (evtl. geänderte) Phasenfenster begrenzen
              let rs = a.start > s ? a.start : s, re = a.end < e ? a.end : e;
              if (rs > re) return null;
              return (rs === s && re === e) ? a.id : { id: a.id, start: rs, end: re };
            }).filter(Boolean);
            return { trade: p.trade, start: s, end: e, count: Math.max(1, +p.count || 1), assigned: asg };
          })
        : undefined;
      delete bar.crew;
    }
    save(); render(); closeEditor();
  };
  document.getElementById('f-delete').onclick = () => {
    if (!current) return;
    const i = current.row.bars.indexOf(current.bar);
    if (i >= 0) current.row.bars.splice(i, 1);
    save(); render(); closeEditor();
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
  let curResource = null, curResKind = 'resource';
  function openResourceDialog(row, kind) {
    curResource = row; curResKind = kind || 'resource';
    const bl = curResKind === 'bauleiter';
    document.getElementById('rTitle').textContent =
      (row ? (bl ? 'Bauleiter bearbeiten' : 'Ressourcen-Zeile bearbeiten') : (bl ? 'Neuer Bauleiter' : 'Neue Ressourcen-Zeile'));
    document.getElementById('r-role-wrap').style.display = bl ? 'none' : ''; // Bauleiter: keine Kapazitätswirkung
    document.getElementById('r-delete').style.display = row ? '' : 'none';
    rName.value = row ? (row.label || '') : '';
    rRole.value = row ? (row.capRole || 'none') : 'monteur';
    rName.placeholder = bl ? 'z. B. BL Becker' : 'z. B. Urlaub Monteure / externe Trupps';
    roverlay.hidden = false; rName.focus();
  }
  function closeResourceDialog() { roverlay.hidden = true; curResource = null; }
  document.getElementById('r-save').onclick = () => {
    const name = rName.value.trim();
    if (!name) { rName.focus(); return; }
    const bl = curResKind === 'bauleiter';
    const role = bl ? 'none' : rRole.value;
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
  function render() { viewMode === 'week' ? renderWeek() : renderTimeline(); }
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
  }

  // ================= WOCHEN-EINSATZPLAN =================
  const WDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  // Manuelle Zell-Typen (Zusätze) – KEIN „baustelle": Baustellen-Einsätze kommen aus dem Zeitplan
  // und würden mit type==='baustelle' beim Rendern ausgeblendet. Default = erster Eintrag (ibn).
  const CELL_TYPES = {
    ibn:       { label: 'IBN / Inbetriebnahme' },
    buero:     { label: 'Büro / Info' },
    nv:        { label: 'n.v. / nicht verfügbar' },
    urlaub:    { label: 'Urlaub' },
  };
  const CELL_TYPE_DEFAULT = 'ibn';
  const mondayMs = (ms) => { const d = new Date(ms); return addDays(ms, -((d.getUTCDay() + 6) % 7)); };
  let selMonday = mondayMs(todayMs());
  const akey = (pid, dISO) => pid + '|' + dISO;

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
    return [{ text: 'IBN', type: 'ibn' }, { text: 'Büro', type: 'buero' }, { text: 'n.v.', type: 'nv' }, { text: 'Urlaub', type: 'urlaub' }];
  }

  // Leitet den Wocheninhalt LIVE aus dem Zeitplan ab: je (Person, Tag) die Projekte (aus Phasen),
  // Urlaub (interne Vacation-Balken) und Buchung (externe). Basis für Doppelbuchungs-Anzeige.
  function weekDerived() {
    const map = {};
    const get = (pid, ms) => { const k = akey(pid, isoStr(ms)); return (map[k] = map[k] || { projects: [], urlaub: false, booking: false }); };
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
        const phases = (bar.phases && bar.phases.length) ? bar.phases
          : (bar.crew ? [{ start: bar.crew.start || bar.start, end: bar.crew.end || bar.end, assigned: bar.crew.assigned }] : []);
        for (const ph of phases) for (const r of assignedRanges(ph)) {
          eachWorkday(r.start, r.end, (ms) => { const c = get(r.id, ms); if (c.projects.indexOf(name) < 0) c.projects.push(name); });
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
            const have = new Set(ranges.filter(r => parse(r.start) <= ms && parse(r.end) >= ms).map(r => r.id)).size;
            const open = need - have;
            if (open > 0) { days[isoStr(ms)] = open; anyOpen = true; }
          }
          if (anyOpen) out.push({ name, trade: ph.trade || '', row, bar, idx, days });
        });
      }
    }
    return out;
  }

  // Kleines Auswahlmenü, um einen offenen Bedarf direkt in der Woche taggenau zu besetzen.
  let needMenu = null;
  function closeNeedMenu() { if (needMenu) { needMenu.remove(); needMenu = null; document.removeEventListener('mousedown', onNeedDocDown, true); } }
  function onNeedDocDown(e) { if (needMenu && !needMenu.contains(e.target)) closeNeedMenu(); }
  function openNeedPicker(cell, row, bar, idx, dISO, trade) {
    closeNeedMenu();
    const ph = phasesOf(bar)[idx]; if (!ph) return;
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
      b.onclick = () => { addToPhase(ph, m.id, dISO); save(); closeNeedMenu(); renderWeek(); };
      needMenu.appendChild(b);
    }
    document.body.appendChild(needMenu);
    const r = cell.getBoundingClientRect();
    needMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - needMenu.offsetWidth - 8)) + 'px';
    needMenu.style.top = (r.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onNeedDocDown, true), 0);
  }

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
    grid.appendChild(el('div', 'wk-corner', 'Monteur / Bauleitung'));
    dates.forEach((ms, i) => {
      const h = el('div', 'wk-dayhead' + (i >= 5 ? ' weekend' : ''));
      h.innerHTML = `${WDAYS[i]} <small>${fmt(ms).slice(0, 6)}</small>`;
      grid.appendChild(h);
    });

    const derived = weekDerived();

    // Sektion „Offener Bedarf" – Gewerke, die im Zeitplan gefordert, aber noch nicht besetzt sind
    const needs = weekOpenDemand();
    if (needs.length) {
      grid.appendChild(el('div', 'wk-sep wk-sep-need', 'Offener Bedarf – noch niemand zugeordnet'));
      for (let i = 0; i < 7; i++) grid.appendChild(el('div', 'wk-sep-fill wk-sep-need'));
      for (const nd of needs) {
        const t = TRADES()[nd.trade] || { label: '(Gewerk offen)', short: '', color: '#999' };
        const nameCell = el('div', 'wk-name wk-need-name');
        const dot = el('span', 'need-dot'); dot.style.background = t.color; nameCell.appendChild(dot);
        nameCell.appendChild(document.createTextNode(nd.name + ' · ' + t.label));
        nameCell.title = nd.name + ' · ' + t.label;
        grid.appendChild(nameCell);
        dates.forEach((ms, i) => {
          const dISO = isoStr(ms), open = nd.days[dISO] || 0;
          const cell = el('div', 'wk-cell' + (i >= 5 ? ' weekend' : '') + (open ? ' wk-need' : ''));
          if (open) {
            cell.textContent = open + '×' + (t.short ? ' ' + t.short : '');
            cell.style.setProperty('--need-col', t.color);
            cell.title = t.label + ' – ' + open + ' Monteur' + (open > 1 ? 'e' : '') + ' offen (' + nd.name + ') · klicken zum Zuordnen';
            cell.addEventListener('click', () => openNeedPicker(cell, nd.row, nd.bar, nd.idx, dISO, nd.trade));
          }
          grid.appendChild(cell);
        });
      }
    }

    let lastKind = null;
    for (const p of weekPeople()) {
      if (p.kind === 'bauleiter' && lastKind !== 'bauleiter') {
        const sep = el('div', 'wk-sep', 'Bauleitung'); grid.appendChild(sep);
        for (let i = 0; i < 7; i++) grid.appendChild(el('div', 'wk-sep-fill'));
      }
      lastKind = p.kind;
      const nameCell = el('div', 'wk-name' + (p.kind === 'extern' ? ' extern' : ''), p.name);
      nameCell.title = p.name + (p.kind === 'extern' ? ' (extern)' : '');
      grid.appendChild(nameCell);
      dates.forEach((ms, i) => {
        const dISO = isoStr(ms), key = akey(p.id, dISO);
        const der = derived[key] || { projects: [], urlaub: false, booking: false };
        const note = (assignments[key] && assignments[key].type !== 'baustelle') ? assignments[key] : null;
        const proj = der.projects;
        let text = '', type = '', conflict = false, title = '';
        if (note) {
          text = note.text; type = note.type;
          if (proj.length) { conflict = true; title = 'Konflikt: im Zeitplan eingeplant (' + proj.join(', ') + '), hier manuell „' + note.text + '"'; }
        } else if (der.urlaub && proj.length) {
          conflict = true; type = 'nv'; text = 'Urlaub + ' + proj.join(', '); title = 'Konflikt: Urlaub trotz Einsatz (' + proj.join(', ') + ')';
        } else if (der.urlaub) {
          type = 'urlaub'; text = 'Urlaub';
        } else if (proj.length > 1) {
          conflict = true; type = 'nv'; text = proj.join(' / '); title = 'Doppelbuchung: ' + proj.join(', ');
        } else if (proj.length === 1) {
          type = 'baustelle'; text = proj[0]; title = proj[0];
        }
        const cell = el('div', 'wk-cell' + (i >= 5 ? ' weekend' : '') + (type ? ' t-' + type : '') + (conflict ? ' wk-conflict' : ''));
        cell.dataset.key = key;
        if (text) cell.textContent = text;
        if (title) cell.title = title;
        // Baustellen-Einsatz (aus dem Zeitplan) lässt sich taggenau auf eine andere Person/einen anderen Tag ziehen
        if (proj.length && !note && !der.urlaub) {
          cell.draggable = true;
          const pj = proj.slice(), fd = dISO, fid = p.id;
          cell.addEventListener('dragstart', (e) => { cell.classList.add('dragging'); e.dataTransfer.setData('text/plain', JSON.stringify({ move: { fromId: fid, fromDate: fd, projects: pj } })); });
          cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
        }
        // Manuelle Zusätze (Büro/n.v. …) per Palette-Drop; Baustellen-Einsätze per Zellen-Drag
        cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drop'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
        cell.addEventListener('drop', (e) => {
          e.preventDefault(); cell.classList.remove('drop');
          let data; try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (_) { return; }
          if (data.palette) { assignments[key] = { text: data.palette.text, type: data.palette.type, auto: false }; save(); renderWeek(); }
          else if (data.move) { weekReassign(data.move.fromId, data.move.fromDate, p.id, dISO, data.move.projects); renderWeek(); }
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
        placeCell(m.id, bar.start, bar.end, { text: 'Urlaub', type: 'urlaub' });
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
    save(); renderWeek();
    if (!count && fillOnly) alert('Keine zugeordneten Monteure in dieser Woche gefunden.\nOrdne im Zeitplan den Montage-Phasen Monteure zu (Fenster-Balken anklicken → Phase → Monteure), oder ziehe Baustellen aus der Palette in die Zellen.');
  }
  function scrollToToday() {
    const todayIdx = dayIndex(todayMs(), startMs);
    const labelW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-w'));
    viewport.scrollLeft = Math.max(0, todayIdx * dayWidth - viewport.clientWidth / 2 + labelW);
  }

  // ---- Zellen-Editor (Wochenplan) ----
  const woverlay = document.getElementById('woverlay');
  const wText = document.getElementById('w-text');
  const wType = document.getElementById('w-type');
  let curCell = null, curCellCtx = null;
  for (const key of Object.keys(CELL_TYPES)) { const o = el('option', null, CELL_TYPES[key].label); o.value = key; wType.appendChild(o); }
  function openCellEditor(key, person, ms) {
    curCell = key;
    const der = weekDerived()[key] || { projects: [], urlaub: false };
    curCellCtx = { key, pid: person.id, dISO: isoStr(ms), projects: der.projects.slice() };
    const a = assignments[key] || { text: '', type: CELL_TYPE_DEFAULT };
    document.getElementById('wTitle').textContent = `${person.name} · ${WDAYS[(new Date(ms).getUTCDay() + 6) % 7]} ${fmt(ms).slice(0, 6)}`;
    wText.value = a.text;
    wType.value = (a.type && a.type !== 'baustelle') ? a.type : CELL_TYPE_DEFAULT;  // Alt-„baustelle" auf gültigen Typ ziehen
    // Löschen anzeigen, wenn es eine manuelle Notiz ODER einen Zeitplan-Einsatz zum Entfernen gibt
    document.getElementById('w-delete').style.display = (assignments[key] || der.projects.length) ? '' : 'none';
    woverlay.hidden = false; wText.focus();
  }
  function closeCellEditor() { woverlay.hidden = true; curCell = null; curCellCtx = null; }
  document.getElementById('w-save').onclick = () => {
    if (!curCell) return;
    const text = wText.value.trim();
    if (!text) delete assignments[curCell]; else assignments[curCell] = { text, type: wType.value, auto: false };
    save(); renderWeek(); closeCellEditor();
  };
  document.getElementById('w-delete').onclick = () => {
    if (curCell) delete assignments[curCell];
    // Zeitplan-Einsatz dieses Tages ebenfalls entfernen (schreibt in die Phasen zurück)
    if (curCellCtx && curCellCtx.projects.length) removePersonDay(curCellCtx.pid, curCellCtx.dISO, curCellCtx.projects);
    save(); renderWeek(); closeCellEditor();
  };
  document.getElementById('w-cancel').onclick = () => closeCellEditor();
  woverlay.addEventListener('click', (e) => { if (e.target === woverlay) closeCellEditor(); });
  woverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCellEditor();
    if (e.key === 'Enter') document.getElementById('w-save').click();
  });

  // ---- Ansicht umschalten & Wochen-Navigation ----
  function setView(mode) {
    viewMode = mode;
    document.getElementById('viewTimeline').classList.toggle('active', mode === 'timeline');
    document.getElementById('viewWeek').classList.toggle('active', mode === 'week');
    document.getElementById('hint').style.display = mode === 'week' ? 'none' : '';
    document.getElementById('weekbar').hidden = mode !== 'week';
    document.querySelectorAll('.timeline-only').forEach(elm => { elm.style.display = mode === 'week' ? 'none' : ''; });
    render();
  }
  document.getElementById('viewTimeline').onclick = () => setView('timeline');
  document.getElementById('viewWeek').onclick = () => setView('week');
  document.getElementById('wkPrev').onclick = () => { selMonday = addDays(selMonday, -7); renderWeek(); };
  document.getElementById('wkNext').onclick = () => { selMonday = addDays(selMonday, 7); renderWeek(); };
  document.getElementById('wkToday').onclick = () => { selMonday = mondayMs(todayMs()); renderWeek(); };

  document.getElementById('zoomIn').onclick = () => { dayWidth = Math.min(48, dayWidth + 4); render(); };
  document.getElementById('zoomOut').onclick = () => { dayWidth = Math.max(6, dayWidth - 4); render(); };
  document.getElementById('today').onclick = () => scrollToToday();
  document.getElementById('addProject').onclick = () => openProjectDialog(null);
  document.getElementById('addResource').onclick = () => openResourceDialog(null, 'resource');
  document.getElementById('search').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render(); };

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

  // ---- Cloud-Sync (Microsoft-Login + SharePoint), optional ----
  const cloudStatusEl = document.getElementById('cloudStatus');
  const cloudLoginBtn = document.getElementById('cloudLogin');
  const cloudReloadBtn = document.getElementById('cloudReload');
  const loginNotice = document.getElementById('loginNotice');
  const loginNoticeErr = document.getElementById('loginNoticeErr');
  function updateCloudUI(text, cls) {
    if (cloudStatusEl) { cloudStatusEl.textContent = text; cloudStatusEl.className = 'cloud-status ' + (cls || ''); }
    const ready = !!(window.Cloud && Cloud.isReady());
    if (cloudLoginBtn) cloudLoginBtn.textContent = ready ? 'Abmelden' : 'Anmelden';
    if (loginNotice) loginNotice.hidden = ready;   // nur zeigen, solange nicht angemeldet
    // Fehler (z. B. fehlender Admin-Consent) direkt im Banner sichtbar machen – nicht nur im kleinen Status oben rechts
    if (loginNoticeErr) {
      const isErr = cls === 'warn' && !ready;
      loginNoticeErr.hidden = !isErr;
      loginNoticeErr.textContent = isErr ? '✕ ' + text + ' — bitte diesen Text an die IT / Johannes weitergeben.' : '';
    }
  }
  if (cloudLoginBtn) cloudLoginBtn.onclick = () => { if (window.Cloud) (Cloud.isReady() ? Cloud.logout() : Cloud.login()); };
  const loginNoticeBtn = document.getElementById('loginNoticeBtn');
  if (loginNoticeBtn) loginNoticeBtn.onclick = () => { if (window.Cloud) Cloud.login(); };
  if (cloudReloadBtn) cloudReloadBtn.onclick = () => { if (window.Cloud) Cloud.reload(); };

  load();
  migrateTeamResources();
  seedCrew();
  saveLocal();
  buildLegend();
  render();
  scrollToToday();

  if (window.Cloud) {
    Cloud.onStatus(updateCloudUI);
    Cloud.onApply((data) => { applySnapshot(data); migrateTeamResources(); seedCrew(); save(); buildLegend(); render(); });
    Cloud.init(); // asynchron: zieht bei Anmeldung den geteilten Stand und rendert neu
  }
})();
