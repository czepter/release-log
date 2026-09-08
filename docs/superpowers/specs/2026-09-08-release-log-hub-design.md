# Release-Log-Hub — Design

Stand: 2026-09-08

## 1. Zweck

Ein gehosteter Dienst, mit dem ein Team seinen Release-Log als GitHub-Repo
führt und über einen MCP-Server aus Claude Code, Codex oder pi heraus
schreibt, aktualisiert und veröffentlicht. Der Log wird über eine öffentliche
URL als JSON eingebunden und liegt zusätzlich als lesbare Seite vor.

Vorbild für Datenformat und Ton ist `client-management-portal/release-log`:
ein abhängigkeitsfreier Node-Dienst, dessen Einträge in `releases/*.json`
liegen und dessen eigentlicher Wert in der Trennung von Rohstoff (Commits)
und Ergebnis (kuratierte Prosa) besteht. Dieser Dienst verallgemeinert das
Vorbild auf mehrere Nutzer und mehrere Repos und ersetzt den Generator
`bin/from-git.mjs` durch den Agenten, der ohnehin im Produkt-Repo arbeitet.

### Abgrenzung

Der Dienst kennt das Produkt-Repo nicht. Er kennt ausschließlich das
Log-Repo. Alles, was aus Commits Themen macht, geschieht im Agenten.

## 2. Entscheidungen

| # | Entscheidung | Begründung |
|---|---|---|
| 1 | Das GitHub-Repo ist die Quelle der Wahrheit; die App hält einen materialisierten Lese-Index | Git-Historie ist die echte Historie. Handedits und PRs zählen gleichberechtigt. Der öffentliche Request-Pfad hängt nicht an GitHubs Verfügbarkeit |
| 2 | Eine GitHub App leistet Anmeldung und Repo-Zugriff; die Repos gehören dem Nutzer | Fine-grained auf ausgewählte Repos statt `repo`-Scope auf alles. Installations-Token überleben Personalwechsel. Private Repos möglich |
| 3 | Den Rohstoff liefert der Agent; die App liest kein Produkt-Repo | Der Agent sieht Diffs und PR-Text, ein Server sieht Betreffzeilen. Nur ein Repo je Log braucht Zugriff |
| 4 | Veröffentlichen ist ein Feld: `published_at` | Ein Commit, ein Ref, eine Datei. Idempotent, und beantwortet die Frage, die eine Timeline stellt |
| 5 | Eingebunden wird JSON; zusätzlich gibt es eine gehostete Ansichtsseite | Wer einbindet, rendert selbst. Die Ansichtseinstellung steuert nur die gehostete Seite |
| 6 | Der Kurations-Skill reist im MCP-Server mit (`instructions` plus Prompt) | Der Agent arbeitet im Produkt-Repo; ein Skill im Log-Repo läge am falschen Ort. Kein Installationsschritt, immer passend zur Tool-Fassung |
| 7 | Node 24, `node:http`, `node:sqlite`, dazu MCP-SDK und Octokit | Kein Build-Schritt, Railpack wie das Vorbild. Handarbeit nur dort, wo sie keine Protokoll- und Sicherheitsdetails betrifft |
| 8 | Ein Dienst, Write-Through über eine einzige Abgleichfunktion | Das Repo ist bei Uneinigkeit immer der Schiedsrichter; der Index ist jederzeit wegwerfbar |

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
| `id` | 12 Zeichen Crockford-Base32 | Öffentliche Kennung, aus einem CSPRNG. Wird beim Anlegen vergeben und nie geändert |
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

