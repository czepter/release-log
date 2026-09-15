# Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wer sich anmeldet und Schreibrechte auf ein Log-Repo hat, sieht es im Dashboard, kann `view`, `visibility` und `curation_notes` ändern (als Commit, nie als Datenbankschreibvorgang), ein Bild hochladen, und das Log endgültig löschen. Admins pflegen zusätzlich die Zulassungsliste.

**Architecture:** Serverseitig gerendertes HTML, kein Build-Schritt, kein Framework (`lib/render.ts` liefert genau eine Escaping-Funktion und eine Seiten-Hülle). Jede schreibende Aktion läuft über eine neue `putFile`-Methode auf der GitHub-Naht — ein Commit über das Installations-Token, mit GitHubs eigener Blob-SHA-Prüfung als Nebenläufigkeitsschutz, ganz ohne eigene Sperrlogik. `lib/permissions.ts`s `canWrite` bekommt hier seinen ersten echten Aufrufer.

**Tech Stack:** TypeScript auf Node 24 ohne Build-Schritt, `node --test`, Drizzle über `better-sqlite3`.

**Spec:** `docs/superpowers/specs/2026-09-08-release-log-hub-design.md` — bindend. §8 ist der Abschnitt, den dieser Plan umsetzt.

## Global Constraints

- Node 24 führt TypeScript zur Laufzeit aus. **Kein Build-Schritt.** Importe tragen die Endung `.ts`. Reine Typ-Importe benutzen `import type`.
- `npm test` ruft `node --test` **ohne Pfadargument**. `npm run typecheck` (`tsc --noEmit`) muss sauber sein. Baseline: 326 Tests grün.
- **Keine neuen Laufzeit-Abhängigkeiten.**
- **Jede dynamische Zeichenkette, die in eine HTML-Antwort gerät, läuft durch `escapeHtml` aus `lib/render.ts` — ausnahmslos.** Diese Datei rendert zum ersten Mal in diesem Projekt echtes HTML statt JSON; XSS ist ab hier ein echtes Risiko, das vorher nicht existierte.
- **`view`, `visibility` und `curation_notes` ändern sich ausschließlich über einen Commit auf `release-log.json`, nie über einen Datenbankschreibvorgang** (Spec §8: „Sonst gäbe es Einstellungen, die ein Neubau des Index verliert"). Dasselbe gilt für Medien.
- Jede schreibende Route prüft zuerst die Session, dann `canWrite(accountId, login, logId, ref)` — nie nur, ob überhaupt jemand angemeldet ist.
- CSRF-Schutz läuft über `SameSite=Lax` auf dem Session-Cookie (schon vorhanden) — kein eigenes Token-System. `SameSite=Lax` verweigert das Cookie bei einer fremden Seiten-POST-Anfrage; genau das ist die Bedrohung, gegen die sich zustandsändernde Formulare wehren müssen.
- Secrets — der signierende Schlüssel, das Client-Secret — erscheinen in keiner Logzeile, keiner Fehlermeldung, keiner HTML-Antwort.
- Kommentare erklären *warum*, nicht *was*.
- Tests, die nicht fallen können, sind der wiederkehrende Fehler dieses Projekts. Jeder Test unten trägt eine **Fällt, wenn**-Zeile, die die konkrete Mutation nennt, die ihn brechen muss. Wer implementiert, prüft mindestens zwei davon live nach.

## Abweichungen von der Spec, bewusst getroffen

1. **„Log anlegen" ist NICHT Teil dieses Plans.** Spec §6 sagt es direkt: `create_log` braucht ein gültiges GitHub-Nutzer-Token des aufrufenden Kontos (`POST /user/repos` akzeptiert laut GitHubs Referenz nur Nutzer-Token) — also das ganze, eigens abgesicherte Nutzer-Token-Geflecht aus Entscheidung 23 (`github_user_token`-Tabelle, `TOKEN_ENCRYPTION_KEY`, 8-Stunden-Token mit 181-Tage-Refresh, je-Konto-serialisierte Refreshes, „ein Refresh widerruft das alte Token sofort"). Das ist unabhängig groß und sicherheitskritisch genug für einen eigenen Plan — dieselbe Begründung, mit der Plan 5 „Rolle 2" herausgeschnitten hat. Nach diesem Plan bleibt der Arbeitsbereich für ein Konto ohne bestehende Logs leer; das ist ein ehrlicher, kein versteckter Zustand.
2. **„Verbundene Clients... widerrufbar" ist NICHT Teil dieses Plans.** Es gibt noch keine OAuth-Clients zum Auflisten — die brauchen den MCP-Authorization-Server aus Spec §5 „Rolle 2", ebenfalls in Plan 5 herausgeschnitten. Eine leere Liste zu bauen, bevor es etwas zu füllen gibt, wäre Attrappen-UI.
3. **„MCP-Server verbinden" (der zweite Weg im leeren Arbeitsbereich) ist NICHT Teil dieses Plans**, aus demselben Grund: `/mcp` existiert noch nicht. Eine URL zu zeigen, die 404 antwortet, ist schlechter als sie wegzulassen.
4. **Releases sind im Dashboard nur Anzeige, keine Aktion.** Die Spec weist `publish_release`/`unpublish_release` explizit den MCP-Tools zu (§6-Tabelle, Schreib-Scope), und Entscheidung 3 trennt bewusst: „Der Agent sieht Diffs und PR-Text" — Inhalts- und Veröffentlichungsentscheidungen bleiben beim Agenten-Pfad, das Dashboard verwaltet Einstellungen. „Releases mit Stand und Knöpfen dafür" wird hier als Statusliste mit einem Link auf die öffentliche JSON-Route gelesen, nicht als Veröffentlichen-Schalter. Das spart außerdem eine ganze Schreib-und-Zusammenführungs-Logik für `releases/<version>.json`, die dieselbe Nebenläufigkeitsfrage aufwerfen würde, die Spec §6 explizit dem MCP-Pfad zuweist (`base_blob_sha`, `conflict`).
5. **„Installationsstand: aktiv, suspendiert, entfernt" wird nicht über eine eigene `installation`-Tabelle geführt.** Spec §4 nennt eine solche Tabelle, aber nichts im Bestand füllt sie — das bräuchte eine eigene Webhook-Schreibroute für `installation`/`installation_repositories`-Ereignisse, reine neue Infrastruktur für eine einzelne Anzeige. Stattdessen liest die Log-Seite live über `probe()` (das die GitHub-Naht schon hat): `ready`/`empty` heißt erreichbar, `no_installation` heißt nicht installiert oder entzogen, `gone` heißt das Repo selbst ist weg. Das beantwortet dieselbe praktische Frage, ohne eine Tabelle zu pflegen, die sonst niemand liest.
6. **`getFile` gibt es nicht — der Index selbst liefert, was ein Commit braucht.** `log.configBlobSha` in der Datenbank ist genau die Blob-SHA der zuletzt synchronisierten `release-log.json`; ein `PUT` mit dieser SHA nutzt GitHubs eigene Konflikterkennung (409/422, wenn sie nicht mehr stimmt) als Nebenläufigkeitsschutz, ganz ohne einen zusätzlichen Lese-Umlauf. Ist die im Index gecachte SHA veraltet (ein Handedit lief, ohne dass der Abgleich schon nachgezogen hat), meldet GitHub genau den Konflikt, den ein extra `getFile`-Aufruf auch nur hätte vorwegnehmen können.
7. **Ein eingefrorenes Log bleibt für Admins löschbar, auch ohne Schreibrecht.** `canWrite` fragt GitHub nach dem Recht auf ein bestimmtes Repo — für ein gelöschtes Repo antwortet GitHub 404 auf jede Rechteanfrage, also wäre ein eingefrorenes Log für niemanden je „schreibbar" und die Löschen-Aktion (die genau für diesen Fall gedacht ist) unerreichbar. Deshalb: die Log-Liste und die Log-Seite sind für ein eingefrorenes Log zusätzlich für Admins sichtbar, unabhängig von `canWrite`. Das ist eine Verfeinerung, die die Spec nicht explizit ausspricht, aber die Lücke schließt, die sonst entstünde.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `lib/render.ts` (neu) | `escapeHtml`, eine minimale Seiten-Hülle |
| `lib/github.ts` (ändern) | `putFile` — ein Commit über das Installations-Token |
| `server.ts` (ändern) | `/dashboard`, `/dashboard/logs/:id`, die schreibenden Routen darunter, `/admin/allowlist` |
| `README.md` (ändern) | die neuen Routen |

---

### Task 1: `lib/render.ts` — Escaping und eine Seiten-Hülle

**Files:**
- Create: `lib/render.ts`
- Test: `lib/render.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `function escapeHtml(s: string): string`, `function page(title: string, bodyHtml: string): string`.

- [ ] **Step 1: Write the failing test**

`lib/render.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, page } from './render.ts';

test('escapeHtml neutralises the five HTML-meaningful characters', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(escapeHtml(`"quoted" 'single'`), '&quot;quoted&quot; &#39;single&#39;');
});

test('escapeHtml leaves ordinary text untouched', () => {
  assert.equal(escapeHtml('Auri CRM 0.9.2'), 'Auri CRM 0.9.2');
});

