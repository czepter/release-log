# Release-Log-Hub — Plan 2: SQLite-Index und Abgleich

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein SQLite-Index, der ein Log-Repo über den Vergleich von git-Blob-SHAs einliest, und ein zweiter `Reader`, der ihn ausliefert — ohne dass `lib/public.ts` oder `server.ts` ihre Routen ändern.

**Architecture:** `syncLog` ist die einzige Stelle, die den Index verändert; sie holt den Baum eines Commits, vergleicht Pfad→Blob-SHA gegen den Index und lädt nur, was sich geändert hat. GitHub liegt hinter einer schmalen Schnittstelle (`lib/github.ts`), die Plan 2 nur als Fake erfüllt — der Fake rechnet echte git-Blob-SHAs, damit der Vergleich real geprüft wird. `lib/indexReader.ts` erfüllt dieselbe `Reader`-Naht wie `fileReader`, also bleibt die gesamte Routing-Schicht unberührt.

**Tech Stack:** Node 24, TypeScript ohne Build-Schritt, `better-sqlite3` mit Drizzle ORM, `drizzle-kit` für Migrationen, `node:test`, `node:crypto` für Blob-SHAs.

**Spec:** `docs/superpowers/specs/2026-09-08-release-log-hub-design.md` — §3 (Repo-Format), §4 (Index und Abgleich), §7 (Caching/ETag), §9 (Modulschnitt), §10 (Fehlerverhalten), §11 (Tests).

**Vorgänger:** Plan 1 ist gemerged (`main`, 69 Tests). Was dort entstand und hier vorausgesetzt wird, steht unter „Bestehende Schnittstellen".

## Global Constraints

- **Node 24.2.** `engines` deklariert `>=24.2`. Kein Build-Schritt, kein Bundler, kein `tsc`-Emit; Node entfernt Typen zur Laufzeit.
- **`npm test` ist genau `node --test`**, aus dem Projektwurzelverzeichnis, **ohne Pfadargument**. Belegt: `node --test lib/` scheitert mit `MODULE_NOT_FOUND`.
- **Importe tragen die Endung `.ts`**; reine Typimporte benutzen `import type`.
- **Nur löschbare Typsyntax.** Keine `enum`, keine `namespace`, keine Parameter-Eigenschaften, kein `declare` im Klassenkörper.
- **Neue Laufzeitabhängigkeiten sind auf `better-sqlite3` und `drizzle-orm` begrenzt.** `drizzle-kit` ist eine Entwicklungsabhängigkeit. Sonst nichts.
- **Bezeichner und Kommentare englisch.** JSON-Feldnamen sind exakt die aus §3 und werden nie übersetzt. Abschnittsbeschriftungen bleiben deutsch und kommen unverändert aus `lib/sections.ts`.
- **Der Index ist eine Ableitung.** Er muss jederzeit aus den Repos neu baubar sein; keine Einstellung und kein Zustand darf nur in ihm existieren (§8 Lackmustest).
- **Schlechte Daten degradieren, sie stürzen nicht ab** (§10). Eine ungültige Datei wird übersprungen und vermerkt; sie nimmt nie den ganzen Log mit.
- **`covered` erscheint in keiner Antwort** (§7).
- **Der Abgleich vergleicht git-Blob-SHAs, nicht Commits** (§4). Damit sind Handedit, gemergter PR und Force-Push derselbe Fall.

## Bestehende Schnittstellen

Aus Plan 1, unverändert vorausgesetzt:

```ts
// lib/document.ts
export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };
export type LogView = 'full' | 'timeline';
export type LogVisibility = 'public' | 'private';
export type LogConfig = { id: string; product: string; view: LogView; visibility: LogVisibility; curation_notes: string | null };
export type ChangeType = 'feat' | 'perf' | 'fix';
export type Change = { type: ChangeType; breaking: boolean; scope: string | null; title: string; description: string; pr: number | null; issues: number[]; commit: string; date: string };
export type ReleaseImage = { src: string; alt: string };
export type ReleaseDoc = { version: string; tag: string | null; date: string; published_at: string | null; commits: number; headline: string; body: string[]; image: ReleaseImage | null; covered: string[]; changes: Change[] };
export function parseConfig(input: unknown): Validated<LogConfig>;
export function parseRelease(input: unknown, filename?: string): Validated<ReleaseDoc>;

// lib/store.ts
export type MediaBlob = { type: string; bytes: Buffer };
export type SyncError = { path: string; message: string };
export type Reader = {
  config(logId: string): LogConfig | null;
  releases(logId: string): ReleaseDoc[];
  media(logId: string, path: string): MediaBlob | null;
  errors(logId: string): SyncError[];
  problems(): SyncError[];
};
export function fileReader(rootInput: string): Reader;

// lib/public.ts
export type Viewer = 'public' | 'member';
export type Reply = { status: number; body: unknown };
export function route(method: string, pathname: string, params: URLSearchParams, reader: Reader, viewer: Viewer): Reply;

// server.ts
export function createApp(reader: Reader): Server;
```

`lib/order.ts` exportiert `compareReleases`, `sortReleases`, `latestOf`; `lib/sections.ts` exportiert `sectionsOf`.

## Dateien

```
drizzle.config.ts       drizzle-kit: wo Schema und Migrationen liegen
drizzle/                erzeugte Migrationen, eingecheckt
lib/db/schema.ts        Drizzle-Tabellen
lib/db/client.ts        Datenbank öffnen, Migrationen anwenden
lib/github.ts           die GitHub-Schnittstelle und ihr Fake
lib/index.ts            syncLog — die einzige Stelle, die den Index ändert
lib/indexReader.ts      Reader über dem Index
bin/reindex.ts          Neubau von Hand
```

`lib/index.ts` und `lib/indexReader.ts` sind getrennt, weil das eine schreibt und das andere liest: sie teilen nur das Schema, und ein Leser darf nie eine Schreiboperation aufrufen können.

---

### Task 1: Datenbank, Schema, Migrationen

**Files:**
- Modify: `package.json`
- Create: `drizzle.config.ts`
- Create: `lib/db/schema.ts`
- Create: `lib/db/client.ts`
- Test: `lib/db/client.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `lib/db/schema.ts` mit den Tabellen `log`, `release`, `media`, `syncError`, `problem`; `lib/db/client.ts` mit `type Db` und `function openDb(path: string): Db`.

- [ ] **Step 1: Write the failing test**

`lib/db/client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb } from './client.ts';
import { log } from './schema.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-db-'));
  try {
    fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('openDb creates the schema and round-trips a log row', () => {
  withDb((db) => {
    db.insert(log).values({
      publicId: 'abc123',
      repoOwner: 'czepter',
      repoName: 'release-log',
      product: 'Demo',
      view: 'full',
      visibility: 'public',
      curationNotes: null,
      state: 'active',
      headSha: null,
      configBlobSha: null,
      indexedAt: null,
    }).run();

    const rows = db.select().from(log).where(eq(log.publicId, 'abc123')).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].product, 'Demo');
    assert.equal(rows[0].state, 'active');
  });
});

