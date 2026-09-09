# Release-Log-Hub — Design

Stand: 2026-09-08 (Fassung 2, nach der Befragung)

## 1. Zweck und Publikum

Ein gehosteter Dienst, mit dem ein Team seinen Release-Log als GitHub-Repo
führt und über einen MCP-Server aus Claude Code, Codex oder pi heraus
schreibt, aktualisiert und veröffentlicht. Der Log wird über eine öffentliche
URL als JSON eingebunden und liegt zusätzlich als lesbare Seite vor.

Vorbild für Datenformat und Ton ist `client-management-portal/release-log`.
Übernommen wird von dort das **Datenformat** und der Kurationsgedanke —
Rohstoff aus Commits ist nie das Ergebnis. Nicht übernommen wird seine
Architektur: das Vorbild ist ein statischer JSON-Diener ohne Abhängigkeiten,
dieser Dienst ist ein OAuth-Server mit mehreren Mandanten. Der Generator
`bin/from-git.mjs` entfällt und wird durch den Agenten ersetzt, der ohnehin
im Produkt-Repo arbeitet und dort Diffs und PR-Text sieht.

**Publikum ist ein geschlossener Kreis:** der Betreiber und namentlich
zugelassene Teams. Anmeldung setzt einen Eintrag in der Zulassungsliste
voraus. Damit entfallen Kontingente, Missbrauchsabwehr und Rechnungswesen;
der Weg zu einem offenen Dienst bleibt offen, wird aber heute nicht bezahlt.

### Abgrenzung

Der Dienst kennt das Produkt-Repo nicht. Er kennt ausschließlich das
Log-Repo. Alles, was aus Commits Themen macht, geschieht im Agenten.

## 2. Entscheidungen

| # | Entscheidung | Begründung |
|---|---|---|
| 1 | Das GitHub-Repo ist die Quelle der Wahrheit; die App hält einen materialisierten Lese-Index | Git-Historie ist die echte Historie. Handedits und PRs zählen gleichberechtigt. Der öffentliche Request-Pfad hängt nicht an GitHubs Verfügbarkeit |
| 2 | Eine GitHub App leistet Anmeldung und Repo-Zugriff; die Repos gehören dem Nutzer | Fine-grained auf ausgewählte Repos statt `repo`-Scope auf alles. Installations-Token überleben Personalwechsel. Private Repos möglich. **Eingeschränkt durch 23** |
| 3 | Den Rohstoff liefert der Agent; die App liest kein Produkt-Repo | Der Agent sieht Diffs und PR-Text, ein Server sieht Betreffzeilen |
| 4 | Veröffentlichen ist ein Feld: `published_at` | Ein Commit, ein Ref, eine Datei. Idempotent, und beantwortet die Frage, die eine Timeline stellt |
| 5 | Eingebunden wird JSON; zusätzlich gibt es eine gehostete Ansichtsseite | Wer einbindet, rendert selbst. Die Ansichtseinstellung steuert nur die gehostete Seite |
| 6 | Der Kurations-Skill reist im MCP-Server mit (`instructions` plus Prompt) | Der Agent arbeitet im Produkt-Repo; ein Skill im Log-Repo läge am falschen Ort |
| 7 | Ein Dienst, Write-Through über eine einzige Abgleichfunktion | Das Repo ist bei Uneinigkeit immer der Schiedsrichter; der Index ist jederzeit wegwerfbar |
| 8 | Publikum ist ein geschlossener Kreis mit Zulassungsliste | Der Sprung von „nur ich" zu „bekannte Teams" ist eine Tabelle; der zu „jeder" ist Arbeit, die nichts mit Release-Logs zu tun hat |
| 9 | `version` ist Pflicht, aber ein **undurchsichtiger Bezeichner** | `2026-09-08` wird damit eine gültige Version. Deckt versionierte und datumsgetriebene Logs ab, ohne einen zweiten Codepfad |
| 10 | Ein Repo trägt genau einen Log | Repos sind gratis, Sonderfälle in Pfadauflösung und Webhook-Zuordnung nicht |
| 11 | `breaking` ist ein **Merkmal**, kein vierter Typ | `type` sagt, was die Änderung ist; `breaking`, was sie dem Leser abverlangt. Die meisten brechenden Änderungen sind Neuerungen |
| 12 | Medien laufen über eine **signierte Upload-URL** | Base64 durch den Agenten-Kontext ist bei Bildgrößen um Größenordnungen unmöglich |
| 13 | Gelöschtes Repo friert den Log ein; Löschen ist ein ausdrücklicher Schritt | Eine eingebundene URL darf nicht als Nebeneffekt einer Aufräumaktion sterben |
| 14 | Wer Schreibrechte am Repo hat, erreicht den Log — **GitHub entscheidet** | Das Repo ist die Wahrheit, also sollen es auch seine Rechte sein. Ein zweites Rechtemodell weicht binnen eines Jahres ab |
| 15 | Zulassung über Tabelle plus Admin-Oberfläche, erster Admin aus der Umgebung | Löst das Henne-Ei-Problem ohne Seed-Skript und hält ein ausgesperrtes System erreichbar |
| 16 | Rechteprüfung 5 Minuten gecacht, Invalidierung per Event | Jedes Mal zu fragen macht GitHubs Verfügbarkeit zur eigenen; für die Token-Laufzeit zu glauben, lässt entzogene Schreibrechte einen Monat weiterlaufen |
| 17 | Sortierung nach `date` absteigend, Gleichstand über den Zahlen-Vergleicher | Folgt aus 9. `sort_key` entfällt ersatzlos, sortiert wird in JavaScript |
| 18 | Ein neutraler Look für alle Logs | Akzentfarbe und Logo sind später zwei Felder; fremdes CSS auszuliefern ist eine Angriffsfläche |
| 19 | TypeScript, `better-sqlite3` mit Drizzle, kein Framework, **kein Build-Schritt** | Folgt den Werkzeugen des Bestands. Node 24 entfernt Typen zur Laufzeit, also Typen ohne Artefakt |
| 20 | OAuth wird aus `umami-mcp/src/oauth-core.ts` übernommen und angepasst | 339 Zeilen zu kopieren ist billiger als drei Laufzeiten an ein gemeinsames Paket zu koppeln |
| 21 | Railpack auf Coolify unter `release-log.czpt.de` | Einprozess-Dienst ohne Build, dieselbe Gattung wie das Vorbild |
| 22 | Ein Spike zur GitHub App geht dem Implementierungsplan voraus | Einziger Teil ohne Vorerfahrung im Bestand; die Annahmen tragen die halbe Bauabfolge |
| 23 | Für `create_log` hält die App ein verschlüsseltes GitHub-Nutzer-Token vor | `POST /user/repos` akzeptiert laut GitHubs Referenz **nur** Nutzer-Token. Ohne dies könnte MCP auf persönlichen Konten keine Repos anlegen. Preis: weicht 2 auf — ein Angriffsziel mehr, personengebunden. Abgefedert durch Verschlüsselung im Ruhezustand und ablaufende Token mit Refresh |