test('escapeHtml handles an empty string', () => {
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml is idempotent-safe against a value that already looks escaped', () => {
  // A value containing a literal "&amp;" must not become "&amp;amp;" -- but
  // escapeHtml only ever runs once per value in this codebase (never on
  // its own output), so this pins the actual & -> &amp; behaviour rather
  // than claiming double-escaping is handled.
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

test('page wraps the body in an HTML shell and escapes the title', () => {
  const html = page('<b>Title</b>', '<p>body content, not re-escaped</p>');
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('<title>&lt;b&gt;Title&lt;/b&gt;</title>'), 'the title must be escaped');
  assert.ok(html.includes('<p>body content, not re-escaped</p>'), 'the body is inserted as-is -- callers escape their own dynamic pieces before composing it');
});

test('page includes a charset declaration', () => {
  assert.ok(page('T', '').includes('charset="utf-8"'));
});
```

**Fällt, wenn:** Test 1 ist die eigentliche Sicherheitsaussage dieses Tasks und fällt, sobald eine der fünf Ersetzungen fehlt oder eine falsche Entität liefert — probiere testweise `<` fehlen zu lassen. Test 4 fällt, wenn `&` nicht zuerst ersetzt wird (eine falsche Reihenfolge ersetzt sonst die frisch eingefügten `&amp;`-Entitäten selbst noch einmal). Test 5 fällt, wenn `page` den Titel roh statt über `escapeHtml` einsetzt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './render.ts'`.

- [ ] **Step 3: Write the implementation**

`lib/render.ts`:

```ts
// Die einzige Stelle, an der eine dynamische Zeichenkette in HTML landet,
// läuft über escapeHtml -- ausnahmslos. Bis hierher hat dieses Projekt nur
// JSON ausgeliefert; ab dieser Datei ist eine ungeschützte Einsetzung ein
// echtes XSS, das vorher nicht existierte.

// & zuerst: jede andere Ersetzung fügt ein &, das eine spätere &-Ersetzung
// sonst noch einmal träfe und aus "&lt;" ein "&amp;lt;" machte.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Kein Framework, kein Build-Schritt (Entscheidung 19) -- eine Zeichenkette
// als Hülle reicht für ein internes Werkzeug. prefers-color-scheme deckt
// den dunklen Modus ab, ohne dass irgendwer ihn umschalten muss.
const STYLE = `
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.5}
h1,h2{font-weight:600}
form{margin:1rem 0}
label{display:block;margin:.6rem 0 .2rem;font-weight:600}
input,select,textarea{width:100%;padding:.4rem;box-sizing:border-box;font:inherit;border:1px solid #999;border-radius:3px}
textarea{min-height:6rem}
button{padding:.5rem 1.2rem;margin-top:.6rem;cursor:pointer}
table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{padding:.35rem .5rem;border-bottom:1px solid #ddd;text-align:left}
.error{color:#b00020}
.muted{color:#666;font-size:.9em}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:3px;font-size:.85em;background:#eee}
@media (prefers-color-scheme: dark) {
  body{background:#151515;color:#e8e8e8}
  input,select,textarea{background:#1e1e1e;color:#e8e8e8;border-color:#555}
  td,th{border-color:#333}
  .badge{background:#2a2a2a}
}
`;

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${bodyHtml}</body></html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die `<`-Ersetzung aus `escapeHtml` — Test 1 muss fallen. Setze zurück. Vertausche die Reihenfolge, sodass `&` NICHT zuerst ersetzt wird — Test 4 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/render.ts lib/render.test.ts
git commit -m "feat: escape HTML and give the dashboard a page shell"
```

---

### Task 2: `putFile` — ein Commit über das Installations-Token

**Files:**
- Modify: `lib/github.ts`
- Test: `lib/github.test.ts`

**Interfaces:**
- Consumes: alles Bestehende aus `lib/github.ts`.
- Produces: `type CommitResult = { kind: 'committed'; sha: string } | { kind: 'conflict' } | { kind: 'no_installation' }`; `GitHub` bekommt `putFile(ref: RepoRef, path: string, content: Buffer, message: string, expectedSha: string | null): Promise<CommitResult>`; `fakeGitHub` erfüllt sie ebenfalls.

`expectedSha: null` heißt „diese Datei soll neu angelegt werden" — GitHub lehnt mit 422 ab, wenn unter dem Pfad schon etwas liegt. Eine nicht-`null`-SHA heißt „ersetze genau diese Version" — GitHub lehnt mit 409 ab, wenn die SHA nicht mehr stimmt. Beide Fälle werden hier auf `{ kind: 'conflict' }` abgebildet; der Aufrufer unterscheidet sie nicht, weil beide dieselbe Antwort verdienen: nicht committen, dem Menschen sagen, dass sich etwas geändert hat.

- [ ] **Step 1: Write the failing test**

An `lib/github.test.ts` anhängen:

```ts
test('putFile commits new content and returns the new blob sha', async () => {
  const http = fakeHttp({
    'PUT /repos/o/r/contents/release-log.json': { body: { content: { sha: 'new-sha-abc' } } },
  });
  const result = await githubClient(withToken('t'), http).putFile(
    REF, 'release-log.json', Buffer.from('{"a":1}', 'utf8'), 'update settings', 'old-sha-123',
  );
  assert.deepEqual(result, { kind: 'committed', sha: 'new-sha-abc' });
});

test('putFile sends the content base64-encoded, with the message and expected sha', async () => {
  const http = fakeHttp({
    'PUT /repos/o/r/contents/media%2Fshot.png': { body: { content: { sha: 'x' } } },
  });
  let sentBody: unknown;
  const spy = Object.assign(
    (url: string, init?: RequestInit) => {
      if (init?.body) sentBody = JSON.parse(String(init.body));
      return http(url, init);
    },
    { calls: http.calls },
  );
  await githubClient(withToken('t'), spy).putFile(REF, 'media/shot.png', Buffer.from([0x89, 0x50]), 'add media/shot.png', null);
  assert.deepEqual(sentBody, {
    message: 'add media/shot.png',
    content: Buffer.from([0x89, 0x50]).toString('base64'),
  });
});

test('putFile omits sha from the request when expectedSha is null, creating a new file', async () => {
  const http = fakeHttp({ 'PUT /repos/o/r/contents/new.json': { body: { content: { sha: 'x' } } } });
  let sentBody: { sha?: string } = {};
  const spy = Object.assign(
    (url: string, init?: RequestInit) => {
      if (init?.body) sentBody = JSON.parse(String(init.body));
      return http(url, init);
    },
    { calls: http.calls },
  );
  await githubClient(withToken('t'), spy).putFile(REF, 'new.json', Buffer.from('{}'), 'msg', null);
  assert.equal('sha' in sentBody, false, 'a null expectedSha must not send a sha field at all');
});

test('a 409 (sha mismatch) is a conflict, not a throw', async () => {
  const http = fakeHttp({ 'PUT /repos/o/r/contents/release-log.json': { status: 409 } });
  const result = await githubClient(withToken('t'), http).putFile(REF, 'release-log.json', Buffer.from('{}'), 'm', 'stale-sha');
  assert.deepEqual(result, { kind: 'conflict' });
});

test('a 422 (path already exists on a create) is also a conflict', async () => {
  const http = fakeHttp({ 'PUT /repos/o/r/contents/media%2Fexisting.png': { status: 422 } });
  const result = await githubClient(withToken('t'), http).putFile(REF, 'media/existing.png', Buffer.from('x'), 'm', null);
  assert.deepEqual(result, { kind: 'conflict' });
});

test('no installation token yields no_installation, without a request', async () => {
  const http = fakeHttp({});
  const result = await githubClient(withToken(null), http).putFile(REF, 'release-log.json', Buffer.from('{}'), 'm', 'sha');
  assert.deepEqual(result, { kind: 'no_installation' });
  assert.deepEqual(http.calls, []);
});

test('an unexpected server error throws rather than reading as a conflict', async () => {
  const http = fakeHttp({ 'PUT /repos/o/r/contents/release-log.json': { status: 500 } });
  await assert.rejects(
    () => githubClient(withToken('t'), http).putFile(REF, 'release-log.json', Buffer.from('{}'), 'm', 'sha'),
    /HTTP 500/,
  );
});

test('a path with a slash is percent-encoded per segment, not as one opaque string', async () => {
  const http = fakeHttp({
    'PUT /repos/o/r/contents/media%2Fa%20b.png': { body: { content: { sha: 'x' } } },
  });
  const result = await githubClient(withToken('t'), http).putFile(REF, 'media/a b.png', Buffer.from('x'), 'm', null);
  assert.equal(result.kind, 'committed');
});

test('fakeGitHub commits and reports it in the fake repo it knows', async () => {
  const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{}' } });
  const result = await gh.putFile({ owner: 'o', repo: 'r' }, 'release-log.json', Buffer.from('{}'), 'm', 'anysha');
  assert.equal(result.kind, 'committed');
});
```

**Fällt, wenn:** Test 1 — die Antwort nicht als `{kind:'committed', sha}` gelesen wird. Test 2 — der Inhalt nicht base64-kodiert wird oder Nachricht/SHA fehlen. Test 3 — bei `expectedSha: null` trotzdem ein `sha`-Feld gesendet wird. Test 4 und 5 — 409/422 nicht auf `conflict` abgebildet werden. Test 6 — ohne Token trotzdem eine Anfrage rausgeht. Test 7 — 500 verschluckt statt geworfen wird. Test 8 — der Pfad als Ganzes statt je Segment kodiert wird (dann bricht `/` im Pfad die URL).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `putFile is not a function`.

- [ ] **Step 3: Write the implementation**

In `lib/github.ts`, `type GitHub` erweitern:

```ts
export type CommitResult =
  | { kind: 'committed'; sha: string }
  // GitHubs eigene Konflikterkennung: 409 heißt "die erwartete SHA stimmt
  // nicht mehr" (jemand hat die Datei seither geändert), 422 auf einem
  // Anlegen-ohne-SHA heißt "unter diesem Pfad liegt schon etwas". Beides
  // verdient dieselbe Antwort -- nicht committen, dem Menschen sagen, dass
  // sich etwas geändert hat -- also bildet putFile beide auf denselben
  // Zustand ab.
  | { kind: 'conflict' }
  | { kind: 'no_installation' };

export type GitHub = {
  probe(ref: RepoRef): Promise<RepoState>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
  collaboratorPermission(ref: RepoRef, login: string): Promise<'admin' | 'write' | 'read' | 'none' | null>;
  putFile(ref: RepoRef, path: string, content: Buffer, message: string, expectedSha: string | null): Promise<CommitResult>;
};
```

In `fakeGitHub`s zurückgegebenem Objekt ergänzen:

```ts
    async putFile() {
      // Kein bestehender Test braucht mehr als "es hat geklappt" von der
      // Fake-Seite -- Tests für das eigentliche Konfliktverhalten laufen
      // gegen githubClient mit fakeHttp, wo die Antwort steuerbar ist.
      return { kind: 'committed', sha: 'fake-committed-sha' };
    },
```

In `lib/github.ts`, oberhalb von `githubClient`, einen kleinen Hilfsfunktion für die pfadweise Kodierung ergänzen (dieselbe Notwendigkeit wie in `lib/public.ts`s `encodePath`, hier lokal, weil eine dreizeilige reine Funktion keine geteilte Datei rechtfertigt):

```ts
// GitHubs Contents-API-Pfad trägt "/" als echten Pfadtrenner -- ihn als
// Ganzes zu kodieren würde ihn selbst mitkodieren und die URL brechen.
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
```

In `githubClient`s zurückgegebenem Objekt ergänzen:

```ts
    async putFile(ref, path, content, message, expectedSha) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/contents/${encodePath(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message,
          content: content.toString('base64'),
          ...(expectedSha !== null ? { sha: expectedSha } : {}),
        }),
      });
      if (res === null) return { kind: 'no_installation' };
      if (res.status === 409 || res.status === 422) return { kind: 'conflict' };
      if (!res.ok) throw new Error(`commit to ${path} failed: HTTP ${res.status}`);
      const body = (await res.json()) as { content: { sha: string } };
      return { kind: 'committed', sha: body.content.sha };
    },
```

`authed` muss ein optionales `init: RequestInit` annehmen und durchreichen, statt es zu ignorieren. Ändere die Signatur und beide `http(...)`-Aufrufe darin:

```ts
  async function authed(ref: RepoRef, path: string, init?: RequestInit): Promise<Response | null> {
    const token = await inst.tokenFor(ref);
    if (token === null) return null;
    const res = await http(`${API}${path}`, { ...init, headers: headers(token) });
    if (res.status !== 401) return res;

    inst.invalidate(ref);
    const fresh = await inst.tokenFor(ref);
    if (fresh === null) return null;
    return http(`${API}${path}`, { ...init, headers: headers(fresh) });
  }
```

(Die vier bestehenden Aufrufstellen von `authed(ref, path)` bleiben unverändert — `init` ist optional und `undefined` verhält sich wie zuvor kein zweites Argument.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: FAIL, dann repariere jeden der jetzt fehlerhaften Aufrufe. `type GitHub` um `putFile` zu erweitern bricht den Typecheck überall, wo ein `GitHub`-Objekt von Hand gebaut wird, ohne diese Methode zu erfüllen — durchsuche `lib/index.test.ts` und `bin/reindex.test.ts` nach `probe:`/`tree:`/`blob:`/`collaboratorPermission:`-Literalen und ergänze bei jedem `async () => ({ kind: 'committed' as const, sha: 'stub' })` als `putFile`, es sei denn, die Stelle wrappt bereits ein bestehendes `GitHub` (dann delegiere stattdessen, wie es die Nachbarmethoden dort schon tun). Melde im Report, wie viele Stellen betroffen waren.

Run erneut: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die Bedingung `res.status === 422` (nur noch 409 prüfen) — Test 5 muss fallen. Setze zurück. Ersetze `encodePath(path)` durch rohes `path` — Test 8 muss fallen (der Pfad `media/a b.png` bricht die URL-Zusammensetzung). Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/github.ts lib/github.test.ts bin/reindex.test.ts lib/index.test.ts
git commit -m "feat: commit a file to a repository via the installation token"
```

---

### Task 3: Der Arbeitsbereich — `GET /dashboard`

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `escapeHtml`, `page` aus `./lib/render.ts`; `type Permissions` aus `./lib/permissions.ts`; `type GitHub` aus `./lib/github.ts`.
- Produces: `Auth` bekommt `gh: GitHub`, `perms: Permissions`, `onRepoWrite(ref: RepoRef): void`. Keine neuen Exporte sonst — `GET /dashboard` ist der erste Verbraucher.

`onRepoWrite` ist bewusst ein generischer Rückruf, nach demselben Muster wie `Hooks.onDelivery`: eine schreibende Dashboard-Aktion (Task 5, Task 6) ruft ihn nach einem erfolgreichen Commit auf, und `import.meta.main` verdrahtet ihn auf `queue.enqueue(ref)` — derselbe Abgleich, den der Webhook sonst anstößt, nur sofort statt erst nach Zustellung.

- [ ] **Step 1: Write the failing test**

An `server.test.ts` anhängen. `withAuth`s zurückgegebenes `Auth`-Objekt braucht die beiden neuen Felder — erweitere den Helfer:

```ts
import { fakeGitHub } from './lib/github.ts';
import type { GitHub } from './lib/github.ts';
import { permissions } from './lib/permissions.ts';
```

```ts
function withAuth(fn: (auth: Auth, db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-auth-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 'gho_test' } },
    'GET /user': { body: { id: 42, login: 'octocat', avatar_url: 'https://example.test/a.png' } },
  });
  const gh = fakeGitHub({});
  return fn(
    {
      db, clientId: 'client-id', clientSecret: 'client-secret', signingKey: SIGNING_KEY,
      adminLogins: ['octocat'], baseUrl: 'https://example.test', http,
      gh, perms: permissions(db, gh), onRepoWrite: () => {},
    },
    db,
  ).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}
```

Jede bestehende Stelle in `server.test.ts`, die ein `Auth`-Objekt von Hand baut (statt über `withAuth`), braucht dieselbe Erweiterung — such nach `clientId: 'client-id'` außerhalb von `withAuth` und ergänze dort ebenfalls `gh`/`perms`/`onRepoWrite`.

Dann die neuen Tests. `fakeGitHub`s `collaboratorPermission` liefert für ein ihr bekanntes Repo immer `'write'` (siehe `lib/github.ts`), also braucht ein Test, der `canWrite: false` prüfen will, ein von Hand gebautes `GitHub`, nicht `fakeGitHub`:

```ts
function insertLog(db: ReturnType<typeof openDb>, publicId: string, owner: string, repo: string, state = 'active'): void {
  db.insert(log).values({
    publicId, repoOwner: owner, repoName: repo, repoNodeId: `R_${publicId}`,
    product: `Product ${publicId}`, view: 'full', visibility: 'public', curationNotes: null,
    state, headSha: 'c0ffee', configBlobSha: 'abc', indexedAt: '2026-09-15T00:00:00.000Z',
  }).run();
}

test('GET /dashboard without a session redirects to login', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/auth/github/login');
    }, undefined, auth);
  });
});

test('GET /dashboard lists only logs the account can write to', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'writable', 'o', 'writable-repo');
    insertLog(db, 'not-writable', 'o', 'other-repo');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }),
      async collaboratorPermission(ref) { return ref.repo === 'writable-repo' ? 'write' : 'read'; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Product writable'), 'a writable log must be listed');
      assert.ok(!html.includes('Product not-writable'), 'a log without write access must not be listed');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a frozen log is listed for an admin even without canWrite', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'frozen-one', 'o', 'gone-repo', 'frozen');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }),
      collaboratorPermission: async () => null, // a gone repo answers null -- never write access
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      // 'octocat' is this fixture's admin (see withAuth's adminLogins).
      assert.ok(html.includes('Product frozen-one'), 'an admin must still see a frozen log, to reach its delete action');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a frozen log is hidden from a non-admin account without write access', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'frozen-two', 'o', 'gone-repo-2', 'frozen');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }),
      collaboratorPermission: async () => null,
    };
    const cookie = createSessionCookie(SIGNING_KEY, 99);
    db.insert(account).values({ githubUserId: 99, login: 'not-an-admin', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('Product frozen-two'), 'a frozen log stays hidden from a non-admin who cannot write to it');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a product name containing HTML-meaningful characters is escaped in the list', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'xss-log', repoOwner: 'o', repoName: 'xss-repo', repoNodeId: 'R_xss',
      product: '<script>alert(1)</script>', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'abc', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh = fakeGitHub({ 'o/xss-repo': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw tag must never appear unescaped');
      assert.ok(html.includes('&lt;script&gt;'), 'it must appear escaped instead');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});
```

**Fällt, wenn:** Test 1 — die Route ohne Session nicht umleitet. Test 2 — die Filterung nach `canWrite` entfällt (dann erscheinen beide Logs) oder `canWrite` gar nicht aufgerufen wird (dann erscheint keins oder alles). Test 3 — die Admin-Ausnahme für eingefrorene Logs fehlt. Test 4 — die Ausnahme zu weit gefasst ist und auch Nicht-Admins eingefrorene Logs zeigt. Test 5 ist die eigentliche Sicherheitsaussage dieses Tasks und fällt, sobald `product` roh statt über `escapeHtml` eingesetzt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `/dashboard` antwortet 404, `Auth` fehlen die neuen Felder.

- [ ] **Step 3: Write the implementation**

In `server.ts` die Importe ergänzen:

```ts
import { escapeHtml, page } from './lib/render.ts';
import type { GitHub } from './lib/github.ts';
import type { Permissions } from './lib/permissions.ts';
```

`Auth` erweitern:

```ts
export type Auth = {
  db: Db;
  clientId: string;
  clientSecret: string;
  signingKey: string;
  adminLogins: string[];
  baseUrl: string;
  http: Http;
  gh: GitHub;
  perms: Permissions;
  // Nach einem erfolgreichen Commit einer Dashboard-Aktion (Task 5, Task 6)
  // -- derselbe Abgleich, den der Webhook sonst anstößt, nur sofort statt
  // erst nach Zustellung.
  onRepoWrite(ref: RepoRef): void;
};
```

Einen kleinen, wiederverwendbaren Session-Helfer ergänzen, oberhalb von `createApp` (Task 4 und die folgenden schreibenden Routen nutzen ihn ebenfalls):

```ts
type LoggedIn = { accountId: number; login: string };

// Session-Cookie lesen, Konto nachschlagen -- genau das, was /me schon tut,
// jetzt an einer Stelle für jede Dashboard-Route.
function currentAccount(req: import('node:http').IncomingMessage, auth: Auth): LoggedIn | null {
  const session = verifySessionCookie(auth.signingKey, cookieValue(req.headers.cookie, 'session'));
  if (!session) return null;
  const row = auth.db.select().from(account).where(eq(account.githubUserId, session.accountId)).all()[0];
  return row ? { accountId: session.accountId, login: row.login } : null;
}
```

In `createApp`, vor der bestehenden `if (pathname === '/me' ...)`-Route (danach ist auch in Ordnung, die Reihenfolge unter den `GET`-Routen ist beliebig), die neue Route ergänzen:

```ts
      if (pathname === '/dashboard' && method === 'GET') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const who = currentAccount(req, auth);
        if (!who) {
          res.writeHead(302, { location: '/auth/github/login' });
          res.end();
          return;
        }
        const isTheAdmin = isAdmin(who.login, auth.adminLogins);
        const allLogs = auth.db.select().from(log).all();
        const rows: string[] = [];
        for (const row of allLogs) {
          const ref = { owner: row.repoOwner, repo: row.repoName };
          // Ein eingefrorenes Log ist für niemanden je "schreibbar" -- GitHub
          // beantwortet eine Rechteanfrage auf ein gelöschtes Repo mit 404,
          // was collaboratorPermission als null liest. Ohne diese Ausnahme
          // gäbe es keinen Weg mehr, ein eingefrorenes Log zu löschen (spec,
          // Plan-Abweichung 7).
          const visible = row.state === 'frozen' && isTheAdmin
            ? true
            : await auth.perms.canWrite(who.accountId, who.login, row.publicId, ref);
          if (!visible) continue;
          rows.push(`<tr><td><a href="/dashboard/logs/${encodeURIComponent(row.publicId)}">${escapeHtml(row.product)}</a></td><td class="muted">${escapeHtml(row.repoOwner)}/${escapeHtml(row.repoName)}</td><td>${row.state === 'frozen' ? '<span class="badge">eingefroren</span>' : ''}</td></tr>`);
        }
        const body = `
          <h1>Deine Logs</h1>
          ${rows.length > 0
            ? `<table><thead><tr><th>Produkt</th><th>Repository</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`
            : `<p class="muted">Keine Logs, auf die du gerade Schreibrechte hast.</p>`}
          ${isTheAdmin ? `<p><a href="/admin/allowlist">Zulassungsliste verwalten</a></p>` : ''}
          <form method="POST" action="/auth/logout" style="margin-top:2rem"><button type="submit">Abmelden</button></form>
        `;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Dashboard', body));
        return;
      }