test('openDb is idempotent — reopening an existing file keeps the data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-db-'));
  const path = join(dir, 'test.sqlite');
  try {
    openDb(path).insert(log).values({
      publicId: 'keep', repoOwner: 'o', repoName: 'r', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    }).run();

    const rows = openDb(path).select().from(log).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].publicId, 'keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a duplicate publicId is rejected by the primary key', () => {
  withDb((db) => {
    const row = {
      publicId: 'dup', repoOwner: 'o', repoName: 'r', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    };
    db.insert(log).values(row).run();
    assert.throws(() => db.insert(log).values(row).run());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find package 'drizzle-orm'`.

- [ ] **Step 3: Install the dependencies and write the schema**

```bash
npm install better-sqlite3 drizzle-orm
npm install --save-dev drizzle-kit
```

`package.json` bekommt zusätzlich das Skript `"db:generate": "drizzle-kit generate"`.

`drizzle.config.ts`:

```ts
// drizzle-kit reads this to generate migrations from the schema.
// It is tooling config, never imported by the service.
import type { Config } from 'drizzle-kit';

export default {
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
} satisfies Config;
```

`lib/db/schema.ts`:

```ts
// The index is a read model, not a normalised domain. A release keeps its
// whole validated document in one column; only what is sorted or filtered
// on gets a column of its own (spec §4).

import { sqliteTable, text, integer, blob, primaryKey } from 'drizzle-orm/sqlite-core';

export const log = sqliteTable('log', {
  publicId: text('public_id').primaryKey(),
  repoOwner: text('repo_owner').notNull(),
  repoName: text('repo_name').notNull(),
  // GitHub's immutable repo id. It survives a rename or a transfer, which
  // is why the index anchors on it rather than on owner/name (spec §10).
  repoNodeId: text('repo_node_id'),
  product: text('product').notNull(),
  view: text('view').notNull(),
  visibility: text('visibility').notNull(),
  curationNotes: text('curation_notes'),
  // 'active' | 'frozen'. A deleted repo freezes its log: the last state
  // stays served, nothing syncs (spec §10).
  state: text('state').notNull(),
  headSha: text('head_sha'),
  configBlobSha: text('config_blob_sha'),
  indexedAt: text('indexed_at'),
});

export const release = sqliteTable('release', {
  logId: text('log_id').notNull(),
  version: text('version').notNull(),
  date: text('date').notNull(),
  publishedAt: text('published_at'),
  blobSha: text('blob_sha').notNull(),
  path: text('path').notNull(),
  doc: text('doc').notNull(),
}, (t) => [primaryKey({ columns: [t.logId, t.version] })]);

export const media = sqliteTable('media', {
  logId: text('log_id').notNull(),
  path: text('path').notNull(),
  blobSha: text('blob_sha').notNull(),
  contentType: text('content_type').notNull(),
  bytes: blob('bytes', { mode: 'buffer' }).notNull(),
}, (t) => [primaryKey({ columns: [t.logId, t.path] })]);

export const syncError = sqliteTable('sync_error', {
  logId: text('log_id').notNull(),
  path: text('path').notNull(),
  message: text('message').notNull(),
  at: text('at').notNull(),
}, (t) => [primaryKey({ columns: [t.logId, t.path] })]);

// Problems with no log id to key them by: an unparseable release-log.json
// and a duplicate id. Keyed by repo path instead (spec §3, §10).
export const problem = sqliteTable('problem', {
  path: text('path').primaryKey(),
  message: text('message').notNull(),
  at: text('at').notNull(),
});
```

`lib/db/client.ts`:

```ts
// Opening the database applies any pending migrations, so a fresh file and
// an existing one reach the same schema by the same path.

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function openDb(path: string): Db {
  const sqlite = new Database(path);
  // Foreign keys are off by default in SQLite and the index relies on
  // explicit deletes rather than cascades, but WAL is worth having: a
  // reader is never blocked by the sync writing.
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
```

- [ ] **Step 4: Generate the migration and run the tests**

Run: `npm run db:generate`
Expected: eine SQL-Datei unter `drizzle/` plus `drizzle/meta/`. Beides wird eingecheckt — ohne sie kann `openDb` kein Schema anlegen.

Run: `npm test && npm run typecheck`
Expected: PASS — die 3 neuen Tests plus die bestehende Suite, alles grün.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json drizzle.config.ts drizzle lib/db
git commit -m "feat: open a migrated SQLite index"
```

---

### Task 2: Die GitHub-Schnittstelle und ihr Fake

**Files:**
- Create: `lib/github.ts`
- Test: `lib/github.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - `type RepoRef = { owner: string; repo: string }`
  - `type TreeEntry = { path: string; sha: string; size: number }`
  - `type GitHub = { head(ref: RepoRef): Promise<string | null>; tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>; blob(ref: RepoRef, sha: string): Promise<Buffer | null> }`
  - `function blobSha(content: Buffer | string): string`
  - `function fakeGitHub(repos: Record<string, Record<string, string | Buffer>>): GitHub`

- [ ] **Step 1: Write the failing test**

`lib/github.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobSha, fakeGitHub } from './github.ts';

test('blobSha matches git hash-object for an empty blob', () => {
  // git's well-known empty-blob hash. If this drifts, the whole diff is wrong.
  assert.equal(blobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('blobSha matches git hash-object for known content', () => {
  // printf 'hello\n' | git hash-object --stdin
  assert.equal(blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('blobSha changes when the content changes by one byte', () => {
  assert.notEqual(blobSha('a'), blobSha('b'));
});

test('fakeGitHub returns a tree with a sha and size per file', async () => {
  const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{}', 'releases/1.0.0.json': 'x' } });
  const head = await gh.head({ owner: 'o', repo: 'r' });
  assert.ok(head);
  const tree = await gh.tree({ owner: 'o', repo: 'r' }, head);
  assert.deepEqual(tree.map((e) => e.path).sort(), ['release-log.json', 'releases/1.0.0.json']);
  const config = tree.find((e) => e.path === 'release-log.json');
  assert.equal(config?.sha, blobSha('{}'));
  assert.equal(config?.size, 2);
});

test('fakeGitHub serves a blob by its sha', async () => {
  const gh = fakeGitHub({ 'o/r': { 'a.txt': 'hello\n' } });
  const bytes = await gh.blob({ owner: 'o', repo: 'r' }, blobSha('hello\n'));
  assert.equal(bytes?.toString('utf8'), 'hello\n');
  assert.equal(await gh.blob({ owner: 'o', repo: 'r' }, blobSha('nope')), null);
});

test('fakeGitHub reports a missing repo as a null head', async () => {
  const gh = fakeGitHub({});
  assert.equal(await gh.head({ owner: 'o', repo: 'gone' }), null);
});

test('the head changes when any file changes', async () => {
  const before = fakeGitHub({ 'o/r': { 'a.txt': '1' } });
  const after = fakeGitHub({ 'o/r': { 'a.txt': '2' } });
  assert.notEqual(
    await before.head({ owner: 'o', repo: 'r' }),
    await after.head({ owner: 'o', repo: 'r' }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './github.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/github.ts`:

```ts
// The only place that will talk to the network, once Plan 3 fills it in.
// Plan 2 uses the fake below, which computes real git blob SHAs — so the
// sync's diff logic is exercised against the same hashes production will
// see, not against invented identifiers.

import { createHash } from 'node:crypto';

export type RepoRef = { owner: string; repo: string };
export type TreeEntry = { path: string; sha: string; size: number };

export type GitHub = {
  // null when the repo is gone: a deleted repo freezes its log (spec §10).
  head(ref: RepoRef): Promise<string | null>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
};

// git hashes a blob as sha1("blob <byte length>\0" + content).
export function blobSha(content: Buffer | string): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

export function fakeGitHub(repos: Record<string, Record<string, string | Buffer>>): GitHub {
  const key = (ref: RepoRef): string => `${ref.owner}/${ref.repo}`;

  const entriesOf = (ref: RepoRef): TreeEntry[] | null => {
    const files = repos[key(ref)];
    if (!files) return null;
    return Object.entries(files).map(([path, content]) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      return { path, sha: blobSha(bytes), size: bytes.length };
    });
  };

  return {
    async head(ref) {
      const entries = entriesOf(ref);
      if (!entries) return null;
      // A stand-in commit id: the hash of every path and blob sha in the
      // tree, so any content change moves the head, exactly as a real
      // commit would.
      const summary = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((e) => `${e.path} ${e.sha}`).join('\n');
      return createHash('sha1').update(summary).digest('hex');
    },
    async tree(ref) {
      return entriesOf(ref) ?? [];
    },
    async blob(ref, sha) {
      const files = repos[key(ref)];
      if (!files) return null;
      for (const content of Object.values(files)) {
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        if (blobSha(bytes) === sha) return bytes;
      }
      return null;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 7 neuen Tests plus die bestehende Suite, alles grün.

- [ ] **Step 5: Commit**

```bash
git add lib/github.ts lib/github.test.ts
git commit -m "feat: define the GitHub port and a fake that hashes like git"
```

---

### Task 3: `syncLog` — der erste Abgleich

**Files:**
- Create: `lib/index.ts`
- Test: `lib/index.test.ts`

**Interfaces:**
- Consumes: `type Db` und die Tabellen aus Task 1; `type GitHub`, `type RepoRef` aus Task 2; `parseConfig`, `parseRelease` aus `./document.ts`.
- Produces: `type SyncOutcome = { logId: string | null; fetched: number; errors: number; frozen: boolean }`, `async function syncLog(db: Db, gh: GitHub, ref: RepoRef): Promise<SyncOutcome>`.

- [ ] **Step 1: Write the failing test**

`lib/index.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { log, release, syncError, problem } from './db/schema.ts';
import { fakeGitHub } from './github.ts';
import { syncLog } from './index.ts';

const REF = { owner: 'o', repo: 'r' };

function withDb(fn: (db: Db) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-idx-'));
  const done = () => rmSync(dir, { recursive: true, force: true });
  let result: Promise<void> | void;
  try {
    result = fn(openDb(join(dir, 'i.sqlite')));
  } catch (err) {
    done();
    throw err;
  }
  return result instanceof Promise ? result.finally(done) : (done(), result);
}

const CONFIG = JSON.stringify({ id: 'abc123', product: 'Demo', view: 'full', visibility: 'public' });
const RELEASE = JSON.stringify({
  version: '1.0.0', date: '2026-01-01', published_at: '2026-01-01T00:00:00Z',
  commits: 1, headline: 'Erste Fassung', body: ['B'], changes: [],
});

test('the first sync registers the log and its releases', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE } });
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.logId, 'abc123');
    assert.equal(outcome.frozen, false);
    const logs = db.select().from(log).all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].product, 'Demo');
    assert.equal(logs[0].repoOwner, 'o');
    assert.ok(logs[0].headSha);
    assert.ok(logs[0].indexedAt);

    const releases = db.select().from(release).all();
    assert.equal(releases.length, 1);
    assert.equal(releases[0].version, '1.0.0');
    assert.equal(JSON.parse(releases[0].doc).headline, 'Erste Fassung');
  });
});

test('an invalid release file is skipped and recorded, the rest is indexed', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG,
      'releases/1.0.0.json': RELEASE,
      'releases/2.0.0.json': '{ not json',
    } });
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.errors, 1);
    assert.equal(db.select().from(release).all().length, 1);
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('2.0.0.json'));
  });
});

