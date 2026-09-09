# Release-Log-Hub — Plan 3: Der echte GitHub-Client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die `GitHub`-Naht, die Plan 2 nur mit einem Fake erfüllt hat, gegen die echte REST-API einer GitHub App ausfüllen — sodass `node bin/reindex.ts <owner>/<repo>` ein wirkliches Repository indiziert.

**Architecture:** Eine GitHub App authentifiziert sich mit einem kurzlebigen, selbst signierten JWT und tauscht es gegen ein Installations-Token, das nie gespeichert und nur bis zum Ablauf im Speicher gehalten wird. Der Client liegt hinter derselben Schnittstelle wie das Fake aus Plan 2, und alles Netz geht durch **eine** injizierte `fetch`-artige Funktion — deshalb braucht kein Test dieses Plans eine Netzverbindung.

**Tech Stack:** Node 24, TypeScript ohne Build-Schritt, `node:crypto` für die JWT-Signatur, globales `fetch`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-08-release-log-hub-design.md` — §4 (Abgleich), §5 (Identität, Rolle 1), §9 (Modulschnitt), §10 (Fehlerverhalten), §12 (Betrieb).

**Vorgänger:** Plan 1 und Plan 2 sind auf `main` gemerged; 133 Tests, Typprüfung sauber.

## Zuschnitt

Schritt 3 der Bauabfolge nennt fünf Dinge: echten Client, Anmeldung mit Zulassungsprüfung, Webhook, Rechteprüfung, Reconcile. Das sind fünf Teilsysteme, und ein Plan soll für sich lauffähige Software ergeben. Dieser Plan baut **nur den Client**. Webhook, Reconcile, Lebenszyklus-Events und das Umschalten des Servers auf den Index sind Plan 4; Anmeldung, Zulassungsliste und Rechte-Cache sind Plan 5.

## Global Constraints

- **Node 24.2.** `engines` deklariert `>=24.2`. Kein Build-Schritt, kein Bundler, kein `tsc`-Emit.
- **`npm test` ist genau `node --test`**, aus dem Projektwurzelverzeichnis, **ohne Pfadargument**. `node --test lib/` scheitert mit `MODULE_NOT_FOUND`. Kein anderer Testrunner.
- **Importe tragen die Endung `.ts`**; reine Typimporte benutzen `import type`.
- **Nur löschbare Typsyntax.** Keine `enum`, keine `namespace`, keine Parameter-Eigenschaften, kein `declare` im Klassenkörper.
- **Keine neuen Abhängigkeiten.** Weder Octokit noch eine JWT-Bibliothek: `node:crypto` und `fetch` genügen, und die Spec begrenzt die Laufzeitfläche.
- **Bezeichner und Kommentare englisch.**
- **Kein Netzzugriff in Tests.** Alles Netz geht durch eine injizierte `fetch`-artige Funktion.
- **Installations-Token werden nie persistiert** (§5). Sie liegen im Speicher, bis sie ablaufen, und werden vorzeitig als abgelaufen behandelt.
- **Geheimnisse kommen aus der Umgebung** und erscheinen in keiner Log-Zeile, keiner Fehlermeldung und keinem Test-Fixture.
- **Drei Module über §9 hinaus:** `lib/appAuth.ts`, `lib/http.ts` und `lib/mediaTypes.ts`. §9 nennt `lib/config.ts` und `lib/github.ts`; die drei anderen trennen Identität von Repo-Zugriff, bündeln die Netz-Naht und entdoppeln eine Tabelle, die Plan 2 zweimal hatte.

## Testregel dieses Plans

Jeder Testfall unten trägt eine Zeile **„Fällt, wenn: …"**, die benennt, was man aus dem Produktionscode entfernen muss, damit er fehlschlägt.

Der Grund: In Plan 2 waren sechs von neunzehn Befunden Testfälle, die bestanden hätten, wenn man ihr Prüfobjekt löscht — alle sechs stammten aus Plantext. Lässt sich diese Zeile für einen Testfall nicht schreiben, ist der Fall falsch geschnitten und gehört umgeschrieben, nicht implementiert.

## Bestehende Schnittstellen

```ts
// lib/github.ts
export type RepoRef = { owner: string; repo: string };
export type TreeEntry = { path: string; sha: string; size: number };
export type GitHub = {
  head(ref: RepoRef): Promise<string | null>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
};
export function blobSha(content: Buffer | string): string;
export function fakeGitHub(repos: Record<string, Record<string, string | Buffer>>): GitHub;

// lib/index.ts
export type SyncOutcome = { logId: string | null; fetched: number; errors: number; frozen: boolean; failed: boolean };
export async function syncLog(db: Db, gh: GitHub, ref: RepoRef): Promise<SyncOutcome>;

// lib/db/client.ts — export type Db, function openDb(path: string): Db
// bin/reindex.ts — export async function reindex(db, gh, refs): Promise<SyncOutcome[]>
```

`lib/db/schema.ts` hat die Spalte `log.repoNodeId`, die bisher immer `null` bleibt.

## Dateien

```
lib/config.ts        Umgebung lesen und beim Start prüfen
lib/appAuth.ts       App-JWT, Installationssuche, Installations-Token mit Cache
lib/http.ts          die eine fetch-artige Naht plus Wiederholungslogik
lib/mediaTypes.ts    die eine Definition erlaubter Medientypen
lib/github.ts        githubClient() neben dem bestehenden Fake
bin/reindex.ts       den echten Client verdrahten
```

`lib/appAuth.ts` und `lib/github.ts` sind getrennt, weil das eine beantwortet „wer bin ich" und das andere „was steht im Repo": Plan 5 braucht die Authentifizierung ohne die Repo-Operationen.

---

### Task 1: Umgebung lesen und prüfen

**Files:**
- Create: `lib/config.ts`
- Test: `lib/config.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `type AppConfig = { appId: string; privateKey: string; webhookSecret: string; baseUrl: string }`, `function readConfig(env: Record<string, string | undefined>): AppConfig`.

`readConfig` nimmt die Umgebung als Argument statt `process.env` direkt zu lesen — sonst wäre sie ohne Prozessglobale nicht testbar.

- [ ] **Step 1: Write the failing test**