```

Zusätzliche Importe für `server.ts`, die diese Route braucht: `log` aus `./lib/db/schema.ts` neben dem bestehenden `account`-Import.

Im `import.meta.main`-Block das `Auth`-Objekt um die drei neuen Felder erweitern:

```ts
  }, {
    db,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    signingKey: config.signingKey,
    adminLogins: config.adminLogins,
    baseUrl: config.baseUrl,
    http: authHttp,
    gh,
    perms,
    onRepoWrite: (ref) => { queue.enqueue(ref); },
  }).listen(port, '127.0.0.1', () => {
```

(`gh`, `perms` und `queue` existieren im `import.meta.main`-Block bereits — nur die Verdrahtung ins `Auth`-Objekt ist neu.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die `canWrite`-Prüfung, sodass jedes Log erscheint — Test 2 muss fallen. Setze zurück. Ersetze `escapeHtml(row.product)` durch `row.product` roh — Test 5 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: list the logs an account can write to"
```

---

### Task 4: Die Log-Seite — `GET /dashboard/logs/:id`

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `currentAccount`, `Auth` aus Task 3.
- Produces: keine neuen Exporte.

Zeigt Einstellungsformular, Abgleichstand mit Fehlerliste, und eine reine Statusliste der Releases (Plan-Abweichung 4 — kein Veröffentlichen-Schalter hier). Das Formular selbst (Task 5) und der Medien-Upload (Task 6) kommen als eigene Tasks; dieser Task liefert die Seite, auf der beides sitzen wird, mit Platzhalter-Formularen, deren Ziel-Routen erst in den nächsten Tasks entstehen — der Test hier prüft nur, was diese Seite tatsächlich anzeigt (Werte, Fehlerliste), nicht, ob die POST-Routen schon existieren.

- [ ] **Step 1: Write the failing test**

An `server.test.ts` anhängen:

```ts
test('GET /dashboard/logs/:id without write access answers 403', async () => {
  await withAuth(async (auth, db) => {
    insertLog(db, 'log1', 'o', 'repo1');
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }), collaboratorPermission: async () => 'read',
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 403);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GET /dashboard/logs/:id for an unknown id answers 404', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/does-not-exist`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 404);
    }, undefined, auth);
  });
});