test('a release whose version disagrees with its filename is an error, not a row', async () => {
  await withDb(async (db) => {
    const wrong = JSON.stringify({ ...JSON.parse(RELEASE), version: '9.9.9' });
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'releases/1.0.0.json': wrong } });
    await syncLog(db, gh, REF);

    assert.equal(db.select().from(release).all().length, 0);
    assert.equal(db.select().from(syncError).all().length, 1);
  });
});

test('a repo without release-log.json registers no log and records a problem', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'readme.md': 'nothing here' } });
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.logId, null);
    assert.equal(db.select().from(log).all().length, 0);
    const problems = db.select().from(problem).all();
    assert.equal(problems.length, 1);
    assert.ok(problems[0].message.includes('release-log.json'));
  });
});

test('an unparseable release-log.json records a problem, not a log', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{ not json' } });
    const outcome = await syncLog(db, gh, REF);

    assert.equal(outcome.logId, null);
    assert.equal(db.select().from(log).all().length, 0);
    assert.equal(db.select().from(problem).all().length, 1);
  });
});

test('a deleted repo freezes an existing log instead of removing it', async () => {
  await withDb(async (db) => {
    const present = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE } });
    await syncLog(db, present, REF);

    const gone = fakeGitHub({});
    const outcome = await syncLog(db, gone, REF);

    assert.equal(outcome.frozen, true);
    const logs = db.select().from(log).all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].state, 'frozen');
    // The last known state stays served (spec §10).
    assert.equal(db.select().from(release).all().length, 1);
  });
});