## 3. Repo-Format

Das Log-Repo erklärt sich selbst. Ohne diese Eigenschaft wäre der Index doch
die Wahrheit, weil ein Neubau die Logs nicht wiedererkennen könnte.

```
release-log.json          Konfiguration des Logs
releases/<version>.json   ein Release je Datei
media/<datei>             Bilder
README.md                 was das ist und wie man es von Hand bearbeitet
```

### `release-log.json`

```json
{
  "id": "k7m2q9xw4p1a",
  "product": "Auri CRM",
  "view": "full",
  "visibility": "public",
  "curation_notes": null
}
```

| Feld | Werte | Bedeutung |
|---|---|---|
| `id` | 12 Zeichen Crockford-Base32 | Öffentliche Kennung aus einem CSPRNG. Beim Anlegen vergeben, nie geändert |
| `product` | Text | Name, der im JSON und auf der Seite steht |
| `view` | `full` \| `timeline` | Darstellung der gehosteten Seite. Ohne Wirkung auf das JSON |
| `visibility` | `public` \| `private` | Sichtbarkeit der Log-Seite und der JSON-Routen. **Nicht** die Sichtbarkeit des GitHub-Repos |
| `curation_notes` | Text oder `null` | Produktspezifische Kurationsregeln. Wird den MCP-Instructions angehängt |

`visibility` und die GitHub-Sichtbarkeit sind unabhängig. Ein privates Repo
kann einen öffentlichen Log tragen — die App liest über das
Installations-Token. Die beiden zu verwechseln wäre die naheliegendste
Datenpanne dieses Produkts, deshalb heißen sie verschieden und stehen an
verschiedenen Stellen.

### `releases/<version>.json`

Das Format des Vorbilds, um `published_at` und `breaking` erweitert.

```json
{
  "version": "0.9.2",
  "tag": "v0.9.2",
  "date": "2026-09-08",
  "published_at": "2026-09-08T14:22:00Z",
  "commits": 4,
  "headline": "Galerie-Einstellungen an einer Stelle",
  "body": ["…"],
  "image": { "src": "media/0.9.2-galerien.png", "alt": "…" },
  "covered": ["b9871b32", "dd9875c9"],
  "changes": [
    {
      "type": "feat",
      "breaking": false,
      "scope": "gallery",
      "title": "…",
      "description": "…",
      "pr": null,
      "issues": [],
      "commit": "b9871b32",
      "date": "2026-09-08"
    }
  ]
}
```

| Feld | Regel |
|---|---|
| `version` | Pflicht, muss dem Dateinamen entsprechen. **Undurchsichtiger Bezeichner** — `1.2.0`, `2026-09-08` und `r42` sind gleichermaßen gültig |
| `tag` | Text oder `null` |
| `date` | Pflicht, `YYYY-MM-DD`. Trägt die Sortierung |
| `published_at` | ISO-8601 in UTC oder `null`. `null` heißt Entwurf |
| `commits` | Ganzzahl ≥ 0 |
| `headline` | Pflicht, nicht leer |
| `body` | Liste von Absätzen, darf leer sein |
| `image` | Objekt mit `src` und `alt`, oder `null`. `src` ist **repo-relativ** |
| `covered` | Liste von Commit-SHAs. Buchhaltung des Agenten, nie von Hand |
| `changes` | Liste; siehe unten |

Ein Eintrag in `changes`:

| Feld | Regel |
|---|---|
| `type` | `feat`, `perf` oder `fix` |
| `breaking` | Boolean, Vorgabe `false`. Die Handlungsanweisung steht in `description`, nicht in einem eigenen Feld |
| `scope` | Text oder `null` |
| `title` | Pflicht |
| `description` | Pflicht, mehrere Absätze |
| `pr` | Zahl oder `null` |
| `issues` | Liste von Zahlen |
| `commit` | Text |
| `date` | `YYYY-MM-DD` |

`image.src` ist repo-relativ, anders als im Vorbild (`/media/…`). Ein
absoluter Pfad bindet die Datei an genau einen Host; die App setzt beim
Ausliefern `/l/<id>/media/…` davor. Das Repo bleibt damit für sich genommen
sinnvoll — bei „Repo = Wahrheit" ist das der Maßstab.

### Doppelte IDs

Zwei Repos können dieselbe `id` beanspruchen, etwa nach einem Fork. Der Index
vergibt sie nach dem Prinzip *wer zuerst da war*: das zweite Repo wird nicht
indiziert, und das Dashboard nennt beide Repos und die betroffene ID.

## 4. Index und Abgleich

### Eine Abgleichfunktion, drei Auslöser

`syncLog(log)` ist die einzige Stelle, die den Index verändert. Sie wird nach
einem MCP-Schreibzugriff aufgerufen, vom Webhook, und vom Reconcile-Intervall.

```
syncLog(log):
  tree = GET /repos/{owner}/{repo}/git/trees/{HEAD}?recursive=1
  vergleiche Pfad -> blob_sha aus dem Baum gegen den Index
  hole nur die Blobs, deren sha sich geändert hat
  validiere über lib/document.ts, schreibe Zeilen
  lösche Zeilen zu Pfaden, die es im Baum nicht mehr gibt
  setze log.head_sha und log.indexed_at
```

Der Vergleich läuft über git-Blob-SHAs statt über Commits. Damit sind
MCP-Schreibzugriff, Handedit, gemergter PR und Force-Push derselbe Fall. Auch
„Webhook nie angekommen" und „Index von Null neu bauen" sind kein Sonderfall:
ein leerer Index ist ein Baum, in dem sich alles geändert hat. Kosten pro Lauf:
ein Aufruf für den Baum plus je einer für die tatsächlich geänderten Dateien.

Der Ansatz ist ein Zustandsvergleich, keine Ereignisverarbeitung.
Ereignisverarbeitung braucht lückenlose Zustellung; ein Zustandsvergleich
braucht nur irgendwann einen Anstoß. Deshalb darf der Webhook unzuverlässig
sein, ohne dass Korrektheit daran hängt.

### Schema

Drizzle über `better-sqlite3`; Migrationen mit `drizzle-kit`.

