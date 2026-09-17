# release-log-hub

Release-Logs als GitHub-Repos, geschrieben über einen MCP-Server, ausgeliefert
als JSON. Entwurf: `docs/superpowers/specs/2026-09-08-release-log-hub-design.md`.

Dieser Stand ist Plan 1: das Dokumentmodell und die öffentliche JSON-Fläche,
gespeist aus einem Verzeichnis statt aus GitHub.

```bash
npm run dev       # Nuxt mit Fake-GitHub aus logs/demo, http://localhost:3000/api/dev/login
npm test          # node --test, ohne Argument aus dem Wurzelverzeichnis
npm run typecheck
npm run build     # Nuxt-Build nach web/.output
npm start         # der gebaute Dienst: Nuxt mit eingebettetem Kern (PORT, Vorgabe 3000)
npm run start:core  # nur der Kern ohne Oberfläche, für Tests und Maschinen-Clients
```

### Aufbau

Nuxt (`web/`) ist die einzige Oberfläche und bindet den Kern (`server.ts`,
`lib/`) im selben Prozess ein. Was Menschen sehen, rendert Nuxt; was
Maschinen sprechen, beantwortet der Kern unverändert
(`web/server/utils/corePaths.ts`):

| Kern | Nuxt |
|---|---|
| `/health`, `/webhook`, `/mcp`, `/me`, `/auth/*`, `/.well-known/*`, `/upload/*` | `/dashboard`, `/dashboard/logs/<id>`, Release-Editor, `/konto` |
| `/oauth/register`, `/oauth/token`, `POST /oauth/authorize` | `GET /oauth/authorize` (Zustimmung), `/anmeldung` |
| `/l/<id>/versions`, `/l/<id>/releases…`, `/l/<id>/media/…` | `/l/<id>`, `/l/<id>/r/<version>` |
| | `/api/*` — Seiten-API aus `lib/api/` |

Nuxt liest die Migrationen aus `MIGRATIONS_DIR` (Vorgabe `./drizzle`,
relativ zum Arbeitsverzeichnis): im gebündelten Server zeigt
`import.meta.url` nicht mehr neben `drizzle/`.

`npm run dev` setzt `RL_DEV_FAKE=1`: der Kern läuft gegen ein Fake-GitHub
aus `logs/demo`, `/api/dev/login?as=admin` meldet ohne GitHub an. Beides
existiert im Produktions-Build nicht (`import.meta.dev`).

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
| `TOKEN_ENCRYPTION_KEY` | 32 Bytes, hex- oder base64-kodiert: verschlüsselt die GitHub-Nutzer-Token (`openssl rand -hex 32`) |

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
  Session-Cookie (30 Tage) und leitet aufs Dashboard weiter. Scheitert die
  Anmeldung, geht es nach `/anmeldung?fehler=state|github|denied`.
- `POST /auth/logout` löscht das Cookie.
- `GET /me` antwortet `{login, isAdmin}` für eine gültige Session, sonst 401.
  Die Kontoseite für Menschen ist `/konto` (Nuxt).
- `GET /` leitet aufs Dashboard weiter.

Adminrecht kommt ausschließlich aus `ADMIN_LOGINS` — es gibt keine
Datenbankspalte dafür. Wer sonst zugelassen ist, steht in der
`allowlist`-Tabelle; Admins verwalten sie unter `/konto`.

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

### Dashboard

Nuxt-Seiten über der Seiten-API (`/api/*`, Sitzungs-Cookie, JSON). Die
Regeln stehen in `lib/api/`:

- `/dashboard` — die Logs, auf die das angemeldete Konto Schreibrechte hat
  (eingefrorene zusätzlich für Admins). „Neues Log" legt über denselben
  Ablauf wie `create_log` ein Repository an.
- `/dashboard/logs/<id>` — Status, Abgleichfehler, Releases, Einstellungen
  (`view`, `visibility`, `curation_notes` als Commit auf
  `release-log.json`, nie als Datenbankschreibvorgang), Medien-Upload
  (`.png`, `.jpg`, `.webp`, höchstens 10 MB, legt an, ersetzt nie) und
  endgültiges Löschen mit Eingabe des Produktnamens.
