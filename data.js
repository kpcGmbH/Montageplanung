// Montageplanung – Beispieldaten (aus den Screenshots abgeleitet)
// Datenmodell: Gruppen -> Zeilen -> Balken
// cat: 'confirmed' (grün) | 'subcontractor' (gelb) | 'preplanning' (orange) | 'vacation' (blau)

const PLAN = {
  rangeStart: '2026-05-18', // Montag, KW21
  rangeEnd:   '2027-04-26',
  today:      '2026-06-30',

  categories: {
    confirmed:    { label: 'Bestätigter Projekttermin',          fill: '#62a92f', border: '#46801f', text: '#10300a' },
    subcontractor:{ label: 'Externe Montage (Nachunternehmer)',  fill: '#f3d011', border: '#c9a800', text: '#3a3000' },
    preplanning:  { label: 'Vorplanung / nicht bestätigt',       fill: '#ec8a2b', border: '#c46a14', text: '#3a1f00' },
    vacation:     { label: 'Urlaub',                             fill: '#39c0d8', border: '#1f97ad', text: '#053038' },
    booking:      { label: 'Externe Trupps (Buchung)',           fill: '#b39ddb', border: '#8f77c4', text: '#2b1e52' },
  },

  // Gewerke/Qualifikationen (Katalog). Pro Monteur beliebig kombinierbar.
  trades: {
    elektrik:       { label: 'Elektriker',                short: 'E',  color: '#f0a020' },
    sanitaer:       { label: 'Sanitär',                   short: 'S',  color: '#2f80c4' },
    sanitaer_klein: { label: 'Kleine Sanitäranschlüsse',  short: 'Sk', color: '#7fb3d5' },
    edelstahl:      { label: 'Edelstahlmonteur',          short: 'Ed', color: '#6b7b8a' },
  },

  // Monteure-Team (Basis für die Kapazität/Auslastung).
  // type: 'intern' zählt in die Kapazität, 'extern' = zubuchbare Fremdtrupps.
  // trades: Liste von Schlüsseln aus dem Gewerke-Katalog oben.
  team: [
    { id: 'm1', name: 'Tomek',          type: 'intern', trades: ['elektrik'] },
    { id: 'm2', name: 'Alex',           type: 'intern', trades: ['sanitaer'] },
    { id: 'm3', name: 'Ivan',           type: 'intern', trades: ['edelstahl'] },
    { id: 'm4', name: 'Christopher',    type: 'intern', trades: ['elektrik'] },
    { id: 'm5', name: 'Milenko',        type: 'intern', trades: ['edelstahl'] },
    { id: 'm6', name: 'Kurt',           type: 'intern', trades: ['sanitaer'] },
    { id: 'm7', name: 'Eban',           type: 'intern', trades: ['edelstahl', 'elektrik'] },
    { id: 'x1', name: 'Mirko Schneider',type: 'extern', trades: ['edelstahl'] },
    { id: 'x2', name: 'Kai',            type: 'extern', trades: ['sanitaer'] },
  ],

  groups: [
    {
      name: 'Ressourcen / Monteure',
      rows: [
        { id: 'r1', label: 'Monteure Urlaub', capRole: 'monteur', bars: [
          { start: '2026-06-29', end: '2026-07-03', label: 'Tomek', cat: 'vacation' },
          { start: '2026-07-06', end: '2026-07-24', label: 'Alex Urlaub', cat: 'vacation' },
          { start: '2026-07-13', end: '2026-07-15', label: 'Niazczll Flo', cat: 'vacation' },
        ]},
        { id: 'r2', label: 'Steinacker', capRole: 'none', bars: [
          { start: '2026-05-25', end: '2026-06-05', label: 'Burghaun Gr', cat: 'confirmed' },
          { start: '2026-07-06', end: '2026-07-10', label: 'IFAZ Marburg', cat: 'subcontractor' },
          { start: '2026-08-10', end: '2026-08-14', label: 'Wiesbaden Kl', cat: 'preplanning' },
          { start: '2026-08-24', end: '2026-08-28', label: 'Karlstadt', cat: 'preplanning' },
          { start: '2026-09-14', end: '2026-09-18', label: 'Bauhaus WÜ', cat: 'preplanning' },
          { start: '2026-11-23', end: '2026-11-27', label: 'Wiesbaden St', cat: 'preplanning' },
        ]},
        { id: 'r3', label: 'Urlaub Monteure', capRole: 'monteur', bars: [
          { start: '2026-06-22', end: '2026-06-26', label: 'Eban', cat: 'vacation' },
          { start: '2026-07-27', end: '2026-07-31', label: 'Christopher', cat: 'vacation' },
        ]},
        { id: 'r4', label: 'Urlaub Monteure', capRole: 'monteur', bars: [
          { start: '2026-06-15', end: '2026-06-19', label: 'Ivan', cat: 'vacation' },
          { start: '2026-07-27', end: '2026-07-31', label: 'Milenko Sava', cat: 'vacation' },
        ]},
        { id: 'r5', label: 'ext. Monteure', capRole: 'extern', bars: [
          { start: '2026-05-25', end: '2026-06-05', label: 'Mirko Schneider', cat: 'vacation' },
          { start: '2026-06-15', end: '2026-06-26', label: 'Mirko Schneider', cat: 'vacation' },
          { start: '2026-07-20', end: '2026-07-24', label: 'Mirko Schneider', cat: 'vacation' },
        ]},
        { id: 'r6', label: 'ext. Monteure II', capRole: 'extern', bars: [
          { start: '2026-05-25', end: '2026-06-12', label: 'Mirko Schneider', cat: 'vacation' },
          { start: '2026-07-27', end: '2026-07-31', label: 'Kai', cat: 'vacation' },
        ]},
        { id: 'r7', label: 'Urlaub Monteure', capRole: 'monteur', bars: [
          { start: '2026-06-29', end: '2026-07-10', label: 'Urlaub Kurt', cat: 'vacation' },
        ]},
        { id: 'r9res', label: 'Schulungen', capRole: 'none', bars: [] },
      ]
    },
    {
      name: 'Bauleiter',
      rows: [
        { id: 'bl1', label: 'BL Becker', capRole: 'none', bars: [
          { start: '2026-07-06', end: '2026-07-17', label: 'Urlaub', cat: 'vacation' },
        ]},
        { id: 'bl2', label: 'BL Wagner', capRole: 'none', bars: [
          { start: '2026-08-03', end: '2026-08-14', label: 'Urlaub', cat: 'vacation' },
        ]},
      ]
    },
    {
      name: 'Projekte',
      rows: [
        { id: 'r9',  label: '831 Wiesbaden BKA Reinigung', bars: [
          { start: '2026-05-25', end: '2026-05-29', label: 'Kaffeest.', cat: 'confirmed' } ]},
        { id: 'r10', label: '833 Adelsheim JVA', bars: [] },
        { id: 'r11', site: '908 Berlin Upbeat', label: 'UG', bars: [
          { start: '2026-06-08', end: '2026-07-10', label: 'EG Ausgabe + Cafe Transit + Pufferraum', cat: 'confirmed' } ]},
        { id: 'r12', site: '908 Berlin Upbeat', label: 'EG', bars: [
          { start: '2026-07-06', end: '2026-07-17', label: 'EG RH / VDS', cat: 'confirmed' } ]},
        { id: 'r13', site: '908 Berlin Upbeat', label: '1.OG', bars: [
          { start: '2026-06-08', end: '2026-07-10', label: '1.OG Ausgabe + Pufferraum + Pantry', cat: 'confirmed' },
          { start: '2026-07-06', end: '2026-07-10', label: 'Wasserspender', cat: 'subcontractor' } ]},
        { id: 'r14', site: '908 Berlin Upbeat', label: 'MEK', bars: [
          { start: '2026-06-15', end: '2026-06-19', label: 'DKB', cat: 'confirmed' },
          { start: '2026-07-06', end: '2026-07-10', label: 'Abnahme', cat: 'confirmed' } ]},
        { id: 'r15', site: '908 Berlin Upbeat', label: '3.OG', bars: [
          { start: '2026-06-29', end: '2026-07-10', label: 'neues Material alle Etagen', cat: 'confirmed' },
          { start: '2026-07-20', end: '2026-07-24', label: 'Übergabe', cat: 'preplanning' } ]},
        { id: 'r16', site: '908 Berlin Upbeat', label: '11.OG', bars: [
          { start: '2026-06-29', end: '2026-07-03', label: '11.OG Grill/RH', cat: 'confirmed' } ]},
        { id: 'r17', site: '908 Berlin Upbeat', label: '17.OG', bars: [] },
        { id: 'r18', site: '908 Berlin Upbeat', label: '18.OG', bars: [
          { start: '2026-06-01', end: '2026-06-05', label: 'Pantry', cat: 'confirmed' } ]},
        { id: 'r19', site: '908 Berlin Upbeat', label: 'Fremd', bars: [
          { start: '2026-06-01', end: '2026-06-05', label: 'Schreiner-Kaffee', cat: 'confirmed' } ]},
        { id: 'r20', label: '921 Homburg - AOK Sp', bars: [
          { start: '2026-07-06', end: '2026-07-10', label: 'Ausgaben Ké', cat: 'confirmed' } ]},
        { id: 'r21', label: '932 Ansbach Klinikum', bars: [
          { start: '2026-06-15', end: '2026-06-17', label: '', cat: 'confirmed' } ]},
        { id: 'r22', label: '949 Frankfurt Jüdische', bars: [
          { start: '2026-07-06', end: '2026-07-10', label: 'Hauben Eingl.', cat: 'confirmed' },
          { start: '2026-09-07', end: '2026-09-25', label: 'Altbau EG', cat: 'preplanning' } ]},
        { id: 'r23', label: '959 Kassel-Waldau Schule', bars: [
          { start: '2026-07-27', end: '2026-07-31', label: 'Kühl', cat: 'subcontractor' } ]},
        { id: 'r24', label: '971 Frankfurt Messe', bars: [
          { start: '2026-08-03', end: '2026-08-07', label: 'Mesko', cat: 'subcontractor' },
          { start: '2026-08-17', end: '2026-08-28', label: 'Neubau UG', cat: 'preplanning' } ]},
        { id: 'r25', label: '973 Hanau - Jüdische C', bars: [
          { start: '2026-08-10', end: '2026-08-12', label: 'Brez', cat: 'confirmed' } ]},
        { id: 'r26', label: '981 Wiesbaden STZ Pör', bars: [
          { start: '2026-11-23', end: '2026-12-18', label: 'Montage Küche → Inbetriebnahme', cat: 'preplanning' } ]},
        { id: 'r27', label: '987 Kriftel Schwarzbach', bars: [] },
        { id: 'r28', label: 'xxx Hammelburg - Schule', bars: [] },
        { id: 'r29', label: '994 Bergisch Gladbach', bars: [
          { start: '2026-06-08', end: '2026-06-10', label: 'IDN', cat: 'confirmed' } ]},
        { id: 'r30', label: '1005 Würzburg Bauhaus', bars: [
          { start: '2026-09-14', end: '2026-09-18', label: 'Montage', cat: 'preplanning' } ]},
        { id: 'r31', label: '1006 Ludwigsburg Götz', bars: [
          { start: '2026-06-15', end: '2026-06-17', label: '', cat: 'confirmed' } ]},
        { id: 'r32', label: '1015 Marburg-Cappel J', bars: [
          { start: '2026-06-29', end: '2026-07-31', label: 'Küchentechnik', cat: 'confirmed' } ]},
        { id: 'r33', label: '1017 Marburg-Cappel E', bars: [
          { start: '2026-08-03', end: '2026-08-07', label: 'IDN Einweis.', cat: 'confirmed' },
          { start: '2026-08-03', end: '2026-08-21', label: 'Montage Küche', cat: 'preplanning' } ]},
        { id: 'r34', label: '1018 Eschborn - Premie', bars: [
          { start: '2026-06-01', end: '2026-06-03', label: '', cat: 'confirmed' } ]},
        { id: 'r35', label: '1021 Heringen Bürgerh', bars: [] },
        { id: 'r36', label: '10xx Frankfurt Messe Ki', bars: [] },
        { id: 'r37', label: '1023 Volkach Mainfran', bars: [
          { start: '2026-08-17', end: '2026-09-04', label: 'Küchentechnik', cat: 'preplanning' },
          { start: '2026-09-07', end: '2026-09-30', label: 'Montage Küche lt. BZ-Plan', cat: 'preplanning' } ]},
        { id: 'r38', label: '1024 Wiesbaden Kita', bars: [
          { start: '2026-09-07', end: '2026-09-18', label: 'Montage', cat: 'preplanning' } ]},
        { id: 'r39', label: '1025 Rostock Edeka', bars: [] },
        { id: 'r40', label: '1029 Bremerhaven Pier', bars: [] },
        { id: 'r41', label: '1030 Frankfurt Messe B', bars: [
          { start: '2026-08-17', end: '2026-08-21', label: 'Montage', cat: 'preplanning' } ]},
        { id: 'r42', label: '1031 Karlstadt Otto', bars: [
          { start: '2026-07-06', end: '2026-07-08', label: 'Kühlzelle Gab', cat: 'vacation' },
          { start: '2026-09-14', end: '2026-10-09', label: 'Küchentechnik', cat: 'preplanning' } ]},
        { id: 'r43', label: '1032 Heilbronn Neckart', bars: [
          { start: '2026-09-07', end: '2026-09-11', label: 'Küchentechnik', cat: 'preplanning' },
          { start: '2026-10-05', end: '2026-10-09', label: 'Abnahme/Einw.', cat: 'preplanning' },
          { start: '2027-03-08', end: '2027-03-26', label: 'Montage', cat: 'preplanning' } ]},
        { id: 'r44', label: '1033 Starnberg Seebad', bars: [
          { start: '2026-07-06', end: '2026-07-10', label: 'Remontage', cat: 'preplanning' } ]},
        { id: 'r45', label: '1035 Steinbach Matthä', bars: [
          { start: '2026-07-06', end: '2026-07-10', label: 'Steinbach Mä', cat: 'confirmed' },
          { start: '2026-07-13', end: '2026-07-17', label: 'Haubenmont.', cat: 'preplanning' } ]},
        { id: 'r46', label: '1036 Darmstadt MTB', bars: [
          { start: '2026-07-20', end: '2026-07-24', label: 'Küchentechnik', cat: 'preplanning' } ]},
        { id: 'r47', label: '1037 Göttingen Kiga', bars: [
          { start: '2026-06-15', end: '2026-06-19', label: 'Montage', cat: 'confirmed' } ]},
        { id: 'r48', label: '1038 Frankfurt RTL', bars: [
          { start: '2026-05-25', end: '2026-05-29', label: '', cat: 'confirmed' } ]},
        { id: 'r49', label: '1048 PI Halle', bars: [] },
        { id: 'r50', label: '1051 Nürnberg Haus', bars: [
          { start: '2026-09-07', end: '2026-09-11', label: 'Aufmaß Kühlzelle', cat: 'preplanning' },
          { start: '2026-10-12', end: '2026-10-16', label: 'Installationsk.', cat: 'preplanning' },
          { start: '2026-12-07', end: '2026-12-11', label: 'Haube', cat: 'preplanning' },
          { start: '2026-12-21', end: '2026-12-23', label: 'Aufmaß', cat: 'preplanning' } ]},
        { id: 'r51', label: '1060 Eschborn PI Kühlz', bars: [] },
        { id: 'r52', label: '1062 Korbach Berliner S', bars: [] },
        { id: 'r53', label: '1065 Neu-Isenburg Goe', bars: [] },
        { id: 'r54', label: '1067 Wetzlar CarGass', bars: [] },
        { id: 'r55', label: '1068 Oberursel Gefahre', bars: [] },
        { id: 'r56', label: '1069 Heidelberg Flüchtl', bars: [] },
        { id: 'r57', label: '1070 Mannheim PI', bars: [] },
        { id: 'r58', label: '1072 Frankfurt Adina', bars: [] },
        { id: 'r59', label: '1076 München PI SPM', bars: [] },
        { id: 'r60', label: '620 Bochum Bergmann', bars: [
          { start: '2026-07-27', end: '2026-07-31', label: '', cat: 'preplanning' } ]},
        { id: 'r61', label: '1078 Göttingen PI', bars: [] },
        { id: 'r62', label: '1079 Frankfurt AMEX', bars: [] },
        { id: 'r63', label: '1080 Pilgerzell Mensa', bars: [
          { start: '2026-07-20', end: '2026-07-24', label: 'Küchentechnik', cat: 'preplanning' },
          { start: '2026-07-27', end: '2026-07-31', label: 'Inbetriebnahm', cat: 'preplanning' } ]},
        { id: 'r64', label: '1081 Darmstadt Friedric', bars: [] },
        { id: 'r65', label: '1083 Berlin Apple', bars: [] },
        { id: 'r66', label: '1086 Erlangen CBBE', bars: [] },
        { id: 'r67', label: '1087 Lütter Grundschule', bars: [
          { start: '2026-06-22', end: '2026-06-24', label: '', cat: 'confirmed' } ]},
        { id: 'r68', label: '1088 Mainz Peter-Härtli', bars: [
          { start: '2027-04-05', end: '2027-04-12', label: 'Montage', cat: 'preplanning' } ]},
        { id: 'r69', label: 'Urlaub', bars: [] },
        { id: 'r70', label: '1089 Wiesbaden Helen', bars: [
          { start: '2026-07-20', end: '2026-07-24', label: 'Küchentechnik', cat: 'preplanning' },
          { start: '2026-07-27', end: '2026-07-31', label: 'Montage', cat: 'confirmed' } ]},
        { id: 'r71', label: '1092 Hofaschenbach', bars: [] },
        { id: 'r72', label: '1093 Mainz Maskenver', bars: [
          { start: '2026-06-29', end: '2026-07-01', label: '', cat: 'confirmed' } ]},
      ]
    }
  ]
};