test('a repo that comes back thaws the log on the next successful sync', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    await syncLog(db, fakeGitHub({}), REF);
    assert.equal(db.select().from(log).all()[0].state, 'frozen');

    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    assert.equal(db.select().from(log).all()[0].state, 'active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './index.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/index.ts`:

```ts
// The single place that changes the index. A write path, a webhook and a
// reconcile run all call this one function, so drift between them is not
// possible (spec §4).

import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, release, syncError, problem } from './db/schema.ts';
import type { GitHub, RepoRef, TreeEntry } from './github.ts';
import { parseConfig, parseRelease } from './document.ts';

export type SyncOutcome = {
  logId: string | null;
  fetched: number;
  errors: number;
  frozen: boolean;
};

const CONFIG_PATH = 'release-log.json';

function now(): string {
  return new Date().toISOString();
}

function releasePaths(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter((e) => e.path.startsWith('releases/') && e.path.endsWith('.json'));
}

export async function syncLog(db: Db, gh: GitHub, ref: RepoRef): Promise<SyncOutcome> {
  const repoPath = `${ref.owner}/${ref.repo}`;
  const head = await gh.head(ref);

  // A repo that is gone freezes whatever log it carried; the last state
  // stays served and nothing is deleted (spec §10).
  if (head === null) {
    const existing = db.select().from(log)
      .where(and(eq(log.repoOwner, ref.owner), eq(log.repoName, ref.repo))).all();
    for (const row of existing) {
      db.update(log).set({ state: 'frozen' }).where(eq(log.publicId, row.publicId)).run();
    }
    return { logId: existing[0]?.publicId ?? null, fetched: 0, errors: 0, frozen: existing.length > 0 };
  }

  const tree = await gh.tree(ref, head);
  const configEntry = tree.find((e) => e.path === CONFIG_PATH);
  if (!configEntry) {
    db.insert(problem)
      .values({ path: repoPath, message: `no ${CONFIG_PATH} in ${repoPath}`, at: now() })
      .onConflictDoUpdate({ target: problem.path, set: { message: `no ${CONFIG_PATH} in ${repoPath}`, at: now() } })
      .run();
    return { logId: null, fetched: 0, errors: 0, frozen: false };
  }

  const configBytes = await gh.blob(ref, configEntry.sha);
  let parsedConfig;
  try {
    parsedConfig = parseConfig(JSON.parse((configBytes ?? Buffer.alloc(0)).toString('utf8')));
  } catch (err) {
    parsedConfig = { ok: false as const, errors: [(err as Error).message] };
  }
  if (!parsedConfig.ok) {
    const message = `invalid ${CONFIG_PATH}: ${parsedConfig.errors.join('; ')}`;
    db.insert(problem)
      .values({ path: repoPath, message, at: now() })
      .onConflictDoUpdate({ target: problem.path, set: { message, at: now() } })
      .run();
    return { logId: null, fetched: 0, errors: 0, frozen: false };
  }
  const config = parsedConfig.value;

  // The repo parses, so any earlier complaint about it is stale.
  db.delete(problem).where(eq(problem.path, repoPath)).run();

  db.insert(log).values({
    publicId: config.id,
    repoOwner: ref.owner,
    repoName: ref.repo,
    repoNodeId: null,
    product: config.product,
    view: config.view,
    visibility: config.visibility,
    curationNotes: config.curation_notes,
    state: 'active',
    headSha: head,
    configBlobSha: configEntry.sha,
    indexedAt: now(),
  }).onConflictDoUpdate({
    target: log.publicId,
    set: {
      repoOwner: ref.owner,
      repoName: ref.repo,
      product: config.product,
      view: config.view,
      visibility: config.visibility,
      curationNotes: config.curation_notes,
      state: 'active',
      headSha: head,
      configBlobSha: configEntry.sha,
      indexedAt: now(),
    },
  }).run();

  let fetched = 0;
  let errors = 0;
  const seen = new Set<string>();

  for (const entry of releasePaths(tree)) {
    seen.add(entry.path);
    const name = entry.path.slice('releases/'.length);
    const bytes = await gh.blob(ref, entry.sha);
    fetched += 1;
    if (bytes === null) {
      db.insert(syncError).values({ logId: config.id, path: entry.path, message: 'blob not found', at: now() })
        .onConflictDoUpdate({ target: [syncError.logId, syncError.path], set: { message: 'blob not found', at: now() } }).run();
      errors += 1;
      continue;
    }
    let parsed;
    try {
      parsed = parseRelease(JSON.parse(bytes.toString('utf8')), name);
    } catch (err) {
      parsed = { ok: false as const, errors: [(err as Error).message] };
    }
    if (!parsed.ok) {
      // A hand edit must never take the whole log down (spec §10).
      const message = parsed.errors.join('; ');
      db.insert(syncError).values({ logId: config.id, path: entry.path, message, at: now() })
        .onConflictDoUpdate({ target: [syncError.logId, syncError.path], set: { message, at: now() } }).run();
      errors += 1;
      continue;
    }
    const doc = parsed.value;
    db.delete(syncError).where(and(eq(syncError.logId, config.id), eq(syncError.path, entry.path))).run();
    db.insert(release).values({
      logId: config.id,
      version: doc.version,
      date: doc.date,
      publishedAt: doc.published_at,
      blobSha: entry.sha,
      path: entry.path,
      doc: JSON.stringify(doc),
    }).onConflictDoUpdate({
      target: [release.logId, release.version],
      set: { date: doc.date, publishedAt: doc.published_at, blobSha: entry.sha, path: entry.path, doc: JSON.stringify(doc) },
    }).run();
  }

  // Anything the tree no longer carries is gone from the index too.
  for (const row of db.select().from(release).where(eq(release.logId, config.id)).all()) {
    if (!seen.has(row.path)) {
      db.delete(release).where(and(eq(release.logId, config.id), eq(release.version, row.version))).run();
    }
  }
  for (const row of db.select().from(syncError).where(eq(syncError.logId, config.id)).all()) {
    if (!seen.has(row.path)) {
      db.delete(syncError).where(and(eq(syncError.logId, config.id), eq(syncError.path, row.path))).run();
    }
  }

  return { logId: config.id, fetched, errors, frozen: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 7 neuen Tests plus die bestehende Suite, alles grün.

- [ ] **Step 5: Commit**

```bash
git add lib/index.ts lib/index.test.ts
git commit -m "feat: index a log repo on the first sync"
```

---

### Task 4: `syncLog` — nur holen, was sich geändert hat

**Files:**
- Modify: `lib/index.ts`
- Test: `lib/index.test.ts`

**Interfaces:**
- Consumes: alles aus Task 3.
- Produces: keine neuen Exporte. `SyncOutcome.fetched` zählt ab jetzt nur die tatsächlich geladenen Blobs.

- [ ] **Step 1: Write the failing test**

An `lib/index.test.ts` anhängen:

```ts
import type { GitHub } from './github.ts';

// Counts blob fetches so a test can prove the second sync is cheap.
function counting(gh: GitHub): { gh: GitHub; blobs: string[] } {
  const blobs: string[] = [];
  return {
    blobs,
    gh: {
      head: (ref) => gh.head(ref),
      tree: (ref, commit) => gh.tree(ref, commit),
      blob: (ref, sha) => { blobs.push(sha); return gh.blob(ref, sha); },
    },
  };
}

test('a second sync with no changes fetches nothing', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);

    const c = counting(fakeGitHub({ 'o/r': files }));
    const outcome = await syncLog(db, c.gh, REF);

    assert.equal(c.blobs.length, 0, 'no blob should be fetched when nothing changed');
    assert.equal(outcome.fetched, 0);
    assert.equal(db.select().from(release).all().length, 1);
  });
});

test('only the changed file is fetched', async () => {
  await withDb(async (db) => {
    const second = JSON.stringify({ ...JSON.parse(RELEASE), version: '2.0.0', date: '2026-02-01' });
    const before = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE, 'releases/2.0.0.json': second };
    await syncLog(db, fakeGitHub({ 'o/r': before }), REF);

    const edited = JSON.stringify({ ...JSON.parse(RELEASE), headline: 'Neu geschrieben' });
    const after = { ...before, 'releases/1.0.0.json': edited };
    const c = counting(fakeGitHub({ 'o/r': after }));
    const outcome = await syncLog(db, c.gh, REF);

    assert.equal(outcome.fetched, 1);
    assert.equal(c.blobs.length, 1);
    const rows = db.select().from(release).all();
    assert.equal(rows.length, 2);
    const one = rows.find((r) => r.version === '1.0.0');
    assert.ok(one);
    assert.equal(JSON.parse(one.doc).headline, 'Neu geschrieben');
  });
});

test('a release removed from the repo disappears from the index', async () => {
  await withDb(async (db) => {
    const second = JSON.stringify({ ...JSON.parse(RELEASE), version: '2.0.0', date: '2026-02-01' });
    await syncLog(db, fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE, 'releases/2.0.0.json': second,
    } }), REF);
    assert.equal(db.select().from(release).all().length, 2);

    await syncLog(db, fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE,
    } }), REF);

    const rows = db.select().from(release).all();
    assert.deepEqual(rows.map((r) => r.version), ['1.0.0']);
  });
});

test('a changed config is re-read and its settings applied', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    assert.equal(db.select().from(log).all()[0].visibility, 'public');

    const priv = JSON.stringify({ ...JSON.parse(CONFIG), visibility: 'private', view: 'timeline' });
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': priv } }), REF);

    const row = db.select().from(log).all()[0];
    assert.equal(row.visibility, 'private');
    assert.equal(row.view, 'timeline');
  });
});

test('an empty index rebuilds everything — no change is a special case', async () => {
  await withDb(async (db) => {
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    const c = counting(fakeGitHub({ 'o/r': files }));
    const outcome = await syncLog(db, c.gh, REF);
    // config + one release
    assert.equal(c.blobs.length, 2);
    assert.equal(outcome.fetched, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — „no blob should be fetched when nothing changed": Task 3 lädt jeden Blob bei jedem Lauf.

- [ ] **Step 3: Write minimal implementation**

In `lib/index.ts`: den Konfigurationsteil und die Release-Schleife auf den SHA-Vergleich umstellen.

Nach dem Ermitteln von `configEntry` und **vor** `gh.blob(ref, configEntry.sha)` einsetzen:

```ts
  const known = db.select().from(log)
    .where(and(eq(log.repoOwner, ref.owner), eq(log.repoName, ref.repo))).all()[0] ?? null;

  // Unchanged config: reuse what the index already holds instead of
  // fetching and re-parsing it.
  const configUnchanged = known !== null && known.configBlobSha === configEntry.sha;
```

Den Block, der `configBytes` holt und parst, in `if (!configUnchanged) { … }` einschließen, und im `else`-Zweig die Konfiguration aus der bekannten Zeile zusammensetzen:

```ts
  let config: LogConfig;
  if (configUnchanged && known !== null) {
    config = {
      id: known.publicId,
      product: known.product,
      view: known.view as LogConfig['view'],
      visibility: known.visibility as LogConfig['visibility'],
      curation_notes: known.curationNotes,
    };
  } else {
    // … the existing fetch-and-parse block, unchanged, assigning config
  }
```

Dafür oben ergänzen: `import type { LogConfig } from './document.ts';`

In der Release-Schleife vor `gh.blob` einsetzen:

```ts
    const indexed = db.select().from(release)
      .where(and(eq(release.logId, config.id), eq(release.path, entry.path))).all()[0] ?? null;
    const failed = db.select().from(syncError)
      .where(and(eq(syncError.logId, config.id), eq(syncError.path, entry.path))).all()[0] ?? null;

    // The blob sha is git's own content hash, so an unchanged sha means an
    // unchanged file — for a good release and for a broken one alike. Both
    // states are already recorded; skip the fetch.
    if (indexed?.blobSha === entry.sha) continue;
    if (failed !== null && indexed === null && failed.message.startsWith('sha:' + entry.sha)) continue;
```

Damit ein fehlerhafter Eintrag seine SHA mitführt, wird die Fehlermeldung beim Schreiben mit ihr präfixiert. Die beiden `syncError`-Schreibstellen in der Schleife bekommen:

```ts
      const message = `sha:${entry.sha} ${parsed.errors.join('; ')}`;
```

beziehungsweise

```ts
      const message = `sha:${entry.sha} blob not found`;
```

Beim Lesen entfernt `lib/indexReader.ts` (Task 6) das Präfix wieder, damit es nie in einer Antwort auftaucht.

`fetched` wird nur noch hochgezählt, wenn `gh.blob` tatsächlich gerufen wurde.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 5 neuen Tests plus die bestehende Suite, alles grün.

- [ ] **Step 5: Commit**

```bash
git add lib/index.ts lib/index.test.ts
git commit -m "feat: fetch only the blobs whose sha changed"
```

---

### Task 5: Medien indizieren, mit Obergrenze und Typprüfung

**Files:**
- Modify: `lib/index.ts`
- Test: `lib/index.test.ts`

**Interfaces:**
- Consumes: alles aus Task 4.
- Produces: keine neuen Exporte; `syncLog` füllt zusätzlich die Tabelle `media`.

- [ ] **Step 1: Write the failing test**

An `lib/index.test.ts` anhängen:

```ts
import { media } from './db/schema.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('a media file is indexed with its bytes and content type', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.png': PNG } });
    await syncLog(db, gh, REF);

    const rows = db.select().from(media).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'media/shot.png');
    assert.equal(rows[0].contentType, 'image/png');
    assert.deepEqual(Buffer.from(rows[0].bytes), PNG);
  });
});