`lib/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from './config.ts';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n';
const B64 = Buffer.from(PEM, 'utf8').toString('base64');

const COMPLETE = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: B64,
  GITHUB_WEBHOOK_SECRET: 'shhh',
  BASE_URL: 'https://release-log.czpt.de',
};

test('readConfig decodes the base64 private key back to PEM', () => {
  const config = readConfig(COMPLETE);
  assert.equal(config.privateKey, PEM);
  assert.equal(config.appId, '12345');
});

test('readConfig names every missing variable at once', () => {
  try {
    readConfig({ GITHUB_APP_ID: '12345' });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    for (const name of ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'BASE_URL']) {
      assert.ok(message.includes(name), `expected ${name} in: ${message}`);
    }
    assert.ok(!message.includes('GITHUB_APP_ID'), 'a variable that is present must not be reported missing');
  }
});

test('readConfig rejects a private key that is not PEM after decoding', () => {
  const notPem = Buffer.from('hello', 'utf8').toString('base64');
  assert.throws(
    () => readConfig({ ...COMPLETE, GITHUB_APP_PRIVATE_KEY: notPem }),
    /PRIVATE KEY/,
  );
});

test('the thrown message never contains a secret value', () => {
  try {
    readConfig({ ...COMPLETE, GITHUB_APP_PRIVATE_KEY: undefined });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes('shhh'), 'the webhook secret must not appear in an error');
  }
});
```

**Fällt, wenn:** Test 1 — die base64-Dekodierung entfernt wird. Test 2 — die Sammlung fehlender Namen durch ein Abbrechen beim ersten ersetzt wird (dann fehlen zwei der drei Namen). Test 3 — die PEM-Prüfung entfernt wird. Test 4 — der vorhandene Wert der übrigen Variablen in die Meldung aufgenommen wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './config.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/config.ts`:

```ts
// Read once, at startup, and fail with every problem at once. A service
// that starts and then discovers its third missing variable on the first
// request wastes a deploy cycle per variable.

export type AppConfig = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  baseUrl: string;
};

const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'BASE_URL',
];

export function readConfig(env: Record<string, string | undefined>): AppConfig {
  const missing = REQUIRED.filter((name) => {
    const value = env[name];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    // Names only. A value here would be a secret in a log line.
    throw new Error(`missing environment variables: ${missing.join(', ')}`);
  }

  // The key is stored base64-encoded because a multi-line PEM is not an
  // .env line (spec §12).
  const privateKey = Buffer.from(env.GITHUB_APP_PRIVATE_KEY as string, 'base64').toString('utf8');
  if (!privateKey.includes('PRIVATE KEY')) {
    throw new Error('GITHUB_APP_PRIVATE_KEY does not decode to a PEM PRIVATE KEY block');
  }

  return {
    appId: env.GITHUB_APP_ID as string,
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET as string,
    baseUrl: env.BASE_URL as string,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 4 neuen Tests plus die bestehende Suite.

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts lib/config.test.ts
git commit -m "feat: read and validate the app's environment at startup"
```

---

### Task 2: Das App-JWT

**Files:**
- Create: `lib/appAuth.ts`
- Test: `lib/appAuth.test.ts`

**Interfaces:**
- Consumes: `type AppConfig` aus `./config.ts`.
- Produces: `function appJwt(config: AppConfig, nowSeconds?: number): string`.

- [ ] **Step 1: Write the failing test**

`lib/appAuth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt } from './appAuth.ts';
import type { AppConfig } from './config.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CONFIG: AppConfig = {
  appId: '12345',
  privateKey,
  webhookSecret: 'shhh',
  baseUrl: 'https://example.test',
};

function parts(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
  };
}

test('the jwt verifies against the public key', () => {
  const token = appJwt(CONFIG);
  const [h, p, signature] = token.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${p}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true);
});

test('the header declares RS256', () => {
  assert.equal(parts(appJwt(CONFIG)).header.alg, 'RS256');
});

test('the issuer is the app id', () => {
  assert.equal(parts(appJwt(CONFIG)).payload.iss, '12345');
});

test('iat is backdated and exp is under ten minutes out', () => {
  const now = 1_800_000_000;
  const { payload } = parts(appJwt(CONFIG, now));
  // GitHub rejects a token whose iat is in the future by even a second of
  // clock skew, and refuses any exp more than 10 minutes ahead.
  assert.ok((payload.iat as number) < now, 'iat must be backdated against clock skew');
  assert.ok((payload.exp as number) > now, 'exp must be in the future');
  assert.ok((payload.exp as number) - now <= 600, 'exp must be at most 10 minutes ahead');
});

test('a tampered payload no longer verifies', () => {
  const token = appJwt(CONFIG);
  const [h, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ iss: '99999' }), 'utf8').toString('base64url');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${h}.${forged}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), false);
});
```

**Fällt, wenn:** Test 1 — die Signatur über etwas anderem als `header.payload` gebildet wird, oder das Ergebnis nicht base64url ist. Test 2 — `alg` auf einen anderen Wert gesetzt wird. Test 3 — `iss` weggelassen oder auf etwas anderes als die App-ID gesetzt wird. Test 4 — der Rückdatierungsabzug bei `iat` entfällt, oder `exp` über 600 Sekunden hinausgeht. Test 5 ist eine Kontrollprobe für die Verifikationsmechanik der anderen Tests und fällt nur, wenn `createVerify` selbst falsch benutzt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './appAuth.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/appAuth.ts`:

```ts
// Who the app is, as opposed to what a repository contains. A GitHub App
// proves its identity with a short-lived JWT it signs itself, then trades
// that for an installation token (spec §5).

import { createSign } from 'node:crypto';
import type { AppConfig } from './config.ts';

// GitHub rejects a JWT whose iat lies in the future, so back it off far
// enough to absorb clock skew, and it refuses any exp more than ten
// minutes out. Nine minutes leaves room for both.
const SKEW_SECONDS = 60;
const LIFETIME_SECONDS = 540;

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function appJwt(config: AppConfig, nowSeconds?: number): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const head = segment({ alg: 'RS256', typ: 'JWT' });
  const payload = segment({
    iat: now - SKEW_SECONDS,
    exp: now + LIFETIME_SECONDS,
    iss: config.appId,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${payload}`);
  return `${head}.${payload}.${signer.sign(config.privateKey, 'base64url')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 5 neuen Tests plus die bestehende Suite.

- [ ] **Step 5: Commit**

```bash
git add lib/appAuth.ts lib/appAuth.test.ts
git commit -m "feat: sign the app's own identity token"
```

---

### Task 3: Die HTTP-Naht

**Files:**
- Create: `lib/http.ts`
- Test: `lib/http.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `type Http = (url: string, init?: RequestInit) => Promise<Response>`, `type FakeRoute = { status?: number; headers?: Record<string, string>; body?: unknown }`, `function fakeHttp(routes: Record<string, FakeRoute | FakeRoute[]>): Http & { calls: string[] }`.

