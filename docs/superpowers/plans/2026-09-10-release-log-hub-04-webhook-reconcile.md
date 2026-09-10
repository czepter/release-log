# Webhook, Reconcile und Lebenszyklus — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Index gleicht sich von selbst ab — angestoßen vom GitHub-Webhook, abgesichert durch ein Reconcile-Intervall — und der Server liefert aus dem Index statt von der Platte.

**Architecture:** `syncLog` bleibt die einzige Stelle, die den Index verändert; dieser Plan gibt ihr zwei weitere Auslöser und schärft, was sie über den Zustand eines Repos weiß. Die GitHub-Naht bekommt statt `head` und `repoId` eine einzige `probe`, die vier Lagen unterscheidet — bereit, leer, nicht installiert, weg —, weil der Unterschied zwischen „nicht installiert" und „gelöscht" der Unterschied zwischen Weiterlaufen und Einfrieren ist. Webhook-Zustellung und Reconcile schieben beide nur Repo-Referenzen in eine serialisierende Warteschlange; die Warteschlange ruft `syncLog`.

**Tech Stack:** TypeScript auf Node 24 ohne Build-Schritt, `node --test`, `node:crypto` für die Signaturprüfung, Drizzle über `better-sqlite3`.

**Spec:** `docs/superpowers/specs/2026-09-08-release-log-hub-design.md` — bindend. Dieser Plan ist ihr Argument, nicht ihre Ablösung.

**Übertrag aus Plan 3:** `docs/superpowers/plans/2026-09-10-carryover-for-plan-04.md`. Punkte 1 bis 3 daraus werden hier erledigt (Tasks 1, 2, 3), Punkt 4 bleibt liegen.

## Global Constraints

- Node 24 führt TypeScript zur Laufzeit aus. **Kein Build-Schritt.** Importe tragen die Endung `.ts`. Reine Typ-Importe benutzen `import type`.
- `npm test` ruft `node --test` **ohne Pfadargument**. `npm run typecheck` (`tsc --noEmit`) muss sauber sein.
- **Keine neuen Laufzeit-Abhängigkeiten.** `node:crypto`, `node:http`, die Plattform-Globals `fetch`/`Response`/`RequestInit` und die bereits installierten Pakete.
- **Kein Secret in einer Logzeile, einer Fehlermeldung oder einer geworfenen Meldung** — nicht der private Schlüssel, nicht das App-JWT, nicht ein Installations-Token, nicht das Webhook-Secret.
- **Installations-Token werden nie persistiert** (Spec §5). Sie leben in einer `Map` und sterben mit dem Prozess.
- Das Repo ist die Wahrheit, der SQLite-Index eine jederzeit neu baubare Ableitung (Spec §4).
- **Ein privates Log und ein nicht existierendes Log bleiben nach außen ununterscheidbar** (Spec §7). `RepoState` unterscheidet intern vier Lagen — dieser Unterschied darf in keiner HTTP-Antwort auftauchen.
- **Ein Webhook ohne gültige Signatur wird verworfen, bevor sein Inhalt gelesen wird** (Spec §10). Verifizieren, dann parsen — nie umgekehrt.
- Der Server bindet ausdrücklich an eine Adresse, nie an die unspezifizierte (Spec §12).
- Kommentare erklären *warum*, nicht *was*.
- Tests, die nicht fallen können, sind der wiederkehrende Fehler dieses Projekts. Jeder Test unten trägt eine **Fällt, wenn**-Zeile, die die konkrete Mutation nennt, die ihn brechen muss. Wer implementiert, prüft mindestens zwei davon live nach: kaputt machen, Test fällt, exakt zurücksetzen, Suite grün.

## Abweichungen von der Spec, bewusst getroffen

1. **Spec §4 sagt „Logs im Zustand `frozen` werden übersprungen", Spec §10 sagt „Repo wiederhergestellt → der nächste erfolgreiche Abgleich taut den Log von selbst auf".** Beides zusammen geht nicht: ein übersprungener Log bekommt nie einen nächsten Abgleich. Dieser Plan folgt §10 und nimmt eingefrorene Logs in die Reconcile-Auswahl auf. Ein eingefrorener Log kostet pro Runde einen einzigen `probe`-Aufruf, der `gone` zurückgibt; kommt das Repo zurück, taut er beim nächsten Lauf auf. **§4 sollte entsprechend nachgezogen werden.**
2. **Spec §4 listet `log.installation_id` und eine Tabelle `installation`.** Beide bekommen ihren ersten Leser erst in Plan 5 (Rechteprüfung) und Plan 6 (Dashboard). Sie werden hier **nicht** angelegt: eine Spalte, die niemand füllt, ist genau der Zustand, den Plan 3 bei `repo_node_id` erst aufräumen musste. Die Lage „Installation suspendiert" wird in diesem Plan zur Abgleichzeit erkannt (`RepoState.kind === 'no_installation'`), nicht aus einer Tabelle gelesen. **Dieser Plan ändert das Schema nicht und braucht keine Migration.**
3. Der Übertragspunkt 4 aus Plan 3 (doppelter `API`-Konstante, mittig stehende Importe, unterscheidbare `tree()`-Fehlertexte, ungenutzte Env-Variablen in `bin/reindex.ts`) bleibt liegen.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `lib/github.ts` (ändern) | `probe` ersetzt `head` und `repoId`; ein Aufruf liefert Zustand, Head und Node-ID |
| `lib/appAuth.ts` (ändern) | Installations-ID je Repo gemerkt, `invalidate` räumt sie und das Token |
| `lib/index.ts` (ändern) | `syncLog` verbraucht `probe`, verankert auf `repo_node_id`, friert nur bei echtem Verlust ein |
| `lib/webhook.ts` (neu) | Signaturprüfung und Zuordnung Ereignis → Repo-Referenzen. Rein, kein Netz, keine Datenbank |
| `lib/syncQueue.ts` (neu) | Serialisiert Abgleiche und fasst mehrfach angestoßene Repos zusammen |
| `lib/reconcile.ts` (neu) | Welche Logs sind fällig, und das Intervall, das sie einreiht |
| `server.ts` (ändern) | `/health`, `POST /webhook`, Start gegen den Index statt gegen die Platte |
| `bin/reindex.ts` (ändern) | Meldet den neuen übersprungen-Grund mit |
| `README.md` (ändern) | Betrieb: Webhook, Reconcile, `DB_PATH` |

---

### Task 1: `probe` — ein Aufruf statt zweier, vier Lagen statt einer

Heute antwortet `head()` mit `null` auf fünf verschiedene Lagen, und `syncLog` bildet alle auf „eingefroren" ab. Spec §10 trennt sie: eine entfernte Installation heißt *kein Abgleich bei weiterlaufender Auslieferung*, nur ein gelöschtes Repo geht auf `frozen`. Gleichzeitig holen `head()` und `repoId()` beide `GET /repos/{owner}/{repo}` — gemessen die Hälfte des Anfragebudgets eines Abgleichs. Ein Aufruf, der Zustand, Head und Node-ID zusammen liefert, behebt beides.

**Files:**
- Modify: `lib/github.ts`
- Test: `lib/github.test.ts`
- Modify: `lib/index.ts` (nur die zwei Aufrufstellen, damit der Typecheck durchgeht)
- Modify: `lib/index.test.ts`, `bin/reindex.test.ts` (die Fake-Wrapper, die `head`/`repoId` durchreichen)

**Interfaces:**
- Consumes: `type Installations` aus `./appAuth.ts`, `type Http` aus `./http.ts`.
- Produces: `type RepoState`, und `GitHub` hat statt `head`/`repoId` die Methode `probe(ref: RepoRef): Promise<RepoState>`.

```ts
export type RepoState =
  | { kind: 'ready'; head: string; nodeId: string }
  | { kind: 'empty'; nodeId: string }
  | { kind: 'no_installation' }
  | { kind: 'gone' };
```

- [ ] **Step 1: Write the failing test**

`lib/github.test.ts` — die bestehenden `head`- und `repoId`-Tests werden **ersetzt**, nicht ergänzt. Lösche die Tests mit den Namen `head returns the sha of the default branch's tip`, `head follows the repository default branch, not a hardcoded main`, `a deleted repository yields a null head`, `a repository with no commits yields a null head`, `a repository the app is not installed on yields a null head`, `repoId returns the immutable node id`, `fakeGitHub answers repoId for a repo it knows` — und schreibe an ihre Stelle:

