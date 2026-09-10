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

## Index aus GitHub aufbauen

```bash
npm run reindex -- <owner>/<repo> [...]
```

Liest jedes genannte Repository über die installierte GitHub App und
schreibt seinen Log-Index in die SQLite-Datenbank (`DB_PATH`, Vorgabe
`./release-log.sqlite`). Die Werte kommen aus `.env` — das Skript liest die Datei selbst, wenn es
sie findet. `readConfig` verlangt vier Umgebungsvariablen:

| Variable | Bedeutung |
|---|---|
| `GITHUB_APP_ID` | Die App-ID der GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Ihr privater Schlüssel, PEM, base64-kodiert |
| `GITHUB_WEBHOOK_SECRET` | Das Webhook-Secret der App |
| `BASE_URL` | Die öffentliche Basis-URL des Diensts |