Der Fake wird von jedem folgenden Task benutzt. Ein Schlüssel ist `"<METHOD> <path>"`, etwa `"GET /repos/o/r"`. Ein Array bedeutet: nacheinander, für Wiederholungstests.

- [ ] **Step 1: Write the failing test**

`lib/http.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHttp } from './http.ts';

test('fakeHttp answers a route and records the call', async () => {
  const http = fakeHttp({ 'GET /repos/o/r': { body: { node_id: 'R_1' } } });
  const res = await http('https://api.github.com/repos/o/r');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { node_id: 'R_1' });
  assert.deepEqual(http.calls, ['GET /repos/o/r']);
});

test('fakeHttp answers an unknown route with 404, not a throw', async () => {
  const http = fakeHttp({});
  const res = await http('https://api.github.com/repos/o/gone');
  assert.equal(res.status, 404);
});

test('fakeHttp serves an array of responses in order', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': [{ status: 500 }, { status: 200, body: { ok: true } }],
  });
  assert.equal((await http('https://api.github.com/repos/o/r')).status, 500);
  assert.equal((await http('https://api.github.com/repos/o/r')).status, 200);
});

test('the last response of an array repeats once exhausted', async () => {
  const http = fakeHttp({ 'GET /repos/o/r': [{ status: 500 }] });
  assert.equal((await http('https://api.github.com/repos/o/r')).status, 500);
  assert.equal((await http('https://api.github.com/repos/o/r')).status, 500);
});

test('fakeHttp distinguishes methods on the same path', async () => {
  const http = fakeHttp({
    'GET /app/installations/7/access_tokens': { status: 404 },
    'POST /app/installations/7/access_tokens': { body: { token: 't' } },
  });
  const res = await http('https://api.github.com/app/installations/7/access_tokens', { method: 'POST' });
  assert.deepEqual(await res.json(), { token: 't' });
});

test('the query string is part of the key', async () => {
  const http = fakeHttp({ 'GET /repos/o/r/git/trees/abc?recursive=1': { body: { tree: [] } } });
  const res = await http('https://api.github.com/repos/o/r/git/trees/abc?recursive=1');
  assert.equal(res.status, 200);
});
```

**Fällt, wenn:** Test 1 — `calls` nicht befüllt wird, oder der Körper nicht als JSON zurückkommt. Test 2 — eine unbekannte Route einen Fehler wirft statt 404 zu liefern. Test 3 — der Array-Index nicht fortschreitet. Test 4 — der Index über das Ende hinausläuft und `undefined` liefert. Test 5 — die Methode aus dem Schlüssel entfernt wird. Test 6 — die Query aus dem Schlüssel entfernt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './http.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/http.ts`:

```ts
// One seam for everything that touches the network. Production passes the
// global fetch; tests pass fakeHttp, so no test in this project opens a
// socket to GitHub.

export type Http = (url: string, init?: RequestInit) => Promise<Response>;

export type FakeRoute = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

function keyOf(url: string, init?: RequestInit): string {
  const parsed = new URL(url);
  return `${init?.method ?? 'GET'} ${parsed.pathname}${parsed.search}`;
}

export function fakeHttp(
  routes: Record<string, FakeRoute | FakeRoute[]>,
): Http & { calls: string[] } {
  const calls: string[] = [];
  const cursors = new Map<string, number>();

  const http = async (url: string, init?: RequestInit): Promise<Response> => {
    const key = keyOf(url, init);
    calls.push(key);
    const route = routes[key];
    if (route === undefined) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    let chosen: FakeRoute;
    if (Array.isArray(route)) {
      const index = cursors.get(key) ?? 0;
      // Past the end, the last entry repeats: a retry test wants "still
      // failing", not "undefined".
      chosen = route[Math.min(index, route.length - 1)];
      cursors.set(key, index + 1);
    } else {
      chosen = route;
    }
    return new Response(chosen.body === undefined ? null : JSON.stringify(chosen.body), {
      status: chosen.status ?? 200,
      headers: { 'content-type': 'application/json', ...(chosen.headers ?? {}) },
    });
  };

  return Object.assign(http, { calls });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 6 neuen Tests plus die bestehende Suite.

- [ ] **Step 5: Commit**

```bash
git add lib/http.ts lib/http.test.ts
git commit -m "feat: add the http seam and its fake"
```

---

### Task 4: Installations-Token mit Cache

**Files:**
- Modify: `lib/appAuth.ts`
- Test: `lib/appAuth.test.ts`

**Interfaces:**
- Consumes: `appJwt`, `type AppConfig`, `type Http`.
- Produces: `type Installations = { tokenFor(ref: { owner: string; repo: string }): Promise<string | null> }`, `function installations(config: AppConfig, http: Http, nowMs?: () => number): Installations`.

`tokenFor`'s parameter is written out rather than importing `RepoRef` from `./github.ts`: that module imports `Installations` from here, and importing back would close a cycle — the same shape Plan 2's self-review rejected.

`tokenFor` liefert `null`, wenn die App auf diesem Repository nicht installiert ist — das ist ein normaler Zustand, kein Fehler.

- [ ] **Step 1: Write the failing test**

An `lib/appAuth.test.ts` anhängen:

```ts
import { installations } from './appAuth.ts';
import { fakeHttp } from './http.ts';

const REF = { owner: 'o', repo: 'r' };

function inAnHour(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

test('tokenFor exchanges the app jwt for an installation token', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const token = await installations(CONFIG, http).tokenFor(REF);
  assert.equal(token, 'ghs_abc');
});

test('a repository with no installation yields null, not a throw', async () => {
  const http = fakeHttp({ 'GET /repos/o/r/installation': { status: 404 } });
  assert.equal(await installations(CONFIG, http).tokenFor(REF), null);
});

test('a second call for the same installation does not mint a second token', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const inst = installations(CONFIG, http);
  await inst.tokenFor(REF);
  await inst.tokenFor(REF);
  const mints = http.calls.filter((c) => c.startsWith('POST /app/installations'));
  assert.equal(mints.length, 1, 'the cached token must be reused');
});

test('a token close to expiry is replaced before it expires', async () => {
  let clock = 1_000_000;
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': [
      { body: { token: 'first', expires_at: new Date(clock + 120_000).toISOString() } },
      { body: { token: 'second', expires_at: new Date(clock + 3_600_000).toISOString() } },
    ],
  });
  const inst = installations(CONFIG, http, () => clock);
  assert.equal(await inst.tokenFor(REF), 'first');
  // Still 90 seconds of nominal life left, but inside the safety margin.
  clock += 30_000;
  assert.equal(await inst.tokenFor(REF), 'second');
});