```ts
test('probe reports ready with the head and the node id in one call', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  const state = await githubClient(withToken('t'), http).probe(REF);
  assert.deepEqual(state, { kind: 'ready', head: 'c0ffee', nodeId: 'R_kg1' });
  // Zwei Anfragen, nicht drei: der Repo-Aufruf trägt die Node-ID schon.
  assert.deepEqual(http.calls, ['GET /repos/o/r', 'GET /repos/o/r/commits/main']);
});

test('probe follows the repository default branch, not a hardcoded main', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'trunk' } },
    'GET /repos/o/r/commits/trunk': { body: { sha: 'deadbee' } },
  });
  const state = await githubClient(withToken('t'), http).probe(REF);
  assert.equal(state.kind === 'ready' && state.head, 'deadbee');
});

test('a deleted repository probes as gone, which is what freezes a log', async () => {
  const http = fakeHttp({});
  assert.deepEqual(await githubClient(withToken('t'), http).probe(REF), { kind: 'gone' });
});

test('a repository the app is not installed on probes as no_installation, never as gone', async () => {
  // Der Unterschied trägt Spec §10: eine entfernte Installation heißt kein
  // Abgleich bei weiterlaufender Auslieferung, ein gelöschtes Repo heißt
  // frozen. Beides auf 'gone' abzubilden fröre Logs bei jedem Rechteentzug ein.
  const http = fakeHttp({});
  assert.deepEqual(await githubClient(withToken(null), http).probe(REF), { kind: 'no_installation' });
  assert.deepEqual(http.calls, [], 'ohne Token gibt es nichts zu fragen');
});

test('a repository with no commits probes as empty and keeps its node id', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { status: 409 },
  });
  assert.deepEqual(await githubClient(withToken('t'), http).probe(REF), { kind: 'empty', nodeId: 'R_kg1' });
});

test('a default branch that is not there yet is empty, not gone', async () => {
  // Ein Repo, dessen Default-Branch gerade umbenannt wird, liefert 404 auf
  // den Commit-Aufruf. Das Repo selbst gibt es — es einzufrieren wäre der
  // teure Fehler, denn ein eingefrorener Log taut nur über einen weiteren
  // erfolgreichen Abgleich wieder auf.
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { status: 404 },
  });
  assert.deepEqual(await githubClient(withToken('t'), http).probe(REF), { kind: 'empty', nodeId: 'R_kg1' });
});

test('probe carries the installation token, not the app jwt', async () => {
  const seen: string[] = [];
  const inner = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  const spy = Object.assign(
    (url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''));
      return inner(url, init);
    },
    { calls: inner.calls },
  );
  await githubClient(withToken('ghs_abc'), spy).probe(REF);
  assert.deepEqual(seen, ['Bearer ghs_abc', 'Bearer ghs_abc']);
});

test('fakeGitHub probes a repo it knows as ready and one it does not as gone', async () => {
  const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{}' } });
  const ready = await gh.probe({ owner: 'o', repo: 'r' });
  assert.equal(ready.kind, 'ready');
  assert.ok(ready.kind === 'ready' && ready.head.length === 40, 'ein Head sieht aus wie ein Commit');
  assert.ok(ready.kind === 'ready' && ready.nodeId, 'und trägt eine Node-ID');
  assert.deepEqual(await gh.probe({ owner: 'o', repo: 'gone' }), { kind: 'gone' });
});

test('fakeGitHub moves its head when content changes', async () => {
  const before = fakeGitHub({ 'o/r': { 'a.json': '{"v":1}' } });
  const after = fakeGitHub({ 'o/r': { 'a.json': '{"v":2}' } });
  const a = await before.probe({ owner: 'o', repo: 'r' });
  const b = await after.probe({ owner: 'o', repo: 'r' });
  assert.notEqual(a.kind === 'ready' && a.head, b.kind === 'ready' && b.head);
});
```

**Fällt, wenn:** Test 1 — `probe` einen dritten Aufruf macht (etwa `repoId` intern weiterbenutzt), die Node-ID aus dem falschen Feld liest, oder `head` nicht aus dem Commit-Aufruf nimmt. Test 2 — der Branchname fest verdrahtet wird. Test 3 — ein 404 auf den Repo-Aufruf etwas anderes als `gone` ergibt. Test 4 — ein fehlendes Token auf `gone` statt `no_installation` abgebildet wird, oder trotzdem eine Anfrage rausgeht. Test 5 — der 409-Zweig entfällt oder die Node-ID dabei verloren geht. Test 6 — der 404-Zweig auf dem Commit-Aufruf auf `gone` abgebildet wird. Test 7 — irgendein Aufruf mit dem App-JWT statt mit dem Installations-Token authentifiziert. Test 8 und 9 — der Fake `probe` nicht oder falsch erfüllt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `probe is not a function`.

- [ ] **Step 3: Write the implementation**

In `lib/github.ts`: den Typ `RepoState` exportieren, `head` und `repoId` aus `type GitHub` entfernen und durch `probe` ersetzen.

```ts
// Vier Lagen, weil drei davon verschiedene Antworten verlangen: 'gone'
// friert den Log ein, 'no_installation' läuft weiter ohne Abgleich (Spec
// §10), 'empty' ist ein Repo, das noch kein Log ist. Sie bleiben intern —
// welche Lage vorliegt, darf keine HTTP-Antwort verraten (Spec §7).
export type RepoState =
  | { kind: 'ready'; head: string; nodeId: string }
  | { kind: 'empty'; nodeId: string }
  | { kind: 'no_installation' }
  | { kind: 'gone' };

export type GitHub = {
  probe(ref: RepoRef): Promise<RepoState>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
};
```

In `githubClient` die beiden Methoden `head` und `repoId` und den Helfer `repoInfo` löschen und ersetzen durch:

```ts
    async probe(ref) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}`);
      if (res === null) return { kind: 'no_installation' };
      if (res.status === 404) return { kind: 'gone' };
      if (!res.ok) throw new Error(`repo lookup failed: HTTP ${res.status}`);
      const info = (await res.json()) as { node_id: string; default_branch: string };

      const commits = await authed(ref, `/repos/${ref.owner}/${ref.repo}/commits/${info.default_branch}`);
      if (commits === null) return { kind: 'no_installation' };
      // 409 meldet GitHub für ein Repo ganz ohne Commits, 404 für einen
      // Branch, den es (noch) nicht gibt. Beides ist "da, aber nichts zu
      // lesen" — und ausdrücklich nicht 'gone', denn Einfrieren ist die
      // teure Richtung: heraus kommt ein Log nur über einen weiteren
      // erfolgreichen Abgleich.
      if (commits.status === 409 || commits.status === 404) return { kind: 'empty', nodeId: info.node_id };
      if (!commits.ok) throw new Error(`head lookup failed: HTTP ${commits.status}`);
      return { kind: 'ready', head: ((await commits.json()) as { sha: string }).sha, nodeId: info.node_id };
    },
```

In `fakeGitHub` `head` und `repoId` ersetzen durch:

```ts
    async probe(ref) {
      const entries = entriesOf(ref);
      if (!entries) return { kind: 'gone' };
      const nodeId = `R_fake_${key(ref)}`;
      if (entries.length === 0) return { kind: 'empty', nodeId };
      // Ein Ersatz-Commit: der Hash über alle Pfade und Blob-SHAs, damit
      // jede Inhaltsänderung den Head bewegt, genau wie ein echter Commit.
      const summary = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((e) => `${e.path} ${e.sha}`).join('\n');
      return { kind: 'ready', head: createHash('sha1').update(summary).digest('hex'), nodeId };
    },
```

In `lib/index.ts` die beiden Aufrufstellen so anpassen, dass der Typecheck durchgeht — die eigentliche Verhaltensänderung kommt in Task 3:

```ts
  const probed = await gh.probe(ref);
  const head = probed.kind === 'ready' ? probed.head : null;
```

und weiter unten `const repoNodeId = await gh.repoId(ref);` ersetzen durch:

```ts
  const repoNodeId = probed.kind === 'ready' ? probed.nodeId : null;
```

In `lib/index.test.ts` und `bin/reindex.test.ts` jeden Fake-Wrapper anpassen: die Zeilen `head: (ref) => base.head(ref),` und `repoId: (ref) => base.repoId(ref),` werden zu einer Zeile `probe: (ref) => base.probe(ref),`. Der Wrapper in `bin/reindex.test.ts`, der für `repo === 'bad'` wirft, wirft jetzt aus `probe`. Der Test `an unchanged node id is not overwritten with null on a later sync` braucht statt `repoId: async () => null` ein `probe` mit `{ kind: 'ready', head, nodeId: '' }` — **nein**: er braucht einen `probe`, der `no_installation` liefert, und wird in Task 3 neu geschrieben. Für diesen Task reicht es, ihn auf `probe: async () => ({ kind: 'no_installation' } as const)` umzustellen und, falls er dadurch fällt, ihn **nicht** anzupassen, sondern das im Report zu melden. Der Test `the sync stores the repository node id` vergleicht statt `await gh.repoId(REF)` gegen `(await gh.probe(REF) as { nodeId: string }).nodeId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Brich `probe` so, dass ein fehlendes Token `gone` liefert — Test 4 muss fallen. Setze zurück. Brich den 409-Zweig — Test 5 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/github.ts lib/github.test.ts lib/index.ts lib/index.test.ts bin/reindex.test.ts
git commit -m "feat: probe a repository's state, head and id in one call"
```

---

### Task 2: Das Installations-Token wieder loswerden

Der Token-Cache kennt nur Schreiben. Macht GitHub ein Token vorzeitig ungültig — geänderte Rechte, rotierter Schlüssel, suspendierte und wieder aktivierte Installation —, wird es bis zu 58 Minuten lang an jedes Repository dieser Installation ausgegeben, und jeder Abgleich scheitert. Dazu löst `tokenFor` die Installations-ID bei *jedem* Aufruf neu auf, auch wenn das Token längst im Cache liegt: gemessen acht dieser Auflösungen bei einem Abgleich über vier Dateien.

**Files:**
- Modify: `lib/appAuth.ts`
- Modify: `lib/github.ts`
- Test: `lib/appAuth.test.ts`, `lib/github.test.ts`

**Interfaces:**
- Consumes: alles aus Task 1.
- Produces: `type Installations` bekommt `invalidate(ref: { owner: string; repo: string }): void`.

- [ ] **Step 1: Write the failing test**

An `lib/appAuth.test.ts` anhängen:

```ts
test('the installation id is resolved once, not on every call', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const inst = installations(CONFIG, http, () => Date.now());
  await inst.tokenFor(REF);
  await inst.tokenFor(REF);
  await inst.tokenFor(REF);
  const lookups = http.calls.filter((c) => c === 'GET /repos/o/r/installation');
  assert.equal(lookups.length, 1, 'die Installations-ID ändert sich nicht zwischen zwei Aufrufen');
});