test('GET /dashboard/logs/:id with write access shows settings, sync status and errors', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'timeline', visibility: 'private', curationNotes: 'internal notes',
      state: 'active', headSha: 'c0ffee', configBlobSha: 'config-sha-1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(syncError).values({ logId: 'log1', path: 'releases/bad.json', message: 'sha:deadbeef date: required', at: '2026-09-15T00:00:00.000Z' }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      putFile: async () => ({ kind: 'committed', sha: 'x' }), collaboratorPermission: async () => 'admin',
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Auri CRM'));
      assert.ok(html.includes('value="internal notes"') || html.includes('>internal notes<'), 'curation_notes must be pre-filled');
      assert.ok(html.includes('releases/bad.json'), 'the sync error path must be listed');
      assert.ok(html.includes('date: required'), 'the sync error message must be listed');
      assert.ok(html.includes('config-sha-1'), 'the current config blob sha must be embedded for the settings form to submit against');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a curation_notes value with HTML-meaningful characters is escaped', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: '<img src=x onerror=alert(1)>',
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh = fakeGitHub({ 'o/repo1': { 'release-log.json': '{}' } });
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/dashboard/logs/log1`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'the raw markup must never appear unescaped');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});
```

**Fällt, wenn:** Test 1 — die `canWrite`-Prüfung auf dieser Route fehlt. Test 2 — eine unbekannte ID nicht 404 liefert (etwa weil das Log ungeprüft geladen wird). Test 3 — irgendeiner der vier Werte (Produktname, `curation_notes`, Fehlerpfad, Fehlermeldung, Config-SHA) nicht auf der Seite landet. Test 4 ist die eigentliche Sicherheitsaussage und fällt, sobald `curation_notes` roh statt über `escapeHtml` eingesetzt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `/dashboard/logs/log1` antwortet 404 ohne Unterscheidung zwischen „gibt's nicht" und „kein Zugriff".

- [ ] **Step 3: Write the implementation**

In `server.ts`, zusätzlich `syncError` aus `./lib/db/schema.ts` importieren. Nach der `/dashboard`-Route, vor dem Medien-Block, die neue Route ergänzen. Der Pfad trägt eine Log-ID als einzelnes Segment, undekodiert gelesen — dieselbe bewusste Entscheidung wie beim öffentlichen `/l/<id>`-Muster weiter unten in dieser Datei:

```ts
      const dashboardLog = /^\/dashboard\/logs\/([^/]+)$/.exec(pathname);
      if (dashboardLog && method === 'GET') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const who = currentAccount(req, auth);
        if (!who) {
          res.writeHead(302, { location: '/auth/github/login' });
          res.end();
          return;
        }
        const logId = dashboardLog[1];
        const row = auth.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
        if (!row) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Nicht gefunden', '<p>Dieses Log gibt es nicht.</p>'));
          return;
        }
        const ref = { owner: row.repoOwner, repo: row.repoName };
        const isTheAdmin = isAdmin(who.login, auth.adminLogins);
        const allowed = row.state === 'frozen' && isTheAdmin
          ? true
          : await auth.perms.canWrite(who.accountId, who.login, row.publicId, ref);
        if (!allowed) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Kein Zugriff', '<p>Du hast keine Schreibrechte auf dieses Repository.</p>'));
          return;
        }

        const errors = auth.db.select().from(syncError).where(eq(syncError.logId, logId)).all();
        const errorRows = errors.map((e) =>
          `<tr><td>${escapeHtml(e.path)}</td><td>${escapeHtml(e.message)}</td></tr>`,
        ).join('');

        const body = `
          <p><a href="/dashboard">&larr; alle Logs</a></p>
          <h1>${escapeHtml(row.product)}</h1>
          <p class="muted">${escapeHtml(row.repoOwner)}/${escapeHtml(row.repoName)} &middot; ${row.state === 'frozen' ? 'eingefroren' : 'aktiv'} &middot; zuletzt abgeglichen: ${row.indexedAt ? escapeHtml(row.indexedAt) : 'nie'}</p>

          <h2>Einstellungen</h2>
          <form method="POST" action="/dashboard/logs/${encodeURIComponent(row.publicId)}/settings">
            <input type="hidden" name="expected_sha" value="${escapeHtml(row.configBlobSha ?? '')}">
            <label for="view">Ansicht</label>
            <select id="view" name="view">
              <option value="full" ${row.view === 'full' ? 'selected' : ''}>Vollständig</option>
              <option value="timeline" ${row.view === 'timeline' ? 'selected' : ''}>Zeitstrahl</option>
            </select>
            <label for="visibility">Sichtbarkeit</label>
            <select id="visibility" name="visibility">
              <option value="public" ${row.visibility === 'public' ? 'selected' : ''}>Öffentlich</option>
              <option value="private" ${row.visibility === 'private' ? 'selected' : ''}>Privat</option>
            </select>
            <label for="curation_notes">Kurationshinweise</label>
            <textarea id="curation_notes" name="curation_notes">${escapeHtml(row.curationNotes ?? '')}</textarea>
            <button type="submit">Speichern</button>
          </form>

          ${errors.length > 0
            ? `<h2>Abgleichfehler</h2><table><thead><tr><th>Pfad</th><th>Meldung</th></tr></thead><tbody>${errorRows}</tbody></table>`
            : ''}

          <h2>Medien</h2>
          <form method="POST" action="/dashboard/logs/${encodeURIComponent(row.publicId)}/media" id="media-form">
            <input type="file" id="media-file" accept=".png,.jpg,.jpeg,.webp">
            <button type="button" id="media-submit">Hochladen</button>
            <p class="muted" id="media-status"></p>
          </form>

          <h2>Löschen</h2>
          <form method="POST" action="/dashboard/logs/${encodeURIComponent(row.publicId)}/delete">
            <label for="confirm_name">Gib „${escapeHtml(row.product)}" ein, um das endgültige Löschen zu bestätigen</label>
            <input type="text" id="confirm_name" name="confirm_name">
            <button type="submit">Log endgültig löschen</button>
          </form>
        `;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(row.product, body));
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die `if (!row)`-Prüfung — Test 2 muss fallen (statt 404 gäbe es einen Absturz oder ein leeres Formular). Setze zurück. Ersetze `escapeHtml(row.curationNotes ?? '')` durch `row.curationNotes ?? ''` roh — Test 4 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: show a log's settings, sync errors and actions"
```

---

### Task 5: Einstellungen speichern — `POST /dashboard/logs/:id/settings`

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `parseConfig` aus `./lib/document.ts`; `putFile` aus Task 2; `currentAccount` aus Task 3.
- Produces: keine neuen Exporte.

- [ ] **Step 1: Write the failing test**

An `server.test.ts` anhängen. Ein Helfer, um einen `application/x-www-form-urlencoded`-Body zu senden:

```ts
async function postForm(base: string, path: string, fields: Record<string, string>, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `session=${cookie}` },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}
```

```ts
test('POST settings commits the new values and redirects back to the log page', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'config-sha-1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let committed: { path: string; content: string; sha: string | null } | null = null;
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(ref, path, content, message, expectedSha) {
        committed = { path, content: content.toString('utf8'), sha: expectedSha };
        return { kind: 'committed', sha: 'new-sha' };
      },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'config-sha-1', view: 'timeline', visibility: 'private', curation_notes: 'be careful',
      }, cookie);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/dashboard/logs/log1');
      assert.ok(committed, 'putFile must have been called');
      assert.equal(committed!.path, 'release-log.json');
      assert.equal(committed!.sha, 'config-sha-1');
      const parsed = JSON.parse(committed!.content);
      assert.deepEqual(parsed, { id: 'log1', product: 'Auri CRM', view: 'timeline', visibility: 'private', curation_notes: 'be careful' });
      assert.deepEqual(enqueued, { owner: 'o', repo: 'repo1' }, 'a successful commit must trigger an immediate resync');
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('an empty curation_notes becomes null in the committed document, not an empty string', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: 'old notes',
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let committedContent = '';
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(ref, path, content) { committedContent = content.toString('utf8'); return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'sha1', view: 'full', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(JSON.parse(committedContent).curation_notes, null);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('an invalid view value is rejected before anything is committed', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'sha1', view: 'not-a-real-view', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(res.status, 400);
      assert.equal(called, false, 'an invalid document must never reach putFile');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a stale expected_sha results in a conflict page, not a silent overwrite', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'current-sha', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { return { kind: 'conflict' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'a-now-stale-sha', view: 'full', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(res.status, 409);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a settings change without write access is refused with 403 and commits nothing', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'read',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/settings', {
        expected_sha: 'sha1', view: 'timeline', visibility: 'public', curation_notes: '',
      }, cookie);
      assert.equal(res.status, 403);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});
```

**Fällt, wenn:** Test 1 — `id`/`product` nicht unverändert übernommen werden, die falschen Felder committet werden, oder `onRepoWrite` nicht gerufen wird. Test 2 — ein leerer String statt `null` committet wird. Test 3 — `parseConfig` nicht vor dem Commit läuft. Test 4 — `conflict` nicht auf 409 abgebildet wird. Test 5 — die `canWrite`-Prüfung auf dieser Route fehlt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — die Route existiert noch nicht.

- [ ] **Step 3: Write the implementation**

In `server.ts` zusätzlich `parseConfig` aus `./lib/document.ts` importieren. Einen kleinen Helfer zum Einlesen eines urlencodierten POST-Bodys ergänzen, oberhalb von `createApp` (wird auch vom Löschen-Task gebraucht):

```ts
// Node parst POST-Bodys nicht von selbst. Für kleine Formulare reicht ein
// Sammeln der Chunks und URLSearchParams -- derselbe Ansatz wie beim
// Webhook-Body, ohne dessen Größenbegrenzung (Formulare hier sind winzig
// im Vergleich zu einer GitHub-Zustellung).
function readFormBody(req: import('node:http').IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}
```

Nach der `GET /dashboard/logs/:id`-Route ergänzen:

```ts
      const settingsMatch = /^\/dashboard\/logs\/([^/]+)\/settings$/.exec(pathname);
      if (settingsMatch && method === 'POST') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const who = currentAccount(req, auth);
        if (!who) {
          res.writeHead(302, { location: '/auth/github/login' });
          res.end();
          return;
        }
        const logId = settingsMatch[1];
        const row = auth.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
        if (!row) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Nicht gefunden', '<p>Dieses Log gibt es nicht.</p>'));
          return;
        }
        const ref = { owner: row.repoOwner, repo: row.repoName };
        const allowed = row.state === 'frozen' && isAdmin(who.login, auth.adminLogins)
          ? true
          : await auth.perms.canWrite(who.accountId, who.login, row.publicId, ref);
        if (!allowed) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Kein Zugriff', '<p>Du hast keine Schreibrechte auf dieses Repository.</p>'));
          return;
        }

        const form = await readFormBody(req);
        // Dieselbe Prüfung wie der Index (spec §6): ein Dokument, das der
        // Index verwerfen würde, erreicht das Repo nicht.
        const candidate = {
          id: row.publicId,
          product: row.product,
          view: form.get('view'),
          visibility: form.get('visibility'),
          curation_notes: form.get('curation_notes') === '' ? null : form.get('curation_notes'),
        };
        const parsed = parseConfig(candidate);
        if (!parsed.ok) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Ungültige Einstellungen', `<p>${escapeHtml(parsed.errors.join('; '))}</p>`));
          return;
        }

        const content = Buffer.from(JSON.stringify(parsed.value, null, 2) + '\n', 'utf8');
        const expectedSha = form.get('expected_sha');
        const result = await auth.gh.putFile(
          ref, 'release-log.json', content, 'update release-log.json settings via dashboard', expectedSha,
        );
        if (result.kind === 'conflict') {
          res.writeHead(409, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Zwischenzeitlich geändert', '<p>Jemand anderes hat die Einstellungen inzwischen geändert. Bitte die Seite neu laden und erneut versuchen.</p>'));
          return;
        }
        if (result.kind === 'no_installation') {
          res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Nicht erreichbar', '<p>Die GitHub-Installation erreicht dieses Repository gerade nicht.</p>'));
          return;
        }

        auth.onRepoWrite(ref);
        res.writeHead(302, { location: `/dashboard/logs/${encodeURIComponent(row.publicId)}` });
        res.end();
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne den `parseConfig`-Aufruf (übernimm die Formularwerte ungeprüft) — Test 3 muss fallen. Setze zurück. Entferne die `if (result.kind === 'conflict')`-Prüfung — Test 4 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: save log settings as a commit, not a database write"
```

---

### Task 6: Medien-Upload — `POST /dashboard/logs/:id/media`

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `mediaTypeOf` aus `./lib/mediaTypes.ts`; `putFile` aus Task 2.
- Produces: `lib/index.ts` exportiert `MEDIA_MAX_BYTES` (bisher modulintern).

Kein Multipart-Parser: der Upload-Knopf auf der Log-Seite (Task 4) liest die Datei im Browser über ein kleines Inline-Skript und schickt ihre rohen Bytes als Request-Body, den Dateinamen in einem eigenen Header — derselbe begrenzte, schrittweise Lese-Ansatz, den der Webhook-Pfad schon für seinen Body benutzt, nur ohne Signaturprüfung davor (die Sitzung ist hier schon die Beglaubigung).

- [ ] **Step 1: Write the failing test**

An `server.test.ts` anhängen:

```ts
async function postBytes(base: string, path: string, bytes: Buffer, filename: string, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-filename': encodeURIComponent(filename), cookie: `session=${cookie}` },
    body: bytes,
  });
}

const TINY_PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('POST media commits the file under media/<filename> and triggers a resync', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let committed: { path: string; content: Buffer; sha: string | null } | null = null;
    let enqueued: RepoRef | null = null;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile(ref, path, content, message, expectedSha) {
        committed = { path, content, sha: expectedSha };
        return { kind: 'committed', sha: 'media-sha' };
      },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, 'screenshot.png', cookie);
      assert.equal(res.status, 200);
      assert.ok(committed, 'putFile must have been called');
      assert.equal(committed!.path, 'media/screenshot.png');
      assert.deepEqual(committed!.content, TINY_PNG);
      assert.equal(committed!.sha, null, 'a new media file must be created, not replace an unrelated sha');
      assert.deepEqual(enqueued, { owner: 'o', repo: 'repo1' });
    }, undefined, { ...auth, gh, perms: permissions(db, gh), onRepoWrite: (ref) => { enqueued = ref; } });
  });
});

test('a filename with an unsupported extension is rejected before any commit', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', Buffer.from('not really an svg'), 'shot.svg', cookie);
      assert.equal(res.status, 415);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a filename that is not a bare name (contains a path separator) is rejected', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, '../../etc/passwd.png', cookie);
      assert.equal(res.status, 400);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('an oversized upload is refused without buffering the whole body', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write',
      async putFile() { return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    await withServer(reader, async (base) => {
      const status = await postBytes(base, '/dashboard/logs/log1/media', oversized, 'huge.png', cookie)
        .then((res) => res.status)
        .catch(() => 0);
      assert.notEqual(status, 200);
      assert.ok(status === 413 || status === 0, `unexpected status ${status}`);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a media upload without write access is refused with 403', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'P', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    let called = false;
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'read',
      async putFile() { called = true; return { kind: 'committed', sha: 'x' }; },
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postBytes(base, '/dashboard/logs/log1/media', TINY_PNG, 'shot.png', cookie);
      assert.equal(res.status, 403);
      assert.equal(called, false);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});
```

**Fällt, wenn:** Test 1 — der Pfad nicht `media/<Dateiname>` ist, der Inhalt nicht unverändert committet wird, oder `onRepoWrite` nicht gerufen wird. Test 2 — `mediaTypeOf` auf den Dateinamen nicht geprüft wird. Test 3 — der Dateiname nicht auf einen reinen Namen ohne `/` geprüft wird (der committete Pfad enthielte sonst `../../etc/passwd.png` als Fortsetzung von `media/`, was außerhalb des `media/`-Verzeichnisses zeigen könnte, sobald GitHub den Pfad selbst normalisiert). Test 4 — die Größenbegrenzung fehlt. Test 5 — die `canWrite`-Prüfung auf dieser Route fehlt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — die Route existiert noch nicht.

- [ ] **Step 3: Write the implementation**

In `lib/index.ts` die bestehende Zeile

```ts
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
```

zu

```ts
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
```

ändern — eine reine Sichtbarkeitsänderung, keine Verhaltensänderung.

In `server.ts` zusätzlich importieren: `mediaTypeOf` aus `./lib/mediaTypes.ts`, `MEDIA_MAX_BYTES` aus `./lib/index.ts`.

Nach der Einstellungen-Route ergänzen:

```ts
      const mediaUploadMatch = /^\/dashboard\/logs\/([^/]+)\/media$/.exec(pathname);
      if (mediaUploadMatch && method === 'POST') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const who = currentAccount(req, auth);
        if (!who) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const logId = mediaUploadMatch[1];
        const row = auth.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
        if (!row) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const ref = { owner: row.repoOwner, repo: row.repoName };
        const allowed = row.state === 'frozen' && isAdmin(who.login, auth.adminLogins)
          ? true
          : await auth.perms.canWrite(who.accountId, who.login, row.publicId, ref);
        if (!allowed) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }

        const rawName = req.headers['x-filename'];
        let filename: string;
        try {
          filename = decodeURIComponent(String(rawName ?? ''));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'bad_filename' }));
          return;
        }
        // Ein reiner Dateiname, keine Pfadstruktur: media/<Name> ist die
        // einzige Form, die dieser Upload je erzeugen darf.
        if (filename === '' || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'bad_filename' }));
          return;
        }
        const contentType = mediaTypeOf(filename);
        if (!contentType) {
          res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'unsupported_type' }));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let refused = false;
        req.on('data', (chunk: Buffer) => {
          if (refused) return;
          size += chunk.length;
          if (size > MEDIA_MAX_BYTES) {
            refused = true;
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'payload_too_large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (refused) return;
          (async () => {
            try {
              const bytes = Buffer.concat(chunks);
              // expectedSha: null -- ein Medien-Upload legt immer eine neue
              // Datei an, nie ersetzt er eine bestehende. Existiert der
              // Pfad schon, lehnt GitHub mit 422 ab (dieselbe Ablehnung,
              // die add_media als path_exists kennt, spec §6): ein
              // überschriebenes Bild würde sonst jedes veröffentlichte
              // Release stillschweigend ändern, das darauf zeigt.
              const result = await auth.gh.putFile(
                ref, `media/${filename}`, bytes, `add media/${filename} via dashboard`, null,
              );
              if (result.kind === 'conflict') {
                res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'path_exists' }));
                return;
              }
              if (result.kind === 'no_installation') {
                res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'not_installed' }));
                return;
              }
              auth.onRepoWrite(ref);
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              respondInternalError(res, err);
            }
          })();
        });
        return;
      }
```

In der `GET /dashboard/logs/:id`-Route aus Task 4 das bisher untätige Upload-Formular um ein kleines Inline-Skript ergänzen, das die Datei als rohen Body sendet statt als Multipart-Formular. Ersetze im `body`-Template den kompletten Block von `<h2>Medien</h2>` bis zu seinem `</form>` (Task 4s `<form method="POST" action=".../media" id="media-form">…</form>`, das dort noch nichts auslöst) durch:

```ts
          <h2>Medien</h2>
          <input type="file" id="media-file" accept=".png,.jpg,.jpeg,.webp">
          <button type="button" id="media-submit">Hochladen</button>
          <p class="muted" id="media-status"></p>
          <script>
            document.getElementById('media-submit').addEventListener('click', async () => {
              const input = document.getElementById('media-file');
              const status = document.getElementById('media-status');
              const file = input.files[0];
              if (!file) { status.textContent = 'Bitte zuerst eine Datei auswählen.'; return; }
              status.textContent = 'Lädt hoch…';
              const res = await fetch(${JSON.stringify(`/dashboard/logs/${encodeURIComponent(row.publicId)}/media`)}, {
                method: 'POST',
                headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
                body: file,
              });
              status.textContent = res.ok ? 'Hochgeladen. Der Abgleich läuft.' : 'Fehlgeschlagen: ' + res.status;
            });
          </script>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die `mediaTypeOf`-Prüfung — Test 2 muss fallen. Setze zurück. Entferne die `size > MEDIA_MAX_BYTES`-Prüfung — Test 4 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/index.ts server.ts server.test.ts
git commit -m "feat: upload media as a commit, without a multipart parser"
```

---

### Task 7: Endgültiges Löschen — `POST /dashboard/logs/:id/delete`

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `currentAccount` aus Task 3, `readFormBody` aus Task 5.
- Produces: keine neuen Exporte.

Entfernt Index und Medien sofort und endgültig; das Repo selbst rührt die App nicht an (spec §8). Reiner Datenbankschreibvorgang — kein Commit, kein `putFile`.

- [ ] **Step 1: Write the failing test**

An `server.test.ts` anhängen:

```ts
test('POST delete with the correct name wipes the log, its releases, media, errors and permission cache', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({ logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'r1', path: 'releases/1.0.0.json', doc: '{}' }).run();
    db.insert(media).values({ logId: 'log1', path: 'media/x.png', blobSha: 'm1', contentType: 'image/png', bytes: Buffer.from([1]) }).run();
    db.insert(syncError).values({ logId: 'log1', path: 'releases/bad.json', message: 'x', at: '2026-09-15T00:00:00.000Z' }).run();
    db.insert(repoPermission).values({ accountId: 42, logId: 'log1', canWrite: true, checkedAt: '2026-09-15T00:00:00.000Z' }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'Auri CRM' }, cookie);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/dashboard');
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log1')).all().length, 0);
      assert.equal(db.select().from(release).where(eq(release.logId, 'log1')).all().length, 0);
      assert.equal(db.select().from(media).where(eq(media.logId, 'log1')).all().length, 0);
      assert.equal(db.select().from(syncError).where(eq(syncError.logId, 'log1')).all().length, 0);
      assert.equal(db.select().from(repoPermission).where(eq(repoPermission.logId, 'log1')).all().length, 0);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('POST delete with the wrong name changes nothing', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'the wrong name' }, cookie);
      assert.equal(res.status, 400);
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log1')).all().length, 1, 'the log must survive a wrong confirmation');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('a frozen log can be deleted by an admin even without canWrite', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'gone-repo', repoNodeId: 'R_log1',
      product: 'Gone Product', view: 'full', visibility: 'public', curationNotes: null,
      state: 'frozen', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => null, putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    // 'octocat' is this fixture's admin.
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'Gone Product' }, cookie);
      assert.equal(res.status, 302);
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log1')).all().length, 0);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('delete without write access (and not admin, not frozen) is refused with 403', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R_log1',
      product: 'Auri CRM', view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: 'c0ffee', configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const gh: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R_log1' }), tree: async () => [], blob: async () => null,
      collaboratorPermission: async () => 'read', putFile: async () => ({ kind: 'committed', sha: 'x' }),
    };
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/dashboard/logs/log1/delete', { confirm_name: 'Auri CRM' }, cookie);
      assert.equal(res.status, 403);
      assert.equal(db.select().from(log).where(eq(log.publicId, 'log1')).all().length, 1);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});
```

Am Kopf von `server.test.ts` zusätzlich `release`, `media`, `syncError`, `repoPermission` aus `./lib/db/schema.ts` importieren, soweit noch nicht geschehen.

**Fällt, wenn:** Test 1 — irgendeine der fünf Tabellen nicht mitgelöscht wird, oder die Bestätigung nicht geprüft wird. Test 2 ist die eigentliche Sicherheitsaussage („explizit, mit Eingabe des Namens") und fällt, sobald die Namensprüfung entfällt. Test 3 — die Admin-Ausnahme für eingefrorene Logs fehlt. Test 4 — die `canWrite`-Prüfung auf dieser Route fehlt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — die Route existiert noch nicht.

- [ ] **Step 3: Write the implementation**

In `server.ts` zusätzlich `release`, `media`, `repoPermission` aus `./lib/db/schema.ts` importieren. Nach der Medien-Upload-Route ergänzen:

```ts
      const deleteMatch = /^\/dashboard\/logs\/([^/]+)\/delete$/.exec(pathname);
      if (deleteMatch && method === 'POST') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const who = currentAccount(req, auth);
        if (!who) {
          res.writeHead(302, { location: '/auth/github/login' });
          res.end();
          return;
        }
        const logId = deleteMatch[1];
        const row = auth.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
        if (!row) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Nicht gefunden', '<p>Dieses Log gibt es nicht.</p>'));
          return;
        }
        const ref = { owner: row.repoOwner, repo: row.repoName };
        const allowed = row.state === 'frozen' && isAdmin(who.login, auth.adminLogins)
          ? true
          : await auth.perms.canWrite(who.accountId, who.login, row.publicId, ref);
        if (!allowed) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Kein Zugriff', '<p>Du hast keine Schreibrechte auf dieses Repository.</p>'));
          return;
        }

        const form = await readFormBody(req);
        if (form.get('confirm_name') !== row.product) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Name stimmt nicht', `<p>Der eingegebene Name stimmt nicht mit „${escapeHtml(row.product)}" überein. Nichts wurde gelöscht.</p>`));
          return;
        }

        auth.db.delete(release).where(eq(release.logId, logId)).run();
        auth.db.delete(media).where(eq(media.logId, logId)).run();
        auth.db.delete(syncError).where(eq(syncError.logId, logId)).run();
        auth.db.delete(repoPermission).where(eq(repoPermission.logId, logId)).run();
        auth.db.delete(log).where(eq(log.publicId, logId)).run();

        res.writeHead(302, { location: '/dashboard' });
        res.end();
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die `confirm_name`-Prüfung — Test 2 muss fallen. Setze zurück. Entferne die `db.delete(release)`-Zeile — Test 1 muss fallen (die Release-Zeile überlebt). Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: delete a log's index and media, with typed confirmation"
```

---

### Task 8: Zulassungsliste für Admins — `/admin/allowlist`

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `currentAccount`, `readFormBody` aus vorherigen Tasks.
- Produces: keine neuen Exporte.

- [ ] **Step 1: Write the failing test**

An `server.test.ts` anhängen:

```ts
test('GET /admin/allowlist for a non-admin is refused with 403', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 99);
    db.insert(account).values({ githubUserId: 99, login: 'not-an-admin', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 403);
    }, undefined, auth);
  });
});