test('two repositories in one installation share its token', async () => {
  const http = fakeHttp({
    'GET /repos/o/one/installation': { body: { id: 7 } },
    'GET /repos/o/two/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': { body: { token: 'ghs_abc', expires_at: inAnHour() } },
  });
  const inst = installations(CONFIG, http);
  await inst.tokenFor({ owner: 'o', repo: 'one' });
  await inst.tokenFor({ owner: 'o', repo: 'two' });
  const mints = http.calls.filter((c) => c.startsWith('POST /app/installations'));
  assert.equal(mints.length, 1, 'the cache is keyed by installation, not by repository');
});
```

**Fällt, wenn:** Test 1 — einer der beiden Aufrufe entfällt oder das Token nicht aus der Antwort gelesen wird. Test 2 — die 404-Behandlung durch einen Wurf ersetzt wird. Test 3 — der Cache entfernt wird. Test 4 — der Sicherheitsabstand vor dem Ablauf entfernt wird (dann bleibt „first" gültig). Test 5 — der Cache nach Repository statt nach Installation geschlüsselt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `installations` ist kein Export von `./appAuth.ts`.

- [ ] **Step 3: Write minimal implementation**

An `lib/appAuth.ts` anhängen:

```ts
import type { Http } from './http.ts';

const API = 'https://api.github.com';

// Replace a token this long before it nominally expires. A token that
// expires mid-request is a failure the caller cannot distinguish from a
// revoked installation.
const EXPIRY_MARGIN_MS = 60_000;

export type Installations = {
  // The parameter is spelled out rather than imported as RepoRef:
  // lib/github.ts imports Installations from here, and importing back
  // would close a cycle. Structurally it is the same shape.
  //
  // null when the app is not installed on that repository — a normal
  // state, not an error (spec §6: create_log reports no_installation).
  tokenFor(ref: { owner: string; repo: string }): Promise<string | null>;
};

type Minted = { token: string; expiresAtMs: number };

function headers(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'release-log-hub',
    authorization: `Bearer ${token}`,
  };
}

export function installations(
  config: AppConfig,
  http: Http,
  nowMs: () => number = Date.now,
): Installations {
  // Keyed by installation, not by repository: every repository of one
  // installation shares its token, and minting is rate-limited.
  const cache = new Map<number, Minted>();

  return {
    async tokenFor(ref) {
      const found = await http(`${API}/repos/${ref.owner}/${ref.repo}/installation`, {
        headers: headers(appJwt(config)),
      });
      if (found.status === 404) return null;
      if (!found.ok) {
        throw new Error(`installation lookup failed: HTTP ${found.status}`);
      }
      const installationId = ((await found.json()) as { id: number }).id;

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
      // Never persisted: it lives here until it expires (spec §5).
      cache.set(installationId, {
        token: body.token,
        expiresAtMs: Date.parse(body.expires_at),
      });
      return body.token;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 5 neuen Tests plus die bestehende Suite.

- [ ] **Step 5: Commit**

```bash
git add lib/appAuth.ts lib/appAuth.test.ts
git commit -m "feat: mint and cache installation tokens per installation"
```

---

### Task 5: `githubClient` — `head` und `repoId`

**Files:**
- Modify: `lib/github.ts`
- Test: `lib/github.test.ts`

**Interfaces:**
- Consumes: `type Installations`, `type Http`.
- Produces: `GitHub` bekommt eine vierte Methode `repoId(ref: RepoRef): Promise<string | null>`; `function githubClient(inst: Installations, http: Http): GitHub`; `fakeGitHub` erfüllt `repoId` ebenfalls.

`repoId` liefert GitHubs unveränderliche Repository-Kennung. Sie überlebt Umbenennen und Transfer, und Plan 4 braucht sie, um beides von einer doppelten Log-Kennung zu unterscheiden.

- [ ] **Step 1: Write the failing test**

An `lib/github.test.ts` anhängen:

```ts
import { githubClient } from './github.ts';
import { fakeHttp } from './http.ts';
import type { Installations } from './appAuth.ts';

const REF = { owner: 'o', repo: 'r' };

function withToken(token: string | null): Installations {
  return { async tokenFor() { return token; } };
}

test('head returns the sha of the default branch tip', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  assert.equal(await githubClient(withToken('t'), http).head(REF), 'c0ffee');
});

test('head follows the repository default branch rather than assuming main', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'trunk' } },
    'GET /repos/o/r/commits/trunk': { body: { sha: 'deadbee' } },
  });
  assert.equal(await githubClient(withToken('t'), http).head(REF), 'deadbee');
});

test('a deleted repository yields a null head', async () => {
  const http = fakeHttp({});
  assert.equal(await githubClient(withToken('t'), http).head(REF), null);
});

test('a repository the app is not installed on yields a null head', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });
  assert.equal(await githubClient(withToken(null), http).head(REF), null);
  assert.deepEqual(http.calls, [], 'without a token there is nothing to ask');
});

test('an empty repository with no commits yields a null head', async () => {
  const http = fakeHttp({
    'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { status: 409, body: { message: 'Git Repository is empty.' } },
  });
  assert.equal(await githubClient(withToken('t'), http).head(REF), null);
});

test('repoId returns the immutable node id', async () => {
  const http = fakeHttp({ 'GET /repos/o/r': { body: { node_id: 'R_kg1', default_branch: 'main' } } });
  assert.equal(await githubClient(withToken('t'), http).repoId(REF), 'R_kg1');
});

test('the request carries the installation token, not the app jwt', async () => {
  let seen: string | undefined;
  const inner = fakeHttp({ 'GET /repos/o/r': { body: { node_id: 'R_1', default_branch: 'main' } } });
  const spy = Object.assign(
    async (url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('authorization') ?? undefined;
      return inner(url, init);
    },
    { calls: inner.calls },
  );
  await githubClient(withToken('ghs_abc'), spy).repoId(REF);
  assert.equal(seen, 'Bearer ghs_abc');
});

test('fakeGitHub answers repoId for a known repository and null for an unknown one', async () => {
  const gh = fakeGitHub({ 'o/r': { 'a.txt': 'x' } });
  assert.ok(await gh.repoId({ owner: 'o', repo: 'r' }));
  assert.equal(await gh.repoId({ owner: 'o', repo: 'gone' }), null);
});
```

**Fällt, wenn:** Test 1 — der Commit-Aufruf entfällt oder `sha` nicht gelesen wird. Test 2 — der Branch fest auf `main` verdrahtet wird. Test 3 — die 404-Behandlung des Repository-Aufrufs entfernt wird. Test 4 — der `null`-Token-Frühausstieg entfernt wird (dann werden Aufrufe abgesetzt und `calls` ist nicht leer). Test 5 — die 409-Behandlung entfernt wird. Test 6 — `node_id` nicht durchgereicht wird. Test 7 — der Authorization-Header weggelassen oder auf das JWT gesetzt wird. Test 8 — `repoId` aus dem Fake entfernt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `githubClient` ist kein Export von `./github.ts`, und `fakeGitHub` hat kein `repoId`.

- [ ] **Step 3: Write minimal implementation**

In `lib/github.ts` die Schnittstelle erweitern:

```ts
export type GitHub = {
  head(ref: RepoRef): Promise<string | null>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
  // GitHub's immutable id for the repository. It survives a rename and a
  // transfer, which is what lets a later plan tell those apart from a
  // repository claiming an id that belongs to someone else (spec §10).
  repoId(ref: RepoRef): Promise<string | null>;
};
```

Im Rückgabeobjekt von `fakeGitHub` ergänzen:

```ts
    async repoId(ref) {
      return entriesOf(ref) === null ? null : `R_fake_${key(ref)}`;
    },
```

Und den Client anfügen:

```ts
import type { Http } from './http.ts';
import type { Installations } from './appAuth.ts';

const API = 'https://api.github.com';

type RepoInfo = { nodeId: string; defaultBranch: string };

export function githubClient(inst: Installations, http: Http): GitHub {
  async function authed(ref: RepoRef, path: string): Promise<Response | null> {
    const token = await inst.tokenFor(ref);
    // Not installed: there is nothing to ask, and asking without a token
    // would be a different failure than the one the caller means.
    if (token === null) return null;
    return http(`${API}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'release-log-hub',
        authorization: `Bearer ${token}`,
      },
    });
  }

  async function repoInfo(ref: RepoRef): Promise<RepoInfo | null> {
    const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}`);
    if (res === null || res.status === 404) return null;
    if (!res.ok) throw new Error(`repo lookup failed: HTTP ${res.status}`);
    const body = (await res.json()) as { node_id: string; default_branch: string };
    return { nodeId: body.node_id, defaultBranch: body.default_branch };
  }

  return {
    async repoId(ref) {
      return (await repoInfo(ref))?.nodeId ?? null;
    },

    async head(ref) {
      const info = await repoInfo(ref);
      if (info === null) return null;
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/commits/${info.defaultBranch}`);
      if (res === null || res.status === 404) return null;
      // 409 is how GitHub reports a repository with no commits at all.
      // That is an empty log, not a missing one — but there is no tree to
      // read either, so it answers like a gone repository here.
      if (res.status === 409) return null;
      if (!res.ok) throw new Error(`head lookup failed: HTTP ${res.status}`);
      return ((await res.json()) as { sha: string }).sha;
    },

    async tree() {
      throw new Error('not implemented');
    },

    async blob() {
      throw new Error('not implemented');
    },
  };
}
```

`tree` und `blob` werfen bewusst, bis Task 6 sie füllt — ein stiller leerer Baum würde `syncLog` dazu bringen, jede Datei als verschwunden zu löschen.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 8 neuen Tests plus die bestehende Suite.

- [ ] **Step 5: Commit**

```bash
git add lib/github.ts lib/github.test.ts
git commit -m "feat: read a repository's head and immutable id from GitHub"
```

---

### Task 6: `tree` und `blob`

**Files:**
- Modify: `lib/github.ts`
- Test: `lib/github.test.ts`

**Interfaces:**
- Consumes: alles aus Task 5.
- Produces: keine neuen Exporte; `githubClient`s `tree` und `blob` funktionieren.

- [ ] **Step 1: Write the failing test**

An `lib/github.test.ts` anhängen:

```ts
test('tree returns only blobs, with path, sha and size', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/git/trees/c0ffee?recursive=1': {
      body: {
        truncated: false,
        tree: [
          { path: 'releases', type: 'tree', sha: 't1' },
          { path: 'releases/1.0.0.json', type: 'blob', sha: 'b1', size: 42 },
          { path: 'media/shot.png', type: 'blob', sha: 'b2', size: 7 },
        ],
      },
    },
  });
  const entries = await githubClient(withToken('t'), http).tree(REF, 'c0ffee');
  assert.deepEqual(entries, [
    { path: 'releases/1.0.0.json', sha: 'b1', size: 42 },
    { path: 'media/shot.png', sha: 'b2', size: 7 },
  ]);
});

