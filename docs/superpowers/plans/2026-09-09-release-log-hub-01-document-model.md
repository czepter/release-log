# Release-Log-Hub — Plan 1: Dokumentmodell und öffentliche JSON-Fläche

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein lauffähiger JSON-Dienst, der Release-Logs aus einem Verzeichnis mit statischen Dateien ausliefert — im Format des Vorbilds, mit Entwurfsfilter, Abschnitten und Paginierung.

**Architecture:** Reine Funktionen im Kern, Ein-/Ausgabe außen. `document.ts` validiert und normalisiert, `order.ts` sortiert, `sections.ts` gruppiert, `public.ts` bildet Anfragen auf `{ status, body }` ab — alle vier ohne Netz, Dateisystem oder Datenbank. Dazwischen liegt eine `Reader`-Schnittstelle: Plan 1 erfüllt sie aus Dateien, Plan 2 aus dem SQLite-Index, ohne dass `public.ts` sich ändert. `server.ts` ist die einzige Datei mit einem Socket.

**Tech Stack:** Node 24, TypeScript ohne Build-Schritt (Node entfernt Typen zur Laufzeit), `node:http`, `node:test`, `node:assert/strict`. Eine einzige Entwicklungsabhängigkeit: `typescript` für `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-08-release-log-hub-design.md` — insbesondere §3 (Repo-Format), §7 (Öffentliche Fläche), §9 (Modulschnitt), §10 (Fehlerverhalten), §11 (Tests).

## Global Constraints

- **Node 24.** `engines.node` ist `>=24`. Kein Build-Schritt, kein Bundler, kein `tsc`-Emit.
- **Kein Argument an `node --test`.** Belegt: `node --test lib/` scheitert mit `MODULE_NOT_FOUND`, weil der Pfad als Modul geladen wird. `npm test` ist genau `node --test`, ausgeführt im Projektwurzelverzeichnis; die Voreinstellung findet `**/*.test.ts`.
- **Importe tragen die Endung `.ts`.** `import { parseRelease } from './document.ts'`. ESM in Node verlangt die Endung; ohne sie bricht der Lauf.
- **Nur löschbare Typsyntax.** Node entfernt Typen, es übersetzt sie nicht: keine `enum`, keine `namespace`, keine Parameter-Eigenschaften im Konstruktor, kein `declare` im Klassenkörper. Stattdessen `type`-Aliase und Union-Typen aus Zeichenketten.
- **Sprache.** Bezeichner und Code-Kommentare Englisch, wo sie Fachbegriffe der Domäne tragen (`headline`, `covered`), Prosa in Commits Englisch. Die Feldnamen im JSON sind exakt die aus §3 und werden nie übersetzt.
- **Keine Laufzeitabhängigkeiten.** In Plan 1 kommt keine hinzu. `typescript` steht unter `devDependencies`.
- **Schlechte Daten degradieren, sie stürzen nicht ab** (§10). Eine ungültige Datei wird übersprungen und gemeldet; sie nimmt nie den ganzen Log mit.
- **`covered` erscheint in keiner Antwort** (§7). Es ist Buchhaltung, kein Inhalt.
- **Drei Module über §9 hinaus:** `lib/order.ts`, `lib/sections.ts` und `lib/store.ts`. §9 listet sie nicht, weil es den Dienst grob schneidet. Sortierung und Gruppierung braucht später auch `lib/render.ts`, gehören also nicht in `lib/public.ts`; `lib/store.ts` hält die `Reader`-Schnittstelle, die Plan 2 aus `lib/index.ts` bedient.

---

### Task 1: Gerüst und Konfigurationsvalidierung

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `lib/document.ts`
- Test: `lib/document.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `type LogConfig`, `type Validated<T>`, `function parseConfig(input: unknown): Validated<LogConfig>`.

- [ ] **Step 1: Write the failing test**

`lib/document.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from './document.ts';