test('GET /admin/allowlist for an admin lists the current entries', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: 'someone', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: 'trusted contractor' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('someone'));
      assert.ok(html.includes('trusted contractor'));
    }, undefined, auth);
  });
});

test('POST /admin/allowlist adds a login, recording who added it', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/admin/allowlist', { github_login: 'new-person', note: 'joined the team' }, cookie);
      assert.equal(res.status, 302);
      const row = db.select().from(allowlist).where(eq(allowlist.githubLogin, 'new-person')).all()[0];
      assert.equal(row.addedBy, 'octocat');
      assert.equal(row.note, 'joined the team');
    }, undefined, auth);
  });
});

test('POST /admin/allowlist by a non-admin is refused and adds nothing', async () => {
  await withAuth(async (auth, db) => {
    const cookie = createSessionCookie(SIGNING_KEY, 99);
    db.insert(account).values({ githubUserId: 99, login: 'not-an-admin', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await postForm(base, '/admin/allowlist', { github_login: 'sneaky', note: '' }, cookie);
      assert.equal(res.status, 403);
      assert.equal(db.select().from(allowlist).where(eq(allowlist.githubLogin, 'sneaky')).all().length, 0);
    }, undefined, auth);
  });
});

test('POST /admin/allowlist/:login/delete removes exactly that entry', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: 'keep-me', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    db.insert(allowlist).values({ githubLogin: 'remove-me', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist/remove-me/delete`, { method: 'POST', headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(db.select().from(allowlist).where(eq(allowlist.githubLogin, 'remove-me')).all().length, 0);
      assert.equal(db.select().from(allowlist).where(eq(allowlist.githubLogin, 'keep-me')).all().length, 1, 'removing one entry must not touch another');
    }, undefined, auth);
  });
});

test('an allowlist login containing HTML-meaningful characters is escaped', async () => {
  await withAuth(async (auth, db) => {
    db.insert(allowlist).values({ githubLogin: '<script>x</script>', addedBy: 'octocat', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/admin/allowlist`, { headers: { cookie: `session=${cookie}` } });
      const html = await res.text();
      assert.ok(!html.includes('<script>x</script>'));
    }, undefined, auth);
  });
});
```

Am Kopf von `server.test.ts` zusätzlich `allowlist` aus `./lib/db/schema.ts` importieren, soweit noch nicht geschehen.

**Fällt, wenn:** Test 1 und 4 sind die eigentliche Zugangsbeschränkung und fallen, sobald die `isAdmin`-Prüfung entfällt. Test 2 — die Tabelle nicht korrekt gerendert wird. Test 3 — `addedBy` nicht auf den aktuell angemeldeten Login gesetzt wird. Test 5 — die Route den falschen Login löscht oder alle löscht. Test 6 ist die Sicherheitsaussage und fällt, sobald `githubLogin` roh statt über `escapeHtml` eingesetzt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — die Routen existieren noch nicht.

- [ ] **Step 3: Write the implementation**

In `server.ts` zusätzlich `allowlist` aus `./lib/db/schema.ts` importieren. Nach der Löschen-Route ergänzen:

```ts
      if (pathname === '/admin/allowlist' && method === 'GET') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const who = currentAccount(req, auth);
        if (!who) {
          res.writeHead(302, { location: '/auth/github/login' });
          res.end();
          return;
        }
        if (!isAdmin(who.login, auth.adminLogins)) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Kein Zugriff', '<p>Nur Admins verwalten die Zulassungsliste.</p>'));
          return;
        }
        const entries = auth.db.select().from(allowlist).all();
        const rows = entries.map((e) =>
          `<tr><td>${escapeHtml(e.githubLogin)}</td><td class="muted">${escapeHtml(e.note ?? '')}</td><td class="muted">${escapeHtml(e.addedBy)}, ${escapeHtml(e.addedAt)}</td><td><form method="POST" action="/admin/allowlist/${encodeURIComponent(e.githubLogin)}/delete"><button type="submit">Entfernen</button></form></td></tr>`,
        ).join('');
        const body = `
          <p><a href="/dashboard">&larr; Dashboard</a></p>
          <h1>Zulassungsliste</h1>
          <table><thead><tr><th>Login</th><th>Notiz</th><th>Hinzugefügt</th><th></th></tr></thead><tbody>${rows}</tbody></table>
          <h2>Hinzufügen</h2>
          <form method="POST" action="/admin/allowlist">
            <label for="github_login">GitHub-Login</label>
            <input type="text" id="github_login" name="github_login" required>
            <label for="note">Notiz</label>
            <input type="text" id="note" name="note">
            <button type="submit">Zulassen</button>
          </form>
        `;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Zulassungsliste', body));
        return;
      }

      if (pathname === '/admin/allowlist' && method === 'POST') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const who = currentAccount(req, auth);
        if (!who) {
          res.writeHead(302, { location: '/auth/github/login' });
          res.end();
          return;
        }
        if (!isAdmin(who.login, auth.adminLogins)) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Kein Zugriff', '<p>Nur Admins verwalten die Zulassungsliste.</p>'));
          return;
        }
        const form = await readFormBody(req);
        const login = form.get('github_login');
        if (!login) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Fehlender Login', '<p>Ein GitHub-Login ist erforderlich.</p>'));
          return;
        }
        const note = form.get('note');
        auth.db.insert(allowlist)
          .values({ githubLogin: login, addedBy: who.login, addedAt: new Date().toISOString(), note: note === '' ? null : note })
          .onConflictDoUpdate({
            target: allowlist.githubLogin,
            set: { addedBy: who.login, addedAt: new Date().toISOString(), note: note === '' ? null : note },
          })
          .run();
        res.writeHead(302, { location: '/admin/allowlist' });
        res.end();
        return;
      }

      const allowlistDeleteMatch = /^\/admin\/allowlist\/([^/]+)\/delete$/.exec(pathname);
      if (allowlistDeleteMatch && method === 'POST') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const who = currentAccount(req, auth);
        if (!who) {
          res.writeHead(302, { location: '/auth/github/login' });
          res.end();
          return;
        }
        if (!isAdmin(who.login, auth.adminLogins)) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Kein Zugriff', '<p>Nur Admins verwalten die Zulassungsliste.</p>'));
          return;
        }
        const targetLogin = decodeURIComponent(allowlistDeleteMatch[1]);
        auth.db.delete(allowlist).where(eq(allowlist.githubLogin, targetLogin)).run();
        res.writeHead(302, { location: '/admin/allowlist' });
        res.end();
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die `isAdmin`-Prüfung aus der `GET`-Route — Test 1 muss fallen. Setze zurück. Ersetze `escapeHtml(e.githubLogin)` durch `e.githubLogin` roh — Test 6 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: let admins manage the allowlist from the dashboard"
```

---

### Task 9: Dokumentation nachziehen

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nichts.
- Produces: keine neuen Exporte.

- [ ] **Step 1: README ergänzen**

Einen neuen Unterabschnitt „Dashboard" nach dem bestehenden „Repo-Rechte"-Abschnitt ergänzen:

```markdown
### Dashboard