test('a tree that cannot be read throws instead of returning an empty one', async () => {
  const http = fakeHttp({});
  // An empty array would tell the sync that every file was deleted.
  await assert.rejects(
    () => githubClient(withToken('t'), http).tree(REF, 'c0ffee'),
    /tree lookup failed/,
  );
});

test('a tree requested without an installation throws rather than reading as empty', async () => {
  const http = fakeHttp({});
  await assert.rejects(
    () => githubClient(withToken(null), http).tree(REF, 'c0ffee'),
    /no installation token/,
  );
});

test('a truncated tree throws instead of returning a partial one', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/git/trees/c0ffee?recursive=1': {
      body: { truncated: true, tree: [{ path: 'a.json', type: 'blob', sha: 'b1', size: 1 }] },
    },
  });
  // A partial tree looks to the sync exactly like a repository whose other
  // files were deleted, and it would delete their rows. Refusing is the
  // only safe answer.
  await assert.rejects(
    () => githubClient(withToken('t'), http).tree(REF, 'c0ffee'),
    /truncated/,
  );
});

test('blob decodes base64 content', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/git/blobs/b1': {
      body: { encoding: 'base64', content: Buffer.from('hello\n', 'utf8').toString('base64') },
    },
  });
  const bytes = await githubClient(withToken('t'), http).blob(REF, 'b1');
  assert.equal(bytes?.toString('utf8'), 'hello\n');
});

test('blob handles the newlines GitHub inserts into base64 content', async () => {
  const raw = Buffer.from('hello\n', 'utf8').toString('base64');
  const http = fakeHttp({
    'GET /repos/o/r/git/blobs/b1': { body: { encoding: 'base64', content: `${raw.slice(0, 2)}\n${raw.slice(2)}\n` } },
  });
  const bytes = await githubClient(withToken('t'), http).blob(REF, 'b1');
  assert.equal(bytes?.toString('utf8'), 'hello\n');
});

test('a missing blob yields null', async () => {
  const http = fakeHttp({});
  assert.equal(await githubClient(withToken('t'), http).blob(REF, 'nope'), null);
});