| Tabelle | Spalten |
|---|---|
| `account` | `github_user_id` (PK), `login`, `avatar_url`, `last_seen_at` |
| `allowlist` | `github_login` (PK), `added_by`, `added_at`, `note` |
| `installation` | `installation_id` (PK), `target_login`, `target_type`, `state` (`active`\|`suspended`\|`removed`), `updated_at` |
| `log` | `public_id` (PK), `repo_owner`, `repo_name`, `repo_node_id`, `installation_id`, `product`, `view`, `visibility`, `curation_notes`, `state` (`active`\|`frozen`), `head_sha`, `config_blob_sha`, `indexed_at` |
| `release` | `log_id`, `version`, `date`, `published_at`, `blob_sha`, `doc` (JSON-Text); PK (`log_id`, `version`) |
| `media` | `log_id`, `path`, `blob_sha`, `content_type`, `bytes`; PK (`log_id`, `path`) |
| `sync_error` | `log_id`, `path`, `message`, `at` |
| `repo_permission` | `account_id`, `log_id`, `can_write`, `checked_at`; PK (`account_id`, `log_id`) |
| `github_user_token` | `account_id` (PK), `access_token_enc`, `refresh_token_enc`, `expires_at`, `refreshed_at`. **Verschlüsselt**, nicht gehasht — es wird benutzt, nicht geprüft. Nur für `POST /user/repos` |
| `upload_token` | `token_hash` (PK), `log_id`, `path`, `account_id`, `max_bytes`, `expires_at`, `used_at` |
| `oauth_client` | `client_id` (PK), `client_name`, `redirect_uris` (JSON), `created_at` |
| `oauth_grant` | `account_id`, `client_id`, `scopes`, `granted_at`; PK (`account_id`, `client_id`). Dient der Anzeige verbundener Clients und dem Widerruf — **nicht** dazu, die Zustimmung zu überspringen |
| `oauth_token` | `token_hash` (PK), `kind` (`access`\|`refresh`), `account_id`, `client_id`, `scopes`, `expires_at`, `revoked_at` |

`release.doc` hält das vollständige validierte Dokument. Eigene Spalten
bekommt nur, wonach sortiert oder gefiltert wird. Der Index ist ein
Lesemodell, keine normalisierte Domäne.

`repo_node_id` hält GitHubs unveränderliche Repo-Kennung. Sie überlebt
Umbenennen und Transfer und ist damit der verlässliche Anker, wenn ein Event
mit neuem Namen eintrifft.

Eindeutigkeit über (`repo_owner`, `repo_name`) verhindert, dass dasselbe Repo
zweimal als Log geführt wird.

### Sortierung

Da `version` ein undurchsichtiger Bezeichner ist, trägt `date` die
Sortierung: absteigend, bei Gleichstand absteigend über
`Intl.Collator(undefined, { numeric: true })` auf `version` — den Vergleicher
des Vorbilds, sodass `0.9.10` weiterhin vor `0.9.2` steht.

Sortiert wird in JavaScript, nicht in SQL. Ein Log hat Dutzende Releases,
nicht Millionen; dafür eine `sort_key`-Spalte zu pflegen wäre Aufwand ohne
Abnehmer. `latest` ist der erste Eintrag dieser Reihenfolge unter den
veröffentlichten.

Ausdrücklich **nicht** nach `published_at`: ein nachgetragenes Release gehört
dorthin, wo sein `date` es hinstellt, nicht ans obere Ende.

### Medien

Medien liegen mit Bytes im Index, adressiert über ihre Blob-SHA. Eine
Blob-SHA identifiziert unveränderlichen Inhalt, also ist die Auslieferung mit
langem Cache und ETag korrekt, und private Repos brauchen beim Ausliefern
keinen Sonderweg. Erlaubt sind `.png`, `.jpg`, `.webp`; Dateien über 10 MB
werden nicht indiziert und erscheinen als `sync_error`.

### Reconcile

Ein Intervall nimmt alle 5 Minuten den Log mit dem ältesten `indexed_at` und
gleicht ihn ab; zusätzlich wird jeder Log mindestens stündlich erfasst. Der
Webhook sorgt für Sofortigkeit, das Intervall dafür, dass ein verlorener
Webhook höchstens eine Runde kostet statt für immer zu driften.

Logs im Zustand `frozen` werden übersprungen.

## 5. Identität, Rechte und OAuth

Zwei getrennte OAuth-Rollen liegen nebeneinander. Verwechslungen zwischen
ihnen sind die Fehlerklasse, die man später nicht mehr sieht.

### Zulassung

Anmelden darf nur, wessen GitHub-Login in `allowlist` steht. Wer nicht darin
steht, bekommt nach der GitHub-Anmeldung eine Seite, die das sagt, und keine
Session.

`ADMIN_LOGINS` aus der Umgebung nennt die Logins mit Adminrecht; alles
Weitere wird in der Oberfläche gepflegt. Das löst das Henne-Ei-Problem ohne
Seed-Skript und hält ein ausgesperrtes System über eine Umgebungsvariable
erreichbar.

Adminrecht ist ausschließlich Zulassung. Es gewährt **keinen** Blick in fremde
Logs — die hängen an den Repo-Rechten.

### Wer erreicht welchen Log

Wer Schreibrechte auf das Repo hat, erreicht den Log. Geprüft wird gegen
GitHub, das Ergebnis liegt 5 Minuten in `repo_permission`.

Das Repo ist die Wahrheit, also sind es auch seine Rechte. Jedes eigene
Rechtemodell würde binnen eines Jahres von GitHubs abweichen, und dann gäbe
es zwei Antworten auf „darf der das".

Sofort invalidiert wird der Cache bei den Events `installation_repositories`
und `member`. Öffentliche Log-Seiten brauchen gar keine Prüfung.

### Rolle 1: die App als OAuth-Client gegenüber GitHub

Eine einzige GitHub App leistet beides.

**Anmeldung** über den User-to-Server-Flow. Der Nutzer meldet sich bei GitHub
an, nicht bei uns. Aus der Antwort entsteht eine Session als signiertes
Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, Laufzeit 30 Tage.

**Repo-Zugriff** über Installations-Token. Die App signiert ein kurzlebiges
JWT mit ihrem privaten Schlüssel, tauscht es gegen ein Installations-Token
und verwirft das JWT. Installations-Token laufen nach einer Stunde ab und
werden **nie persistiert** — sie werden bei Bedarf geholt und im Speicher
gehalten, bis sie ablaufen.