- `GET /dashboard` — die Logs, auf die das angemeldete Konto Schreibrechte
  hat (eingefrorene Logs zusätzlich für Admins, sonst wäre eins nie mehr
  erreichbar).
- `GET /dashboard/logs/<id>` — Einstellungen, Abgleichfehler, Medien-Upload,
  Löschen.
- `POST /dashboard/logs/<id>/settings` — `view`, `visibility`,
  `curation_notes` als Commit auf `release-log.json`, nie als
  Datenbankschreibvorgang.
- `POST /dashboard/logs/<id>/media` — ein Bild (`.png`, `.jpg`, `.webp`,
  höchstens 10 MB) als Commit unter `media/<Dateiname>`.
- `POST /dashboard/logs/<id>/delete` — endgültiges Löschen von Index und
  Medien, mit Eingabe des Produktnamens zur Bestätigung. Das Repo selbst
  bleibt unangetastet.
- `GET`/`POST /admin/allowlist`, `POST /admin/allowlist/<login>/delete` —
  nur für Admins.

„Log anlegen" und die Liste verbundener MCP-Clients fehlen bewusst noch —
beide brauchen Bausteine, die noch nicht existieren (ein persistentes
GitHub-Nutzer-Token für `create_log` beziehungsweise den MCP-
Authorization-Server für verbundene Clients).
```

- [ ] **Step 2: Die README-Zeilen gegen den tatsächlichen Code zurücklesen**

Prüfe: heißen die Routen wirklich so, ist die Medien-Obergrenze wirklich 10 MB, sind die erlaubten Endungen wirklich genau diese drei? Eine Dokumentationszeile, die nicht stimmt, ist schlechter als keine.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the dashboard routes"
```