test('an unsupported media type is not indexed and is recorded', async () => {
  await withDb(async (db) => {
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/notes.txt': 'hi' } });
    await syncLog(db, gh, REF);

    assert.equal(db.select().from(media).all().length, 0);
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('notes.txt'));
  });
});

test('a media file over the size cap is not indexed and is recorded', async () => {
  await withDb(async (db) => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const gh = fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/huge.png': huge } });
    await syncLog(db, gh, REF);

    assert.equal(db.select().from(media).all().length, 0);
    const errors = db.select().from(syncError).all();
    assert.equal(errors.length, 1);
    assert.ok(errors[0].message.includes('10'));
  });
});

test('an oversized media file is never fetched, only its tree entry is read', async () => {
  await withDb(async (db) => {
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const c = counting(fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/huge.png': huge } }));
    await syncLog(db, c.gh, REF);
    // Only the config blob. The size comes from the tree entry, so the
    // service never pulls ten megabytes it is going to reject.
    assert.equal(c.blobs.length, 1);
  });
});

test('a media file removed from the repo disappears from the index', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG, 'media/shot.png': PNG } }), REF);
    assert.equal(db.select().from(media).all().length, 1);

    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    assert.equal(db.select().from(media).all().length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `media` bleibt leer; `syncLog` sieht `media/` nicht an.

- [ ] **Step 3: Write minimal implementation**

In `lib/index.ts` oben ergänzen:

```ts
import { media } from './db/schema.ts';

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

function mediaPaths(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter((e) => e.path.startsWith('media/'));
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}
```

Die Endung wird kleingeschrieben verglichen: `shot.PNG` ist dieselbe Datei wie `shot.png`, und ein Repo, das so etwas enthält, soll nicht stillschweigend ein Bild verlieren.

Nach der Release-Schleife und **vor** dem Aufräumen der verschwundenen Pfade einsetzen:

```ts
  const seenMedia = new Set<string>();
  for (const entry of mediaPaths(tree)) {
    seenMedia.add(entry.path);
    const type = MEDIA_TYPES[extensionOf(entry.path)];
    if (!type) {
      const message = `sha:${entry.sha} unsupported media type`;
      db.insert(syncError).values({ logId: config.id, path: entry.path, message, at: now() })
        .onConflictDoUpdate({ target: [syncError.logId, syncError.path], set: { message, at: now() } }).run();
      errors += 1;
      continue;
    }
    // The tree carries the size, so an oversized file is rejected without
    // ever being downloaded.
    if (entry.size > MEDIA_MAX_BYTES) {
      const message = `sha:${entry.sha} media file exceeds the 10 MB limit (${entry.size} bytes)`;
      db.insert(syncError).values({ logId: config.id, path: entry.path, message, at: now() })
        .onConflictDoUpdate({ target: [syncError.logId, syncError.path], set: { message, at: now() } }).run();
      errors += 1;
      continue;
    }
    const indexedMedia = db.select().from(media)
      .where(and(eq(media.logId, config.id), eq(media.path, entry.path))).all()[0] ?? null;
    if (indexedMedia?.blobSha === entry.sha) continue;

    const bytes = await gh.blob(ref, entry.sha);
    fetched += 1;
    if (bytes === null) {
      const message = `sha:${entry.sha} blob not found`;
      db.insert(syncError).values({ logId: config.id, path: entry.path, message, at: now() })
        .onConflictDoUpdate({ target: [syncError.logId, syncError.path], set: { message, at: now() } }).run();
      errors += 1;
      continue;
    }
    db.delete(syncError).where(and(eq(syncError.logId, config.id), eq(syncError.path, entry.path))).run();
    db.insert(media).values({
      logId: config.id, path: entry.path, blobSha: entry.sha, contentType: type, bytes,
    }).onConflictDoUpdate({
      target: [media.logId, media.path],
      set: { blobSha: entry.sha, contentType: type, bytes },
    }).run();
  }

  for (const row of db.select().from(media).where(eq(media.logId, config.id)).all()) {
    if (!seenMedia.has(row.path)) {
      db.delete(media).where(and(eq(media.logId, config.id), eq(media.path, row.path))).run();
    }
  }
```

Das bestehende Aufräumen der `syncError`-Zeilen prüft ab jetzt gegen beide Mengen: `if (!seen.has(row.path) && !seenMedia.has(row.path))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 5 neuen Tests plus die bestehende Suite, alles grün.

- [ ] **Step 5: Commit**

```bash
git add lib/index.ts lib/index.test.ts
git commit -m "feat: index media with a size cap and a type whitelist"
```

---

### Task 6: `indexReader` — dieselbe Naht, andere Quelle

**Files:**
- Create: `lib/indexReader.ts`
- Test: `lib/indexReader.test.ts`

**Interfaces:**
- Consumes: `type Db`, die Tabellen, `syncLog`, `fakeGitHub`.
- Produces: `function indexReader(db: Db): Reader` — erfüllt `Reader` aus `./store.ts` vollständig.

- [ ] **Step 1: Write the failing test**

`lib/indexReader.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import type { Db } from './db/client.ts';
import { fakeGitHub } from './github.ts';
import { syncLog } from './index.ts';
import { indexReader } from './indexReader.ts';

const REF = { owner: 'o', repo: 'r' };
const CONFIG = JSON.stringify({ id: 'abc123', product: 'Demo', view: 'full', visibility: 'public' });
const RELEASE = JSON.stringify({
  version: '1.0.0', date: '2026-01-01', published_at: '2026-01-01T00:00:00Z',
  commits: 1, headline: 'Erste Fassung', body: ['B'],
  image: { src: 'media/shot.png', alt: 'A' }, covered: ['deadbeef'],
  changes: [{ type: 'feat', scope: null, title: 'T', description: 'D', pr: null, issues: [], commit: 'c', date: '2026-01-01' }],
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function withReader(fn: (reader: ReturnType<typeof indexReader>, db: Db) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-rd-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    await syncLog(db, fakeGitHub({ 'o/r': {
      'release-log.json': CONFIG,
      'releases/1.0.0.json': RELEASE,
      'media/shot.png': PNG,
      'releases/bad.json': '{ not json',
    } }), REF);
    await fn(indexReader(db), db);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config comes back for a known id and null for an unknown one', async () => {
  await withReader(async (reader) => {
    assert.equal(reader.config('abc123')?.product, 'Demo');
    assert.equal(reader.config('abc123')?.view, 'full');
    assert.equal(reader.config('nope'), null);
  });
});

test('releases come back fully parsed, covered included', async () => {
  await withReader(async (reader) => {
    const releases = reader.releases('abc123');
    assert.equal(releases.length, 1);
    assert.equal(releases[0].headline, 'Erste Fassung');
    assert.deepEqual(releases[0].covered, ['deadbeef']);
    assert.equal(releases[0].changes[0].breaking, false);
    assert.deepEqual(reader.releases('nope'), []);
  });
});

test('media comes back with its bytes and type', async () => {
  await withReader(async (reader) => {
    const blob = reader.media('abc123', 'media/shot.png');
    assert.equal(blob?.type, 'image/png');
    assert.deepEqual(blob?.bytes, PNG);
    assert.equal(reader.media('abc123', 'media/missing.png'), null);
    assert.equal(reader.media('nope', 'media/shot.png'), null);
  });
});

test('a media path cannot escape its own log', async () => {
  await withReader(async (reader) => {
    // The index keys media by exact path, so traversal is not a filesystem
    // question here — it simply misses.
    assert.equal(reader.media('abc123', '../release-log.json'), null);
    assert.equal(reader.media('abc123', 'media/../../etc/hosts'), null);
  });
});

test('errors name the broken file without leaking the internal sha prefix', async () => {
  await withReader(async (reader) => {
    const errors = reader.errors('abc123');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].path.includes('bad.json'));
    assert.ok(!errors[0].message.startsWith('sha:'), 'the sha prefix is bookkeeping, not a message');
    assert.deepEqual(reader.errors('nope'), []);
  });
});