Repo-Zugriff hängt damit an der Installation, nicht an einer Person. Verlässt
jemand das Team, laufen Index und öffentliche Seite weiter.

**Ausnahme: Repos anlegen.** GitHubs Berechtigungsreferenz führt
`POST /orgs/{org}/repos` für Installations- und Nutzer-Token, `POST /user/repos`
dagegen **nur für Nutzer-Token**. Da die Log-Repos auf einem persönlichen Konto
liegen, kann `create_log` nicht über das Installations-Token laufen.

Die App hält deshalb je Konto ein GitHub-Nutzer-Token vor, **verschlüsselt** im
Ruhezustand mit `TOKEN_ENCRYPTION_KEY` — nicht gehasht, weil es benutzt und
nicht nur geprüft wird. Die Einstellung „Expire user authorization tokens"
bleibt aktiv: gespeichert wird ein kurzlebiges Token samt Refresh-Token statt
eines unbefristeten. Benutzt wird es **ausschließlich** für `POST /user/repos`;
jeder andere Repo-Zugriff läuft weiter über die Installation.

Im Spike gemessen: das Access-Token gilt **8 Stunden**, das Refresh-Token
**181 Tage**. Zwischen zwei Releases liegt regelmäßig mehr als acht Stunden,
also ist der Refresh der Normalfall und nicht die Ausnahme.

Ein Refresh **widerruft das alte Access-Token sofort**. Daraus folgen zwei
Anforderungen, die man dem Ablauf nicht ansieht:

- Das Ergebnis eines Refresh ersetzt beide Token **in einem Schreibvorgang**.
  Ein halb geschriebener Datensatz lässt das alte Token widerrufen und das
  neue ungespeichert zurück — das Konto wäre ausgesperrt.
- Refreshes laufen **je Konto serialisiert**. Zwei gleichzeitige Refreshes
  widerrufen einander: der zweite entwertet das Token, das der erste gerade
  bekommen hat. Genau das passiert nach einer längeren Pause, wenn mehrere
  Aufrufe zugleich eintreffen — der wahrscheinlichste Moment, nicht der
  unwahrscheinlichste.

Das weicht die Begründung von Entscheidung 2 auf, und das soll hier stehen: ein
gespeichertes Nutzer-Token ist ein Angriffsziel, das der Entwurf vorher nicht
hatte, und es geht mit der Person. Ist es abgelaufen und der Refresh
abgewiesen, scheitert `create_log` mit `reauth_required` — der Mensch meldet
sich einmal neu an. Kein anderer Weg des Dienstes bricht dadurch.

Berechtigungen der GitHub App: `contents: write`, `metadata: read`,
`administration: write` (Repos anlegen).

Abonniert werden genau drei Events: `push`, `repository`, `member`.
`installation`, `installation_repositories` und `github_app_authorization`
bekommt jede GitHub App automatisch — sie stehen nicht in der Auswahl und
lassen sich nicht abbestellen. Wer sie dort sucht, sucht vergeblich.

### Rolle 2: die App als Authorization Server gegenüber Agent-Clients

Grundlage ist `umami-mcp/src/oauth-core.ts`, hereinkopiert und angepasst: an
GitHub als Upstream-Identität, an unsere Audience-Bindung und an das Schema
oben. Ein gemeinsames Paket über die drei bestehenden Projekte hinweg wäre
die falsche Naht — sie laufen auf Nitro, Laravel und Node und würden
einander an ihre Freigaben binden.