test('invalidate drops both the token and the resolved installation id', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': [
      { body: { token: 'first', expires_at: inAnHour() } },
      { body: { token: 'second', expires_at: inAnHour() } },
    ],
  });
  const inst = installations(CONFIG, http, () => Date.now());
  assert.equal(await inst.tokenFor(REF), 'first');
  inst.invalidate(REF);
  assert.equal(await inst.tokenFor(REF), 'second', 'nach invalidate wird neu geprägt');
  const lookups = http.calls.filter((c) => c === 'GET /repos/o/r/installation');
  assert.equal(lookups.length, 2, 'auch die ID wird neu aufgelöst — ein Transfer ändert sie');
});

test('invalidating an unknown repository is a no-op, not a throw', () => {
  const inst = installations(CONFIG, fakeHttp({}), () => Date.now());
  inst.invalidate({ owner: 'never', repo: 'asked' });
});
```

An `lib/github.test.ts` anhängen:

```ts
test('a 401 invalidates the token and the request is retried once', async () => {
  // GitHub kann ein Token vor seinem genannten Ablauf töten. Ohne diesen
  // Pfad läge das tote Token bis zu einer Stunde im Cache und jeder
  // Abgleich dieser Installation schlüge fehl.
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': [
      { body: { token: 'dead', expires_at: new Date(Date.now() + 3_600_000).toISOString() } },
      { body: { token: 'fresh', expires_at: new Date(Date.now() + 3_600_000).toISOString() } },
    ],
    'GET /repos/o/r': [
      { status: 401 },
      { body: { node_id: 'R_kg1', default_branch: 'main' } },
    ],
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  const inst = installations(
    { appId: '12345', privateKey: TEST_PEM, webhookSecret: 'shhh', baseUrl: 'https://example.test' },
    http,
  );
  const state = await githubClient(inst, http).probe(REF);
  assert.equal(state.kind, 'ready');
  const mints = http.calls.filter((c) => c === 'POST /app/installations/7/access_tokens');
  assert.equal(mints.length, 2, 'das tote Token wurde weggeworfen und ein neues geprägt');
});