test('problems are reported per repo, not per log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-rd-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    await syncLog(db, fakeGitHub({ 'x/y': { 'release-log.json': '{ not json' } }), { owner: 'x', repo: 'y' });
    const problems = indexReader(db).problems();
    assert.equal(problems.length, 1);
    assert.ok(problems[0].path.includes('x/y'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a frozen log is still served', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-rd-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    const files = { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE };
    await syncLog(db, fakeGitHub({ 'o/r': files }), REF);
    await syncLog(db, fakeGitHub({}), REF);

    const reader = indexReader(db);
    assert.equal(reader.config('abc123')?.product, 'Demo');
    assert.equal(reader.releases('abc123').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './indexReader.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/indexReader.ts`:

```ts
// The index side of the Reader seam. lib/public.ts and server.ts do not
// know which implementation they were handed, which is the whole point of
// the seam (spec §4, §9).
//
// Note what is absent: no path guard. Media is keyed by exact path in a
// table, so "../" is a key that matches nothing rather than a filesystem
// traversal to defend against.

import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, release, media, syncError, problem } from './db/schema.ts';
import type { Reader, MediaBlob, SyncError } from './store.ts';
import type { LogConfig, ReleaseDoc } from './document.ts';

// syncLog prefixes a sync error's message with the blob sha so a repeated
// sync can tell "same broken file" from "newly broken file" without
// re-fetching. That prefix is bookkeeping and never reaches a reader.
function stripSha(message: string): string {
  const match = /^sha:[0-9a-f]{40} (.*)$/s.exec(message);
  return match ? match[1] : message;
}

export function indexReader(db: Db): Reader {
  return {
    config(logId: string): LogConfig | null {
      const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
      if (!row) return null;
      return {
        id: row.publicId,
        product: row.product,
        view: row.view as LogConfig['view'],
        visibility: row.visibility as LogConfig['visibility'],
        curation_notes: row.curationNotes,
      };
    },
    releases(logId: string): ReleaseDoc[] {
      return db.select().from(release).where(eq(release.logId, logId)).all()
        .map((row) => JSON.parse(row.doc) as ReleaseDoc);
    },
    media(logId: string, path: string): MediaBlob | null {
      const row = db.select().from(media).where(eq(media.logId, logId)).all()
        .find((r) => r.path === path);
      if (!row) return null;
      return { type: row.contentType, bytes: Buffer.from(row.bytes) };
    },
    errors(logId: string): SyncError[] {
      return db.select().from(syncError).where(eq(syncError.logId, logId)).all()
        .map((row) => ({ path: row.path, message: stripSha(row.message) }));
    },
    problems(): SyncError[] {
      return db.select().from(problem).all()
        .map((row) => ({ path: row.path, message: row.message }));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 7 neuen Tests plus die bestehende Suite, alles grün.

- [ ] **Step 5: Commit**

```bash
git add lib/indexReader.ts lib/indexReader.test.ts
git commit -m "feat: serve the index through the Reader seam"
```

---

### Task 7: Doppelte Kennungen und ein URL-sicherer Bezeichner

**Files:**
- Modify: `lib/document.ts`
- Modify: `lib/index.ts`
- Test: `lib/document.test.ts`
- Test: `lib/index.test.ts`

**Interfaces:**
- Consumes: alles bisherige.
- Produces: keine neuen Exporte. `parseConfig` weist ab jetzt Kennungen zurück, die eine URL nicht unverändert tragen kann; `syncLog` registriert bei einer belegten Kennung nichts und vermerkt beide Repos.

- [ ] **Step 1: Write the failing test**

An `lib/document.test.ts` anhängen:

```ts
test('parseConfig rejects an id that a URL cannot carry unchanged', () => {
  for (const bad of ['with space', 'with/slash', 'with%25', 'with?query', '']) {
    const result = parseConfig({ id: bad, product: 'X' });
    assert.equal(result.ok, false, `expected "${bad}" to be rejected`);
  }
});

test('parseConfig accepts the id shapes the service generates', () => {
  for (const good of ['k7m2q9xw4p1a', 'demo00000001', 'a-b_c.d~e']) {
    const result = parseConfig({ id: good, product: 'X' });
    assert.equal(result.ok, true, `expected "${good}" to be accepted`);
  }
});
```

An `lib/index.test.ts` anhängen:

```ts
test('a second repo claiming a taken id is not registered and both are named', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/first': { 'release-log.json': CONFIG } }), { owner: 'o', repo: 'first' });
    await syncLog(db, fakeGitHub({ 'o/second': { 'release-log.json': CONFIG } }), { owner: 'o', repo: 'second' });

    const logs = db.select().from(log).all();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].repoName, 'first', 'the first claimant keeps the id');

    const problems = db.select().from(problem).all();
    assert.equal(problems.length, 1);
    assert.ok(problems[0].message.includes('o/first'));
    assert.ok(problems[0].message.includes('o/second'));
    assert.ok(problems[0].message.includes('"abc123"'));
  });
});