| Endpunkt | Zweck |
|---|---|
| `/.well-known/oauth-protected-resource` | nennt den zuständigen Authorization Server (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Metadaten: Endpunkte, unterstützte Verfahren (RFC 8414) |
| `/oauth/register` | Dynamic Client Registration (RFC 7591) |
| `/oauth/authorize` | Zustimmung, danach Authorization Code |
| `/oauth/token` | Code gegen Token, Refresh |
| `/mcp` | die geschützte Ressource, Streamable HTTP |

Ablauf: Der Client ruft `/mcp` und bekommt `401` mit `WWW-Authenticate`, das
auf die Metadaten zeigt. Er registriert sich selbst, schickt den Nutzer zu
`/oauth/authorize`. Dort greift die bestehende Web-Session, oder es geht
zuerst durch die GitHub-Anmeldung. Danach ein Zustimmungsbildschirm, der
Client, Scopes und betroffene Logs benennt, dann zurück mit Code.

### Festlegungen

- **PKCE mit `S256` ist Pflicht.** Ein Autorisierungsversuch ohne
  Code-Challenge wird abgelehnt.
- **Authorization Codes** sind einmalig, 60 Sekunden gültig und an Client,
  Redirect-URI und Code-Challenge gebunden. Eine zweite Einlösung widerruft
  alle aus diesem Code entstandenen Token.
- **Redirect-URIs werden exakt geprüft.** Ausnahme sind Loopback-Adressen
  lokaler Clients, bei denen der Port variiert; dort wird alles außer dem
  Port exakt geprüft (RFC 8252).
- **Der Zustimmungsbildschirm wird bei selbstregistrierten Clients nie
  übersprungen**, auch bei erneuter Verbindung desselben Nutzers. Dynamic
  Client Registration streicht das Vertrauenssignal, das eine vorab geprüfte
  Client-ID war: sie sagt nur noch, dass jemand ein Formular ausgefüllt hat.
  Das verbliebene Vertrauen kommt vom Menschen, der liest, was er verbindet.
- **Unsere Token sind keine GitHub-Token.** Ein MCP-Client bekommt nie ein
  GitHub-Token zu sehen, und ein GitHub-Token wird nie als MCP-Token
  akzeptiert. Unsere Access-Token tragen als Audience unseren eigenen
  MCP-Endpunkt und werden gegen ihn geprüft. Token-Weiterreichung ist damit
  ausgeschlossen.
- **Unsere Token liegen nur als SHA-256-Hash in der Datenbank.** Was
  gespeichert wird, reicht zum Prüfen und nicht zum Benutzen. Einzige
  Ausnahme ist das GitHub-Nutzer-Token aus 23: es wird benutzt, nicht geprüft,
  liegt also verschlüsselt statt gehasht — und ist damit das einzige
  Geheimnis im System, das ein Datenbankdiebstahl brauchbar erbeutet.
- **Laufzeiten:** Access-Token 1 Stunde, Refresh-Token 30 Tage mit Rotation.
  Ein zweimal benutztes Refresh-Token widerruft die ganze Kette.
- **Zwei Scopes:** `logs:read` und `logs:write`.
- **Widerruf** im Dashboard je Client, wirksam beim nächsten Aufruf.
- **Webhook-Signaturen werden geprüft**, HMAC-SHA-256 gegen das Secret der
  App, Vergleich zeitkonstant. Eine Anfrage ohne gültige Signatur wird
  verworfen, bevor ihr Inhalt gelesen wird. Ein Webhook ist ein öffentlich
  erreichbarer Endpunkt, der Schreiboperationen anstößt.
- **Ratenbegrenzung:** `/oauth/register` 10 Anfragen je IP und Stunde,
  `/oauth/token` 60 je IP und Minute.
- **Secrets** kommen aus der Umgebung und stehen nie im Repo.

## 6. MCP-Fläche

Transport ist Streamable HTTP unter `/mcp`. Webhooks richtet kein Tool ein:
eine GitHub App bekommt die Events ihrer Installationen von selbst.

### Tools

| Tool | Scope | Eingabe | Tut |
|---|---|---|---|
| `list_logs` | read | — | Logs dieses Zugangs: ID, Repo, Produkt, letzte Version |
| `create_log` | write | `repo_name`, `owner`, `product`, `view?`, `visibility?` | Legt Repo und `release-log.json` mit frischer `id` an, indiziert es, liefert ID und URL |
| `get_log` | read | `log_id` | Konfiguration, alle Versionen mit Stand, `covered` der jüngsten |
| `get_release` | read | `log_id`, `version` | Ganzes Dokument plus `blob_sha` |
| `write_release` | write | `log_id`, `version`, `document`, `base_blob_sha?` | Legt an oder ersetzt, committet; liefert Commit-SHA und Permalink |
| `publish_release` | write | `log_id`, `version` | Setzt `published_at` auf jetzt |
| `unpublish_release` | write | `log_id`, `version` | Setzt `published_at` auf `null` |
| `add_media` | write | `log_id`, `path` | Liefert eine signierte Upload-URL; siehe unten |

`create_log` braucht zweierlei: eine bestehende Installation auf dem
Ziel-Account und ein gültiges GitHub-Nutzer-Token des aufrufenden Kontos. Fehlt
die Installation, scheitert der Aufruf mit `no_installation` und liefert die
Installations-URL zurück. Ist das Nutzer-Token abgelaufen und der Refresh
abgewiesen, scheitert er mit `reauth_required` und liefert die Anmelde-URL.
Beide Male reicht der Agent die URL an den Menschen weiter, der sie einmal
öffnet; danach läuft das Anlegen ohne Browser.

Das Nutzer-Token wird ausschließlich für `POST /user/repos` benutzt. Alles
Weitere am neuen Repo — die erste `release-log.json`, die `README.md`, der
Abgleich — läuft über das Installations-Token.

Bei einer Installation mit `repository_selection=all` sieht das
Installations-Token das frisch angelegte Repo sofort; das ist im Spike
bestätigt. Für `repository_selection=selected` ist es **nicht geprüft** und
vermutlich nicht der Fall — ein neu angelegtes Repo gehört dann noch nicht zur
Auswahl. `create_log` prüft deshalb nach dem Anlegen, ob das
Installations-Token das Repo erreicht, und scheitert andernfalls mit
`repo_not_installed` samt der URL, unter der man es zur Installation
hinzufügt. Blind weiterzuschreiben ergäbe sonst einen Log, den der Index nie
zu sehen bekommt.

`view`, `visibility` und `curation_notes` ändert nur das Dashboard. Sie sind
Einstellungen, die ein Mensch trifft und ansieht.

### Medien-Upload

`add_media` liefert `{ upload_url, expires_at, max_bytes }`. Der Agent lädt
die Bytes per `PUT` direkt dorthin; der Endpunkt prüft Typ und Größe,
committet ins Repo und stößt den Abgleich an. Das Upload-Token ist einmalig,
10 Minuten gültig und an Log, Zielpfad und Konto gebunden. Grenze 10 MB.

Damit berühren die Bytes den Kontext des Agenten nie. Base64 durch den
Kontext zu schicken wäre bei Bildgrößen um Größenordnungen unmöglich — 5 MB
ergeben rund 6,7 MB Text.

Existiert der Zielpfad bereits, scheitert der Aufruf mit `path_exists`. Ein
überschriebenes Bild würde stillschweigend jedes bereits veröffentlichte
Release ändern, das darauf zeigt.

Wo ein Client nicht per `PUT` hochladen kann, bleibt der Dashboard-Upload.

### Nebenläufigkeit

`write_release` verlangt `base_blob_sha`, sobald die Version existiert.
Blindes Überschreiben wird abgelehnt. Stimmt die SHA nicht, kommt `conflict`
mit aktueller SHA und aktuellem Dokument zurück, damit der Agent
zusammenführen kann statt zu raten. Mensch im Repo und Agent über MCP sind
damit gleichberechtigte Schreiber, und wer zuletzt kommt, merkt es.

### Validierung

`write_release` validiert über dieselbe Funktion wie der Index
(`lib/document.ts`). Ein Dokument, das der Index verwerfen würde, erreicht
das Repo nicht; der Fehler kommt als `invalid_document` mit den konkreten
Feldern zurück, während der Agent noch am Zug ist. Zwei Validatoren würden
auseinanderlaufen und genau das Loch lassen, durch das kaputte Dateien ins
Repo rutschen.

### Fehler

`conflict`, `invalid_document`, `installation_inactive`, `no_installation`,
`reauth_required`, `repo_not_installed`, `log_frozen`, `path_exists`,
`not_found`, `forbidden`, `payload_too_large`, `github_unavailable`. Jeder trägt eine Meldung, die sagt, was als Nächstes zu
tun ist.

### Instructions und Prompt

Die `instructions` des Servers tragen den Kurationsteil des Vorbild-Skills:

- Rohstoff ist nie Ergebnis. Ein Release ist fertig, wenn kein Eintrag mehr
  wie eine Commit-Nachricht liest.
- Ein Eintrag ist ein Thema, kein Commit. 15 Commits werden zu drei bis fünf
  Themen.
- Der Lesertest: ein Satz bleibt, wenn der Leser das auf seinem Bildschirm
  bemerken kann. Klassennamen, Tabellen, Spalten, Framework- und Paketnamen
  fallen raus; sichtbar gewordene technische Aussagen bleiben.
- `title` ist ein Substantivstück, kein Imperativ, keine Route, kein
  Ticketkürzel. `description` sind mehrere Absätze: was jetzt geht, warum es
  so entschieden wurde, was nebenbei behoben wurde.
- `headline` benennt, sie bewertet nicht. `body` nennt Richtungen des
  Release, statt die Einträge nachzuerzählen.
- Typen: `feat` → Neu, `perf` → Änderungen, `fix` → Behoben.
- `breaking: true` setzen, wenn der Leser handeln muss. Die Handlungsanweisung
  gehört in `description`.
- `covered` nie von Hand anfassen.

Der Ablauf, den die Instructions beschreiben:

1. `list_logs`, dann `get_log` — liefert jüngste Version und deren `covered`
2. Der Agent liest lokal `git log` ab diesen Commits. Das ist die Stelle, an
   der im Vorbild `bin/from-git.mjs` stand
3. Verwandte Commits zu Themen bündeln, Prosa schreiben
4. `write_release` mit `published_at: null` — ein Entwurf
5. Der Mensch liest den Permalink, den der Aufruf zurückgibt
6. `publish_release`

`covered` bleibt Buchhaltung und bleibt nichts, was ein Mensch anfasst — nur
schreibt sie jetzt der Agent. Sie ist zugleich der Zustand, der den Ablauf
zwischen Sitzungen wiederaufnehmbar macht: ein Agent hat kein Gedächtnis,
„wo war ich stehengeblieben" muss aus den Daten kommen.

Dazu ein MCP-Prompt `release-kuratieren`, der den Ablauf anstößt.

Produktspezifische Regeln stehen in `curation_notes` des jeweiligen Logs und
werden den Instructions angehängt.

## 7. Öffentliche Fläche

### JSON

| Route | Antwort |
|---|---|
| `/l/<id>/versions` | `product`, `latest`, alle Versionen mit `version`, `date`, `headline`, `url` |
| `/l/<id>/releases?page=&per_page=` | Feed mit Anzahl je Abschnitt; `per_page` Vorgabe 10, höchstens 100 |
| `/l/<id>/releases/<version>` | Eine Version mit allen Einträgen |
| `/l/<id>/media/<datei>` | Bilder |
| `/health` | `{"status":"ok"}` |

Ausgeliefert wird nur, was `published_at` gesetzt hat. `covered` fällt aus
der Antwort — Generator-Buchhaltung, wie im Vorbild. `image.src` wird auf
`/l/<id>/media/…` absolutiert.

Abschnitte in dieser Reihenfolge, leere fallen weg:

| Abschnitt | Inhalt |
|---|---|
| Wichtig | alle Einträge mit `breaking: true`, unabhängig vom Typ |
| Neu | `feat` ohne `breaking` |
| Änderungen | `perf` ohne `breaking` |
| Behoben | `fix` ohne `breaking` |

Ein brechender Eintrag erscheint **nur** unter „Wichtig", nicht zusätzlich in
seinem Typ-Abschnitt. Das JSON trägt `type` und `breaking` weiterhin an jedem
Eintrag, sodass ein Konsument selbst anders gruppieren kann.

Der Feed trägt je Abschnitt nur die Anzahl, nicht die Einträge. Ungültige
Werte für `page` oder `per_page` ergeben `400`.

**Die `view`-Einstellung wirkt nicht auf das JSON.** Sonst hinge die
Einbindung eines Kunden an einem Schalter, den jemand anders im Dashboard
umlegen kann — ein Klick, der fremdes Frontend bricht.

CORS steht auf `*` für die JSON-Routen öffentlicher Logs. Private Logs setzen
keinen CORS-Header und antworten ohne gültige Session mit `404`.

Caching: ETag aus `head_sha` und `max-age=60` für JSON; Medien werden über
ihre Blob-SHA mit `max-age=31536000, immutable` ausgeliefert.

### Sichtbarkeit

Zwei Zustände. `public`: wer die URL hat, kommt rein. `private`: nur
angemeldete Nutzer mit Schreibrechten am Repo. Ein „unlisted" dazwischen wäre
bedeutungslos, weil es kein öffentliches Verzeichnis aller Logs gibt und die
IDs nicht erratbar sind.

Ein nicht existierender und ein privater Log antworten identisch mit `404`.

### Gehostete Seite

`/l/<id>` und Permalinks `/l/<id>/r/<version>`. Serverseitig gerendert, kein
Build-Schritt, CSS inline, hell und dunkel über `prefers-color-scheme`. Ein
neutraler Look für alle Logs — Akzentfarbe und Logo je Log sind später zwei
Felder und ein Renderer-Zweig; fremdes CSS wird nie ausgeliefert.

- `view: "timeline"` — ein flacher chronologischer Strom: Datum, `headline`,
  `body`. Die Einträge bleiben zu, der Permalink führt hinein. Brechende
  Releases sind im Strom markiert.
- `view: "full"` — `headline`, `body`, Bild, dann die Abschnitte oben.

**Entwürfe sind nur für Angemeldete mit Schreibrechten sichtbar.**
`write_release` gibt den Permalink zurück; kein Vorschau-Token — ein Link,
der Unveröffentlichtes ohne Anmeldung zeigt, ist ein Link, den man
versehentlich weitergibt.

Öffentliche Log-Seiten sind indexierbar; private tragen `noindex`.

## 8. Dashboard

Serverseitig gerenderte Formulare, kein SPA.

- Nach der ersten Anmeldung ein leerer Arbeitsbereich mit zwei Wegen: Log
  anlegen, oder den MCP-Server verbinden — mit der Endpunkt-URL zum Kopieren.
- **Log anlegen**: Repo-Name und Ziel-Account wählen, Vorgabe `release-log`.
  Die App legt das Repo an, schreibt `release-log.json` mit frischer `id`
  sowie eine `README.md`, und indiziert es. Ein bestehendes Repo lässt sich
  übernehmen: trägt es bereits `release-log.json`, gilt dessen `id`; fehlt
  die Datei, schreibt die App sie mit frischer `id`. Vorhandene
  `releases/*.json` werden indiziert, fehlerhafte einzeln gemeldet.
- Je Log: öffentliche URL, `view`, `visibility`, `curation_notes`,
  Abgleichstand mit Fehlerliste, Releases mit Stand und Knöpfen dafür,
  Medien-Upload, sowie das endgültige Löschen.
- Verbundene Clients mit Name, Scopes und Datum, jeweils widerrufbar.
- Installationsstand: aktiv, suspendiert, entfernt.
- **Für Admins**: die Zulassungsliste — Logins hinzufügen und entfernen, mit
  Notiz und Datum.

Änderungen an `view`, `visibility` und `curation_notes` sind Commits auf
`release-log.json`, keine Datenbankschreibvorgänge. Sonst gäbe es
Einstellungen, die ein Neubau des Index verliert. Der Lackmustest der
Architektur lautet: die Datenbank lässt sich löschen, ohne dass etwas fehlt.

## 9. Modulschnitt

TypeScript, von Node 24 zur Laufzeit ausgeführt — Typen werden entfernt, es
entsteht kein Artefakt. `tsc --noEmit` läuft als Prüfschritt, nicht als
Voraussetzung zum Starten.

```
server.ts           HTTP, Routing, Start
lib/config.ts       Umgebung und Secrets, an einer Stelle gelesen
lib/github.ts       App-JWT, Installations-Token, Repo-Operationen
lib/document.ts     Validierung und Normalisierung eines Release-Dokuments
lib/db/schema.ts    Drizzle-Schema
lib/index.ts        syncLog und Abfragen
lib/permissions.ts  Repo-Rechte gegen GitHub, 5-Minuten-Cache
lib/oauth.ts        Authorization Server, aus oauth-core.ts übernommen
lib/session.ts      Cookie-Session, Zulassungsprüfung
lib/mcp.ts          Tools, Instructions, Prompt
lib/upload.ts       Signierte Upload-Token und Annahme der Bytes
lib/public.ts       JSON-Routen
lib/render.ts       HTML: Log-Seite, Timeline, Dashboard
bin/reindex.ts      Neubau von Hand
```

Zwei Schnitte tragen die Testbarkeit:

`lib/document.ts` ist rein — Dokument hinein, Fehlerliste oder normalisiertes
Dokument heraus — und wird von Schreibpfad und Index benutzt. Sein Typ ist
zugleich die Definition des Formats.

`lib/github.ts` ist die einzige Stelle, die das Netz anfasst. Alles darüber
lässt sich mit einem Fake testen, das einen Baum und ein paar Blobs
zurückgibt.

## 10. Fehlerverhalten und Lebenszyklus

Schlechte Daten degradieren, sie stürzen nicht ab.

| Lage | Verhalten |
|---|---|
| Ungültige Release-Datei | übersprungen, als `sync_error` vermerkt, Rest wird ausgeliefert |
| Ungültige `release-log.json` | Log behält die zuletzt gültige Konfiguration, Fehler im Dashboard |
| GitHub nicht erreichbar oder Rate-Limit | Abgleich wartet mit Backoff, letzter guter Stand bleibt online |
| Webhook ohne gültige Signatur | verworfen, bevor der Inhalt gelesen wird |
| Installation suspendiert oder entfernt | kein Abgleich, Auslieferung läuft, Schreibzugriffe scheitern mit Grund |
| Zwei Repos mit derselben ID | das zweite wird nicht indiziert, Dashboard nennt beide |
| Schreibkonflikt | `conflict` mit aktueller SHA und Dokument, nie überschreiben |
| Medium zu groß oder falscher Typ | nicht indiziert, als `sync_error` vermerkt |

Lebenszyklus des Repos, über `repo_node_id` verankert:

| Ereignis | Verhalten |
|---|---|
| Repo umbenannt | Index zieht Owner und Name nach. `public_id` bleibt, eingebundene URLs brechen nicht |
| Repo transferiert | wie oben, zusätzlich wird die Installation neu zugeordnet; fehlt sie beim neuen Owner, wird der Log eingefroren |
| Repo gelöscht | Log geht auf `frozen`, letzter Stand bleibt online, kein Abgleich, Schreibzugriffe scheitern mit `log_frozen` |
| Repo wiederhergestellt | Der nächste erfolgreiche Abgleich taut den Log von selbst auf |
| Log löschen | Ausdrücklicher Schritt im Dashboard mit Eingabe des Log-Namens. Entfernt Index und Medien sofort und endgültig; das Repo selbst rührt die App nicht an |

Ein Handedit im Repo darf eine öffentliche Seite nie abschießen, und ein
Aufräumen im GitHub-Konto darf keine eingebundene URL als Nebeneffekt töten.

## 11. Tests

`node --test` auf den `.ts`-Dateien, ohne Framework — Node entfernt die Typen
zur Laufzeit, also braucht es keinen Build für den Testlauf. Dazu
`tsc --noEmit` als eigener Prüfschritt.

**Rein und direkt prüfbar:** Dokumentvalidierung (jedes Pflichtfeld, jeder
Typ, `breaking`-Vorgabe), Sortierung (`0.9.10` vor `0.9.2`, gleiches Datum,
Datumsversionen), Abschnittszuordnung inklusive „Wichtig" und der Regel, dass
ein brechender Eintrag nur dort steht, Feed-Zähler, Paginierung und ihre
Fehlerfälle, Baum-Vergleich.

**Sicherheitspfade als eigene Fälle:** PKCE fehlt, PKCE passt nicht, Code
zweimal eingelöst, abweichende Redirect-URI, Loopback mit anderem Port, Token
mit fremder Audience, abgelaufenes und widerrufenes Token, rotiertes
Refresh-Token zweimal benutzt, Webhook mit falscher Signatur, Zugriff auf
fremden Log, Anmeldung ohne Eintrag in der Zulassungsliste, Upload-Token
zweimal benutzt, Upload-Token für fremden Pfad.

**GitHub-Nutzer-Token:** wird verschlüsselt abgelegt und entschlüsselt wieder
gelesen; ein abgelaufenes Token wird über den Refresh erneuert; ein
abgewiesener Refresh ergibt `reauth_required` statt eines Serverfehlers; das
Token wird auf keinem anderen Pfad als `create_log` angefasst.

**Refresh unter Nebenläufigkeit:** zwei gleichzeitige Aufrufe auf ein
abgelaufenes Token ergeben **einen** Refresh und ein gültiges Token für beide,
nicht zwei Refreshes, die einander widerrufen. Dazu: ein abgebrochener
Schreibvorgang lässt nie das alte Token widerrufen und das neue ungespeichert
zurück.

**`create_log` bei `repository_selection=selected`:** erreicht das
Installations-Token das neue Repo nicht, kommt `repo_not_installed` mit der
Hinzufüge-URL — kein halb angelegter Log.

**Rechte:** Cache liefert innerhalb von 5 Minuten ohne GitHub-Aufruf, danach
mit; `installation_repositories` invalidiert sofort.

**Durchgehend:** Fake-GitHub liefert einen Baum, `syncLog` läuft, das
erwartete JSON kommt heraus. Danach derselbe Baum mit einer geänderten Datei
— nur diese wird geholt. Danach eine kaputte Datei — der Rest bleibt
ausgeliefert. Danach ein gelöschtes Repo — der Log friert ein und liefert
weiter aus.

**Sichtbarkeit:** privater Log antwortet ohne Session mit `404`, Entwurf
erscheint nicht im öffentlichen JSON, `covered` fehlt in jeder Antwort.

## 12. Betrieb

Railpack auf Coolify, Node 24, kein Build-Schritt, Health-Check auf
`/health`, Branch `main`. Domain **`release-log.czpt.de`**. SQLite liegt auf
einem Coolify-Volume.

Für den Spike und die Entwicklung eine zweite GitHub App („…-dev") mit
Callbacks auf einen lokalen Tunnel, damit Produktionsschlüssel nie in
Versuchen landen.

| Variable | Inhalt |
|---|---|
| `PORT` | von Coolify gesetzt, lokal 8787 |
| `BASE_URL` | `https://release-log.czpt.de` |
| `GITHUB_APP_ID` | ID der GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | privater Schlüssel, **base64-kodiert** — ein mehrzeiliges PEM ist keine `.env`-Zeile |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | für den User-to-Server-Flow |
| `GITHUB_WEBHOOK_SECRET` | zur Signaturprüfung |
| `SIGNING_KEY` | signiert Sessions, Token und Upload-Token |
| `TOKEN_ENCRYPTION_KEY` | verschlüsselt die GitHub-Nutzer-Token im Ruhezustand |
| `ADMIN_LOGINS` | GitHub-Logins mit Adminrecht, kommagetrennt |
| `DB_PATH` | Pfad der SQLite-Datei auf dem Volume |

**Backup.** Fast alles ist rekonstruierbar: welche Repos Logs sind, steht in
ihnen selbst — die Installation aufzulisten und nach `release-log.json` zu
suchen baut den Bestand neu. Verloren gingen nur die Zulassungsliste,
registrierte OAuth-Clients, erteilte Zustimmungen und die
GitHub-Nutzer-Token; die erste steht zur Not in `ADMIN_LOGINS`, die übrigen
entstehen beim nächsten Verbinden und Anmelden neu. Ein Datenbankverlust
kostet eine Neuverbindung je Client und eine Neuanmeldung je Person, keinen
Datenverlust. Gesichert wird täglich.

`bin/reindex.ts` baut den Index neu, für einen Log oder für alle.

Der Server bindet **ausdrücklich** an eine Adresse statt an die
unspezifizierte. Ohne Host bindet Node `::` und nimmt IPv4 nur mit, solange
dort nichts anderes hört; ist der Port auf IPv4 belegt, startet der Dienst
still IPv6-only und meldet Erfolg. Im Spike sind so zwei Dienste auf einem
Port gelandet, ohne dass eine Kollision gemeldet wurde.

## 13. Bauabfolge

Der Spike, der dem Implementierungsplan vorausging, ist erledigt: die GitHub
App war der einzige Teil ohne Vorerfahrung im Bestand, und ihre Annahmen tragen
die Schritte 3 bis 6. Alle acht bestätigt, zwei neue Anforderungen dabei
entstanden — siehe §14.

1. **Dokumentmodell** — `lib/document.ts` und `lib/public.ts` gegen statische
   Dateien. Testbar ohne GitHub.
2. **Index** — Drizzle-Schema und `syncLog` gegen das Fake-GitHub.
3. **GitHub App** — Anmeldung mit Zulassungsprüfung, Installation, echte
   Repo-Operationen, Webhook mit Signaturprüfung, Rechteprüfung mit Cache,
   Reconcile-Intervall, Lebenszyklus-Events.
4. **Öffentliche Fläche** — JSON-Routen, gehostete Seite, beide Ansichten,
   Sichtbarkeit. *Ab hier ist es ein funktionierender Mehr-Repo-Release-Log.*
5. **OAuth und MCP** — `oauth-core.ts` übernehmen und anpassen, Resource
   Server, Tools, Upload-Weg, Instructions, Prompt.
6. **Dashboard** — Log anlegen, Einstellungen als Commits, Medien, Clients,
   Zulassungsliste, Löschen.
7. **Deployment** — Railpack, Coolify, Volume, Domain, Health-Check.

Das Riskanteste kommt bewusst erst, wenn alles darunter durch Tests
abgesichert ist. Umgekehrt debuggte man Protokoll- und Datenmodellfehler
gleichzeitig, ohne sagen zu können, welcher gerade zuschlägt.

## 14. Ergebnisse des Spikes

Gelaufen am 2026-09-09 gegen die „…-dev"-App am Tunnel
(`spikes/github-app/`). Acht Prüfungen, acht Mal bestätigt.

| Frage | Ergebnis |
|---|---|
| Callback erreichbar, Nutzer-Token erhalten | ja — `expires_in=28800` (8 h), Refresh-Token vorhanden |
| Trägt der Refresh-Zyklus | ja — `refresh_token_expires_in=15638400` (181 Tage) |
| Legt ein Nutzer-Token ein Repo auf dem persönlichen Konto an | ja — HTTP 201 |
| Installations-Token erhalten | ja — `repository_selection=all` |
| Erreicht die Installation das neu angelegte Repo | ja — **nur für `all` geprüft** |
| Gibt die Contents-API beim Commit die Blob-SHA zurück | ja — `content.sha` und `commit.sha` in derselben Antwort |
| Trägt der Baum-Abgleich innerhalb der Rate-Limits | ja — 7647 von 7650 nach dem Lauf übrig |
| Kommen Webhooks am Tunnel an, Signatur gültig | ja — `push`, 8510 Bytes, Signatur verifiziert |

Drei Dinge, die der Lauf über die Fragen hinaus geliefert hat:

**Ein Refresh widerruft das alte Access-Token.** Aufgefallen, weil ein früher
Fehlschlag genau daran lag. Daraus die beiden Anforderungen in §5: atomar
ersetzen, je Konto serialisieren.

**`repository_selection` entscheidet über `create_log`.** Getestet ist nur
`all`. Für `selected` bleibt offen, ob das Installations-Token ein frisch
angelegtes Repo erreicht — deshalb die Prüfung und `repo_not_installed` in §6,
statt sich auf den geprüften Fall zu verlassen.

**Der Rate-Limit einer Installation liegt bei 7650 Anfragen pro Stunde**, und
ein vollständiger Abgleich kostet einen Aufruf plus einen je geänderter Datei.
Der Baum-Abgleich aus §4 ist damit nicht annähernd am Limit.

## 15. Nicht in Version 1

Eigene Domains je Log, Themes und Branding je Log, RSS, Statistiken,
Teamverwaltung jenseits dessen, was GitHub regelt, Schreiben über eine
Warteschlange, offene Registrierung mit Kontingenten und Rechnungswesen.