test('an unexpected blob encoding throws rather than returning garbage', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/git/blobs/b1': { body: { encoding: 'utf-8', content: 'hello' } },
  });
  await assert.rejects(
    () => githubClient(withToken('t'), http).blob(REF, 'b1'),
    /encoding/,
  );
});

test('a fetched blob really hashes to the sha it was asked for', async () => {
  const content = 'version: 1\n';
  const sha = blobSha(content);
  const http = fakeHttp({
    [`GET /repos/o/r/git/blobs/${sha}`]: {
      body: { encoding: 'base64', content: Buffer.from(content, 'utf8').toString('base64') },
    },
  });
  const bytes = await githubClient(withToken('t'), http).blob(REF, sha);
  assert.equal(blobSha(bytes as Buffer), sha, 'the decode must round-trip to the same git hash');
});
```

**Fällt, wenn:** Test 1 — der `type === 'blob'`-Filter entfällt (dann kommt der Verzeichniseintrag mit). Test 2 und 3 — ein Fehlschlag wieder als leeres Array beantwortet wird statt zu werfen. Test 4 — die `truncated`-Prüfung entfernt wird. Test 5 — die base64-Dekodierung entfällt. Test 6 — die Zeilenumbrüche vor dem Dekodieren nicht entfernt werden. Test 7 — die 404-Behandlung von `blob` entfernt wird. Test 8 — die Encoding-Prüfung entfernt wird. Test 9 — irgendetwas an der Dekodierung die Bytes verändert; er ist die Brücke zwischen diesem Client und dem SHA-Vergleich, auf dem der ganze Abgleich beruht.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `not implemented`.

- [ ] **Step 3: Write minimal implementation**

In `lib/github.ts` die beiden Platzhalter ersetzen:

```ts
    async tree(ref, commit) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/git/trees/${commit}?recursive=1`);
      // Never return an empty array for a failure. To the sync an empty
      // tree is indistinguishable from a repository whose files were all
      // deleted, and it would delete every row. head() already answers
      // null for a gone or empty repository, so by the time anything asks
      // for a tree there is one to read.
      if (res === null) throw new Error(`tree unavailable for ${ref.owner}/${ref.repo}: no installation token`);
      if (!res.ok) throw new Error(`tree lookup failed: HTTP ${res.status}`);
      const body = (await res.json()) as {
        truncated: boolean;
        tree: { path: string; type: string; sha: string; size?: number }[];
      };
      // A truncated tree is indistinguishable, to the sync, from a
      // repository whose remaining files were deleted — and the sync would
      // delete their rows. Refuse rather than silently lose content.
      if (body.truncated) {
        throw new Error(`tree for ${ref.owner}/${ref.repo}@${commit} is truncated; refusing a partial sync`);
      }
      return body.tree
        .filter((entry) => entry.type === 'blob')
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
    },

    async blob(ref, sha) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/git/blobs/${sha}`);
      if (res === null || res.status === 404) return null;
      if (!res.ok) throw new Error(`blob fetch failed: HTTP ${res.status}`);
      const body = (await res.json()) as { encoding: string; content: string };
      if (body.encoding !== 'base64') {
        throw new Error(`unexpected blob encoding "${body.encoding}" for ${sha}`);
      }
      // GitHub wraps base64 content at 60 characters; Buffer.from ignores
      // the newlines, but strip them so the input is what it claims to be.
      return Buffer.from(body.content.replace(/\n/g, ''), 'base64');
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 9 neuen Tests plus die bestehende Suite.

- [ ] **Step 5: Commit**

```bash
git add lib/github.ts lib/github.test.ts
git commit -m "feat: read trees and blobs, refusing an unreadable or truncated tree"
```

---

### Task 7: Rate-Limit und vorübergehende Fehler

**Files:**
- Modify: `lib/http.ts`
- Test: `lib/http.test.ts`

**Interfaces:**
- Consumes: `type Http`.
- Produces: `function withRetry(http: Http, options?: { attempts?: number; sleep?: (ms: number) => Promise<void>; nowMs?: () => number }): Http`.

`withRetry` umhüllt eine `Http` und wiederholt begrenzt. Task 9 verdrahtet sie; `githubClient` selbst weiß nichts davon.

- [ ] **Step 1: Write the failing test**

An `lib/http.test.ts` anhängen:

```ts
import { withRetry } from './http.ts';

function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('a 500 is retried and the second answer is returned', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': [{ status: 500 }, { status: 200, body: { ok: true } }] });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 200);
  assert.equal(waits.length, 1);
});

test('retries are bounded and the last failure is returned, not thrown', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': [{ status: 500 }] });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { attempts: 3, sleep })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 500);
  assert.equal(waits.length, 2, 'three attempts means two waits');
});

test('a 404 is not retried', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': { status: 404 } });
  const { sleep, waits } = recordingSleep();
  await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(waits.length, 0, 'a missing resource will not appear by waiting');
});

test('a 200 is not retried', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': { body: { ok: true } } });
  const { sleep, waits } = recordingSleep();
  await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(waits.length, 0);
});

test('an exhausted rate limit waits until its reset', async () => {
  const now = 1_700_000_000_000;
  const resetAtSeconds = Math.floor(now / 1000) + 30;
  const inner = fakeHttp({
    'GET /repos/o/r': [
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAtSeconds) } },
      { status: 200, body: { ok: true } },
    ],
  });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep, nowMs: () => now })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 200);
  assert.ok(waits[0] >= 30_000 && waits[0] <= 31_000, `expected a ~30s wait, got ${waits[0]}`);
});

test('a 403 that is not a rate limit is not retried', async () => {
  const inner = fakeHttp({ 'GET /repos/o/r': { status: 403, headers: { 'x-ratelimit-remaining': '4999' } } });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 403);
  assert.equal(waits.length, 0, 'a permission failure will not resolve itself');
});

test('a 429 honours Retry-After', async () => {
  const inner = fakeHttp({
    'GET /repos/o/r': [{ status: 429, headers: { 'retry-after': '5' } }, { status: 200, body: { ok: true } }],
  });
  const { sleep, waits } = recordingSleep();
  await withRetry(inner, { sleep })('https://api.github.com/repos/o/r');
  assert.equal(waits[0], 5000);
});

test('a wait longer than the ceiling gives up rather than sleeping for an hour', async () => {
  const now = 1_700_000_000_000;
  const inner = fakeHttp({
    'GET /repos/o/r': { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600) } },
  });
  const { sleep, waits } = recordingSleep();
  const res = await withRetry(inner, { sleep, nowMs: () => now })('https://api.github.com/repos/o/r');
  assert.equal(res.status, 403);
  assert.equal(waits.length, 0, 'an hour-long wait blocks the process; report instead');
});
```