test('re-syncing the repo that holds an id is not a duplicate', async () => {
  await withDb(async (db) => {
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);
    await syncLog(db, fakeGitHub({ 'o/r': { 'release-log.json': CONFIG } }), REF);

    assert.equal(db.select().from(log).all().length, 1);
    assert.equal(db.select().from(problem).all().length, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `parseConfig` nimmt `with space` an, und der zweite Anspruch überschreibt den ersten Log.

- [ ] **Step 3: Write minimal implementation**

In `lib/document.ts`, in `parseConfig`, die Prüfung von `input.id` ersetzen:

```ts
// The id is interpolated into every emitted URL and looked up undecoded on
// the way back in, so it has to survive that round trip unchanged. This is
// a charset rule, not a format rule: the service generates Crockford
// base32, but a hand-written id is fine as long as a URL can carry it.
const ID = /^[A-Za-z0-9._~-]{1,64}$/;

if (!str(input.id) || !ID.test(input.id)) {
  errors.push('config.id: required, 1-64 chars from A-Z a-z 0-9 . _ ~ -');
}
```

In `lib/index.ts`, direkt vor dem `db.insert(log)`-Aufruf:

```ts
  // First claimant wins (spec §3). In a database "first" is temporal, not
  // alphabetical: whichever repo registered the id keeps it.
  const holder = db.select().from(log).where(eq(log.publicId, config.id)).all()[0] ?? null;
  if (holder !== null && (holder.repoOwner !== ref.owner || holder.repoName !== ref.repo)) {
    const held = `${holder.repoOwner}/${holder.repoName}`;
    const message = `duplicate id "${config.id}": kept ${held}, dropped ${repoPath}`;
    db.insert(problem).values({ path: repoPath, message, at: now() })
      .onConflictDoUpdate({ target: problem.path, set: { message, at: now() } }).run();
    return { logId: null, fetched: 0, errors: 0, frozen: false };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 4 neuen Tests plus die bestehende Suite, alles grün. Der Beispiel-Log `logs/demo` trägt `demo00000001` und bleibt gültig.

- [ ] **Step 5: Commit**

```bash
git add lib/document.ts lib/document.test.ts lib/index.ts lib/index.test.ts
git commit -m "feat: keep ids URL-safe and let the first claimant hold one"
```

---

### Task 8: `bin/reindex.ts` — Neubau von Hand

**Files:**
- Create: `bin/reindex.ts`
- Modify: `package.json`
- Test: `bin/reindex.test.ts`

**Interfaces:**
- Consumes: `openDb`, `syncLog`, `type GitHub`.
- Produces: `async function reindex(db: Db, gh: GitHub, refs: RepoRef[]): Promise<SyncOutcome[]>`.

- [ ] **Step 1: Write the failing test**

`bin/reindex.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db/client.ts';
import { log, release } from '../lib/db/schema.ts';
import { fakeGitHub } from '../lib/github.ts';
import { reindex } from './reindex.ts';

const CONFIG = JSON.stringify({ id: 'abc123', product: 'Demo', view: 'full', visibility: 'public' });
const RELEASE = JSON.stringify({
  version: '1.0.0', date: '2026-01-01', published_at: '2026-01-01T00:00:00Z',
  commits: 1, headline: 'H', body: [], changes: [],
});

test('reindex syncs every repo it is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    const other = JSON.stringify({ id: 'def456', product: 'Other', view: 'full', visibility: 'public' });
    const gh = fakeGitHub({
      'o/one': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE },
      'o/two': { 'release-log.json': other },
    });

    const outcomes = await reindex(db, gh, [
      { owner: 'o', repo: 'one' },
      { owner: 'o', repo: 'two' },
    ]);

    assert.deepEqual(outcomes.map((o) => o.logId), ['abc123', 'def456']);
    assert.equal(db.select().from(log).all().length, 2);
    assert.equal(db.select().from(release).all().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reindex rebuilds an emptied index from the repos alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const path = join(dir, 'i.sqlite');
    const gh = fakeGitHub({ 'o/one': { 'release-log.json': CONFIG, 'releases/1.0.0.json': RELEASE } });
    const refs = [{ owner: 'o', repo: 'one' }];

    await reindex(openDb(path), gh, refs);
    const before = openDb(path).select().from(release).all();

    // Delete the file and start over: the index is a derivation, so this
    // must reproduce it exactly (spec §8 litmus test).
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    await reindex(openDb(path), gh, refs);
    const after = openDb(path).select().from(release).all();

    assert.equal(after.length, before.length);
    assert.equal(after[0].doc, before[0].doc);
    assert.equal(after[0].blobSha, before[0].blobSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one failing repo does not stop the others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-re-'));
  try {
    const db = openDb(join(dir, 'i.sqlite'));
    const gh = fakeGitHub({ 'o/good': { 'release-log.json': CONFIG } });

    const outcomes = await reindex(db, gh, [
      { owner: 'o', repo: 'gone' },
      { owner: 'o', repo: 'good' },
    ]);

    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0].logId, null);
    assert.equal(outcomes[1].logId, 'abc123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './reindex.ts'`.

- [ ] **Step 3: Write minimal implementation**

`bin/reindex.ts`:

```ts
// Rebuilding the index by hand. It is the same syncLog the webhook calls,
// so a rebuild is not a special path — an empty index is simply a tree in
// which everything changed (spec §4).

import { openDb } from '../lib/db/client.ts';
import type { Db } from '../lib/db/client.ts';
import { syncLog } from '../lib/index.ts';
import type { GitHub, RepoRef } from '../lib/github.ts';
import type { SyncOutcome } from '../lib/index.ts';

export async function reindex(db: Db, gh: GitHub, refs: RepoRef[]): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];
  for (const ref of refs) {
    // One repo's failure is not the run's failure: the others still sync.
    outcomes.push(await syncLog(db, gh, ref));
  }
  return outcomes;
}

if (import.meta.main) {
  const dbPath = process.env.DB_PATH ?? './release-log.sqlite';
  const refs = process.argv.slice(2).map((arg) => {
    const [owner, repo] = arg.split('/');
    if (!owner || !repo) {
      console.error(`not an owner/repo pair: ${arg}`);
      process.exit(1);
    }
    return { owner, repo };
  });
  if (refs.length === 0) {
    console.error('usage: node bin/reindex.ts <owner>/<repo> [...]');
    process.exit(1);
  }
  // Plan 2 has no real GitHub client yet, so the entrypoint says so rather
  // than pretending. Plan 3 replaces this line with the real one.
  console.error('bin/reindex.ts needs the GitHub client from Plan 3; the reindex() function is usable today.');
  process.exit(1);
}
```

`SyncOutcome` kommt direkt aus `lib/index.ts`. Ein Re-Export über `lib/github.ts` wäre ein Zirkelbezug — `lib/index.ts` importiert bereits von dort.

`package.json` bekommt das Skript `"reindex": "node bin/reindex.ts"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 3 neuen Tests plus die bestehende Suite, alles grün.

- [ ] **Step 5: Commit**

```bash
git add bin/reindex.ts bin/reindex.test.ts package.json
git commit -m "feat: rebuild the index from the repos alone"
```

---

### Task 9: ETag aus `head_sha`

**Files:**
- Modify: `lib/store.ts`
- Modify: `lib/indexReader.ts`
- Modify: `server.ts`
- Test: `server.test.ts`
- Test: `lib/indexReader.test.ts`

**Interfaces:**
- Consumes: alles bisherige.
- Produces: `Reader` bekommt eine sechste Methode `etag(logId: string): string | null`. `fileReader` liefert immer `null` (kein Commit, kein ETag), `indexReader` liefert `head_sha`.

- [ ] **Step 1: Write the failing test**

An `lib/indexReader.test.ts` anhängen:

```ts
test('etag is the head sha of the indexed commit', async () => {
  await withReader(async (reader, db) => {
    const tag = reader.etag('abc123');
    assert.ok(tag);
    assert.match(tag, /^[0-9a-f]{40}$/);
    assert.equal(reader.etag('nope'), null);
  });
});
```

An `server.test.ts` anhängen:

```ts
test('a JSON response carries an ETag when the reader has one', async () => {
  const tagged: Reader = { ...reader, etag: () => 'abc0000000000000000000000000000000000def' };
  const server = createApp(tagged);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const res = await fetch(`${base}/l/abc123/versions`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), '"abc0000000000000000000000000000000000def"');

    const again = await fetch(`${base}/l/abc123/versions`, {
      headers: { 'if-none-match': '"abc0000000000000000000000000000000000def"' },
    });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), '"abc0000000000000000000000000000000000def"');
    assert.equal((await again.arrayBuffer()).byteLength, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a reader without an etag answers 200 with no ETag header', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/l/abc123/versions`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), null);
  });
});

test('a stale If-None-Match still gets the body', async () => {
  const tagged: Reader = { ...reader, etag: () => 'aaaa000000000000000000000000000000000000' };
  const server = createApp(tagged);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/l/abc123/versions`, {
      headers: { 'if-none-match': '"something-else"' },
    });
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength > 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `etag` existiert nicht auf `Reader`; die Typprüfung meldet es zusätzlich.

- [ ] **Step 3: Write minimal implementation**

In `lib/store.ts` die Schnittstelle erweitern und `fileReader` ergänzen:

```ts
export type Reader = {
  config(logId: string): LogConfig | null;
  releases(logId: string): ReleaseDoc[];
  media(logId: string, path: string): MediaBlob | null;
  errors(logId: string): SyncError[];
  problems(): SyncError[];
  // The commit the log was last read at, or null when there is no commit
  // to name. A directory of files has no head, so fileReader returns null
  // and the server simply omits the header (spec §7).
  etag(logId: string): string | null;
};
```

Im Rückgabeobjekt von `fileReader`: `etag: () => null,`.

In `lib/indexReader.ts`:

```ts
    etag(logId: string): string | null {
      const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
      return row?.headSha ?? null;
    },
```

In `server.ts`, den JSON-Zweig ersetzen:

```ts
    const reply = route(method, pathname, url.searchParams, reader, viewer);
    const headers: Record<string, string | number> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': JSON_CACHE,
    };
    if (reply.status === 200) headers['access-control-allow-origin'] = '*';

    // The ETag is the commit the log was read at, so it changes exactly
    // when the content does. Only a served log gets one; a 404 must stay
    // indistinguishable between "missing" and "private" (spec §7).
    const logMatch = /^\/l\/([^/]+)\//.exec(pathname + '/');
    const tag = reply.status === 200 && logMatch ? reader.etag(logMatch[1]) : null;
    if (tag !== null) {
      const quoted = `"${tag}"`;
      headers['etag'] = quoted;
      if (req.headers['if-none-match'] === quoted) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    }
    res.writeHead(reply.status, headers);
    res.end(method === 'HEAD' ? undefined : JSON.stringify(reply.body));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — die 4 neuen Tests plus die bestehende Suite, alles grün.

- [ ] **Step 5: Commit**

```bash
git add lib/store.ts lib/indexReader.ts lib/indexReader.test.ts server.ts server.test.ts
git commit -m "feat: emit an ETag from the indexed head and honour If-None-Match"
```

---

## Was dieser Plan bewusst nicht tut

- **Kein echtes GitHub.** `lib/github.ts` definiert die Schnittstelle und ein Fake; die App-Authentifizierung, Installations-Token und der Webhook sind Plan 3. `bin/reindex.ts` sagt beim direkten Aufruf, dass ihm der Client fehlt, statt es zu verschweigen.
- **Kein Reconcile-Intervall und kein Webhook-Empfänger.** Beide rufen `syncLog`, das hier fertig wird; die Auslöser gehören zu Plan 3.
- **Keine Umstellung des Servers auf den Index.** `server.ts` startet weiter mit `fileReader`. Der Wechsel gehört dorthin, wo es echte Repos zu lesen gibt.
- **Keine `repo_node_id`.** Die Spalte existiert, bleibt aber leer, bis Plan 3 sie von GitHub bekommt; Umbenennen und Transfer hängen daran.
- **Keine Sitzungen, kein Dashboard, kein Rendering.** Pläne 4 bis 6.