test('a 401 that survives the retry is reported, not retried forever', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': {
      body: { token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    },
    'GET /repos/o/r': { status: 401 },
  });
  const inst = installations(
    { appId: '12345', privateKey: TEST_PEM, webhookSecret: 'shhh', baseUrl: 'https://example.test' },
    http,
  );
  await assert.rejects(() => githubClient(inst, http).probe(REF), /HTTP 401/);
  const repoCalls = http.calls.filter((c) => c === 'GET /repos/o/r');
  assert.equal(repoCalls.length, 2, 'genau ein Wiederholungsversuch, nicht mehr');
});
```

`TEST_PEM` ist ein zur Testzeit erzeugtes Schlüsselpaar. Lege es am Kopf der Datei an, falls es dort noch keines gibt:

```ts
const TEST_PEM = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
```

**Fällt, wenn:** Test 1 — die ID-Memoisierung fehlt (dann sind es drei Auflösungen). Test 2 — `invalidate` nur das Token und nicht die ID räumt (dann bleibt es bei einer Auflösung), oder gar nichts räumt (dann bleibt das Token `first`). Test 3 — `invalidate` bei unbekanntem Repo wirft. Test 4 — der 401-Zweig in `authed` fehlt (dann wird nur einmal geprägt und `probe` wirft). Test 5 — die Wiederholung nicht begrenzt ist (dann mehr als zwei Repo-Aufrufe, im schlimmsten Fall eine Schleife).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `inst.invalidate is not a function`.

- [ ] **Step 3: Write the implementation**

In `lib/appAuth.ts` den Typ erweitern und die Fabrik umbauen:

```ts
export type Installations = {
  tokenFor(ref: { owner: string; repo: string }): Promise<string | null>;
  // Ein Token, das GitHub vor seinem Ablauf getötet hat, muss weggeworfen
  // werden können — sonst wird es bis zu einer Stunde lang weiter an jedes
  // Repository dieser Installation ausgegeben.
  invalidate(ref: { owner: string; repo: string }): void;
};
```

```ts
export function installations(
  config: AppConfig,
  http: Http,
  nowMs: () => number = Date.now,
): Installations {
  // Nach Installation gekeyt, nicht nach Repository: alle Repositories
  // einer Installation teilen sich ihr Token, und Prägen ist rate-limitiert.
  const cache = new Map<number, Minted>();
  // Nach Repository gekeyt: die Zuordnung Repo -> Installation ändert sich
  // nur bei einem Transfer, und dann räumt invalidate sie weg.
  const ids = new Map<string, number>();
  const keyOf = (ref: { owner: string; repo: string }): string => `${ref.owner}/${ref.repo}`;

  async function idFor(ref: { owner: string; repo: string }): Promise<number | null> {
    const known = ids.get(keyOf(ref));
    if (known !== undefined) return known;
    const found = await http(`${API}/repos/${ref.owner}/${ref.repo}/installation`, {
      headers: headers(appJwt(config)),
    });
    if (found.status === 404) return null;
    if (!found.ok) throw new Error(`installation lookup failed: HTTP ${found.status}`);
    const id = ((await found.json()) as { id: number }).id;
    ids.set(keyOf(ref), id);
    return id;
  }

  return {
    async tokenFor(ref) {
      const installationId = await idFor(ref);
      if (installationId === null) return null;

      const cached = cache.get(installationId);
      if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > nowMs()) {
        return cached.token;
      }

      const minted = await http(`${API}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: headers(appJwt(config)),
      });
      if (!minted.ok) {
        throw new Error(`minting an installation token failed: HTTP ${minted.status}`);
      }
      const body = (await minted.json()) as { token: string; expires_at: string };
      // Nie persistiert: es lebt hier bis zum Ablauf (Spec §5).
      cache.set(installationId, { token: body.token, expiresAtMs: Date.parse(body.expires_at) });
      return body.token;
    },

    invalidate(ref) {
      const id = ids.get(keyOf(ref));
      ids.delete(keyOf(ref));
      if (id !== undefined) cache.delete(id);
    },
  };
}
```

In `lib/github.ts` den Helfer `authed` um den 401-Pfad ergänzen:

```ts
  async function authed(ref: RepoRef, path: string): Promise<Response | null> {
    const token = await inst.tokenFor(ref);
    // Nicht installiert: es gibt nichts zu fragen, und ohne Token zu fragen
    // wäre ein anderer Fehler als der, den der Aufrufer meint.
    if (token === null) return null;
    const res = await http(`${API}${path}`, { headers: headers(token) });
    if (res.status !== 401) return res;

    // Genau ein Versuch: ein 401 heißt entweder "Token tot" — dann trägt
    // ein frisches es — oder "Recht weg", und dann trüge auch das zehnte
    // nicht. withRetry wiederholt einen 401 bewusst nicht, weil er eine
    // Antwort ist und kein Ausfall.
    inst.invalidate(ref);
    const fresh = await inst.tokenFor(ref);
    if (fresh === null) return null;
    return http(`${API}${path}`, { headers: headers(fresh) });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die ID-Memoisierung (`ids.set(...)`) — Test 1 muss fallen. Setze zurück. Entferne den 401-Zweig aus `authed` — Test 4 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/appAuth.ts lib/appAuth.test.ts lib/github.ts lib/github.test.ts
git commit -m "feat: throw away an installation token GitHub has killed"
```

---

### Task 3: `syncLog` unterscheidet weg von nicht installiert

**Files:**
- Modify: `lib/index.ts`
- Test: `lib/index.test.ts`

**Interfaces:**
- Consumes: `type RepoState` aus Task 1.
- Produces: `SyncOutcome` bekommt das Feld `skipped: 'no_installation' | 'no_commits' | null`.

- [ ] **Step 1: Write the failing test**

An `lib/index.test.ts` anhängen (`GitHub` und `fakeGitHub` sind dort schon importiert):

```ts
test('a repository the app is not installed on is skipped, not frozen', async () => {
  await withDb(async (db) => {
    const base = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } });
    await syncLog(db, base, REF);
    assert.equal(db.select().from(log).all()[0].state, 'active');

    // Spec §10: Installation suspendiert oder entfernt -> kein Abgleich,
    // Auslieferung läuft. Einfrieren wäre hier der teure Fehler.
    const uninstalled: GitHub = {
      probe: async () => ({ kind: 'no_installation' }),
      tree: (ref, commit) => base.tree(ref, commit),
      blob: (ref, sha) => base.blob(ref, sha),
    };
    const outcome = await syncLog(db, uninstalled, REF);

    assert.equal(outcome.skipped, 'no_installation');
    assert.equal(outcome.frozen, false);
    assert.equal(db.select().from(log).all()[0].state, 'active', 'der Log bleibt aktiv');
    assert.equal(db.select().from(release).all().length, 1, 'und behält seinen Inhalt');
  });
});

test('a deleted repository still freezes its log', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    const outcome = await syncLog(db, fakeGitHub({}), REF);
    assert.equal(outcome.frozen, true);
    assert.equal(outcome.skipped, null);
    assert.equal(db.select().from(log).all()[0].state, 'frozen');
  });
});

test('a restored repository thaws on the next successful sync', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    await syncLog(db, fakeGitHub({}), REF);
    assert.equal(db.select().from(log).all()[0].state, 'frozen');

    // Spec §10: der nächste erfolgreiche Abgleich taut den Log von selbst auf.
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    assert.equal(db.select().from(log).all()[0].state, 'active');
  });
});

test('a repository with no commits is skipped without a problem row', async () => {
  await withDb(async (db) => {
    const empty: GitHub = {
      probe: async () => ({ kind: 'empty', nodeId: 'R_1' }),
      tree: async () => [],
      blob: async () => null,
    };
    const outcome = await syncLog(db, empty, REF);
    assert.equal(outcome.skipped, 'no_commits');
    assert.equal(outcome.logId, null);
    // Ein frisch angelegtes Repo ist noch kein kaputtes Repo.
    assert.equal(db.select().from(problem).all().length, 0);
  });
});

test('a renamed repository keeps its log, anchored on the node id', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    const before = db.select().from(log).all()[0];

    // Dasselbe Repo unter neuem Namen: gleiche Node-ID, anderer Pfad.
    const renamed: GitHub = {
      probe: async () => ({ kind: 'ready', head: 'c1', nodeId: before.repoNodeId as string }),
      tree: async () => fakeGitHub({ 'o/r': files }).tree(REF, 'c1'),
      blob: (ref, sha) => fakeGitHub({ 'o/r': files }).blob(REF, sha),
    };
    await syncLog(db, renamed, { owner: 'o', repo: 'renamed' });

    const rows = db.select().from(log).all();
    assert.equal(rows.length, 1, 'kein zweiter Log für dasselbe Repo');
    assert.equal(rows[0].publicId, before.publicId, 'eingebundene URLs brechen nicht');
    assert.equal(rows[0].repoName, 'renamed', 'Owner und Name ziehen nach');
  });
});
```

**Fällt, wenn:** Test 1 — `no_installation` wie `gone` behandelt wird (dann `frozen: true` und `state: 'frozen'`). Test 2 — der Einfrierpfad entfällt. Test 3 — der Upsert `state: 'active'` nicht mehr setzt. Test 4 — `empty` eine Problemzeile schreibt oder wie `ready` weiterläuft (dann fällt es am fehlenden Baum). Test 5 — die `known`-Suche nur über (Owner, Name) läuft; dann entsteht ein zweiter Log und `rows.length` ist 2.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `outcome.skipped` ist `undefined`.

- [ ] **Step 3: Write the implementation**

In `lib/index.ts`, `SyncOutcome` erweitern:

```ts
export type SyncOutcome = {
  logId: string | null;
  fetched: number;
  errors: number;
  frozen: boolean;
  // Warum nichts getan wurde, wenn nichts getan wurde. 'no_installation'
  // ist ausdrücklich kein Fehler und ausdrücklich kein Einfrieren (Spec
  // §10): die Auslieferung läuft weiter, nur der Abgleich ruht.
  skipped: 'no_installation' | 'no_commits' | null;
  // Always false from syncLog itself: a thrown error propagates out of
  // this function rather than being turned into an outcome. reindex()
  // sets this true when it catches that throw, so a caller can tell "this
  // repository's sync failed outright" apart from a clean "nothing to do"
  // (logId: null, frozen: false) outcome — the two would otherwise look
  // identical.
  failed: boolean;
};
```

Den Kopf von `syncLog` (bis einschließlich der `known`-Zuweisung) ersetzen:

```ts
export async function syncLog(db: Db, gh: GitHub, ref: RepoRef): Promise<SyncOutcome> {
  const repoPath = `${ref.owner}/${ref.repo}`;
  const byPath = (): typeof log.$inferSelect | null =>
    db.select().from(log)
      .where(and(eq(log.repoOwner, ref.owner), eq(log.repoName, ref.repo))).all()[0] ?? null;

  const probed = await gh.probe(ref);

  // Die Installation ist weg oder suspendiert. Der Log bleibt, wie er ist,
  // und wird weiter ausgeliefert; nur abgeglichen wird nicht (Spec §10).
  // Einfrieren wäre hier der teure Fehler: aus 'frozen' kommt ein Log nur
  // über einen weiteren erfolgreichen Abgleich wieder heraus.
  if (probed.kind === 'no_installation') {
    return { logId: byPath()?.publicId ?? null, fetched: 0, errors: 0, frozen: false, skipped: 'no_installation', failed: false };
  }

  // Ein Repo, das es nicht mehr gibt, friert den Log ein, den es trug; der
  // letzte Stand bleibt online und nichts wird gelöscht (Spec §10).
  if (probed.kind === 'gone') {
    const existing = byPath();
    if (existing) {
      db.update(log).set({ state: 'frozen' }).where(eq(log.publicId, existing.publicId)).run();
    }
    return { logId: existing?.publicId ?? null, fetched: 0, errors: 0, frozen: existing !== null, skipped: null, failed: false };
  }

  // Ein Repo ohne Commits ist noch kein Log und noch kein kaputtes Repo.
  if (probed.kind === 'empty') {
    return { logId: null, fetched: 0, errors: 0, frozen: false, skipped: 'no_commits', failed: false };
  }

  const head = probed.head;
  const repoNodeId = probed.nodeId;

  const tree = await gh.tree(ref, head);
  const configEntry = tree.find((e) => e.path === CONFIG_PATH);
  if (!configEntry) {
    writeProblem(db, repoPath, `no ${CONFIG_PATH} in ${repoPath}`);
    return { logId: null, fetched: 0, errors: 0, frozen: false, skipped: null, failed: false };
  }

  // Die Node-ID zuerst: sie überlebt Umbenennen und Transfer, der Pfad
  // nicht. Ohne diese Reihenfolge entstünde nach einer Umbenennung ein
  // zweiter Log und die eingebundene URL des ersten zeigte ins Leere
  // (Spec §10).
  const known =
    db.select().from(log).where(eq(log.repoNodeId, repoNodeId)).all()[0]
    ?? byPath()
    ?? null;
```

Danach bleibt der Rumpf, wie er ist, mit drei Anpassungen:

1. Die Zeile `const repoNodeId = await gh.repoId(ref);` samt ihres Kommentars entfällt — der Wert kommt jetzt aus `probed`.
2. Im Upsert bleibt `...(repoNodeId !== null ? { repoNodeId } : {})` **nicht** stehen; `repoNodeId` ist auf diesem Pfad immer eine Zeichenkette. Schreibe im `set`-Block schlicht `repoNodeId,`.
3. Jedes verbleibende `return { ... }` bekommt `skipped: null` — das sind die Rückgaben bei ungültiger Konfiguration, bei doppelter ID und die Schlusszeile.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS. Der bestehende Test `an unchanged node id is not overwritten with null on a later sync` prüft jetzt eine Lage, die es nicht mehr gibt — auf dem `ready`-Pfad ist die Node-ID nie null. Ersetze ihn durch:

```ts
test('a sync without an installation leaves the stored node id alone', async () => {
  await withDb(async (db) => {
    const base = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } });
    await syncLog(db, base, REF);
    const first = db.select().from(log).all()[0].repoNodeId;
    assert.ok(first, 'der erste Abgleich muss eine ID abgelegt haben');

    const uninstalled: GitHub = {
      probe: async () => ({ kind: 'no_installation' }),
      tree: (ref, commit) => base.tree(ref, commit),
      blob: (ref, sha) => base.blob(ref, sha),
    };
    await syncLog(db, uninstalled, REF);
    assert.equal(db.select().from(log).all()[0].repoNodeId, first);
  });
});
```

**Fällt, wenn:** der `no_installation`-Zweig weiterläuft statt früh zurückzukehren — dann schreibt der Upsert und die ID wird überschrieben oder der Aufruf wirft.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Bilde `no_installation` auf denselben Zweig wie `gone` ab — Test 1 muss fallen. Setze zurück. Streiche die Node-ID-Suche aus `known` — Test 5 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/index.ts lib/index.test.ts
git commit -m "feat: freeze a log only when its repository is really gone"
```

---

### Task 4: `lib/webhook.ts` — Signatur prüfen, Ereignis auf Repos abbilden

**Files:**
- Create: `lib/webhook.ts`
- Test: `lib/webhook.test.ts`

**Interfaces:**
- Consumes: `type RepoRef` aus `./github.ts`.
- Produces: `function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean`, `type Delivery = { event: string; payload: unknown }`, `function refsFor(delivery: Delivery): RepoRef[]`.

Beides ist rein: kein Netz, keine Datenbank, keine Uhr. Der Server in Task 7 setzt die zwei Teile zusammen.

- [ ] **Step 1: Write the failing test**

`lib/webhook.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, refsFor } from './webhook.ts';

const SECRET = 'not-the-real-secret';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('a correctly signed body verifies', () => {
  const body = Buffer.from('{"zen":"hi"}', 'utf8');
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
});

test('a body signed with another secret does not verify', () => {
  const body = Buffer.from('{"zen":"hi"}', 'utf8');
  assert.equal(verifySignature(SECRET, body, sign(body, 'someone-elses-secret')), false);
});

test('a changed body does not verify against the old signature', () => {
  const signature = sign(Buffer.from('{"zen":"hi"}', 'utf8'));
  assert.equal(verifySignature(SECRET, Buffer.from('{"zen":"HI"}', 'utf8'), signature), false);
});

test('a missing or malformed signature header does not verify', () => {
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, ''), false);
  assert.equal(verifySignature(SECRET, body, 'deadbeef'), false, 'ohne sha256= ist es kein Header, den wir kennen');
  assert.equal(verifySignature(SECRET, body, 'sha1=deadbeef'), false);
  assert.equal(verifySignature(SECRET, body, 'sha256=nothex!!'), false);
  assert.equal(verifySignature(SECRET, body, 'sha256=abc'), false, 'zu kurz, und timingSafeEqual wirft bei ungleicher Länge');
});

test('push names the repository it happened in', () => {
  assert.deepEqual(
    refsFor({ event: 'push', payload: { repository: { full_name: 'o/r' } } }),
    [{ owner: 'o', repo: 'r' }],
  );
});

