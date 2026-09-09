# release-log-hub

Release-Logs als GitHub-Repos, geschrieben über einen MCP-Server, ausgeliefert
als JSON. Entwurf: `docs/superpowers/specs/2026-09-08-release-log-hub-design.md`.

Dieser Stand ist Plan 1: das Dokumentmodell und die öffentliche JSON-Fläche,
gespeist aus einem Verzeichnis statt aus GitHub.

```bash
npm test        # node --test, ohne Argument aus dem Wurzelverzeichnis
npm run typecheck
npm start       # LOGS_ROOT (Vorgabe ./logs), PORT (Vorgabe 8787)
```

| Route | Antwort |
|---|---|
| `/health` | `{"status":"ok"}` |
| `/l/<id>/versions` | Alle Versionen mit Datum, Titel und Link |
| `/l/<id>/releases?page=&per_page=` | Feed mit Anzahl je Abschnitt, höchstens 100 je Seite |
| `/l/<id>/releases/<version>` | Eine Version mit allen Einträgen |
| `/l/<id>/media/<pfad>` | Bilder, die eine Version benennt |

Ein Log ist ein Verzeichnis unter `LOGS_ROOT` mit `release-log.json`,
`releases/*.json` und `media/`. Die öffentliche Kennung steht als `id` in
`release-log.json`, nicht im Verzeichnisnamen.

`covered` erscheint in keiner Antwort: es ist Buchhaltung, kein Inhalt.