- `/dashboard/logs/<id>/releases/new`, `…/releases/<version>` — der
  Release-Editor (Editor.js): Überschrift, Absätze, ein Bild und Änderungen
  als Blöcke. Speichern committet über denselben Weg wie `write_release`
  gegen die zuletzt gelesene Blob-SHA; hat sich das Release inzwischen
  geändert, wird nichts überschrieben. Veröffentlichen und Zurückziehen
  daneben. `covered` und `commits` fasst der Editor nie an.
- `/konto` — Profil, verbundene MCP-Clients trennen, Zulassungsliste
  (Admins).

Mutierende `/api`-Aufrufe verlangen `content-type: application/json`
(Upload: `x-filename`); mit `SameSite=Lax` kann keine fremde Seite sie
auslösen.

### MCP und OAuth

Ein eigener OAuth-2.0-Autorisierungsserver (spec §5, "Rolle 2") schützt `/mcp`:

- `POST /oauth/register` — Dynamic Client Registration (RFC 7591), nur
  öffentliche Clients (kein Secret, PKCE `S256` ist Pflicht).
- `GET /oauth/authorize` — Zustimmungsbildschirm (Nuxt), `POST` löst die
  Entscheidung im Kern ein. Beide prüfen über `lib/oauthRequest.ts`.
- `POST /oauth/token` — `authorization_code`- und `refresh_token`-Grant.
- `GET /.well-known/oauth-protected-resource/mcp`,
  `GET /.well-known/oauth-authorization-server` — Metadaten (RFC 9728/8414).
- Verbundene Clients ansehen und trennen: `/konto`.
- `POST /mcp` — die eigentliche MCP-Fläche, Streamable HTTP, Bearer-Token
  Pflicht: `list_logs`, `get_log`, `get_release` (Scope `logs:read`),
  `create_log`, `write_release`, `publish_release`, `unpublish_release`,
  `add_media` (Scope `logs:write`).
- `PUT /upload/<token>` — der Bildweg von `add_media`. Das Token in der URL
  ist der ganze Ausweis: einmalig, zehn Minuten gültig, an Log, Zielpfad und
  Konto gebunden. Die Route prüft beim Hochladen erneut, ob dieses Konto
  noch schreiben darf, begrenzt auf 10 MB und legt die Datei an, statt eine
  bestehende zu ersetzen (`path_exists`, sonst änderte ein neues Bild
  stillschweigend jedes veröffentlichte Release, das darauf zeigt).

So berühren Bilddaten den Kontext des Agenten nie — 5 MB ergäben als Base64
rund 6,7 MB Text.

### Repos anlegen und das GitHub-Nutzer-Token

`create_log` ist der einzige Weg dieses Diensts, der nicht über das
Installations-Token läuft: `POST /user/repos` gibt es nur für Nutzer-Token.
Der Dienst hält deshalb je Konto das Nutzer-Token aus der Anmeldung
vor — **verschlüsselt** mit `TOKEN_ENCRYPTION_KEY`, nicht gehasht, weil es
benutzt und nicht nur geprüft wird. Es ist damit das einzige Geheimnis im
System, das ein Datenbankdiebstahl brauchbar erbeutet.

- Ein Refresh widerruft das alte Access-Token sofort, also ersetzt sein
  Ergebnis beide Token in einem Schreibvorgang.
- Refreshes laufen je Konto serialisiert: zwei gleichzeitige widerrufen
  einander.
- Scheitert der Refresh, antwortet `create_log` mit `reauth_required` und
  nennt die Anmelde-URL. Der Mensch meldet sich einmal neu an.

Angelegt wird mit dem Nutzer-Token, geschrieben wird mit dem
Installations-Token: erst das Repo, dann die Erreichbarkeitsprüfung
(`repo_not_installed`, wenn die App das frische Repo nicht sieht), dann
`release-log.json` und `README.md`, dann der Abgleich. Die Antwort kommt
erst, wenn der Log im Index steht.

### Gehostete Seite

- `/l/<id>` — Nuxt, serverseitig gerendert als Zeitstrahl: Version und
  Datum links, Abschnitte (Wichtig, Neu, Änderungen, Behoben) zum
  Aufklappen. `timeline` öffnet je Release den ersten Abschnitt, `full`
  alle. Entwürfe nur für Angemeldete mit Schreibrecht; private Logs tragen
  `noindex` und antworten allen anderen wie ein fehlender Log mit 404.
- `/l/<id>/r/<version>` — Permalink auf eine einzelne Version.

Der öffentliche JSON-Feed (`/l/<id>/versions`, `/l/<id>/releases`, ...) und
der Medien-Download bleiben im Kern.
