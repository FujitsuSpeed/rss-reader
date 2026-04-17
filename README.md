# RSS Reader

Ein moderner, browserbasieter RSS/Atom Feed Reader — kein Server, kein Login, kein Build-Schritt erforderlich. Läuft vollständig im Browser.

## Features

- **Mehrere RSS- & Atom-Feeds** — beliebig viele Quellen verwalten
- **Artikel-Leseansicht** — RSS-Inhalt direkt anzeigen
- **Vollständiger Lesemodus** — lädt den kompletten Artikel von der Originalseite (Reader Mode)
- **Responsive / Mobile-First** — optimiert für Smartphone, Tablet und Desktop
- **Dark Mode** — folgt automatisch dem Systemthema, manuell umschaltbar
- **Offline-fähig** — dank Service Worker auch ohne Internetverbindung nutzbar (gecachte Artikel)
- **PWA** — als App auf dem Homescreen installierbar
- **Benachrichtigungen** — Browser-Benachrichtigungen bei neuen Artikeln (stündlich)
- **Kein Login** — alle Daten lokal im Browser (LocalStorage)
- **Kein Server** — läuft als statische GitHub Page

## Screenshot

```
┌─────────────────────────────────────────────────────────┐
│ ☰  RSS Reader                            ⟳  +            │
├──────────────┬──────────────────┬──────────────────────-─┤
│ Feeds        │ Alle Artikel  23 │ Artikel-Titel          │
│              │                  │ Feed • vor 2 Std.      │
│ 📰 Alle  23  │ ● Artikel 1      │                        │
│ 🔵 Ungelesen │   Feed • 1 Std.  │ [Reader Mode] [Link]   │
│              │                  │                        │
│ 📡 Heise 5   │   Artikel 2      │ <Artikel-Inhalt>       │
│ 📡 BBC   3   │   Feed • 3 Std.  │                        │
│ ⚙ Settings  │   ...            │                        │
└──────────────┴──────────────────┴────────────────────────┘
```

## Nutzung

### Feeds hinzufügen

1. Auf **+** in der Kopfzeile oder **+ Hinzufügen** in der Sidebar klicken
2. RSS/Atom-URL einfügen (z. B. `https://www.heise.de/rss/heise-atom.xml`)
3. Optionalen Namen vergeben
4. **Feed hinzufügen** klicken — der Feed wird sofort geladen

### Artikel lesen

- Artikel in der Liste anklicken → RSS-Inhalt wird angezeigt
- **Vollständigen Artikel laden** → lädt den kompletten Text von der Originalseite
- **Im Browser öffnen** → öffnet den Artikel im neuen Tab

### Benachrichtigungen aktivieren

1. **Einstellungen** öffnen (Zahnrad-Symbol in der Sidebar)
2. **Benachrichtigungen** aktivieren → Browser fragt nach Erlaubnis
3. Aktualisierungsintervall wählen (Standard: 1 Stunde)
4. Speichern

> Hintergrund-Benachrichtigungen funktionieren am zuverlässigsten in Chrome/Edge wenn die App als PWA installiert ist (Periodic Background Sync).

### Als PWA installieren

- **Desktop**: Klick auf das Installations-Symbol in der Adressleiste oder den ⬇ Button in der App
- **Android**: „Zum Startbildschirm hinzufügen" im Browser-Menü
- **iOS**: Safari → Teilen → „Zum Home-Bildschirm"

## Technische Details

| Aspekt | Detail |
|---|---|
| Datenspeicherung | LocalStorage (Feeds, Artikel, Einstellungen) |
| CORS-Proxy | `api.allorigins.win`, Fallback: `corsproxy.io`, `api.codetabs.com` |
| Offline-Cache | Service Worker (Cache-first für App-Shell) |
| Hintergrund-Sync | Periodic Background Sync API (Chrome/Edge) |
| Benachrichtigungen | Web Notifications API via Service Worker |
| RSS-Formate | RSS 2.0, RSS 1.0, Atom |
| Max. Artikel/Feed | 100 (älteste werden automatisch gelöscht) |

## Als GitHub Page veröffentlichen

### Automatisch (empfohlen)

Der enthaltene GitHub Actions Workflow (`.github/workflows/pages.yml`) deployed automatisch bei jedem Push auf `main`.

1. Repository auf GitHub erstellen / forken
2. **Settings → Pages → Source: GitHub Actions** aktivieren
3. Auf `main` pushen → automatisches Deployment

### Manuell

1. **Settings → Pages → Source: Deploy from a branch**
2. Branch: `main`, Ordner: `/ (root)`
3. Speichern → App ist unter `https://<username>.github.io/<repo>/` erreichbar

## Lokale Entwicklung

Da es sich um statische Dateien handelt, genügt ein einfacher HTTP-Server:

```bash
# Python
python3 -m http.server 8080

# Node.js (npx)
npx serve .

# VS Code: Live Server Extension
```

Dann im Browser: `http://localhost:8080`

> Wichtig: Direkt als `file://` öffnen funktioniert nicht wegen Service Worker Einschränkungen.

## Datenschutz

- Keine externen Dienste außer den RSS-Feeds selbst und dem CORS-Proxy
- Der CORS-Proxy (`api.allorigins.win`) leitet Anfragen weiter — Feed-URLs werden an diesen Dienst übermittelt
- Alle Einstellungen und Artikel bleiben lokal im Browser
- Keine Cookies, keine Tracker, keine Analytics

## Browser-Kompatibilität

| Browser | Unterstützung |
|---|---|
| Chrome / Edge 80+ | ✅ Vollständig inkl. Periodic Background Sync |
| Firefox 105+ | ✅ Vollständig (ohne Periodic Background Sync) |
| Safari 16.4+ | ✅ Vollständig (ohne Periodic Background Sync) |
| Samsung Internet | ✅ Weitgehend |

## Lizenz

MIT License — frei verwendbar und anpassbar.