**Fällt, wenn:** Test 1 — die Wiederholung entfällt. Test 2 — die Versuchsgrenze entfernt wird (der Test hinge) oder der letzte Fehlschlag geworfen statt zurückgegeben wird. Test 3 und 4 — der Statuscode nicht mehr darüber entscheidet, ob wiederholt wird. Test 5 — die Auswertung von `x-ratelimit-reset` entfällt. Test 6 — die Prüfung auf `x-ratelimit-remaining: 0` entfällt und jeder 403 wiederholt wird. Test 7 — `retry-after` ignoriert wird. Test 8 — die Obergrenze für die Wartezeit entfernt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `withRetry` ist kein Export von `./http.ts`.

- [ ] **Step 3: Write minimal implementation**

An `lib/http.ts` anhängen:

```ts
// Bounded patience. GitHub answers a spent rate limit with 403 plus the
// second at which it resets, and a secondary limit with 429 plus
// Retry-After; a 5xx is worth one more try. Everything else is an answer,
// not a delay (spec §10).

const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
// Longer than this and waiting would block the sync for minutes. Report
// the failure and let the caller decide.
const MAX_WAIT_MS = 60_000;

function waitFor(res: Response, attempt: number, nowMs: () => number): number | null {
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    return Number.isFinite(after) && after >= 0 ? after * 1000 : BASE_BACKOFF_MS;
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (!Number.isFinite(reset)) return BASE_BACKOFF_MS;
    return Math.max(0, reset * 1000 - nowMs());
  }
  if (res.status >= 500) return BASE_BACKOFF_MS * 2 ** attempt;
  return null;
}

export function withRetry(
  http: Http,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; nowMs?: () => number } = {},
): Http {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = options.nowMs ?? Date.now;

  return async (url, init) => {
    let last = await http(url, init);
    for (let attempt = 0; attempt < attempts - 1; attempt += 1) {
      const wait = waitFor(last, attempt, nowMs);
      if (wait === null || wait > MAX_WAIT_MS) return last;
      await sleep(wait);
      last = await http(url, init);
    }
    return last;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 8 neuen Tests plus die bestehende Suite.

- [ ] **Step 5: Commit**

```bash
git add lib/http.ts lib/http.test.ts
git commit -m "feat: retry within bounds on rate limits and server errors"
```

---

### Task 8: `repoNodeId` speichern, Medientypen entdoppeln

**Files:**
- Create: `lib/mediaTypes.ts`
- Modify: `lib/index.ts`
- Modify: `lib/store.ts`
- Test: `lib/index.test.ts`
- Test: `lib/mediaTypes.test.ts`

**Interfaces:**
- Consumes: `gh.repoId(ref)` aus Task 5.
- Produces: `lib/mediaTypes.ts` mit `const MEDIA_TYPES: Record<string, string>` und `function mediaTypeOf(path: string): string | null`.

Zwei zusammengehörige Aufräumarbeiten, beide aus Plan 2 vorgemerkt: `log.repoNodeId` blieb immer `null`, und `MEDIA_TYPES` existierte zweimal — wobei `lib/index.ts` die Endung kleinschrieb und `lib/store.ts` nicht, sodass `shot.PNG` je nach Reader gefunden oder nicht gefunden wurde. Der Umzug in ein eigenes Modul behebt außerdem, dass die Sync-Schicht bisher aus der Auslieferungsschicht importierte.

- [ ] **Step 1: Write the failing test**

`lib/mediaTypes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaTypeOf } from './mediaTypes.ts';

test('mediaTypeOf maps the allowed extensions', () => {
  assert.equal(mediaTypeOf('media/shot.png'), 'image/png');
  assert.equal(mediaTypeOf('media/shot.jpg'), 'image/jpeg');
  assert.equal(mediaTypeOf('media/shot.webp'), 'image/webp');
});

test('mediaTypeOf is case-insensitive', () => {
  assert.equal(mediaTypeOf('media/SHOT.PNG'), 'image/png');
});

test('mediaTypeOf rejects anything else', () => {
  assert.equal(mediaTypeOf('media/notes.txt'), null);
  assert.equal(mediaTypeOf('media/noextension'), null);
});
```

**Fällt, wenn:** Test 1 — ein Eintrag aus der Tabelle entfernt wird. Test 2 — das Kleinschreiben entfällt. Test 3 — die Tabelle durch etwas ersetzt wird, das jede Endung annimmt.

An `lib/index.test.ts` anhängen:

```ts
test('the sync stores the repository node id', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } });
    await syncLog(db, gh, REF);
    const row = db.select().from(log).all()[0];
    assert.ok(row.repoNodeId, 'repoNodeId must be filled from the client');
  });
});

test('an unchanged node id is not overwritten with null on a later sync', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    const first = db.select().from(log).all()[0].repoNodeId;
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    assert.equal(db.select().from(log).all()[0].repoNodeId, first);
  });
});
```

**Fällt, wenn:** Test 1 — der `repoId`-Aufruf oder das Schreiben der Spalte entfernt wird. Test 2 — das Feld im Update-Zweig des Upserts auf `null` gesetzt wird.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './mediaTypes.ts'`, und `repoNodeId` ist `null`.

- [ ] **Step 3: Write minimal implementation**

`lib/mediaTypes.ts`:

```ts
// One definition of what counts as media, shared by the sync that stores
// it and the readers that serve it. Two copies drifted apart once: the
// sync lower-cased the extension and the file reader did not, so
// "shot.PNG" was found by one and missed by the other.

export const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function mediaTypeOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  return MEDIA_TYPES[path.slice(dot).toLowerCase()] ?? null;
}
```

In `lib/index.ts`: die lokale `MEDIA_TYPES`-Tabelle und `extensionOf` entfernen, `mediaTypeOf` aus `./mediaTypes.ts` importieren und an der Prüfstelle benutzen. Den Import von `./store.ts` entfernen — die Sync-Schicht importiert nicht mehr aus der Auslieferungsschicht.

In `lib/store.ts`: die lokale Tabelle entfernen und in `media()` `mediaTypeOf(target)` benutzen statt `MEDIA_TYPES[extname(target)]`.

In `lib/index.ts`, im `log`-Upsert: `repoNodeId` aus `await gh.repoId(ref)` setzen, und im Update-Zweig nur dann überschreiben, wenn der neue Wert nicht `null` ist — ein Ausfall der Abfrage darf einen bekannten Wert nicht löschen.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 5 neuen Tests plus die bestehende Suite, einschließlich der Medientests aus Plan 2.

- [ ] **Step 5: Commit**

