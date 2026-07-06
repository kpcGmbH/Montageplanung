# Montageplanung – Online stellen (für die IT)

Ziel: die App unter einer festen Web-URL bereitstellen und den **geteilten Datenstand**
für alle Planer ermöglichen – **genau wie die Montagefortschrittsapp**
(GitHub Pages + Microsoft-Login + SharePoint via Graph).

Die App ist rein statisch (HTML/CSS/JS). Kein Server, kein Build nötig.

---

## 1. GitHub Pages (die Web-URL)

1. Neues Repo in der Org **`kpcgmbh`** anlegen, z. B. **`Montageplanung`**.
2. Diese Dateien ins Repo-Root pushen:
   `index.html`, `styles.css`, `data.js`, `cloud.js`, `app.js`
   *(Alternativ die gebündelte Einzeldatei `dist/Montageplanung.html` als `index.html` – dann reicht eine Datei.)*
3. Repo → **Settings → Pages** → Source: „Deploy from a branch", Branch `main` / `/root` → Speichern.
4. Ergebnis-URL (merken, wird unten gebraucht):
   **`https://kpcgmbh.github.io/Montageplanung/`**

> Cache-Hinweis: Die lokalen Dateien werden mit `?v=2` eingebunden. Bei einem
> Update die Zahl in `index.html` erhöhen (`?v=3` …), damit Browser die neue
> Version laden.

---

## 2. Entra ID – bestehende App-Registrierung erweitern

Wir verwenden **dieselbe App-Registrierung wie die Fortschrittsapp**
(Client-ID `68f89557-eef9-4481-b45c-29919ed7b55d`, Tenant `cba1b1fc-…`).
Nur zwei Ergänzungen nötig:

1. **Redirect-URI hinzufügen**
   Entra ID → App-Registrierungen → die bestehende App → **Authentifizierung**
   → Plattform **Single-Page Application (SPA)** → Redirect-URI ergänzen:
   **`https://kpcgmbh.github.io/Montageplanung/`** (mit abschließendem `/`).
2. **Graph-Berechtigungen** (sollten von der Fortschrittsapp bereits vorhanden sein):
   delegiert **`User.Read`** und **`Sites.Selected`**.

---

## 3. SharePoint-Site + Zugriff

1. Neue SharePoint-Site **`/sites/Montageplanung`** anlegen (Team- oder Kommunikationssite)
   auf `kpcfulda.sharepoint.com`. Planer als Mitglieder berechtigen.
2. Der App **Schreibzugriff auf genau diese Site** über `Sites.Selected` gewähren
   – derselbe Schritt wie damals für `/sites/Montagefortschritt`.
   Per Graph (Admin/PowerShell), einmalig:

   ```http
   POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
   Content-Type: application/json

   {
     "roles": ["write"],
     "grantedToIdentities": [
       { "application": { "id": "68f89557-eef9-4481-b45c-29919ed7b55d",
                          "displayName": "KPC Montage-Apps" } }
     ]
   }
   ```
   `{siteId}` = `GET /sites/kpcfulda.sharepoint.com:/sites/Montageplanung` → Feld `id`.

Die App speichert den kompletten Plan als **eine Datei `plan.json`** in der
Standard-Dokumentbibliothek der Site (wird beim ersten Speichern automatisch angelegt).

---

## 4. Konfiguration prüfen (`cloud.js`)

Oben in `cloud.js` steht `MS_CONFIG`. Standardwerte sind bereits gesetzt:

```js
tenantId: 'cba1b1fc-4a80-4da1-a7f1-e3e4614056eb',   // KPC-Tenant
clientId: '68f89557-eef9-4481-b45c-29919ed7b55d',   // bestehende App
spHost:   'kpcfulda.sharepoint.com',
sitePath: '/sites/Montageplanung',                  // aus Schritt 3
filePath: 'plan.json',                              // Datei in der Doku-Bibliothek
```

Nur ändern, falls Site-/Dateiname abweichen.

---

## 5. Fertig – so läuft es

- App-URL öffnen → oben rechts **„Anmelden"** (Microsoft-Login).
- Danach wird `plan.json` aus SharePoint geladen; Änderungen werden automatisch
  (1,5 s nach der letzten Aktion) zurückgeschrieben. Statusanzeige rechts oben.
- **„↻ Laden"** holt den aktuellen Stand vom Server.
- Ohne Anmeldung arbeitet die App weiter **lokal** (Browser-Speicher) – als Fallback.

### Gleichzeitiges Bearbeiten
Der Plan wird als eine Datei gespeichert (optimistische Sperre per ETag). Ändert
eine zweite Person zeitgleich, meldet die App **„⚠ Konflikt – bitte ↻ Laden"**;
dann neu laden und die Änderung wiederholen. Für ein Team von wenigen Planern,
die sich grob abstimmen, ist das ausreichend. Falls später feinere Parallelität
nötig ist, lässt sich der Speicher auf eine SharePoint-**Liste pro Baustelle/Zeile**
umstellen (wie bei der Fortschrittsapp).
