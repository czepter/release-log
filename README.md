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

## Betrieb

Der Dienst gleicht sich selbst ab. Zwei Auslöser stoßen dieselbe Funktion an:

- **Webhook.** `POST /webhook`, signiert mit `GITHUB_WEBHOOK_SECRET`. Eine
  Zustellung ohne gültige Signatur wird verworfen, bevor ihr Inhalt gelesen
  wird. Der Dienst antwortet sofort mit 202; der Abgleich läuft danach.
- **Reconcile.** Alle fünf Minuten der Log mit dem ältesten `indexed_at`,
  dazu jeder Log, der länger als eine Stunde nicht erfasst wurde.
  Eingefrorene Logs sind eingeschlossen — nur so taut ein Log wieder auf,
  dessen Repository zurückkommt.

Ein verlorener Webhook kostet damit höchstens eine Reconcile-Runde. Der
Abgleich vergleicht git-Blob-SHAs, kein Ereignisprotokoll: „Webhook nie
angekommen" und „Index von Null neu bauen" sind derselbe Fall.

| Variable | Bedeutung |
|---|---|
| `DB_PATH` | Pfad der SQLite-Datei, Vorgabe `./release-log.sqlite` |
| `PORT` | Port des Dienstes, Vorgabe 8787 |
| `GITHUB_CLIENT_ID` | Client-ID der GitHub App, für die Anmeldung |
| `GITHUB_CLIENT_SECRET` | Client-Secret der GitHub App, für die Anmeldung |
| `SIGNING_KEY` | signiert das Session-Cookie |
| `ADMIN_LOGINS` | GitHub-Logins mit Adminrecht, kommagetrennt — mindestens einer ist Pflicht |

`GET /health` antwortet 200, ohne den Index anzufassen.

### Anmeldung

- `GET /auth/github/login` leitet zu GitHub weiter.
- `GET /auth/github/callback` (bei GitHub als Callback-URL hinterlegt) nimmt
  die Antwort entgegen, prüft die Zulassungsliste, setzt bei Erfolg ein
  Session-Cookie (30 Tage) und leitet auf `/me` weiter.
- `POST /auth/logout` löscht das Cookie.
- `GET /me` antwortet `{login, isAdmin}` für eine gültige Session, sonst 401.

Adminrecht kommt ausschließlich aus `ADMIN_LOGINS` — es gibt keine
Datenbankspalte dafür. Wer sonst zugelassen ist, steht in der
`allowlist`-Tabelle; ohne Dashboard (kommt in einem späteren Plan) lässt
sie sich nur von Hand füllen.

### Repo-Rechte

Ob ein Konto Schreibzugriff auf das Repository hinter einem Log hat, wird
gegen GitHub geprüft und fünf Minuten je (Konto, Log) im Cache gehalten.
Der Cache wird früher invalidiert, wenn `member`, `installation_repositories`
oder `installation` eintrifft — eine Mitgliedschafts- oder
Installationsänderung kann genau dieses Recht betreffen. Eine Übertragung
oder Löschung des Repositories (über das `repository`-Ereignis, das nur
den Inhalts-Abgleich anstößt) tut das nicht: ein gecachtes „ja" kann bis zu
fünf Minuten über ein solches Ereignis hinaus bestehen bleiben, dieselbe
Fünf-Minuten-Obergrenze wie sonst auch.