Das Format des Vorbilds, um `published_at` erweitert.

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
| `version` | Pflicht, muss dem Dateinamen entsprechen. Weichen sie ab, ist die Datei fehlerhaft |
| `tag` | Text oder `null` |
| `date` | Pflicht, `YYYY-MM-DD` |
| `published_at` | ISO-8601 in UTC oder `null`. `null` heißt Entwurf |
| `commits` | Ganzzahl ≥ 0 |
| `headline` | Pflicht, nicht leer |
| `body` | Liste von Absätzen, darf leer sein |
| `image` | Objekt mit `src` und `alt`, oder `null`. `src` ist **repo-relativ** |
| `covered` | Liste von Commit-SHAs. Buchhaltung des Agenten, nie von Hand |
| `changes` | Liste; `type` ist `feat`, `perf` oder `fix`; `title` und `description` sind Pflicht; `scope` Text oder `null`; `pr` Zahl oder `null`; `issues` Liste von Zahlen; `commit` Text; `date` `YYYY-MM-DD` |

`image.src` ist repo-relativ, anders als im Vorbild (`/media/…`). Ein
absoluter Pfad bindet die Datei an genau einen Host; die App setzt beim
Ausliefern `/l/<id>/media/…` davor. Das Repo bleibt damit für sich genommen
sinnvoll — bei "Repo = Wahrheit" ist das der Maßstab.

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
  validiere über lib/document.mjs, schreibe Zeilen
  lösche Zeilen zu Pfaden, die es im Baum nicht mehr gibt
  setze log.head_sha und log.indexed_at