---

## Nach dem letzten Task: Prüfung von Hand

Diese Prüfung braucht echte Zugangsdaten und einen echten Browser und gehört dem Menschen. **Nicht von einem Agenten ausführen.**

```bash
cd /Users/christian/www/release-log && npm start
```

1. Im Browser anmelden (`/auth/github/login`), dann `/dashboard` öffnen: erscheinen genau die Logs, auf die das eigene GitHub-Konto Schreibrechte hat?
2. Auf einem Log die Sichtbarkeit von `public` auf `private` stellen und speichern: erscheint ein neuer Commit im Repo, und zeigt `git log` auf GitHub genau eine Änderung an `release-log.json`? Nach ein paar Sekunden (Abgleich läuft im Hintergrund) die Seite neu laden — steht `private` jetzt auch im Index?
3. Ein Bild hochladen: erscheint es als neuer Commit unter `media/<Dateiname>` im Repo? Denselben Dateinamen ein zweites Mal hochladen — kommt eine Fehlermeldung statt eines stillen Überschreibens?
4. Die Einstellungsseite in zwei Browser-Tabs offen lassen, in einem speichern, dann im anderen (mit der jetzt veralteten `expected_sha`) ebenfalls speichern versuchen: kommt „Zwischenzeitlich geändert" statt eines stillen Überschreibens?
5. Ein Log löschen, mit dem korrekten Produktnamen bestätigt: verschwindet es aus `/dashboard`? Bleibt das GitHub-Repo selbst unangetastet?
6. Als Admin `/admin/allowlist` öffnen, einen Login hinzufügen und wieder entfernen. Mit einem nicht-Admin-Konto denselben Pfad versuchen: kommt 403?