test('parseConfig accepts a complete config', () => {
  const result = parseConfig({
    id: 'k7m2q9xw4p1a',
    product: 'Auri CRM',
    view: 'full',
    visibility: 'public',
    curation_notes: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, 'k7m2q9xw4p1a');
  assert.equal(result.value.view, 'full');
});

test('parseConfig defaults view and visibility', () => {
  const result = parseConfig({ id: 'k7m2q9xw4p1a', product: 'X' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.view, 'full');
  assert.equal(result.value.visibility, 'public');
  assert.equal(result.value.curation_notes, null);
});

test('parseConfig rejects an unknown view and names the field', () => {
  const result = parseConfig({ id: 'k7m2q9xw4p1a', product: 'X', view: 'grid' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('view')));
});

test('parseConfig rejects a missing id', () => {
  const result = parseConfig({ product: 'X' });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './document.ts'`.

- [ ] **Step 3: Write the scaffolding and the minimal implementation**

`package.json`:

```json
{
  "name": "release-log-hub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node server.ts",
    "test": "node --test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.9.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "lib": ["esnext"],
    "types": ["node"]
  },
  "include": ["lib/**/*.ts", "bin/**/*.ts", "server.ts"]
}
```

`lib/document.ts`:

```ts
// Validation and normalisation of the two documents a log repo holds.
// Pure: no filesystem, no network. The index and the write path share it,
// so a document the index would reject never reaches the repo (spec §6).

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

export type LogView = 'full' | 'timeline';
export type LogVisibility = 'public' | 'private';

export type LogConfig = {
  id: string;
  product: string;
  view: LogView;
  visibility: LogVisibility;
  curation_notes: string | null;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function parseConfig(input: unknown): Validated<LogConfig> {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['config: not an object'] };

  if (!str(input.id)) errors.push('config.id: required, non-empty string');
  if (!str(input.product)) errors.push('config.product: required, non-empty string');

  const view = input.view === undefined ? 'full' : input.view;
  if (view !== 'full' && view !== 'timeline') {
    errors.push('config.view: must be "full" or "timeline"');
  }

  const visibility = input.visibility === undefined ? 'public' : input.visibility;
  if (visibility !== 'public' && visibility !== 'private') {
    errors.push('config.visibility: must be "public" or "private"');
  }

  const notes = input.curation_notes === undefined ? null : input.curation_notes;
  if (notes !== null && typeof notes !== 'string') {
    errors.push('config.curation_notes: must be a string or null');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: input.id as string,
      product: input.product as string,
      view: view as LogView,
      visibility: visibility as LogVisibility,
      curation_notes: notes as string | null,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm install && npm test`
Expected: PASS — 4 Tests.

Run: `npm run typecheck`
Expected: keine Ausgabe, Rückgabewert 0.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json lib/document.ts lib/document.test.ts
git commit -m "feat: validate a log's release-log.json"
```

---

### Task 2: Release-Kopffelder validieren

**Files:**
- Modify: `lib/document.ts`
- Test: `lib/document.test.ts`

**Interfaces:**
- Consumes: `Validated<T>`, `isObject`, `str` aus Task 1.
- Produces: `type ReleaseImage`, `type ReleaseDoc` (Feld `changes` noch `unknown[]`), `function parseRelease(input: unknown, filename?: string): Validated<ReleaseDoc>`.

- [ ] **Step 1: Write the failing test**

An `lib/document.test.ts` anhängen:

```ts
import { parseRelease } from './document.ts';

const HEAD = {
  version: '0.9.2',
  tag: 'v0.9.2',
  date: '2026-09-08',
  published_at: '2026-09-08T14:22:00Z',
  commits: 4,
  headline: 'Galerie-Einstellungen an einer Stelle',
  body: ['Ein Absatz.'],
  image: { src: 'media/0.9.2.png', alt: 'Liste' },
  covered: ['b9871b32'],
  changes: [],
};

test('parseRelease accepts a complete head', () => {
  const result = parseRelease(HEAD);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.version, '0.9.2');
  assert.equal(result.value.published_at, '2026-09-08T14:22:00Z');
});

test('parseRelease treats a null published_at as a draft', () => {
  const result = parseRelease({ ...HEAD, published_at: null });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.published_at, null);
});

test('parseRelease defaults optional collections', () => {
  const result = parseRelease({
    version: 'r1', date: '2026-01-01', headline: 'X', commits: 0,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.body, []);
  assert.deepEqual(result.value.covered, []);
  assert.deepEqual(result.value.changes, []);
  assert.equal(result.value.tag, null);
  assert.equal(result.value.image, null);
});

test('parseRelease accepts an opaque version such as a date', () => {
  const result = parseRelease({ ...HEAD, version: '2026-09-08' });
  assert.equal(result.ok, true);
});

test('parseRelease rejects a version that differs from the filename', () => {
  const result = parseRelease(HEAD, '0.9.1.json');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('filename')));
});

test('parseRelease rejects a malformed date', () => {
  const result = parseRelease({ ...HEAD, date: '08.09.2026' });
  assert.equal(result.ok, false);
});

test('parseRelease rejects an absolute image src', () => {
  const result = parseRelease({ ...HEAD, image: { src: '/media/x.png', alt: 'a' } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('image.src')));
});

test('parseRelease rejects a negative commit count', () => {
  const result = parseRelease({ ...HEAD, commits: -1 });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `parseRelease` ist kein Export von `./document.ts`.

- [ ] **Step 3: Write minimal implementation**

An `lib/document.ts` anhängen:

```ts
export type ReleaseImage = { src: string; alt: string };

export type ReleaseDoc = {
  version: string;
  tag: string | null;
  date: string;
  published_at: string | null;
  commits: number;
  headline: string;
  body: string[];
  image: ReleaseImage | null;
  covered: string[];
  changes: unknown[]; // Task 3 gives this a type
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function stringList(v: unknown, field: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    errors.push(`${field}: must be a list of strings`);
    return [];
  }
  return v as string[];
}

export function parseRelease(input: unknown, filename?: string): Validated<ReleaseDoc> {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['release: not an object'] };

  // version is an opaque identifier (spec, decision 9): "1.2.0", "2026-09-08"
  // and "r42" are equally valid. Only the tie to the filename is enforced.
  if (!str(input.version)) errors.push('release.version: required, non-empty string');
  if (filename !== undefined && str(input.version)) {
    const stem = filename.replace(/\.json$/, '');
    if (stem !== input.version) {
      errors.push(`release.version: "${input.version}" does not match filename "${stem}"`);
    }
  }

  if (!str(input.date) || !DATE.test(input.date)) {
    errors.push('release.date: required, format YYYY-MM-DD');
  }
  if (!str(input.headline)) errors.push('release.headline: required, non-empty string');

  const tag = input.tag === undefined ? null : input.tag;
  if (tag !== null && typeof tag !== 'string') errors.push('release.tag: string or null');

  const published = input.published_at === undefined ? null : input.published_at;
  if (published !== null && !(typeof published === 'string' && INSTANT.test(published))) {
    errors.push('release.published_at: ISO-8601 UTC instant or null');
  }

  const commits = input.commits === undefined ? 0 : input.commits;
  if (!Number.isInteger(commits) || (commits as number) < 0) {
    errors.push('release.commits: integer >= 0');
  }

  const body = stringList(input.body, 'release.body', errors);
  const covered = stringList(input.covered, 'release.covered', errors);

  let image: ReleaseImage | null = null;
  if (input.image !== undefined && input.image !== null) {
    if (!isObject(input.image) || !str(input.image.src) || !str(input.image.alt)) {
      errors.push('release.image: object with src and alt, or null');
    } else if (input.image.src.startsWith('/')) {
      // Repo-relative keeps the repo meaningful on its own (spec §3).
      errors.push('release.image.src: must be repo-relative, not absolute');
    } else {
      image = { src: input.image.src, alt: input.image.alt };
    }
  }

  const changes = input.changes === undefined ? [] : input.changes;
  if (!Array.isArray(changes)) errors.push('release.changes: must be a list');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: input.version as string,
      tag: tag as string | null,
      date: input.date as string,
      published_at: published as string | null,
      commits: commits as number,
      headline: input.headline as string,
      body,
      image,
      covered,
      changes: changes as unknown[],
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 12 Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/document.ts lib/document.test.ts
git commit -m "feat: validate the head fields of a release document"
```

---

### Task 3: Einträge validieren, `breaking` normalisieren

**Files:**
- Modify: `lib/document.ts`
- Test: `lib/document.test.ts`

**Interfaces:**
- Consumes: alles aus Task 2.
- Produces: `type ChangeType = 'feat' | 'perf' | 'fix'`, `type Change`, und `ReleaseDoc.changes` wird `Change[]`.

- [ ] **Step 1: Write the failing test**

An `lib/document.test.ts` anhängen:

```ts
const CHANGE = {
  type: 'feat',
  scope: 'gallery',
  title: 'Galerie-Einstellungen über der Liste',
  description: 'Zwei Absätze.\n\nDer zweite.',
  pr: null,
  issues: [19, 20],
  commit: 'b9871b32',
  date: '2026-09-08',
};

test('parseRelease accepts a change and defaults breaking to false', () => {
  const result = parseRelease({ ...HEAD, changes: [CHANGE] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.changes[0].breaking, false);
  assert.equal(result.value.changes[0].type, 'feat');
  assert.deepEqual(result.value.changes[0].issues, [19, 20]);
});

test('parseRelease keeps an explicit breaking flag', () => {
  const result = parseRelease({ ...HEAD, changes: [{ ...CHANGE, breaking: true }] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.changes[0].breaking, true);
});

test('parseRelease rejects an unknown change type', () => {
  const result = parseRelease({ ...HEAD, changes: [{ ...CHANGE, type: 'chore' }] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('changes[0].type')));
});

test('parseRelease names the index of a bad change', () => {
  const result = parseRelease({
    ...HEAD,
    changes: [CHANGE, { ...CHANGE, title: '' }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('changes[1].title')));
});

test('parseRelease rejects non-numeric issues', () => {
  const result = parseRelease({ ...HEAD, changes: [{ ...CHANGE, issues: ['19'] }] });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `result.value.changes[0].breaking` ist `undefined`, weil `changes` noch `unknown[]` ist; TypeScript meldet zusätzlich einen Zugriff auf `unknown`.

- [ ] **Step 3: Write minimal implementation**

In `lib/document.ts`: `ReleaseDoc.changes` von `unknown[]` auf `Change[]` ändern, die Typen ergänzen und den Aufruf einsetzen.

```ts
export type ChangeType = 'feat' | 'perf' | 'fix';

export type Change = {
  type: ChangeType;
  breaking: boolean;
  scope: string | null;
  title: string;
  description: string;
  pr: number | null;
  issues: number[];
  commit: string;
  date: string;
};

const CHANGE_TYPES = ['feat', 'perf', 'fix'];

function parseChange(input: unknown, i: number, errors: string[]): Change | null {
  const at = `release.changes[${i}]`;
  if (!isObject(input)) {
    errors.push(`${at}: not an object`);
    return null;
  }
  const before = errors.length;

  if (typeof input.type !== 'string' || !CHANGE_TYPES.includes(input.type)) {
    errors.push(`${at}.type: must be one of feat, perf, fix`);
  }
  if (!str(input.title)) errors.push(`${at}.title: required, non-empty string`);
  if (!str(input.description)) errors.push(`${at}.description: required, non-empty string`);
  if (!str(input.commit)) errors.push(`${at}.commit: required, non-empty string`);
  if (!str(input.date) || !DATE.test(input.date)) {
    errors.push(`${at}.date: required, format YYYY-MM-DD`);
  }

  // breaking says what the change demands of the reader; type says what it is.
  // Two questions, two fields (spec, decision 11).
  const breaking = input.breaking === undefined ? false : input.breaking;
  if (typeof breaking !== 'boolean') errors.push(`${at}.breaking: boolean`);

  const scope = input.scope === undefined ? null : input.scope;
  if (scope !== null && typeof scope !== 'string') errors.push(`${at}.scope: string or null`);

  const pr = input.pr === undefined ? null : input.pr;
  if (pr !== null && !Number.isInteger(pr)) errors.push(`${at}.pr: integer or null`);

  const issues = input.issues === undefined ? [] : input.issues;
  if (!Array.isArray(issues) || issues.some((x) => !Number.isInteger(x))) {
    errors.push(`${at}.issues: list of integers`);
  }

  if (errors.length > before) return null;
  return {
    type: input.type as ChangeType,
    breaking: breaking as boolean,
    scope: scope as string | null,
    title: input.title as string,
    description: input.description as string,
    pr: pr as number | null,
    issues: issues as number[],
    commit: input.commit as string,
    date: input.date as string,
  };
}
```

In `parseRelease` den Block `const changes = …` ersetzen durch:

```ts
  let changes: Change[] = [];
  if (input.changes !== undefined) {
    if (!Array.isArray(input.changes)) {
      errors.push('release.changes: must be a list');
    } else {
      changes = input.changes
        .map((c, i) => parseChange(c, i, errors))
        .filter((c): c is Change => c !== null);
    }
  }
```

und im Rückgabeobjekt `changes: changes as unknown[]` durch `changes` ersetzen.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — 17 Tests, Typprüfung ohne Ausgabe.

- [ ] **Step 5: Commit**

```bash
git add lib/document.ts lib/document.test.ts
git commit -m "feat: validate release entries and default the breaking flag"
```

---

### Task 4: Sortierung und `latest`

**Files:**
- Create: `lib/order.ts`
- Test: `lib/order.test.ts`

**Interfaces:**
- Consumes: `type ReleaseDoc` aus `./document.ts`.
- Produces: `function compareReleases(a: ReleaseDoc, b: ReleaseDoc): number` (absteigend), `function sortReleases(rs: ReleaseDoc[]): ReleaseDoc[]` (neue Liste), `function latestOf(rs: ReleaseDoc[]): ReleaseDoc | null`.

- [ ] **Step 1: Write the failing test**

`lib/order.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortReleases, latestOf } from './order.ts';
import type { ReleaseDoc } from './document.ts';

function rel(version: string, date: string, published = true): ReleaseDoc {
  return {
    version, tag: null, date,
    published_at: published ? '2026-01-01T00:00:00Z' : null,
    commits: 0, headline: version, body: [], image: null, covered: [], changes: [],
  };
}

test('sortReleases orders by date, newest first', () => {
  const out = sortReleases([rel('a', '2026-01-01'), rel('b', '2026-03-01')]);
  assert.deepEqual(out.map((r) => r.version), ['b', 'a']);
});

test('sortReleases breaks a date tie numerically, not lexically', () => {
  const out = sortReleases([rel('0.9.2', '2026-01-01'), rel('0.9.10', '2026-01-01')]);
  assert.deepEqual(out.map((r) => r.version), ['0.9.10', '0.9.2']);
});

test('sortReleases handles opaque versions on the same date', () => {
  const out = sortReleases([rel('r2', '2026-01-01'), rel('r10', '2026-01-01')]);
  assert.deepEqual(out.map((r) => r.version), ['r10', 'r2']);
});

test('sortReleases does not mutate its input', () => {
  const input = [rel('a', '2026-01-01'), rel('b', '2026-03-01')];
  sortReleases(input);
  assert.deepEqual(input.map((r) => r.version), ['a', 'b']);
});

test('latestOf ignores drafts', () => {
  const out = latestOf([rel('a', '2026-01-01'), rel('b', '2026-03-01', false)]);
  assert.equal(out?.version, 'a');
});

test('latestOf returns null when nothing is published', () => {
  assert.equal(latestOf([rel('a', '2026-01-01', false)]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './order.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/order.ts`:

```ts
// Ordering for a set of releases. Since version is an opaque identifier
// (spec, decision 9), date carries the order and version only breaks ties —
// with the reference project's numeric collator, so 0.9.10 still precedes
// 0.9.2. Sorting happens here in JavaScript rather than in SQL: a log holds
// dozens of releases, not millions (spec §4).

import type { ReleaseDoc } from './document.ts';

const collator = new Intl.Collator(undefined, { numeric: true });

export function compareReleases(a: ReleaseDoc, b: ReleaseDoc): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return collator.compare(b.version, a.version);
}

export function sortReleases(releases: ReleaseDoc[]): ReleaseDoc[] {
  return [...releases].sort(compareReleases);
}

export function latestOf(releases: ReleaseDoc[]): ReleaseDoc | null {
  const published = releases.filter((r) => r.published_at !== null);
  return sortReleases(published)[0] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 23 Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/order.ts lib/order.test.ts
git commit -m "feat: order releases by date with a numeric version tiebreak"
```

---

### Task 5: Abschnitte, mit „Wichtig" zuerst

**Files:**
- Create: `lib/sections.ts`
- Test: `lib/sections.test.ts`

**Interfaces:**
- Consumes: `type Change`, `type ReleaseDoc` aus `./document.ts`.
- Produces: `type Section = { key: string; label: string; items: Change[] }`, `function sectionsOf(changes: Change[]): Section[]`.

- [ ] **Step 1: Write the failing test**

`lib/sections.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionsOf } from './sections.ts';
import type { Change } from './document.ts';

function change(type: 'feat' | 'perf' | 'fix', breaking = false, title = 't'): Change {
  return {
    type, breaking, scope: null, title, description: 'd',
    pr: null, issues: [], commit: 'abc1234', date: '2026-01-01',
  };
}

test('sectionsOf maps the three types to their labels', () => {
  const out = sectionsOf([change('feat'), change('perf'), change('fix')]);
  assert.deepEqual(out.map((s) => s.key), ['new', 'changed', 'fixed']);
  assert.deepEqual(out.map((s) => s.label), ['Neu', 'Änderungen', 'Behoben']);
});

test('sectionsOf drops empty sections', () => {
  const out = sectionsOf([change('fix')]);
  assert.deepEqual(out.map((s) => s.key), ['fixed']);
});

test('sectionsOf puts breaking entries into Wichtig, first', () => {
  const out = sectionsOf([change('fix'), change('feat', true, 'breaks')]);
  assert.equal(out[0].key, 'important');
  assert.equal(out[0].label, 'Wichtig');
  assert.equal(out[0].items[0].title, 'breaks');
});

test('a breaking entry appears only in Wichtig', () => {
  const out = sectionsOf([change('feat', true, 'breaks'), change('feat', false, 'plain')]);
  const newSection = out.find((s) => s.key === 'new');
  assert.deepEqual(newSection?.items.map((i) => i.title), ['plain']);
  assert.equal(out.flatMap((s) => s.items).filter((i) => i.title === 'breaks').length, 1);
});

test('sectionsOf returns nothing for no changes', () => {
  assert.deepEqual(sectionsOf([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './sections.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/sections.ts`:

```ts
// Grouping for both the JSON detail view and, later, the rendered page.
// A breaking entry appears only under "Wichtig", never a second time in its
// own type section (spec §7).

import type { Change } from './document.ts';

export type Section = { key: string; label: string; items: Change[] };

const GROUPS = [
  { key: 'new', label: 'Neu', type: 'feat' },
  { key: 'changed', label: 'Änderungen', type: 'perf' },
  { key: 'fixed', label: 'Behoben', type: 'fix' },
];

export function sectionsOf(changes: Change[]): Section[] {
  const breaking = changes.filter((c) => c.breaking);
  const rest = changes.filter((c) => !c.breaking);

  const sections: Section[] = [];
  if (breaking.length > 0) {
    sections.push({ key: 'important', label: 'Wichtig', items: breaking });
  }
  for (const group of GROUPS) {
    const items = rest.filter((c) => c.type === group.type);
    if (items.length > 0) sections.push({ key: group.key, label: group.label, items });
  }
  return sections;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — 28 Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sections.ts lib/sections.test.ts
git commit -m "feat: group changes into sections with breaking ones first"
```

---

### Task 6: Reader-Schnittstelle und Datei-Reader

**Files:**
- Create: `lib/store.ts`
- Test: `lib/store.test.ts`

**Interfaces:**
- Consumes: `parseConfig`, `parseRelease`, `type LogConfig`, `type ReleaseDoc` aus `./document.ts`.
- Produces:
  - `type MediaBlob = { type: string; bytes: Buffer }`
  - `type SyncError = { path: string; message: string }`
  - `type Reader = { config(logId: string): LogConfig | null; releases(logId: string): ReleaseDoc[]; media(logId: string, path: string): MediaBlob | null; errors(logId: string): SyncError[] }`
  - `function fileReader(root: string): Reader`

`root` enthält je Log ein Unterverzeichnis, dessen Name beliebig ist; die Zuordnung läuft über `release-log.json` → `id`. Plan 2 ersetzt `fileReader` durch einen Index-Reader, ohne dass `public.ts` sich ändert.

- [ ] **Step 1: Write the failing test**

`lib/store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileReader } from './store.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'rlh-'));
  const log = join(root, 'demo');
  mkdirSync(join(log, 'releases'), { recursive: true });
  mkdirSync(join(log, 'media'), { recursive: true });
  writeFileSync(join(log, 'release-log.json'), JSON.stringify({
    id: 'abc123', product: 'Demo', view: 'full', visibility: 'public',
  }));
  writeFileSync(join(log, 'releases', '1.0.0.json'), JSON.stringify({
    version: '1.0.0', date: '2026-02-01', published_at: '2026-02-01T00:00:00Z',
    commits: 1, headline: 'Erste Fassung', changes: [],
  }));
  writeFileSync(join(log, 'releases', '1.1.0.json'), JSON.stringify({
    version: '1.1.0', date: '2026-03-01', published_at: null,
    commits: 1, headline: 'Entwurf', changes: [],
  }));
  writeFileSync(join(log, 'releases', 'broken.json'), '{ not json');
  writeFileSync(join(log, 'media', 'shot.png'), Buffer.from([0x89, 0x50]));
  return root;
}

test('fileReader finds a log by its configured id', () => {
  const r = fileReader(fixture());
  assert.equal(r.config('abc123')?.product, 'Demo');
  assert.equal(r.config('nope'), null);
});

test('fileReader returns published and draft releases alike', () => {
  const r = fileReader(fixture());
  const versions = r.releases('abc123').map((x) => x.version).sort();
  assert.deepEqual(versions, ['1.0.0', '1.1.0']);
});

test('a broken file is skipped and reported, the rest survives', () => {
  const r = fileReader(fixture());
  assert.equal(r.releases('abc123').length, 2);
  const errors = r.errors('abc123');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].path.includes('broken.json'));
});

test('fileReader serves media by repo-relative path', () => {
  const r = fileReader(fixture());
  const blob = r.media('abc123', 'media/shot.png');
  assert.equal(blob?.type, 'image/png');
  assert.equal(blob?.bytes.length, 2);
  assert.equal(r.media('abc123', 'media/missing.png'), null);
});

test('fileReader refuses a path that escapes the log directory', () => {
  const r = fileReader(fixture());
  assert.equal(r.media('abc123', '../release-log.json'), null);
  assert.equal(r.media('abc123', 'media/../../etc/hosts'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './store.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/store.ts`:

```ts
// The seam between "where do releases come from" and "how are they served".
// Plan 1 fills it from a directory; Plan 2 fills it from the SQLite index
// without public.ts changing (spec §4, §9).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { parseConfig, parseRelease } from './document.ts';
import type { LogConfig, ReleaseDoc } from './document.ts';

export type MediaBlob = { type: string; bytes: Buffer };
export type SyncError = { path: string; message: string };

export type Reader = {
  config(logId: string): LogConfig | null;
  releases(logId: string): ReleaseDoc[];
  media(logId: string, path: string): MediaBlob | null;
  errors(logId: string): SyncError[];
};

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

type Loaded = {
  dir: string;
  config: LogConfig;
  releases: ReleaseDoc[];
  errors: SyncError[];
};

function loadLog(dir: string): Loaded | null {
  let config: LogConfig;
  try {
    const parsed = parseConfig(JSON.parse(readFileSync(join(dir, 'release-log.json'), 'utf8')));
    if (!parsed.ok) return null;
    config = parsed.value;
  } catch {
    return null;
  }

  const releases: ReleaseDoc[] = [];
  const errors: SyncError[] = [];
  const releaseDir = join(dir, 'releases');
  let names: string[] = [];
  try {
    names = readdirSync(releaseDir).filter((n) => n.endsWith('.json'));
  } catch {
    names = [];
  }
  for (const name of names) {
    const path = join('releases', name);
    try {
      const raw = JSON.parse(readFileSync(join(releaseDir, name), 'utf8'));
      const parsed = parseRelease(raw, name);
      if (parsed.ok) releases.push(parsed.value);
      else errors.push({ path, message: parsed.errors.join('; ') });
    } catch (err) {
      // A hand edit in the repo must never take a public page down (spec §10).
      errors.push({ path, message: (err as Error).message });
    }
  }
  return { dir, config, releases, errors };
}

export function fileReader(root: string): Reader {
  const logs = new Map<string, Loaded>();
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const loaded = loadLog(dir);
    // First claimant wins: a second repo with a taken id is not indexed
    // (spec §3).
    if (loaded && !logs.has(loaded.config.id)) logs.set(loaded.config.id, loaded);
  }

  return {
    config: (logId) => logs.get(logId)?.config ?? null,
    releases: (logId) => logs.get(logId)?.releases ?? [],
    errors: (logId) => logs.get(logId)?.errors ?? [],
    media(logId, path) {
      const log = logs.get(logId);
      if (!log) return null;
      const target = resolve(log.dir, path);
      // resolve() collapses "..", so a path that leaves the log directory is
      // visible here and nowhere later.
      if (target !== log.dir && !target.startsWith(log.dir + sep)) return null;
      const type = MEDIA_TYPES[extname(target)];
      if (!type) return null;
      try {
        return { type, bytes: readFileSync(target) };
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — 33 Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/store.ts lib/store.test.ts
git commit -m "feat: read logs from a directory behind a Reader seam"
```

---

### Task 7: Routen `/versions` und `/releases/<version>`

**Files:**
- Create: `lib/public.ts`
- Test: `lib/public.test.ts`

**Interfaces:**
- Consumes: `type Reader` aus `./store.ts`, `sortReleases`/`latestOf` aus `./order.ts`, `sectionsOf` aus `./sections.ts`.
- Produces:
  - `type Viewer = 'public' | 'member'`
  - `type Reply = { status: number; body: unknown }`
  - `function route(method: string, pathname: string, params: URLSearchParams, reader: Reader, viewer: Viewer): Reply`

- [ ] **Step 1: Write the failing test**

`lib/public.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from './public.ts';
import type { Reader } from './store.ts';
import type { LogConfig, ReleaseDoc, Change } from './document.ts';

const CONFIG: LogConfig = {
  id: 'abc123', product: 'Demo', view: 'full',
  visibility: 'public', curation_notes: null,
};

function change(type: 'feat' | 'fix', breaking = false): Change {
  return {
    type, breaking, scope: null, title: 'T', description: 'D',
    pr: null, issues: [], commit: 'abc1234', date: '2026-01-01',
  };
}

function rel(version: string, date: string, published: boolean, changes: Change[] = []): ReleaseDoc {
  return {
    version, tag: null, date,
    published_at: published ? `${date}T00:00:00Z` : null,
    commits: 1, headline: `H ${version}`, body: ['B'],
    image: { src: 'media/x.png', alt: 'a' }, covered: ['deadbeef'], changes,
  };
}

function reader(config: LogConfig, releases: ReleaseDoc[]): Reader {
  return {
    config: (id) => (id === config.id ? config : null),
    releases: (id) => (id === config.id ? releases : []),
    media: () => null,
    errors: () => [],
  };
}

const P = new URLSearchParams();

test('versions lists published releases newest first', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true), rel('1.1.0', '2026-02-01', true)]);
  const reply = route('GET', '/l/abc123/versions', P, r, 'public');
  assert.equal(reply.status, 200);
  const body = reply.body as { latest: string; versions: { version: string }[] };
  assert.equal(body.latest, '1.1.0');
  assert.deepEqual(body.versions.map((v) => v.version), ['1.1.0', '1.0.0']);
});

test('versions hides drafts from the public', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true), rel('1.1.0', '2026-02-01', false)]);
  const body = route('GET', '/l/abc123/versions', P, r, 'public').body as { versions: unknown[] };
  assert.equal(body.versions.length, 1);
});

test('versions shows drafts to a member', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true), rel('1.1.0', '2026-02-01', false)]);
  const body = route('GET', '/l/abc123/versions', P, r, 'member').body as { versions: unknown[] };
  assert.equal(body.versions.length, 2);
});

test('a release detail carries sections and never carries covered', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true, [change('feat'), change('fix', true)])]);
  const reply = route('GET', '/l/abc123/releases/1.0.0', P, r, 'public');
  assert.equal(reply.status, 200);
  const body = reply.body as Record<string, unknown>;
  assert.equal('covered' in body, false);
  const sections = body.sections as { key: string }[];
  assert.deepEqual(sections.map((s) => s.key), ['important', 'new']);
});

test('a release detail absolutises the image path', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true)]);
  const body = route('GET', '/l/abc123/releases/1.0.0', P, r, 'public').body as
    { image: { src: string } };
  assert.equal(body.image.src, '/l/abc123/media/media/x.png');
});

test('a draft detail is 404 for the public and 200 for a member', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', false)]);
  assert.equal(route('GET', '/l/abc123/releases/1.0.0', P, r, 'public').status, 404);
  assert.equal(route('GET', '/l/abc123/releases/1.0.0', P, r, 'member').status, 200);
});

test('a private log is 404 for the public, exactly like a missing one', () => {
  const r = reader({ ...CONFIG, visibility: 'private' }, [rel('1.0.0', '2026-01-01', true)]);
  assert.equal(route('GET', '/l/abc123/versions', P, r, 'public').status, 404);
  assert.equal(route('GET', '/l/nosuch/versions', P, r, 'public').status, 404);
  assert.equal(route('GET', '/l/abc123/versions', P, r, 'member').status, 200);
});

test('a non-GET method is 405', () => {
  const r = reader(CONFIG, []);
  assert.equal(route('POST', '/l/abc123/versions', P, r, 'public').status, 405);
});

test('health answers without a log', () => {
  const r = reader(CONFIG, []);
  const reply = route('GET', '/health', P, r, 'public');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { status: 'ok' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './public.ts'`.

- [ ] **Step 3: Write minimal implementation**

`lib/public.ts`:

```ts
// Requests to [status, body]. No sockets here, so every route is a plain
// function call in a test. The JSON shape is the reference project's, scoped
// by log id (spec §7).

import type { Reader } from './store.ts';
import type { LogConfig, ReleaseDoc } from './document.ts';
import { sortReleases, latestOf } from './order.ts';
import { sectionsOf } from './sections.ts';

export type Viewer = 'public' | 'member';
export type Reply = { status: number; body: unknown };

const NOT_FOUND: Reply = { status: 404, body: { error: 'not_found' } };

function visible(releases: ReleaseDoc[], viewer: Viewer): ReleaseDoc[] {
  return viewer === 'member' ? releases : releases.filter((r) => r.published_at !== null);
}

// covered is the agent's bookkeeping, not part of the feed (spec §7).
function detail(release: ReleaseDoc, config: LogConfig): Record<string, unknown> {
  const { changes, covered, image, ...rest } = release;
  return {
    ...rest,
    url: `/l/${config.id}/releases/${release.version}`,
    image: image === null ? null : { src: `/l/${config.id}/media/${image.src}`, alt: image.alt },
    sections: sectionsOf(changes),
  };
}

export function route(
  method: string,
  pathname: string,
  params: URLSearchParams,
  reader: Reader,
  viewer: Viewer,
): Reply {
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, body: { error: 'method_not_allowed' } };
  }
  if (pathname === '/health') return { status: 200, body: { status: 'ok' } };

  const match = /^\/l\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return NOT_FOUND;
  const [, logId, rest] = match;

  const config = reader.config(logId);
  if (!config) return NOT_FOUND;
  // A private log and a missing one answer identically (spec §7).
  if (config.visibility === 'private' && viewer !== 'member') return NOT_FOUND;

  const releases = visible(reader.releases(logId), viewer);

  if (rest === 'versions') {
    const sorted = sortReleases(releases);
    const newest = viewer === 'member' ? (sorted[0] ?? null) : latestOf(releases);
    return {
      status: 200,
      body: {
        product: config.product,
        latest: newest?.version ?? null,
        versions: sorted.map((r) => ({
          version: r.version,
          date: r.date,
          headline: r.headline,
          url: `/l/${logId}/releases/${r.version}`,
        })),
      },
    };
  }

  const one = /^releases\/(.+)$/.exec(rest);
  if (one) {
    const found = releases.find((r) => r.version === one[1]);
    return found ? { status: 200, body: detail(found, config) } : NOT_FOUND;
  }

  return NOT_FOUND;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — 42 Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/public.ts lib/public.test.ts
git commit -m "feat: serve a log's versions and a single release as JSON"
```

---

### Task 8: Feed `/releases` mit Paginierung

**Files:**
- Modify: `lib/public.ts`
- Test: `lib/public.test.ts`

**Interfaces:**
- Consumes: alles aus Task 7.
- Produces: keine neuen Exporte; `route` beantwortet zusätzlich `/l/<id>/releases`.

- [ ] **Step 1: Write the failing test**

An `lib/public.test.ts` anhängen:

```ts
function many(n: number): ReleaseDoc[] {
  return Array.from({ length: n }, (_, i) =>
    rel(`1.${i}.0`, `2026-01-${String(i + 1).padStart(2, '0')}`, true, [change('feat')]));
}

test('the feed carries counts per section, not entries', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true, [change('feat'), change('fix')])]);
  const body = route('GET', '/l/abc123/releases', P, r, 'public').body as
    { releases: { sections: { key: string; count: number }[] }[] };
  assert.deepEqual(body.releases[0].sections, [
    { key: 'new', label: 'Neu', count: 1 },
    { key: 'fixed', label: 'Behoben', count: 1 },
  ]);
});

test('the feed defaults to ten per page', () => {
  const body = route('GET', '/l/abc123/releases', P, reader(CONFIG, many(25)), 'public').body as
    { page: number; per_page: number; total: number; total_pages: number; releases: unknown[] };
  assert.equal(body.per_page, 10);
  assert.equal(body.page, 1);
  assert.equal(body.total, 25);
  assert.equal(body.total_pages, 3);
  assert.equal(body.releases.length, 10);
});

test('the feed honours page and per_page', () => {
  const params = new URLSearchParams({ page: '2', per_page: '5' });
  const body = route('GET', '/l/abc123/releases', params, reader(CONFIG, many(12)), 'public').body as
    { releases: { version: string }[] };
  assert.equal(body.releases.length, 5);
  assert.equal(body.releases[0].version, '1.6.0');
});

test('a page beyond the end is empty, not an error', () => {
  const params = new URLSearchParams({ page: '9' });
  const reply = route('GET', '/l/abc123/releases', params, reader(CONFIG, many(3)), 'public');
  assert.equal(reply.status, 200);
  assert.deepEqual((reply.body as { releases: unknown[] }).releases, []);
});

test('bad pagination values are 400', () => {
  const r = reader(CONFIG, many(3));
  for (const bad of [{ page: '0' }, { page: '-1' }, { page: 'x' }, { per_page: '101' }]) {
    const reply = route('GET', '/l/abc123/releases', new URLSearchParams(bad), r, 'public');
    assert.equal(reply.status, 400, JSON.stringify(bad));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `/l/abc123/releases` liefert 404, weil nur `releases/<version>` behandelt wird.

- [ ] **Step 3: Write minimal implementation**

In `lib/public.ts` oberhalb von `route` ergänzen:

```ts
const PER_PAGE_DEFAULT = 10;
const PER_PAGE_MAX = 100;

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number | null {
  const raw = params.get(name);
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return value <= max ? value : null;
}

// The feed carries counts, not entries: a single release can hold hundreds.
function feedItem(release: ReleaseDoc, config: LogConfig): Record<string, unknown> {
  const full = detail(release, config);
  const sections = full.sections as { key: string; label: string; items: unknown[] }[];
  return {
    ...full,
    sections: sections.map((s) => ({ key: s.key, label: s.label, count: s.items.length })),
  };
}
```

In `route`, unmittelbar vor `const one = /^releases\/(.+)$/…` einsetzen:

```ts
  if (rest === 'releases') {
    const page = intParam(params, 'page', 1, 1e6);
    const perPage = intParam(params, 'per_page', PER_PAGE_DEFAULT, PER_PAGE_MAX);
    if (page === null || perPage === null) return { status: 400, body: { error: 'bad_request' } };

    const sorted = sortReleases(releases);
    const offset = (page - 1) * perPage;
    return {
      status: 200,
      body: {
        product: config.product,
        page,
        per_page: perPage,
        total: sorted.length,
        total_pages: Math.max(1, Math.ceil(sorted.length / perPage)),
        releases: sorted.slice(offset, offset + perPage).map((r) => feedItem(r, config)),
      },
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — 47 Tests.

- [ ] **Step 5: Commit**

```bash
git add lib/public.ts lib/public.test.ts
git commit -m "feat: page through a log's release feed"
```

---

### Task 9: HTTP-Server, Medien und Cache-Kopfzeilen

**Files:**
- Create: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `route`, `type Viewer` aus `./lib/public.ts`; `fileReader`, `type Reader` aus `./lib/store.ts`.
- Produces: `function createApp(reader: Reader): import('node:http').Server` und den Standard-Export-freien Start unter `import.meta.main`.

- [ ] **Step 1: Write the failing test**

`server.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.ts';
import type { Reader } from './lib/store.ts';

const reader: Reader = {
  config: (id) => (id === 'abc123'
    ? { id: 'abc123', product: 'Demo', view: 'full', visibility: 'public', curation_notes: null }
    : null),
  releases: () => [],
  media: (id, path) =>
    id === 'abc123' && path === 'media/x.png'
      ? { type: 'image/png', bytes: Buffer.from([1, 2, 3]) }
      : null,
  errors: () => [],
};

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp(reader);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('health answers 200 with JSON', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

test('a public JSON route allows cross-origin reads', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/l/abc123/versions`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

test('media is served with a long immutable cache', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/l/abc123/media/media/x.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await res.arrayBuffer()).byteLength, 3);
  });
});

test('missing media is 404 JSON', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/l/abc123/media/media/nope.png`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });
});

test('a trailing slash resolves to the same route', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/l/abc123/versions/`)).status, 200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './server.ts'`.

- [ ] **Step 3: Write minimal implementation**

`server.ts`:

```ts
// The only file with a socket. Everything it decides is decided in
// lib/public.ts, which is why the routing tests need no server at all.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { route } from './lib/public.ts';
import { fileReader } from './lib/store.ts';
import type { Reader } from './lib/store.ts';

const MEDIA_CACHE = 'public, max-age=31536000, immutable';
const JSON_CACHE = 'public, max-age=60';

export function createApp(reader: Reader): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    // Viewer is 'public' until sessions exist (Plan 3). Drafts and private
    // logs stay invisible until then, which is the safe direction.
    const viewer = 'public';

    const media = /^\/l\/([^/]+)\/media\/(.+)$/.exec(pathname);
    if (media && (method === 'GET' || method === 'HEAD')) {
      const config = reader.config(media[1]);
      const blob = config && config.visibility === 'public'
        ? reader.media(media[1], media[2])
        : null;
      if (blob) {
        res.writeHead(200, {
          'content-type': blob.type,
          'content-length': blob.bytes.length,
          'cache-control': MEDIA_CACHE,
          'access-control-allow-origin': '*',
        });
        res.end(method === 'HEAD' ? undefined : blob.bytes);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const reply = route(method, pathname, url.searchParams, reader, viewer);
    // Only a served log gets the cross-origin header. A private or missing log
    // answers 404 without it, so the two stay indistinguishable (spec §7).
    const headers: Record<string, string | number> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': JSON_CACHE,
    };
    if (reply.status === 200) headers['access-control-allow-origin'] = '*';
    res.writeHead(reply.status, headers);
    res.end(method === 'HEAD' ? undefined : JSON.stringify(reply.body));
  });
}

if (import.meta.main) {
  const root = process.env.LOGS_ROOT ?? './logs';
  const port = Number(process.env.PORT ?? 8787);
  // Bind an explicit address: without a host Node listens on :: and takes
  // IPv4 only while nothing else holds it, so a busy port turns into a
  // silent IPv6-only start instead of an error (spec §12).
  createApp(fileReader(root)).listen(port, '127.0.0.1', () => {
    console.log(`release-log-hub on http://127.0.0.1:${port}, logs from ${root}`);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — 52 Tests.

- [ ] **Step 5: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: serve the log API over HTTP with media and cache headers"
```

---

### Task 10: Beispiel-Log und README

**Files:**
- Create: `logs/demo/release-log.json`
- Create: `logs/demo/releases/1.0.0.json`
- Create: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `createApp`, `fileReader`.
- Produces: nichts für spätere Tasks; ein Startpunkt zum Anfassen.

- [ ] **Step 1: Write the fixture and run the server against it**

`logs/demo/release-log.json`:

```json
{
  "id": "demo00000001",
  "product": "Demo",
  "view": "full",
  "visibility": "public",
  "curation_notes": null
}
```

`logs/demo/releases/1.0.0.json`:

```json
{
  "version": "1.0.0",
  "tag": "v1.0.0",
  "date": "2026-09-09",
  "published_at": "2026-09-09T09:00:00Z",
  "commits": 3,
  "headline": "Der erste Release-Log",
  "body": ["Ein Log aus Dateien, ausgeliefert als JSON."],
  "image": null,
  "covered": [],
  "changes": [
    {
      "type": "feat",
      "breaking": false,
      "scope": "api",
      "title": "Versionen, Feed und Einzelabruf",
      "description": "Drei Routen je Log: alle Versionen, ein paginierter Feed mit Anzahl je Abschnitt, und eine einzelne Version mit allen Einträgen.\n\nEntwürfe bleiben unsichtbar, solange niemand angemeldet ist.",
      "pr": null,
      "issues": [],
      "commit": "0000000",
      "date": "2026-09-09"
    }
  ]
}
```

- [ ] **Step 2: Verify by hand**

```bash
npm start
```

In einer zweiten Sitzung:

```bash
curl -s localhost:8787/l/demo00000001/versions
curl -s localhost:8787/l/demo00000001/releases
curl -s localhost:8787/l/demo00000001/releases/1.0.0
```

Expected: die erste Antwort nennt `"latest": "1.0.0"`, die zweite trägt `sections` mit `count`, die dritte trägt `sections` mit `items` und **kein** `covered`.

- [ ] **Step 3: Write the README**

`README.md`:

```markdown
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
```

`.gitignore` ergänzen um:

```
logs/*
!logs/demo/
```

- [ ] **Step 4: Run the full suite once more**

Run: `npm test && npm run typecheck`
Expected: PASS — 52 Tests, Typprüfung ohne Ausgabe.

- [ ] **Step 5: Commit**

```bash
git add logs README.md .gitignore
git commit -m "docs: add a demo log and describe how to run the service"
```

---

## Was dieser Plan bewusst nicht tut

- **Kein GitHub.** `Reader` ist die Naht; Plan 2 füllt sie aus dem Index.
- **Keine Sitzungen.** `viewer` steht in `server.ts` fest auf `'public'`.
  Entwürfe und private Logs sind damit unsichtbar — die sichere Richtung.
- **Keine gerenderte Seite.** `lib/render.ts` kommt in Plan 4; `sectionsOf`
  und `sortReleases` sind schon so geschnitten, dass sie sie bedienen können.
- **Kein ETag.** Er kommt aus `head_sha`, den es erst mit dem Index gibt.