```

Der Vergleich läuft über git-Blob-SHAs statt über Commits. Damit sind
MCP-Schreibzugriff, Handedit, gemergter PR und Force-Push derselbe Fall. Auch
"Webhook nie angekommen" und "Index von Null neu bauen" sind kein Sonderfall:
ein leerer Index ist ein Baum, in dem sich alles geändert hat. Kosten pro Lauf:
ein Aufruf für den Baum plus je einer für die tatsächlich geänderten Dateien.

Der Ansatz ist ein Zustandsvergleich, keine Ereignisverarbeitung.
Ereignisverarbeitung braucht lückenlose Zustellung; ein Zustandsvergleich
braucht nur irgendwann einen Anstoß. Deshalb darf der Webhook unzuverlässig
sein, ohne dass Korrektheit daran hängt.

### Schema

SQLite über `node:sqlite`.

| Tabelle | Spalten |
|---|---|
| `account` | `github_user_id` (PK), `login`, `avatar_url`, `last_seen_at` |
| `installation` | `installation_id` (PK), `target_login`, `target_type`, `state` (`active`\|`suspended`\|`removed`), `updated_at` |
| `log` | `public_id` (PK), `repo_owner`, `repo_name`, `installation_id`, `product`, `view`, `visibility`, `curation_notes`, `head_sha`, `config_blob_sha`, `indexed_at` |
| `release` | `log_id`, `version`, `sort_key`, `date`, `published_at`, `blob_sha`, `doc` (JSON-Text); PK (`log_id`, `version`) |
| `media` | `log_id`, `path`, `blob_sha`, `content_type`, `bytes`; PK (`log_id`, `path`) |
| `sync_error` | `log_id`, `path`, `message`, `at` |
| `oauth_client` | `client_id` (PK), `client_name`, `redirect_uris` (JSON), `created_at` |
| `oauth_grant` | `account_id`, `client_id`, `scopes`, `granted_at`; PK (`account_id`, `client_id`). Dient der Anzeige verbundener Clients und dem Widerruf — **nicht** dazu, die Zustimmung zu überspringen |
| `oauth_token` | `token_hash` (PK), `kind` (`access`\|`refresh`), `account_id`, `client_id`, `scopes`, `expires_at`, `revoked_at` |

`release.doc` hält das vollständige validierte Dokument. Eigene Spalten
bekommt nur, wonach sortiert oder gefiltert wird. Der Index ist ein
Lesemodell, keine normalisierte Domäne.

Eindeutigkeit über (`repo_owner`, `repo_name`) verhindert, dass dasselbe Repo
zweimal als Log geführt wird.

### Sortierung

Das Vorbild sortiert mit `Intl.Collator({ numeric: true })`. SQLite kann das
nicht, deshalb entsteht beim Indizieren ein `sort_key`: jedes Segment auf
fünf Stellen mit Nullen aufgefüllt, `0.9.10` wird zu `00000.00009.00010`.
Ohne ihn stünde `0.9.10` vor `0.9.2`. Nicht-numerische Segmente
(Vorabversionen wie `1.0.0-rc1`) werden nach den numerischen einsortiert und
untereinander lexikografisch.

### Medien

Medien liegen mit Bytes im Index, adressiert über ihre Blob-SHA. Eine
Blob-SHA identifiziert unveränderlichen Inhalt, also ist die Auslieferung mit
langem Cache und ETag korrekt, und private Repos brauchen beim Ausliefern
keinen Sonderweg. Erlaubt sind `.png`, `.jpg`, `.webp`; größere Dateien als
5 MB werden nicht indiziert und erscheinen als `sync_error`.

### Reconcile

Ein Intervall nimmt alle 5 Minuten den Log mit dem ältesten `indexed_at` und
gleicht ihn ab; zusätzlich wird jeder Log mindestens stündlich erfasst. Der
Webhook sorgt für Sofortigkeit, das Intervall dafür, dass ein verlorener
Webhook höchstens eine Runde kostet statt für immer zu driften.

### Installation suspendiert oder entfernt

Die Installation wird als `suspended` oder `removed` markiert. Die Logs
bleiben mit ihrem letzten Stand online und werden nicht mehr abgeglichen. Das
Dashboard sagt es; MCP-Schreibzugriffe auf betroffene Logs scheitern mit
`installation_inactive`. Eine Deinstallation ist kein Grund, eine öffentliche
Seite verschwinden zu lassen.

## 5. Identität und OAuth

Zwei getrennte OAuth-Rollen liegen nebeneinander. Verwechslungen zwischen
ihnen sind die Fehlerklasse, die man später nicht mehr sieht.

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

Benötigte Berechtigungen der GitHub App: `contents: write` (Dateien lesen und
committen), `metadata: read`, `administration: write` (Repos anlegen).
Abonnierte Events: `push`, `installation`, `installation_repositories`,
`repository`.

### Rolle 2: die App als Authorization Server gegenüber Agent-Clients

Damit sich ein Client verbinden kann, ohne vorher registriert zu sein, tritt
die App als eigener OAuth-2.1-Authorization-Server und als Resource Server auf.

| Endpunkt | Zweck |
|---|---|
| `/.well-known/oauth-protected-resource` | nennt den zuständigen Authorization Server (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Metadaten: Endpunkte, unterstützte Verfahren (RFC 8414) |
| `/oauth/register` | Dynamic Client Registration (RFC 7591) |
| `/oauth/authorize` | Zustimmung, danach Authorization Code |
| `/oauth/token` | Code gegen Token, Refresh |
| `/mcp` | die geschützte Ressource, Streamable HTTP |

Ablauf beim Verbinden: Der Client ruft `/mcp` und bekommt `401` mit
`WWW-Authenticate`, das auf die Metadaten zeigt. Er registriert sich selbst,
schickt den Nutzer zu `/oauth/authorize`. Dort greift die bestehende
Web-Session, oder es geht zuerst durch die GitHub-Anmeldung. Danach ein
Zustimmungsbildschirm, der Client, Scopes und betroffene Logs benennt, dann
zurück mit Code, den der Client gegen Token tauscht.

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
  Ohne erzwungene Zustimmung könnte ein fremder Client eine bestehende
  Einwilligung für sich verwenden.
- **Unsere Token sind keine GitHub-Token.** Ein MCP-Client bekommt nie ein
  GitHub-Token zu sehen, und ein GitHub-Token wird nie als MCP-Token
  akzeptiert. Unsere Access-Token tragen als Audience unseren eigenen
  MCP-Endpunkt und werden gegen ihn geprüft. Token-Weiterreichung ist damit
  ausgeschlossen.
- **Token liegen nur als SHA-256-Hash in der Datenbank.** Was gespeichert
  wird, reicht zum Prüfen und nicht zum Benutzen.
- **Laufzeiten:** Access-Token 1 Stunde, Refresh-Token 30 Tage mit Rotation.
  Ein zweimal benutztes Refresh-Token widerruft die ganze Kette.
- **Zwei Scopes:** `logs:read` und `logs:write`. Der Zustimmungsbildschirm
  benennt sie im Klartext; ein nur lesend verbundener Client kann nichts
  committen.
- **Widerruf** im Dashboard je Client, wirksam beim nächsten Aufruf.
- **Webhook-Signaturen werden geprüft**, HMAC-SHA-256 gegen das Secret der
  App, Vergleich zeitkonstant. Eine Anfrage ohne gültige Signatur wird
  verworfen, bevor ihr Inhalt gelesen wird. Ein Webhook ist ein öffentlich
  erreichbarer Endpunkt, der Schreiboperationen anstößt.
- **Ratenbegrenzung:** `/oauth/register` 10 Anfragen je IP und Stunde,
  `/oauth/token` 60 je IP und Minute.
- **Secrets** (App-ID, privater Schlüssel, Client-Secret, Webhook-Secret,
  Signaturschlüssel) kommen aus der Umgebung und stehen nie im Repo.

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
| `add_media` | write | `log_id`, `path`, `content_base64` | Bild ins Repo, höchstens 5 MB |

`create_log` braucht eine bestehende Installation auf dem Ziel-Account.
Gibt es keine, scheitert der Aufruf mit `no_installation` und liefert die
Installations-URL zurück — der Agent reicht sie an den Menschen weiter, der
sie einmal öffnet. Danach läuft das Anlegen ohne Browser.

`view`, `visibility` und `curation_notes` ändert nur das Dashboard. Sie sind
Einstellungen, die ein Mensch trifft und ansieht, und ein Agent hat keinen
Anlass, sie im Vorbeigehen zu verstellen.

### Nebenläufigkeit

`write_release` verlangt `base_blob_sha`, sobald die Version existiert.
Blindes Überschreiben wird abgelehnt. Stimmt die SHA nicht, kommt `conflict`
mit aktueller SHA und aktuellem Dokument zurück, damit der Agent
zusammenführen kann statt zu raten. Mensch im Repo und Agent über MCP sind
damit gleichberechtigte Schreiber, und wer zuletzt kommt, merkt es.

### Validierung

`write_release` validiert über dieselbe Funktion wie der Index
(`lib/document.mjs`). Ein Dokument, das der Index verwerfen würde, erreicht
das Repo nicht; der Fehler kommt als `invalid_document` mit den konkreten
Feldern zurück, während der Agent noch am Zug ist. Zwei Validatoren würden
auseinanderlaufen und genau das Loch lassen, durch das kaputte Dateien ins
Repo rutschen.

### Fehler

`conflict`, `invalid_document`, `installation_inactive`, `not_found`,
`forbidden`, `payload_too_large`, `github_unavailable`. Jeder trägt eine
Meldung, die sagt, was als Nächstes zu tun ist.

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
  Release, nicht die Einträge nacherzählt.
- Typen: `feat` → Neu, `perf` → Änderungen, `fix` → Behoben.
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
"wo war ich stehengeblieben" muss aus den Daten kommen.

Dazu ein MCP-Prompt `release-kuratieren`, der den Ablauf als eine
Aufforderung anstößt.

Produktspezifische Regeln gehören nicht in einen geteilten Text. Sie stehen
in `curation_notes` des jeweiligen Logs und werden den Instructions
angehängt.

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
`/l/<id>/media/…` absolutiert. Gruppierung: `feat` → Neu, `perf` →
Änderungen, `fix` → Behoben; leere Abschnitte fallen weg. Der Feed trägt je
Abschnitt nur die Anzahl, nicht die Einträge.

Ungültige Werte für `page` oder `per_page` ergeben `400`.

**Die `view`-Einstellung wirkt nicht auf das JSON.** Sonst hinge die
Einbindung eines Kunden an einem Schalter, den jemand anders im Dashboard
umlegen kann — ein Klick, der fremdes Frontend bricht.

CORS steht auf `*` für die JSON-Routen öffentlicher Logs; ohne das wäre
Einbinden aus dem Browser nicht möglich. Private Logs setzen keinen
CORS-Header und antworten ohne gültige Session mit `404`.

Caching: ETag aus `head_sha` und `max-age=60` für JSON; Medien sind über ihre
Blob-SHA inhaltsadressiert und werden mit `max-age=31536000, immutable`
ausgeliefert.

### Sichtbarkeit

Zwei Zustände. `public`: wer die URL hat, kommt rein. `private`: nur
angemeldete Nutzer mit Zugriff auf das Repo. Ein "unlisted" dazwischen wäre
bedeutungslos, weil es kein öffentliches Verzeichnis aller Logs gibt und die
IDs nicht erratbar sind — jeder öffentliche Log ist bereits nur über seinen
Link auffindbar.

Ein nicht existierender oder privater Log antwortet identisch mit `404`.

### Gehostete Seite

`/l/<id>` und Permalinks `/l/<id>/r/<version>`. Serverseitig gerendert aus
Template-Literals, kein Build-Schritt, CSS inline, hell und dunkel über
`prefers-color-scheme`.

- `view: "timeline"` — ein flacher chronologischer Strom: Datum, `headline`,
  `body`. Die Einträge bleiben zu, der Permalink führt hinein.
- `view: "full"` — das Modell des Vorbilds: `headline`, `body`, Bild, dann
  Neu/Änderungen/Behoben mit allen Einträgen.

**Entwürfe sind nur für Angemeldete sichtbar.** `write_release` gibt den
Permalink zurück; wer ihn öffnet, sieht den Entwurf nur mit Session und
Repo-Zugriff. Kein Vorschau-Token — ein Link, der Unveröffentlichtes ohne
Anmeldung zeigt, ist ein Link, den man versehentlich weitergibt.

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
  Abgleichstand mit Fehlerliste, Releases mit Entwurfs- und
  Veröffentlicht-Stand samt Knöpfen dafür.
- Verbundene Clients mit Name, Scopes und Datum, jeweils widerrufbar.
- Installationsstand: aktiv, suspendiert, entfernt.

Änderungen an `view`, `visibility` und `curation_notes` sind Commits auf
`release-log.json`, keine Datenbankschreibvorgänge. Sonst gäbe es
Einstellungen, die ein Neubau des Index verliert. Der Lackmustest der
Architektur lautet: die Datenbank lässt sich löschen, ohne dass etwas fehlt.

## 9. Modulschnitt

```
server.mjs          HTTP, Routing, Start
lib/config.mjs      Umgebung und Secrets, an einer Stelle gelesen
lib/github.mjs      App-JWT, Installations-Token, Repo-Operationen
lib/document.mjs    Validierung und Normalisierung eines Release-Dokuments
lib/index.mjs       SQLite: Schema, syncLog, Abfragen
lib/oauth.mjs       Authorization Server: register, authorize, token, Zustimmung
lib/session.mjs     Cookie-Session
lib/mcp.mjs         Tools, Instructions, Prompt
lib/public.mjs      JSON-Routen
lib/render.mjs      HTML: Log-Seite, Timeline, Dashboard
bin/reindex.mjs     Neubau von Hand
```

Zwei Schnitte tragen die Testbarkeit:

`lib/document.mjs` ist rein — Dokument hinein, Fehlerliste oder
normalisiertes Dokument heraus — und wird von Schreibpfad und Index benutzt.

`lib/github.mjs` ist die einzige Stelle, die das Netz anfasst. Alles darüber
lässt sich mit einem Fake testen, das einen Baum und ein paar Blobs
zurückgibt.

## 10. Fehlerverhalten

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
| Medium über 5 MB oder falscher Typ | nicht indiziert, als `sync_error` vermerkt |

Ein Handedit im Repo darf eine öffentliche Seite nie abschießen.

## 11. Tests

`node --test`, ohne Framework, wie im Vorbild.

**Rein und direkt prüfbar:** Dokumentvalidierung (jedes Pflichtfeld, jeder
Typ), `sort_key` (`0.9.10` nach `0.9.2`, Vorabversionen), Abschnittsgruppierung,
Feed-Zähler, Paginierung und ihre Fehlerfälle, Baum-Vergleich.

**Sicherheitspfade als eigene Fälle:** PKCE fehlt, PKCE passt nicht, Code
zweimal eingelöst, abweichende Redirect-URI, Loopback mit anderem Port,
Token mit fremder Audience, abgelaufenes und widerrufenes Token, rotiertes
Refresh-Token zweimal benutzt, Webhook mit falscher Signatur, Zugriff auf
fremden Log.

**Durchgehend:** Fake-GitHub liefert einen Baum, `syncLog` läuft, das
erwartete JSON kommt heraus. Danach derselbe Baum mit einer geänderten Datei
— nur diese wird geholt. Danach eine kaputte Datei — der Rest bleibt
ausgeliefert.

**Sichtbarkeit:** privater Log antwortet ohne Session mit `404`, Entwurf
erscheint nicht im öffentlichen JSON, `covered` fehlt in jeder Antwort.

## 12. Betrieb

Coolify mit Railpack wie das Vorbild, Node 24, kein Build-Schritt,
Health-Check auf `/health`, Branch `main`.

`railpack.json` hält Node-Version und Startbefehl. SQLite liegt auf einem
Volume.

| Variable | Inhalt |
|---|---|
| `PORT` | von Coolify gesetzt, lokal 8080 |
| `BASE_URL` | öffentliche Basis-URL, für OAuth-Metadaten und Permalinks |
| `GITHUB_APP_ID` | ID der GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | privater Schlüssel im PEM-Format |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | für den User-to-Server-Flow |
| `GITHUB_WEBHOOK_SECRET` | zur Signaturprüfung |
| `SIGNING_KEY` | signiert Sessions und Token |
| `DB_PATH` | Pfad der SQLite-Datei auf dem Volume |

**Backup.** Fast alles ist rekonstruierbar: welche Repos Logs sind, steht in
ihnen selbst — die Installation aufzulisten und nach `release-log.json` zu
suchen baut den Bestand neu. Verloren gingen nur registrierte OAuth-Clients
und erteilte Zustimmungen, und die entstehen beim nächsten Verbinden neu. Ein
Datenbankverlust kostet eine Neuverbindung je Client, keinen Datenverlust.
Gesichert wird sie trotzdem, täglich.

`bin/reindex.mjs` baut den Index neu, für einen Log oder für alle.

## 13. Bauabfolge

So geschnitten, dass ab Schritt 4 etwas Nutzbares steht, bevor MCP existiert.

1. **Dokumentmodell** — `lib/document.mjs` und `lib/public.mjs` gegen
   statische Dateien. Testbar ohne GitHub. Das ist im Kern `server.mjs` des
   Vorbilds, aufgeteilt und um `published_at` und die Log-ID erweitert.
2. **Index** — Schema und `syncLog` gegen das Fake-GitHub.
3. **GitHub App** — Anmeldung, Installation, echte Repo-Operationen, Webhook
   mit Signaturprüfung, Reconcile-Intervall.
4. **Öffentliche Fläche** — JSON-Routen, gehostete Seite, beide Ansichten,
   Sichtbarkeit. *Ab hier ist es ein funktionierender Mehr-Repo-Release-Log.*
5. **OAuth und MCP** — Authorization Server, Resource Server, Tools,
   Instructions, Prompt.
6. **Dashboard** — Log anlegen, Einstellungen als Commits, Clients, Fehler.
7. **Deployment** — Railpack, Coolify, Volume, Health-Check.

Das Riskanteste — OAuth-Server und MCP — kommt bewusst erst, wenn alles
darunter durch Tests abgesichert ist. Umgekehrt debuggte man Protokoll- und
Datenmodellfehler gleichzeitig, ohne sagen zu können, welcher gerade zuschlägt.

## 14. Nicht in Version 1

Eigene Domains je Log, Themes, RSS, Statistiken, Teamverwaltung jenseits
dessen, was GitHub regelt, Schreiben über eine Warteschlange.
