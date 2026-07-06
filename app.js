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
        if (bar.crew || bar.cat === 'vacation' || bar.cat === 'subcontractor') continue;
        const x0 = dayIndex(parse(bar.start), startMs), x1 = dayIndex(parse(bar.end), startMs);
        const wd = Math.max(1, workingDaysIn(clamp(x0,0,totalDays-1), clamp(x1,0,totalDays-1)));
        bar.crew = { count: bar.cat === 'preplanning' ? 2 : 1, days: Math.min(wd, 5), assigned: [] };
      }
    }
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

    // Nur Zeilen mit Kapazitäts-Rolle wirken: 'monteur' = Urlaub (−1), 'extern' = Buchung (+1).
    // 'none' (z. B. Bauleiter-Urlaub, Schulungen) bleibt ohne Wirkung.
    for (const g of PLAN.groups) for (const r of g.rows) {
      if (r.capRole !== 'monteur' && r.capRole !== 'extern') continue;
      const delta = r.capRole === 'extern' ? +1 : -1;
      for (const bar of r.bars) {
        if (bar.cat !== 'vacation') continue;
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
        if (!bar.crew || bar.cat === 'vacation' || bar.cat === 'subcontractor') continue;
        const count = +bar.crew.count || 0, need = +bar.crew.days || 0;
        if (count <= 0 || need <= 0) continue;
        const x0 = clamp(dayIndex(parse(bar.start), startMs), 0, totalDays-1);
        const x1 = clamp(dayIndex(parse(bar.end), startMs), 0, totalDays-1);
        const slots = []; for (let i = x0; i <= x1; i++) if (days[i].work) slots.push(i);
        if (slots.length < need) infeasible.add(bar); // Fenster zu kurz
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

  // ---- Engpass: konkret zugeordnete Monteure mit überlappenden Fenstern ----
  function computeConflicts() {
    const byMonteur = {};
    for (const g of PLAN.groups) for (const r of g.rows) for (const bar of r.bars) {
      const ass = bar.crew && bar.crew.assigned || [];
      for (const id of ass) {
        (byMonteur[id] = byMonteur[id] || []).push(bar);
      }
    }
    const conflict = new Set();
    for (const id in byMonteur) {
      const list = byMonteur[id].map(b => ({ b, x0: dayIndex(parse(b.start), startMs), x1: dayIndex(parse(b.end), startMs) }))
                                .sort((a, z) => a.x0 - z.x0);
      for (let i = 1; i < list.length; i++) {
        if (list[i].x0 <= list[i-1].x1) { conflict.add(list[i].b); conflict.add(list[i-1].b); }
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
  function tradeTags(trades) {
    const wrap = el('span', 'trade-tags');
    for (const key of (trades || [])) {
      const t = TRADES()[key]; if (!t) continue;
      const tag = el('span', 'trade-tag', t.short); tag.style.background = t.color; tag.title = t.label;
      wrap.appendChild(tag);
    }
    return wrap;
  }

  function makeBar(row, bar, flags) {
    const cat = PLAN.categories[bar.cat] || PLAN.categories.preplanning;
    const x0 = dayIndex(parse(bar.start), startMs);
    const x1 = dayIndex(parse(bar.end), startMs);
    const reasons = flags.get(bar);
    const b = el('div', 'bar' + (reasons ? ' conflict' : ''));
    b.style.left = (x0 * dayWidth) + 'px';
    b.style.width = Math.max((x1 - x0 + 1) * dayWidth - 2, dayWidth - 2) + 'px';
    b.style.background = cat.fill; b.style.borderColor = cat.border; b.style.color = cat.text;
    b.appendChild(el('span', 'lbl', bar.label || ''));
    if (bar.crew && bar.crew.count > 0 && bar.crew.days > 0)
      b.appendChild(el('span', 'badge', `${bar.crew.count}×${bar.crew.days}T`));
    b.appendChild(el('div', 'h h-l'));
    b.appendChild(el('div', 'h h-r'));
    const crewTxt = bar.crew && bar.crew.count
      ? `\nBedarf: ${bar.crew.count} Monteure · ${bar.crew.days} Arbeitstage`
        + (bar.crew.assigned && bar.crew.assigned.length ? `\nZugeordnet: ${bar.crew.assigned.map(monteurName).join(', ')}` : '')
      : '';
    b.title = `${row.label}\n${bar.label || '(ohne Bezeichnung)'}\n${cat.label}\n${fmt(parse(bar.start))} – ${fmt(parse(bar.end))}${crewTxt}${reasons ? '\n⚠ ' + reasons.join('\n⚠ ') : ''}`;
    b._row = row; b._bar = bar;
    attachDrag(b);
    return b;
  }

  function buildBody(flags) {
    const body = el('div', 'body');
    const trackW = totalDays * dayWidth;
    let visible = 0;

    function makeRow(group, row, idx, indent) {
      const isProjects = group.name === 'Projekte';
      const isResources = group.name === 'Ressourcen / Monteure';
      const isBauleiter = group.name === 'Bauleiter';
      const editable = isProjects || isResources || isBauleiter;
      const r = el('div', 'row' + (idx % 2 ? ' alt' : ''));
      const roleTag = isResources && row.capRole && row.capRole !== 'monteur'
        ? (row.capRole === 'extern' ? '  ⟂ extern' : '  ⓘ keine Kapazität') : '';
      const label = el('div', 'label', row.label); label.title = row.label + roleTag + (editable ? '  (Doppelklick: bearbeiten)' : '');
      if (isResources && row.capRole === 'none') label.classList.add('row-info');
      if (indent) label.classList.add('area');
      if (editable) {
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
        const bar = { start: isoStr(ms), end: isoStr(ms), label: '', cat: 'preplanning', crew: { count: 1, days: 1, assigned: [] } };
        row.bars.push(bar);
        openEditor(row, bar, true);
      });
      for (const bar of row.bars) {
        if (hiddenCats.has(bar.cat)) continue;
        track.appendChild(makeBar(row, bar, flags));
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

    for (const group of PLAN.groups) {
      const rows = group.rows.filter(matches);
      if (!rows.length) continue;
      body.appendChild(el('div', 'group-row', group.name));
      let idx = 0;
      if (group.name === 'Projekte') {
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
    if (!visible) body.appendChild(el('div', 'group-row', 'Keine Treffer'));
    return body;
  }

  // ---- Ziehen / Größe ändern ----
  function attachDrag(b) {
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
        if (!moved && mode === 'move') { openEditor(b._row, bar, false); return; }
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
  const fCount = document.getElementById('f-count');
  const fDays = document.getElementById('f-days');
  const fAssign = document.getElementById('f-assign');
  let current = null;

  for (const key of Object.keys(PLAN.categories)) {
    const o = el('option', null, PLAN.categories[key].label); o.value = key; fCat.appendChild(o);
  }
  // Monteur-Checkboxen (wird bei jedem Öffnen neu aufgebaut → immer aktuell)
  function buildAssignList() {
    fAssign.innerHTML = '';
    for (const m of PLAN.team) {
      const lab = el('label', null);
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = m.id;
      const span = el('span', m.type === 'extern' ? 'ext' : null, m.name + (m.type === 'extern' ? ' (ext)' : ''));
      lab.appendChild(cb); lab.appendChild(span); lab.appendChild(tradeTags(m.trades));
      fAssign.appendChild(lab);
    }
  }
  fAssign.addEventListener('change', () => {
    const n = fAssign.querySelectorAll('input:checked').length;
    if (n > 0) fCount.value = n;
  });

  function openEditor(row, bar, isNew) {
    current = { row, bar, isNew };
    if (!bar.crew) bar.crew = { count: 0, days: 0, assigned: [] };
    document.getElementById('dlgTitle').textContent = (isNew ? 'Neuer Termin' : 'Termin bearbeiten') + ' · ' + row.label;
    fLabel.value = bar.label || '';
    fCat.value = bar.cat;
    fStart.value = bar.start; fEnd.value = bar.end;
    fCount.value = bar.crew.count || 0;
    fDays.value = bar.crew.days || 0;
    buildAssignList();
    const ass = new Set(bar.crew.assigned || []);
    fAssign.querySelectorAll('input').forEach(cb => { cb.checked = ass.has(cb.value); });
    overlay.hidden = false; fLabel.focus();
  }
  function closeEditor() { overlay.hidden = true; current = null; }

  document.getElementById('f-save').onclick = () => {
    if (!current) return;
    const { bar } = current;
    bar.label = fLabel.value.trim();
    bar.cat = fCat.value;
    let s = fStart.value || bar.start, e = fEnd.value || bar.end;
    if (parse(e) < parse(s)) e = s;
    bar.start = s; bar.end = e;
    const assigned = Array.from(fAssign.querySelectorAll('input:checked')).map(cb => cb.value);
    bar.crew = { count: Math.max(0, +fCount.value || 0), days: Math.max(0, +fDays.value || 0), assigned };
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
      sel.addEventListener('change', () => { m.type = sel.value; save(); render(); refreshCapInfo(); });
      const del = el('span', 'm-del', '✕'); del.title = 'Monteur entfernen';
      del.onclick = () => {
        if (!confirm(`„${m.name}" wirklich entfernen?`)) return;
        PLAN.team.splice(PLAN.team.indexOf(m), 1);
        save(); render(); renderTeamList();
      };
      row1.appendChild(name); row1.appendChild(sel); row1.appendChild(del);

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
  const CELL_TYPES = {
    baustelle: { label: 'Baustelle / Einsatz' },
    ibn:       { label: 'IBN / Inbetriebnahme' },
    buero:     { label: 'Büro / Info' },
    nv:        { label: 'n.v. / nicht verfügbar' },
    urlaub:    { label: 'Urlaub' },
  };
  const mondayMs = (ms) => { const d = new Date(ms); return addDays(ms, -((d.getUTCDay() + 6) % 7)); };
  let selMonday = mondayMs(todayMs());
  const akey = (pid, dISO) => pid + '|' + dISO;

  function weekPeople() {
    const monteure = PLAN.team.map(m => ({ id: m.id, name: m.name, kind: m.type === 'extern' ? 'extern' : 'monteur', trades: m.trades }));
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
    const names = new Map(); // name -> type
    for (const { row, bar } of barsOverlappingWeek()) {
      const name = row.site || row.label;
      if (name) names.set(name, bar.cat === 'subcontractor' ? 'baustelle' : 'baustelle');
    }
    const chips = [...names.keys()].sort().map(n => ({ text: n, type: 'baustelle' }));
    chips.push({ text: 'IBN', type: 'ibn' }, { text: 'Büro', type: 'buero' }, { text: 'n.v.', type: 'nv' }, { text: 'Urlaub', type: 'urlaub' });
    return chips;
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
        const a = assignments[key];
        const cell = el('div', 'wk-cell' + (i >= 5 ? ' weekend' : '') + (a ? ' t-' + a.type : ''));
        cell.dataset.key = key;
        if (a) { cell.textContent = a.text; cell.draggable = true; cell.title = a.text; }
        cell.addEventListener('dragstart', (e) => { if (a) e.dataTransfer.setData('text/plain', JSON.stringify({ from: key })); });
        cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drop'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
        cell.addEventListener('drop', (e) => {
          e.preventDefault(); cell.classList.remove('drop');
          let data; try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (_) { return; }
          if (data.from) moveAssignment(data.from, key);
          else if (data.palette) { assignments[key] = { text: data.palette.text, type: data.palette.type }; save(); renderWeek(); }
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
    if (dst) assignments[fromKey] = dst; else delete assignments[fromKey];
    assignments[toKey] = src;
    save(); renderWeek();
  }
  function vorplanung() {
    let count = 0;
    for (const { row, bar } of barsOverlappingWeek()) {
      const assigned = bar.crew && bar.crew.assigned || [];
      if (!assigned.length) continue;
      const name = row.site || row.label;
      for (let i = 0; i < 7; i++) {
        const ms = addDays(selMonday, i);
        if (new Date(ms).getUTCDay() === 0 || new Date(ms).getUTCDay() === 6) continue;
        if (parse(bar.start) > ms || parse(bar.end) < ms) continue;
        for (const pid of assigned) {
          const key = akey(pid, isoStr(ms));
          if (!assignments[key]) { assignments[key] = { text: name, type: bar.cat === 'confirmed' ? 'baustelle' : 'baustelle' }; count++; }
        }
      }
    }
    save(); renderWeek();
    if (!count) alert('Keine konkret zugeordneten Monteure in dieser Woche gefunden.\nOrdne im Zeitplan Termine Monteuren zu (Termin anklicken → „Konkret zuordnen"), oder ziehe Baustellen aus der Palette in die Zellen.');
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
  let curCell = null;
  for (const key of Object.keys(CELL_TYPES)) { const o = el('option', null, CELL_TYPES[key].label); o.value = key; wType.appendChild(o); }
  function openCellEditor(key, person, ms) {
    curCell = key;
    const a = assignments[key] || { text: '', type: 'baustelle' };
    document.getElementById('wTitle').textContent = `${person.name} · ${WDAYS[(new Date(ms).getUTCDay() + 6) % 7]} ${fmt(ms).slice(0, 6)}`;
    wText.value = a.text; wType.value = a.type;
    document.getElementById('w-delete').style.display = assignments[key] ? '' : 'none';
    woverlay.hidden = false; wText.focus();
  }
  function closeCellEditor() { woverlay.hidden = true; curCell = null; }
  document.getElementById('w-save').onclick = () => {
    if (!curCell) return;
    const text = wText.value.trim();
    if (!text) delete assignments[curCell]; else assignments[curCell] = { text, type: wType.value };
    save(); renderWeek(); closeCellEditor();
  };
  document.getElementById('w-delete').onclick = () => { if (curCell) delete assignments[curCell]; save(); renderWeek(); closeCellEditor(); };
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
  document.getElementById('wkVorplan').onclick = () => vorplanung();

  document.getElementById('zoomIn').onclick = () => { dayWidth = Math.min(48, dayWidth + 4); render(); };
  document.getElementById('zoomOut').onclick = () => { dayWidth = Math.max(6, dayWidth - 4); render(); };
  document.getElementById('today').onclick = () => scrollToToday();
  document.getElementById('addProject').onclick = () => openProjectDialog(null);
  document.getElementById('addResource').onclick = () => openResourceDialog(null, 'resource');
  document.getElementById('reset').onclick = () => {
    if (!confirm('Alle Änderungen verwerfen und Beispieldaten wiederherstellen?')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    location.reload();
  };
  // Export: aktuellen Plan als JSON sichern
  document.getElementById('exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(snapshot(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'montageplanung-export.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  // Import: Plan aus JSON-Datei laden (und – falls angemeldet – in die Cloud schreiben)
  const importFile = document.getElementById('importFile');
  document.getElementById('importBtn').onclick = () => importFile.click();
  importFile.onchange = () => {
    const f = importFile.files && importFile.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      let data;
      try { data = JSON.parse(rd.result); } catch (e) { alert('Das ist keine gültige JSON-Datei.'); importFile.value = ''; return; }
      if (!data || !Array.isArray(data.groups)) { alert('Die Datei enthält keine Plandaten ("groups").'); importFile.value = ''; return; }
      const rowN = data.groups.reduce((n, g) => n + (g.rows ? g.rows.length : 0), 0);
      const cloudNote = (window.Cloud && Cloud.isReady())
        ? '\n\n⚠ Du bist angemeldet: Der importierte Stand ersetzt danach auch die gemeinsamen Daten in SharePoint.'
        : '';
      if (!confirm(`Plan aus "${f.name}" importieren?\n${rowN} Zeilen werden geladen und ERSETZEN den aktuellen Plan.${cloudNote}\n\nTipp: vorher „Export" für ein Backup.`)) { importFile.value = ''; return; }
      applySnapshot(data); seedCrew(); save(); buildLegend(); render();
      importFile.value = '';
      alert('Import fertig – ' + rowN + ' Zeilen geladen.');
    };
    rd.readAsText(f);
  };
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
  function updateCloudUI(text, cls) {
    if (cloudStatusEl) { cloudStatusEl.textContent = text; cloudStatusEl.className = 'cloud-status ' + (cls || ''); }
    if (cloudLoginBtn) cloudLoginBtn.textContent = (window.Cloud && Cloud.isReady()) ? 'Abmelden' : 'Anmelden';
  }
  if (cloudLoginBtn) cloudLoginBtn.onclick = () => { if (window.Cloud) (Cloud.isReady() ? Cloud.logout() : Cloud.login()); };
  if (cloudReloadBtn) cloudReloadBtn.onclick = () => { if (window.Cloud) Cloud.reload(); };

  load();
  seedCrew();
  buildLegend();
  render();
  scrollToToday();

  if (window.Cloud) {
    Cloud.onStatus(updateCloudUI);
    Cloud.onApply((data) => { applySnapshot(data); seedCrew(); saveLocal(); buildLegend(); render(); });
    Cloud.init(); // asynchron: zieht bei Anmeldung den geteilten Stand und rendert neu
  }
})();