test('a renamed repository is named by its new name', () => {
  // Der Abgleich verankert auf der Node-ID, findet den Log also wieder;
  // was der Webhook liefern muss, ist der Pfad, unter dem GitHub das Repo
  // jetzt kennt.
  assert.deepEqual(
    refsFor({
      event: 'repository',
      payload: { action: 'renamed', repository: { full_name: 'o/renamed' } },
    }),
    [{ owner: 'o', repo: 'renamed' }],
  );
});

test('a deleted repository is still reported, so the sync can freeze its log', () => {
  assert.deepEqual(
    refsFor({ event: 'repository', payload: { action: 'deleted', repository: { full_name: 'o/r' } } }),
    [{ owner: 'o', repo: 'r' }],
  );
});

test('an installation event names every repository it carries', () => {
  assert.deepEqual(
    refsFor({
      event: 'installation',
      payload: { action: 'created', repositories: [{ full_name: 'o/a' }, { full_name: 'o/b' }] },
    }),
    [{ owner: 'o', repo: 'a' }, { owner: 'o', repo: 'b' }],
  );
});

test('installation_repositories names both what was added and what was removed', () => {
  // Ein entzogenes Repository muss angestoßen werden, damit der Abgleich
  // 'no_installation' sieht und aufhört, es anzufassen.
  assert.deepEqual(
    refsFor({
      event: 'installation_repositories',
      payload: {
        action: 'removed',
        repositories_added: [{ full_name: 'o/added' }],
        repositories_removed: [{ full_name: 'o/removed' }],
      },
    }),
    [{ owner: 'o', repo: 'added' }, { owner: 'o', repo: 'removed' }],
  );
});

test('ping and anything unknown name nothing', () => {
  assert.deepEqual(refsFor({ event: 'ping', payload: { zen: 'hi' } }), []);
  assert.deepEqual(refsFor({ event: 'star', payload: { repository: { full_name: 'o/r' } } }), []);
});

test('a malformed payload names nothing instead of throwing', () => {
  // Was über die Leitung kommt, ist Eingabe, keine Zusicherung — auch mit
  // gültiger Signatur.
  assert.deepEqual(refsFor({ event: 'push', payload: null }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: {} }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: { repository: {} } }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: { repository: { full_name: 'no-slash' } } }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: { repository: { full_name: 'a/b/c' } } }), []);
  assert.deepEqual(refsFor({ event: 'push', payload: { repository: { full_name: '../../etc' } } }), []);
  assert.deepEqual(refsFor({ event: 'installation', payload: { repositories: 'nope' } }), []);
});
```

**Fällt, wenn:** Test 1 — die HMAC über etwas anderem als dem rohen Body gebildet wird. Test 2 und 3 sind die eigentliche Sicherheitsaussage und fallen, sobald der Vergleich immer wahr liefert. Test 4 — das `sha256=`-Präfix nicht geprüft wird, oder die Längenprüfung vor `timingSafeEqual` fehlt (dann wirft es statt `false` zu liefern). Tests 5 bis 9 — das jeweilige Ereignis nicht oder auf die falschen Felder abgebildet wird. Test 10 — unbekannte Ereignisse durchgereicht werden. Test 11 — `refsFor` einer Zusicherung über die Form des Payloads traut; jede Zeile dort wirft heute `TypeError` bei naiver Implementierung.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './webhook.ts'`.

- [ ] **Step 3: Write the implementation**

`lib/webhook.ts`:

```ts
// Was GitHub schickt, ist Eingabe und keine Zusicherung. Deshalb zwei
// getrennte reine Funktionen: erst prüfen, ob die Zustellung echt ist,
// dann herausfinden, welche Repositories sie betrifft. Der Server setzt
// beides zusammen und stößt den Abgleich an — hier gibt es kein Netz,
// keine Datenbank und keine Uhr (Spec §9, §10).

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RepoRef } from './github.ts';

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, 'utf8');
  const given = Buffer.from(header, 'utf8');
  // timingSafeEqual wirft bei ungleicher Länge, und die Länge ist ohnehin
  // öffentlich — sie zu vergleichen verrät nichts, was der Angreifer nicht
  // selbst ausrechnen kann.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export type Delivery = { event: string; payload: unknown };

function refOf(value: unknown): RepoRef | null {
  const fullName = (value as { full_name?: unknown } | null)?.full_name;
  if (typeof fullName !== 'string') return null;
  const parts = fullName.split('/');
  // Genau zwei nicht-leere Segmente. Alles andere landete sonst ungeprüft
  // in einem API-Pfad.
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return { owner: parts[0], repo: parts[1] };
}

function listOf(value: unknown): RepoRef[] {
  if (!Array.isArray(value)) return [];
  return value.map(refOf).filter((ref): ref is RepoRef => ref !== null);
}

export function refsFor(delivery: Delivery): RepoRef[] {
  const payload = (delivery.payload ?? {}) as Record<string, unknown>;
  if (typeof payload !== 'object') return [];

  switch (delivery.event) {
    // Beide tragen genau ein Repository. 'repository' umfasst auch
    // 'deleted' und 'transferred': gerade die müssen angestoßen werden,
    // damit der Abgleich den neuen Zustand sieht (Spec §10).
    case 'push':
    case 'repository': {
      const ref = refOf(payload.repository);
      return ref ? [ref] : [];
    }
    case 'installation':
      return listOf(payload.repositories);
    case 'installation_repositories':
      return [...listOf(payload.repositories_added), ...listOf(payload.repositories_removed)];
    // Alles andere, 'ping' eingeschlossen, ist nichts, wofür der Index
    // sich ändern müsste. Ein unbekanntes Ereignis stößt keinen Abgleich
    // an, statt vorsichtshalber alles anzufassen.
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Ersetze in `verifySignature` den Rückgabewert durch `true` — Test 2 und 3 müssen fallen. Setze zurück. Entferne in `refOf` die Prüfung auf genau zwei Segmente — Test 11 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/webhook.ts lib/webhook.test.ts
git commit -m "feat: verify a webhook delivery and name the repositories it touches"
```

---

### Task 5: `lib/syncQueue.ts` — serialisieren und zusammenfassen

Ein Push-Sturm auf ein Repo darf nicht zehn gleichzeitige Abgleiche desselben Logs auslösen: `syncLog` schreibt in dieselben Zeilen, und zwei Läufe nebeneinander würden sich die Sweeps gegenseitig unter den Füßen wegziehen. Ein Repo, das während seines Laufs erneut angestoßen wird, läuft danach genau einmal nach — nicht einmal pro Anstoß.

**Files:**
- Create: `lib/syncQueue.ts`
- Test: `lib/syncQueue.test.ts`

**Interfaces:**
- Consumes: `type RepoRef` aus `./github.ts`.
- Produces: `type Queue = { enqueue(ref: RepoRef): void; idle(): Promise<void>; pending(): number }`, `function syncQueue(run: (ref: RepoRef) => Promise<void>, onError?: (ref: RepoRef, err: unknown) => void): Queue`.

- [ ] **Step 1: Write the failing test**

`lib/syncQueue.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncQueue } from './syncQueue.ts';

const REF = { owner: 'o', repo: 'r' };

test('an enqueued ref is run', async () => {
  const seen: string[] = [];
  const q = syncQueue(async (ref) => { seen.push(`${ref.owner}/${ref.repo}`); });
  q.enqueue(REF);
  await q.idle();
  assert.deepEqual(seen, ['o/r']);
});

test('two refs run one after the other, never side by side', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const q = syncQueue(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
  });
  q.enqueue({ owner: 'o', repo: 'a' });
  q.enqueue({ owner: 'o', repo: 'b' });
  await q.idle();
  assert.equal(maxInFlight, 1, 'zwei Läufe auf denselben Zeilen dürfen sich nicht überlappen');
});

test('a ref enqueued twice before it runs runs once', async () => {
  let runs = 0;
  const q = syncQueue(async () => { runs += 1; });
  q.enqueue(REF);
  q.enqueue(REF);
  q.enqueue(REF);
  await q.idle();
  assert.equal(runs, 1, 'drei Pushes in einer Sekunde sind ein Abgleich, nicht drei');
});

test('a ref enqueued while it runs runs exactly once more', async () => {
  // Der Anstoß kam nach dem Lesen des Baums, also muss ein weiterer Lauf
  // folgen — aber genau einer, egal wie oft angestoßen wurde.
  let runs = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const q = syncQueue(async () => {
    runs += 1;
    if (runs === 1) await blocked;
  });
  q.enqueue(REF);
  await new Promise((resolve) => setImmediate(resolve));
  q.enqueue(REF);
  q.enqueue(REF);
  release();
  await q.idle();
  assert.equal(runs, 2);
});

test('a throwing run does not stop the queue', async () => {
  const done: string[] = [];
  const errors: string[] = [];
  const q = syncQueue(
    async (ref) => {
      if (ref.repo === 'bad') throw new Error('500 from upstream');
      done.push(ref.repo);
    },
    (ref, err) => { errors.push(`${ref.repo}: ${(err as Error).message}`); },
  );
  q.enqueue({ owner: 'o', repo: 'bad' });
  q.enqueue({ owner: 'o', repo: 'good' });
  await q.idle();
  assert.deepEqual(done, ['good'], 'ein kaputtes Repo darf die anderen nicht mitnehmen');
  assert.deepEqual(errors, ['bad: 500 from upstream']);
});

test('idle on an empty queue resolves immediately', async () => {
  await syncQueue(async () => {}).idle();
});

test('pending counts what is waiting', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const q = syncQueue(async () => { await blocked; });
  q.enqueue({ owner: 'o', repo: 'a' });
  q.enqueue({ owner: 'o', repo: 'b' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(q.pending(), 1, 'a läuft, b wartet');
  release();
  await q.idle();
  assert.equal(q.pending(), 0);
});
```