```bash
git add lib/mediaTypes.ts lib/mediaTypes.test.ts lib/index.ts lib/index.test.ts lib/store.ts
git commit -m "feat: store the repository node id and share one media type table"
```

---

### Task 9: `bin/reindex.ts` verdrahten

**Files:**
- Modify: `bin/reindex.ts`
- Modify: `README.md`
- Test: `bin/reindex.test.ts`

**Interfaces:**
- Consumes: `readConfig`, `installations`, `githubClient`, `withRetry`, `openDb`, `reindex`.
- Produces: keine neuen Exporte; der Einstiegspunkt funktioniert.

- [ ] **Step 1: Write the failing test**

An `bin/reindex.test.ts` anhängen:

```ts
import { buildClient } from './reindex.ts';
import { fakeHttp } from '../lib/http.ts';

const PEM_ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_WEBHOOK_SECRET: 'shhh',
  BASE_URL: 'https://example.test',
};

test('buildClient produces a GitHub client that talks through the given http', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const env = { ...PEM_ENV, GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey, 'utf8').toString('base64') };
  const http = fakeHttp({
    'GET /repos/o/r/installation': { body: { id: 7 } },
    'POST /app/installations/7/access_tokens': {
      body: { token: 'ghs_abc', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    },
    'GET /repos/o/r': { body: { node_id: 'R_1', default_branch: 'main' } },
    'GET /repos/o/r/commits/main': { body: { sha: 'c0ffee' } },
  });

  const gh = buildClient(env, http);
  assert.equal(await gh.head({ owner: 'o', repo: 'r' }), 'c0ffee');
});

test('buildClient reports a missing environment rather than failing later', () => {
  assert.throws(() => buildClient({ GITHUB_APP_ID: '1' }, fakeHttp({})), /GITHUB_APP_PRIVATE_KEY/);
});
```

**Fällt, wenn:** Test 1 — die Verdrahtung von `installations` in `githubClient` entfällt, oder das injizierte `http` nicht durchgereicht wird. Test 2 — `readConfig` nicht beim Bauen aufgerufen wird, sondern erst bei der ersten Anfrage.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildClient` ist kein Export von `./reindex.ts`.

- [ ] **Step 3: Write minimal implementation**

In `bin/reindex.ts` ergänzen und den Einstiegspunkt ersetzen:

```ts
import { readConfig } from '../lib/config.ts';
import { installations } from '../lib/appAuth.ts';
import { githubClient } from '../lib/github.ts';
import { withRetry } from '../lib/http.ts';
import type { Http } from '../lib/http.ts';

// Assembled here rather than inside githubClient so a test can hand in a
// fake http and a caller can hand in the real fetch.
export function buildClient(env: Record<string, string | undefined>, http: Http): GitHub {
  const config = readConfig(env);
  return githubClient(installations(config, http), http);
}

if (import.meta.main) {
  const dbPath = process.env.DB_PATH ?? './release-log.sqlite';
  const refs = process.argv.slice(2).map((arg) => {
    const [owner, repo, ...rest] = arg.split('/');
    if (!owner || !repo || rest.length > 0) {
      console.error(`not an owner/repo pair: ${arg}`);
      process.exit(1);
    }
    return { owner, repo };
  });
  if (refs.length === 0) {
    console.error('usage: node bin/reindex.ts <owner>/<repo> [...]');
    process.exit(1);
  }

  const gh = buildClient(process.env, withRetry((url, init) => fetch(url, init)));
  const outcomes = await reindex(openDb(dbPath), gh, refs);
  for (const [i, outcome] of outcomes.entries()) {
    const ref = refs[i];
    const state = outcome.failed ? 'failed'
      : outcome.frozen ? 'frozen'
      : outcome.logId === null ? 'not a log'
      : `${outcome.logId} (${outcome.fetched} fetched, ${outcome.errors} errors)`;
    console.log(`${ref.owner}/${ref.repo}: ${state}`);
  }
  if (outcomes.some((o) => o.failed)) process.exit(1);
}
```

Der Pfad-Parser weist jetzt auch `owner/repo/extra` zurück, statt die überzähligen Segmente stillschweigend zu verwerfen — vorgemerkt aus Plan 2.

`README.md` bekommt einen Abschnitt, der `npm run reindex -- <owner>/<repo>` beschreibt und die vier Umgebungsvariablen nennt, die `readConfig` verlangt.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 2 neuen Tests plus die bestehende Suite.

- [ ] **Step 5: Manuelle Prüfung gegen ein echtes Repository**

Dies ist der Punkt des ganzen Plans, und keine automatische Prüfung ersetzt ihn.

```bash
node bin/reindex.ts <owner>/<repo>
```

mit den vier Variablen aus `.env` in der Umgebung, gegen ein Repository, auf dem die dev-App installiert ist. Erwartet: eine Zeile je Repository mit der Log-Kennung und der Zahl geholter Dateien; danach zeigt `sqlite3 release-log.sqlite 'select public_id, repo_node_id, head_sha from log'` eine Zeile mit gefüllter `repo_node_id`.

Ein zweiter Lauf muss `0 fetched` melden. Tut er das nicht, ist der SHA-Vergleich gegen die echte API anders als gegen das Fake — das wäre ein Befund, kein Anlass, die Fixture anzupassen.

Beides in den Bericht aufnehmen, einschließlich der tatsächlichen Ausgabe.

- [ ] **Step 6: Commit**

```bash
git add bin/reindex.ts bin/reindex.test.ts README.md
git commit -m "feat: index a real repository from the command line"
```

---

## Was dieser Plan bewusst nicht tut

- **Kein Webhook, kein Reconcile, keine Lebenszyklus-Events.** Alle drei rufen `syncLog`, das fertig ist; die Auslöser sind Plan 4, und dieser sollte `syncLog` vorher nach Phasen aufteilen — Konfiguration auflösen, Releases abgleichen, Medien abgleichen, aufräumen —, statt die Funktion weiter wachsen zu lassen.
- **Kein Umschalten des Servers auf den Index.** `server.ts` startet weiter mit `fileReader`. Der Wechsel gehört zu Plan 4, zusammen mit einem Test, dass beide Reader für dieselbe Anfrage dasselbe antworten.
- **Keine Anmeldung, keine Zulassungsliste, kein Rechte-Cache.** Plan 5.
- **Kein Nutzer-Token.** `create_log` braucht es (Entscheidung 23), aber es gehört zum Dashboard und damit zu Plan 6.
- **Keine Behandlung von Umbenennung und Transfer.** Dieser Plan füllt nur `repo_node_id`; sie auszuwerten ist Plan 4.