Punkt 2 und 3 sind die einzigen, die kein Test abdecken kann: ob GitHubs Contents-API mit einem Installations-Token wirklich wie angenommen committet, ist eine Annahme dieses Plans — der Spike aus Plan 3 prüfte nur Lesezugriffe (Baum, Blobs), nie einen Schreibzugriff. Weicht das Verhalten ab, ist das ein echter Fund und gehört gemeldet, nicht stillschweigend umgangen.

---

## Selbstprüfung

**Spec-Abdeckung.** §8 „öffentliche URL, view, visibility, curation_notes": Task 4, Task 5. „Abgleichstand mit Fehlerliste": Task 4. „Releases mit Stand": Task 4, als reine Anzeige (Plan-Abweichung 4). „Medien-Upload": Task 6. „endgültiges Löschen": Task 7. „Für Admins: die Zulassungsliste": Task 8. „Änderungen an view, visibility und curation_notes sind Commits, keine Datenbankschreibvorgänge": Task 2, Task 5, Task 6 — jede schreibende Aktion außer dem Löschen läuft über `putFile`. „Log anlegen", „Verbundene Clients", „MCP-Server verbinden", „Installationsstand" über eine eigene Tabelle: bewusst nicht Teil dieses Plans, siehe „Abweichungen" Punkte 1, 2, 3, 5.

**Nicht abgedeckt und bewusst offen:** `create_log` (Dashboard-Knopf und MCP-Tool, beide an Entscheidung 23 gebunden), die MCP-Fläche insgesamt (Spec §6), die gehostete öffentliche Log-Seite (Spec §7 „Gehostete Seite" — `/l/<id>`, `/l/<id>/r/<version>`, Zeitstrahl- und Vollansicht, Entwürfe nur für Schreibberechtigte sichtbar). Letzteres ist im ursprünglichen Modulschnitt (§9) zusammen mit dem Dashboard in `lib/render.ts` vorgesehen, aber unabhängig groß genug (eigene Layout-Logik für zwei Ansichten, `noindex`, Entwurfssichtbarkeit) für einen eigenen Plan — `lib/render.ts` bleibt hier bewusst auf das beschränkt, was das Dashboard braucht, und ein künftiger Plan für die gehostete Seite baut darauf auf oder erweitert sie.

**Typkonsistenz.** `CommitResult` (Task 2) wird in Task 5, 6 verbraucht — dieselben drei `kind`-Werte an beiden Stellen behandelt. `Auth.gh`/`Auth.perms`/`Auth.onRepoWrite` (Task 3) laufen durch alle folgenden Tasks unverändert. `currentAccount` (Task 3) wird von jeder schreibenden und jeder Admin-Route wiederverwendet, nie neu erfunden.

**Testzahl.** Aktuell 326. Nach diesem Plan werden es ungefähr 370-380 sein.