**Fällt, wenn:** Test 2 — die Läufe nicht serialisiert werden (dann steigt `maxInFlight` auf 2). Test 3 — nach Referenz statt nach Repo-Pfad zusammengefasst wird, oder gar nicht (dann 3 Läufe). Test 4 — der Anstoß während des Laufs verloren geht (dann 1 Lauf) oder jeder Anstoß einen Lauf ergibt (dann 3). Test 5 — der Fehler aus der Schleife herausfliegt (dann läuft `good` nie). Test 7 — `pending` das gerade Laufende mitzählt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './syncQueue.ts'`.

- [ ] **Step 3: Write the implementation**

`lib/syncQueue.ts`:

```ts
// Webhook und Reconcile stoßen beide denselben Abgleich an, und ein Push-
// Sturm stößt ihn zehnmal in einer Sekunde an. syncLog schreibt in dieselben
// Zeilen und macht am Ende Sweeps über alles, was der Baum nicht mehr trägt
// — zwei Läufe nebeneinander würden sich diese Sweeps gegenseitig unter den
// Füßen wegziehen. Also: einer nach dem anderen, und mehrfach angestoßene
// Repos genau einmal nach.

import type { RepoRef } from './github.ts';

export type Queue = {
  enqueue(ref: RepoRef): void;
  // Läuft, bis nichts mehr wartet. Für Tests und für ein sauberes
  // Herunterfahren; im Betrieb wartet niemand darauf.
  idle(): Promise<void>;
  pending(): number;
};

export function syncQueue(
  run: (ref: RepoRef) => Promise<void>,
  onError: (ref: RepoRef, err: unknown) => void = () => {},
): Queue {
  // Nach Pfad gekeyt, nicht nach Objekt: derselbe Log, zehnmal angestoßen,
  // ist ein Eintrag. Ein Anstoß während des Laufs legt den Eintrag neu an,
  // also folgt genau ein weiterer Lauf.
  const waiting = new Map<string, RepoRef>();
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    for (;;) {
      const next = waiting.entries().next();
      if (next.done) break;
      const [key, ref] = next.value;
      waiting.delete(key);
      try {
        await run(ref);
      } catch (err) {
        // Ein Repo, dessen Abgleich scheitert, darf die anderen nicht
        // mitnehmen — dieselbe Regel wie in reindex().
        onError(ref, err);
      }
    }
    draining = null;
  }

  return {
    enqueue(ref) {
      waiting.set(`${ref.owner}/${ref.repo}`, ref);
      if (draining === null) draining = drain();
    },
    async idle() {
      while (draining !== null) await draining;
    },
    pending() {
      return waiting.size;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Ersetze die `Map` durch ein Array, das jeden Anstoß anhängt — Test 3 muss fallen. Setze zurück. Entferne den `try/catch` um `run(ref)` — Test 5 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/syncQueue.ts lib/syncQueue.test.ts
git commit -m "feat: run one sync per repository at a time"
```

---

### Task 6: `lib/reconcile.ts` — welcher Log ist fällig

Der Webhook sorgt für Sofortigkeit, das Intervall dafür, dass ein verlorener Webhook höchstens eine Runde kostet statt für immer zu driften (Spec §4). Zwei Regeln zusammen: alle fünf Minuten der Log mit dem ältesten `indexed_at`, und zusätzlich jeder Log, der länger als eine Stunde nicht erfasst wurde.

Eingefrorene Logs sind **eingeschlossen** — siehe „Abweichungen von der Spec", Punkt 1. Ein eingefrorener Log kostet pro Runde einen `probe`, und nur so kann Spec §10s „der nächste erfolgreiche Abgleich taut den Log von selbst auf" je eintreten.

**Files:**
- Create: `lib/reconcile.ts`
- Test: `lib/reconcile.test.ts`

**Interfaces:**
- Consumes: `type Db` aus `./db/client.ts`, `type Queue` aus `./syncQueue.ts`, `type RepoRef` aus `./github.ts`.
- Produces: `function dueLogs(db: Db, nowMs: number): RepoRef[]`, `function reconcileTick(db: Db, queue: Queue, nowMs: number): number`, `function startReconcile(db: Db, queue: Queue, everyMs?: number): { stop(): void }`.

- [ ] **Step 1: Write the failing test**

`lib/reconcile.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { log } from './db/schema.ts';
import { dueLogs, reconcileTick } from './reconcile.ts';
import { syncQueue } from './syncQueue.ts';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

async function withDb(fn: (db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'));
  try {
    await fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function insert(db: ReturnType<typeof openDb>, publicId: string, repo: string, indexedAt: string | null, state = 'active'): void {
  db.insert(log).values({
    publicId, repoOwner: 'o', repoName: repo, repoNodeId: `R_${publicId}`,
    product: 'P', view: 'sections', visibility: 'public', curationNotes: null,
    state, headSha: 'c0ffee', configBlobSha: 'abc', indexedAt,
  }).run();
}

test('a log that has never been indexed is due', async () => {
  await withDb(async (db) => {
    insert(db, 'never', 'never', null);
    assert.deepEqual(dueLogs(db, NOW), [{ owner: 'o', repo: 'never' }]);
  });
});

test('a log older than an hour is due, a fresh one is not', async () => {
  await withDb(async (db) => {
    insert(db, 'stale', 'stale', new Date(NOW - 61 * 60_000).toISOString());
    insert(db, 'fresh', 'fresh', new Date(NOW - 60_000).toISOString());
    insert(db, 'fresher', 'fresher', new Date(NOW - 30_000).toISOString());
    const due = dueLogs(db, NOW).map((r) => r.repo);
    assert.ok(due.includes('stale'), 'über eine Stunde alt');
    assert.ok(!due.includes('fresher'), 'gerade erst abgeglichen');
  });
});

test('the single oldest log is due even when nothing is stale', async () => {
  // Spec §4: alle fünf Minuten der Log mit dem ältesten indexed_at. Ohne
  // diese Regel täte eine Runde in einem ruhigen Bestand gar nichts.
  await withDb(async (db) => {
    insert(db, 'old', 'old', new Date(NOW - 10 * 60_000).toISOString());
    insert(db, 'new', 'new', new Date(NOW - 60_000).toISOString());
    assert.deepEqual(dueLogs(db, NOW), [{ owner: 'o', repo: 'old' }]);
  });
});

test('a frozen log is due too, which is the only way it can ever thaw', async () => {
  // Spec §10: "Repo wiederhergestellt -> der nächste erfolgreiche Abgleich
  // taut den Log von selbst auf." Ein übersprungener Log bekommt nie einen
  // nächsten Abgleich. Siehe "Abweichungen von der Spec", Punkt 1.
  await withDb(async (db) => {
    insert(db, 'frozen', 'frozen', new Date(NOW - 2 * 3_600_000).toISOString(), 'frozen');
    assert.deepEqual(dueLogs(db, NOW), [{ owner: 'o', repo: 'frozen' }]);
  });
});

test('a due log is named once, not twice, when both rules pick it', async () => {
  await withDb(async (db) => {
    insert(db, 'stale', 'stale', new Date(NOW - 5 * 3_600_000).toISOString());
    assert.equal(dueLogs(db, NOW).length, 1);
  });
});

test('an empty index has nothing due', async () => {
  await withDb(async (db) => {
    assert.deepEqual(dueLogs(db, NOW), []);
  });
});

test('a tick enqueues every due log and reports how many', async () => {
  await withDb(async (db) => {
    insert(db, 'a', 'a', null);
    insert(db, 'b', 'b', new Date(NOW - 3 * 3_600_000).toISOString());
    const seen: string[] = [];
    const q = syncQueue(async (ref) => { seen.push(ref.repo); });
    assert.equal(reconcileTick(db, q, NOW), 2);
    await q.idle();
    assert.deepEqual(seen.sort(), ['a', 'b']);
  });
});
```

**Fällt, wenn:** Test 1 — `indexed_at IS NULL` nicht als fällig gilt. Test 2 — die Stundenschwelle fehlt oder falsch herum vergleicht (dann ist auch `fresher` dabei). Test 3 — die Ältester-Regel fehlt (dann leer). Test 4 — eingefrorene Logs gefiltert werden. Test 5 — die Vereinigung der beiden Regeln nicht dedupliziert. Test 7 — `reconcileTick` nicht einreiht oder die Anzahl falsch meldet.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './reconcile.ts'`.

- [ ] **Step 3: Write the implementation**

`lib/reconcile.ts`:

```ts
// Der Webhook sorgt für Sofortigkeit, dieses Intervall dafür, dass ein
// verlorener Webhook höchstens eine Runde kostet statt für immer zu driften
// (Spec §4). Der Zustandsvergleich in syncLog braucht keine lückenlose
// Zustellung, nur irgendwann einen Anstoß — das hier ist das "irgendwann".

import { asc } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log } from './db/schema.ts';
import type { RepoRef } from './github.ts';
import type { Queue } from './syncQueue.ts';

const STALE_MS = 60 * 60 * 1000;
const EVERY_MS = 5 * 60 * 1000;

export function dueLogs(db: Db, nowMs: number): RepoRef[] {
  // Nach indexed_at aufsteigend, NULL zuerst — ein nie erfasster Log ist
  // der älteste, den es gibt. SQLite sortiert NULL von sich aus nach vorn.
  const rows = db.select({ owner: log.repoOwner, repo: log.repoName, indexedAt: log.indexedAt })
    .from(log).orderBy(asc(log.indexedAt)).all();
  if (rows.length === 0) return [];

  const due: RepoRef[] = [];
  const seen = new Set<string>();
  const take = (row: { owner: string; repo: string }): void => {
    const key = `${row.owner}/${row.repo}`;
    if (seen.has(key)) return;
    seen.add(key);
    due.push({ owner: row.owner, repo: row.repo });
  };

  // Regel 1: der älteste, immer. Sonst täte eine Runde in einem ruhigen
  // Bestand gar nichts.
  take(rows[0]);
  // Regel 2: alles, was über eine Stunde nicht erfasst wurde. Das ist die
  // Zusage "jeder Log mindestens stündlich", die Regel 1 allein bei mehr
  // als zwölf Logs nicht mehr halten könnte.
  for (const row of rows) {
    if (row.indexedAt === null || nowMs - Date.parse(row.indexedAt) > STALE_MS) take(row);
  }

  // Eingefrorene Logs sind absichtlich nicht gefiltert: sie kosten einen
  // einzigen probe-Aufruf, und nur so kann Spec §10s "der nächste
  // erfolgreiche Abgleich taut den Log von selbst auf" je eintreten.
  return due;
}

export function reconcileTick(db: Db, queue: Queue, nowMs: number): number {
  const due = dueLogs(db, nowMs);
  for (const ref of due) queue.enqueue(ref);
  return due.length;
}

export function startReconcile(db: Db, queue: Queue, everyMs: number = EVERY_MS): { stop(): void } {
  const timer = setInterval(() => { reconcileTick(db, queue, Date.now()); }, everyMs);
  // Ein Intervall darf den Prozess nicht am Leben halten, wenn sonst nichts
  // mehr läuft.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

`startReconcile` ist die vier Zeilen `setInterval` um `reconcileTick` und wird bewusst nicht getestet: der Teil mit der Entscheidung steckt in `dueLogs` und `reconcileTick`, und ein Test über echte Zeit wäre langsam und wackelig.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Filtere eingefrorene Logs heraus — Test 4 muss fallen. Setze zurück. Entferne `take(rows[0])` — Test 3 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/reconcile.ts lib/reconcile.test.ts
git commit -m "feat: pick the logs a reconcile round owes a sync"
```

---

### Task 7: Der Server nimmt Webhooks an

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `verifySignature`, `refsFor` aus `./lib/webhook.ts`.
- Produces: `createApp(reader: Reader, hooks?: Hooks): Server` mit `type Hooks = { webhookSecret: string; onDelivery(refs: RepoRef[]): void }`. Ohne `hooks` verhält sich der Server exakt wie bisher, und `/webhook` antwortet 404.

- [ ] **Step 1: Write the failing test**

An `server.test.ts` anhängen. Die Datei hat bereits `withServer(reader, fn)`, das eine App auf einem freien Port startet und die Basis-URL übergibt; Anfragen laufen dort über das globale `fetch`. Erweitere den Helfer um einen dritten Parameter, damit ein Test Hooks mitgeben kann:

```ts
async function withServer(
  reader: Reader,
  fn: (base: string) => Promise<void>,
  hooks?: Hooks,
): Promise<void> {
  const server = createApp(reader, hooks);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
```

`Hooks` wird als Typ aus `./server.ts` importiert. Die bestehenden Aufrufe von `withServer` bleiben unverändert — der dritte Parameter ist optional. Dann die Tests:

```ts
import { createHmac } from 'node:crypto';

const HOOK_SECRET = 'not-the-real-secret';

function signed(body: string, secret = HOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

async function deliver(base: string, event: string, body: string, signature?: string): Promise<Response> {
  const headers: Record<string, string> = { 'x-github-event': event, 'content-type': 'application/json' };
  if (signature !== undefined) headers['x-hub-signature-256'] = signature;
  return fetch(`${base}/webhook`, { method: 'POST', headers, body });
}

test('health answers 200 without touching the reader', async () => {
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('a signed push is accepted and its repository is handed on', async () => {
  const seen: string[] = [];
  const body = JSON.stringify({ repository: { full_name: 'o/r' } });
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'push', body, signed(body));
      assert.equal(res.status, 202);
      assert.deepEqual(seen, ['o/r']);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: (refs) => { for (const ref of refs) seen.push(`${ref.owner}/${ref.repo}`); } },
  );
});

test('an unsigned delivery is refused and nothing is handed on', async () => {
  let called = false;
  const body = JSON.stringify({ repository: { full_name: 'o/r' } });
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'push', body);
      assert.equal(res.status, 401);
      assert.equal(called, false);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: () => { called = true; } },
  );
});

test('a delivery signed with the wrong secret is refused', async () => {
  let called = false;
  const body = JSON.stringify({ repository: { full_name: 'o/r' } });
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'push', body, signed(body, 'someone-elses-secret'));
      assert.equal(res.status, 401);
      assert.equal(called, false);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: () => { called = true; } },
  );
});

test('a body that is not json is refused after the signature checks out', async () => {
  // Die Signatur stimmt, der Inhalt ist trotzdem Müll. Das darf 400 sein
  // und nicht der Absturz des Prozesses.
  let called = false;
  const body = 'not json at all';
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'push', body, signed(body));
      assert.equal(res.status, 400);
      assert.equal(called, false);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: () => { called = true; } },
  );
});

test('an oversized delivery is refused', async () => {
  // Gültiges JSON, nur zu groß. Das ist der Punkt: ohne Größenbegrenzung
  // liefe dieser Körper glatt durch und würde mit 202 angenommen — ein
  // Test mit kaputtem JSON bestünde auch ohne die Grenze, weil er dann am
  // Parser scheiterte statt an der Grenze.
  let handed = -1;
  const body = JSON.stringify({ repository: { full_name: 'o/r' }, pad: 'x'.repeat(2 * 1024 * 1024) });
  await withServer(
    reader,
    async (base) => {
      // Der Server bricht die Verbindung ab, sobald die Grenze fällt; je
      // nachdem, wie weit der Körper schon draußen war, sieht der Client
      // die 413 oder einen Verbindungsabbruch. Beides ist "abgelehnt".
      const status = await deliver(base, 'push', body, signed(body))
        .then((res) => res.status)
        .catch(() => 0);
      assert.notEqual(status, 202, 'ein zu großer Körper darf nicht angenommen werden');
      assert.ok(status === 413 || status === 0, `unerwarteter Status ${status}`);
      assert.equal(handed, -1, 'und nichts davon darf in die Warteschlange');
    },
    { webhookSecret: HOOK_SECRET, onDelivery: (refs) => { handed = refs.length; } },
  );
});

test('a ping is accepted and names nothing', async () => {
  let refCount = -1;
  const body = JSON.stringify({ zen: 'hi' });
  await withServer(
    reader,
    async (base) => {
      const res = await deliver(base, 'ping', body, signed(body));
      assert.equal(res.status, 202);
      assert.equal(refCount, 0);
    },
    { webhookSecret: HOOK_SECRET, onDelivery: (refs) => { refCount = refs.length; } },
  );
});

test('without a webhook secret configured the route does not exist', async () => {
  // Ein Dienst ohne konfiguriertes Secret darf kein offener Auslöser sein.
  const body = JSON.stringify({ repository: { full_name: 'o/r' } });
  await withServer(reader, async (base) => {
    const res = await deliver(base, 'push', body, signed(body));
    assert.equal(res.status, 404);
  });
});
```

**Fällt, wenn:** Test 1 — `/health` fehlt. Test 2 — die Route fehlt oder `refsFor` nicht angewendet wird. Tests 3 und 4 sind die Sicherheitsaussage und fallen, sobald die Signaturprüfung übersprungen wird oder erst nach dem Parsen läuft. Test 5 — `JSON.parse` ungeschützt läuft (dann 500 oder ein Absturz). Test 6 — die Größenbegrenzung fehlt; der Körper ist absichtlich gültiges JSON, sodass er ohne die Grenze mit 202 durchginge. Test 8 — die Route auch ohne Secret antwortet, was einen unkonfigurierten Dienst zum offenen Auslöser machte.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `/webhook` antwortet 404 statt 202.

- [ ] **Step 3: Write the implementation**

In `server.ts` oben ergänzen:

```ts
import { verifySignature, refsFor } from './lib/webhook.ts';
import type { RepoRef } from './lib/github.ts';

// Eine GitHub-Zustellung ist typischerweise wenige Kilobyte; ein Megabyte
// ist großzügig und begrenzt zugleich, was ein Fremder in den Speicher
// dieses Prozesses schreiben kann, bevor irgendetwas geprüft wurde.
const WEBHOOK_MAX_BYTES = 1024 * 1024;

export type Hooks = {
  webhookSecret: string;
  onDelivery(refs: RepoRef[]): void;
};
```

`createApp` bekommt den zweiten Parameter und, ganz am Anfang des Handlers (vor der URL-Auswertung ist es egal, aber vor jedem Reader-Zugriff), zwei Zweige. Setze sie direkt nach der Berechnung von `pathname` ein:

```ts
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === '/webhook' && hooks && method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      let refused = false;
      req.on('data', (chunk: Buffer) => {
        if (refused) return;
        size += chunk.length;
        if (size > WEBHOOK_MAX_BYTES) {
          // Abbrechen statt weiterzulesen: der Rest des Körpers ist für
          // niemanden mehr von Nutzen, und ihn zu puffern wäre genau das,
          // wogegen die Grenze steht.
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
        const body = Buffer.concat(chunks);
        // Erst prüfen, dann lesen (Spec §10). Alles unterhalb dieser Zeile
        // verarbeitet Bytes, von denen feststeht, dass sie von GitHub
        // stammen; alles oberhalb fasst sie nur an, um sie zu zählen.
        if (!verifySignature(hooks.webhookSecret, body, req.headers['x-hub-signature-256'] as string | undefined)) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'bad_signature' }));
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'bad_request' }));
          return;
        }
        const event = String(req.headers['x-github-event'] ?? '');
        // Angenommen, nicht erledigt: der Abgleich läuft danach in der
        // Warteschlange. GitHub braucht eine schnelle Antwort, und ob der
        // Abgleich klappt, ändert nichts daran, dass die Zustellung ankam.
        hooks.onDelivery(refsFor({ event, payload }));
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ accepted: true }));
      });
      return;
    }
```

Den `import.meta.main`-Block ersetzen:

```ts
if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const dbPath = process.env.DB_PATH ?? './release-log.sqlite';
  const db = openDb(dbPath);

  const config = readConfig(process.env);
  const gh = githubClient(
    installations(config, withRetry((url, init) => fetch(url, init))),
    withRetry((url, init) => fetch(url, init)),
  );
  const queue = syncQueue(
    async (ref) => { await syncLog(db, gh, ref); },
    (ref, err) => { console.error(`${ref.owner}/${ref.repo}: ${(err as Error).message}`); },
  );
  startReconcile(db, queue);

  // Bind an explicit address: without a host Node listens on :: and takes
  // IPv4 only while nothing else holds it, so a busy port turns into a
  // silent IPv6-only start instead of an error (spec §12).
  createApp(indexReader(db), {
    webhookSecret: config.webhookSecret,
    onDelivery: (refs) => { for (const ref of refs) queue.enqueue(ref); },
  }).listen(port, '127.0.0.1', () => {
    console.log(`release-log-hub on http://127.0.0.1:${port}, index at ${dbPath}`);
  });
}
```

mit den nötigen Importen am Kopf der Datei: `openDb` aus `./lib/db/client.ts`, `indexReader` aus `./lib/indexReader.ts`, `readConfig` aus `./lib/config.ts`, `installations` aus `./lib/appAuth.ts`, `githubClient` aus `./lib/github.ts`, `withRetry` aus `./lib/http.ts`, `syncLog` aus `./lib/index.ts`, `syncQueue` aus `./lib/syncQueue.ts`, `startReconcile` aus `./lib/reconcile.ts`.

Die beiden `withRetry`-Aufrufe oben sind **zwei** Instanzen — das ist gewollt und harmlos, `withRetry` hält keinen Zustand. Wer lieber eine baut, darf: `const http = withRetry((url, init) => fetch(url, init));` und beide Stellen damit versorgen.

Der Kommentar über `const viewer = 'public';` verweist auf „Plan 3"; er meint die Sessions, die erst mit dem Anmeldeweg kommen. Ändere ihn auf „(bis Sessions existieren)" ohne Plannummer.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Verschiebe die Signaturprüfung hinter `JSON.parse` und lasse sie den Fehler nur protokollieren — Test 3 und 4 müssen fallen. Setze zurück. Entferne die Größenbegrenzung — Test 6 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: accept signed webhook deliveries and serve from the index"
```

---

### Task 8: `bin/reindex.ts` und die Dokumentation nachziehen

**Files:**
- Modify: `bin/reindex.ts`
- Modify: `README.md`
- Test: `bin/reindex.test.ts`

**Interfaces:**
- Consumes: `SyncOutcome.skipped` aus Task 3.
- Produces: keine neuen Exporte.

- [ ] **Step 1: Write the failing test**

An `bin/reindex.test.ts` anhängen:

```ts
test('reindex reports a repository the app is not installed on', async () => {
  await withDb(async (db) => {
    const uninstalled: GitHub = {
      probe: async () => ({ kind: 'no_installation' }),
      tree: async () => [],
      blob: async () => null,
    };
    const [outcome] = await reindex(db, uninstalled, [{ owner: 'o', repo: 'r' }]);
    assert.equal(outcome.skipped, 'no_installation');
    assert.equal(outcome.failed, false, 'eine fehlende Installation ist kein Fehlschlag');
    assert.equal(outcome.frozen, false);
  });
});
```

**Fällt, wenn:** `reindex` den `skipped`-Grund verschluckt oder eine fehlende Installation als `failed` meldet — dann bräuchte ein Betreiber, der eine Installation entfernt hat, einen Exit-Code 1 für einen normalen Zustand.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, falls `reindex` den neuen Zustand nicht durchreicht. Reicht es ihn schon durch, hält der Test das fest — melde das im Report und fahre fort.

- [ ] **Step 3: Write the implementation**

In `bin/reindex.ts` die Zustandszeile in der Ausgabeschleife erweitern, damit ein übersprungenes Repository nicht als „not a log" erscheint:

```ts
    const state = outcome.failed ? 'failed'
      : outcome.skipped === 'no_installation' ? 'no installation'
      : outcome.skipped === 'no_commits' ? 'no commits yet'
      : outcome.frozen ? 'frozen'
      : outcome.logId === null ? 'not a log'
      : `${outcome.logId} (${outcome.fetched} fetched, ${outcome.errors} errors)`;
```

In `package.json` das `start`-Skript die `.env` selbst lesen lassen — der Dienst verlangt jetzt über `readConfig` vier Umgebungsvariablen, und `node server.ts` allein bekäme keine davon:

```json
    "start": "node --env-file-if-exists=.env server.ts",
```

In `README.md` unter dem Abschnitt „Index aus GitHub aufbauen" ergänzen:

```markdown
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

`GET /health` antwortet 200, ohne den Index anzufassen.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Read the README section back against the code**

Prüfe Zeile für Zeile: heißt die Route wirklich `/webhook`, ist die Vorgabe für `DB_PATH` wirklich `./release-log.sqlite`, ist der Reconcile-Abstand wirklich fünf Minuten und die Schwelle wirklich eine Stunde? Eine Dokumentationszeile, die nicht stimmt, ist schlechter als keine.

- [ ] **Step 6: Commit**

```bash
git add bin/reindex.ts bin/reindex.test.ts README.md package.json
git commit -m "docs: describe how the index keeps itself current"
```

---

## Nach dem letzten Task: Prüfung von Hand

Diese Prüfung braucht echte Zugangsdaten und gehört dem Menschen. **Nicht von einem Agenten ausführen.**

```bash
cd /Users/christian/www/release-log && npm start
```

Erwartet: `release-log-hub on http://127.0.0.1:8787, index at ./release-log.sqlite`.

1. `curl -s localhost:8787/health` → `{"ok":true}`.
2. Im Repo mit installierter Dev-App einen Commit pushen. Innerhalb weniger Sekunden erscheint keine Fehlermeldung im Log, und `sqlite3 release-log.sqlite 'select public_id, head_sha, indexed_at from log'` zeigt den neuen Head.
3. In den Einstellungen der GitHub App unter „Advanced" die letzte Zustellung ansehen: sie muss 202 sein. Ist sie 401, stimmt `GITHUB_WEBHOOK_SECRET` nicht mit dem in der App-Konfiguration überein.
4. Den Dienst laufen lassen und `indexed_at` nach zehn Minuten erneut lesen: es muss sich bewegt haben, auch ohne Push.

Punkt 3 ist der einzige, den kein Test abdecken kann: ob das Secret in `.env` dasselbe ist wie das bei GitHub hinterlegte, weiß nur GitHub.

---

## Selbstprüfung

**Spec-Abdeckung.** §4 „Eine Abgleichfunktion, drei Auslöser": Webhook (Task 7) und Reconcile (Task 6) kommen hinzu, der MCP-Schreibpfad folgt in Plan 5. §4 „Reconcile": Task 6, mit der in „Abweichungen" begründeten Ausnahme für eingefrorene Logs. §4 Schema: unverändert, siehe Abweichung 2. §10 Fehlerverhalten: „Webhook ohne gültige Signatur" Task 4 und 7, „Installation suspendiert oder entfernt" Task 1 und 3, „GitHub nicht erreichbar oder Rate-Limit" steht schon in `withRetry`. §10 Lebenszyklus: umbenannt und transferiert Task 3, gelöscht Task 3, wiederhergestellt Task 3 und 6. „Log löschen" gehört ins Dashboard, Plan 6. §12 `/health` und `DB_PATH`: Task 7 und 8.

**Nicht abgedeckt und bewusst offen:** `log.installation_id` und die Tabelle `installation` (Abweichung 2, Plan 5), die Rechteprüfung mit Fünf-Minuten-Cache (Plan 5), die Zuordnung einer Installation zu einem neuen Owner nach einem Transfer — Spec §10 verlangt „die Installation wird neu zugeordnet; fehlt sie beim neuen Owner, wird der Log eingefroren", und genau das tut Task 3 heute **nicht**: fehlt die Installation beim neuen Owner, meldet `probe` `no_installation` und der Log läuft ohne Abgleich weiter, statt einzufrieren. Das ist die konservativere Richtung und in der Sache dieselbe Entscheidung wie Abweichung 1; Plan 5 kann es schärfen, sobald die Installationstabelle sagen kann, ob eine Installation je bestand.

**Typkonsistenz.** `RepoState` (Task 1) wird in Task 3 verbraucht. `SyncOutcome.skipped` (Task 3) in Task 8. `Queue` (Task 5) in Task 6 und 7. `Hooks` (Task 7) nur dort. `Installations.invalidate` (Task 2) nur in `lib/github.ts`. `refsFor`/`verifySignature` (Task 4) nur in Task 7.

**Testzahl.** Aktuell 195. Task 1 tauscht sieben gegen neun, die übrigen Tasks legen zu; am Ende sollten es rund 240 sein.
