# Login, Zulassung und Rechteprüfung — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Mensch meldet sich mit seinem GitHub-Konto an, kommt nur durch, wenn sein Login zugelassen ist, bekommt eine 30-Tage-Session, und der Dienst kann für diese Person gegen ein bestimmtes Log fragen "darf sie schreiben" — geprüft gegen GitHub, fünf Minuten gecacht, sofort invalidiert bei den zwei Ereignissen, die die Antwort ändern können.

**Architecture:** Zwei fast unabhängige Bausteine, die sich nur in `server.ts` treffen: eine Cookie-Session mit Zulassungsprüfung (`lib/session.ts`), und eine gegen GitHub geprüfte, gecachte Rechteprüfung (`lib/permissions.ts`), die über dieselbe GitHub-Naht läuft wie der Rest des Diensts (`lib/github.ts` bekommt eine vierte Methode). Beide sind reine, für sich testbare Module; `server.ts` verdrahtet sie an drei neue Routen und an den bestehenden Webhook-Pfad.

**Tech Stack:** TypeScript auf Node 24 ohne Build-Schritt, `node --test`, `node:crypto` für Cookie-Signatur, Drizzle über `better-sqlite3`.

**Spec:** `docs/superpowers/specs/2026-09-08-release-log-hub-design.md` — bindend. §5 ist der Abschnitt, den dieser Plan umsetzt; er deckt nur „Rolle 1" (die App als OAuth-Client gegenüber GitHub) und die Rechteprüfung ab. „Rolle 2" (die App als Authorization Server gegenüber Agent-Clients, `/mcp`, Dynamic Client Registration, `oauth-core.ts`) ist ein eigener, deutlich größerer Plan — siehe „Abweichungen" unten.

## Global Constraints

- Node 24 führt TypeScript zur Laufzeit aus. **Kein Build-Schritt.** Importe tragen die Endung `.ts`. Reine Typ-Importe benutzen `import type`.
- `npm test` ruft `node --test` **ohne Pfadargument**. `npm run typecheck` (`tsc --noEmit`) muss sauber sein. Baseline: 261 Tests grün.
- **Keine neuen Laufzeit-Abhängigkeiten.** `node:crypto`, `node:http`, die Plattform-Globals `fetch`/`Response`/`RequestInit`, die bereits installierten Pakete.
- **Kein Secret in einer Logzeile, einer Fehlermeldung oder einer geworfenen Meldung** — nicht der private Schlüssel, nicht `GITHUB_CLIENT_SECRET`, nicht `SIGNING_KEY`, nicht ein GitHub-Nutzer-Token.
- **Ein GitHub-Nutzer-Token wird für die Anmeldung genau einmal benutzt und nie persistiert.** Es dient nur dazu, `GET /user` zu fragen, wer sich da anmeldet. Das dauerhafte, verschlüsselte Nutzer-Token aus Spec-Entscheidung 23 ist ausschließlich für `create_log` (`POST /user/repos`) und liegt außerhalb dieses Plans.
- **Jeder andere Repo-Zugriff — auch die Rechteprüfung — läuft über die Installation, nie über ein Nutzer-Token** (Spec §5, „Repo-Zugriff hängt damit an der Installation, nicht an einer Person").
- Adminrecht ist ausschließlich `ADMIN_LOGINS` aus der Umgebung — es gibt **keine** Admin-Spalte in `allowlist` (Spec-Schema-Tabelle §4: `allowlist` hat nur `github_login`, `added_by`, `added_at`, `note`). Jemanden zum Admin zu machen heißt, die Umgebungsvariable zu ändern, nicht eine Zeile in der Datenbank.
- Session-Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, Laufzeit 30 Tage (Spec §5).
- Kommentare erklären *warum*, nicht *was*.
- Tests, die nicht fallen können, sind der wiederkehrende Fehler dieses Projekts. Jeder Test unten trägt eine **Fällt, wenn**-Zeile, die die konkrete Mutation nennt, die ihn brechen muss. Wer implementiert, prüft mindestens zwei davon live nach: kaputt machen, Test fällt, exakt zurücksetzen, Suite grün.

## Abweichungen von der Spec, bewusst getroffen

1. **„Rolle 2" (OAuth Authorization Server für MCP-Clients, `/mcp`, `oauth-core.ts`, Dynamic Client Registration, PKCE, Token-Hashing) ist bewusst NICHT Teil dieses Plans.** §5 beschreibt beide Rollen im selben Abschnitt, aber sie sind unabhängig groß und riskant genug für einen eigenen Plan mit eigenem Review. Dieser Plan liefert trotzdem ein für sich lauffähiges, testbares Stück: nach diesem Plan kann sich ein Mensch anmelden, wird abgewiesen, wenn er nicht zugelassen ist, und der Dienst kann fragen, ob eine angemeldete Person Schreibrechte auf ein bestimmtes Log hat — nur benutzt das noch niemand, weil weder Dashboard noch MCP-Tools existieren. Genau dieselbe Reihenfolge wie in Plan 3: `probe()` und `repoId()` existierten, bevor irgendetwas sie rief.
2. **`GET /me`** ist eine kleine, undekorierte JSON-Route (`{login, isAdmin}`), die dieser Plan zusätzlich zu §5 einführt — nicht Teil der Spec, sondern die einzige Möglichkeit, die Session-Anmeldung ohne ein Dashboard überhaupt zu verifizieren. Ziel der Umleitung nach erfolgreicher Anmeldung, bis Plan 6 ein echtes Dashboard liefert.
3. **Eine fehlgeschlagene Anmeldung (Login nicht zugelassen) legt keine `account`-Zeile an.** Die Tabelle hält nur, wer je durchkam — kein Protokoll gescheiterter Versuche. Das ist eine bewusste, engere Lesart als die Spec verlangt; sie sagt nichts zu diesem Fall.
4. **Der `oauth_state`-Cookie-Vergleich läuft über einfache Gleichheit, nicht `timingSafeEqual`.** Anders als eine Signaturprüfung schützt er nicht gegen einen Angreifer, der viele Versuche gegen ein Geheimnis probiert — er vergleicht einen zufälligen, cookie-gebundenen Wert, den ein Angreifer nicht lesen und nicht raten kann. Zeitkonstanter Vergleich hätte hier nichts zu verteidigen.
5. **`createApp` bekommt einen dritten optionalen Parameter (`Auth`)**, zusätzlich zum bereits bestehenden `Hooks`. Zwei optionale Konfigurationsobjekte statt eines vereinten sind vertretbare, offen hingenommene Unschärfe — eine echte Zusammenführung lohnt sich erst, wenn Plan 6 diese Datei ohnehin wieder anfasst.
6. **Der bestehende Setup-Assistent (`scripts/setup-github-app.sh`) wird von diesem Plan NICHT erweitert.** Er sammelt interaktiv Werte aus GitHubs Oberfläche ein — das braucht einen Menschen vor einem Browser, kein SDD-Task. Task 8 nennt die drei neuen Variablen nur in der README; das Erweitern des Assistenten bleibt ein separater, von Hand angestoßener Schritt.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `lib/config.ts` (ändern) | drei neue Pflichtvariablen: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SIGNING_KEY`, `ADMIN_LOGINS` |
| `lib/db/schema.ts` (ändern) | `account`, `allowlist`, `repo_permission` |
| `lib/session.ts` (neu) | Cookie signieren/prüfen, Zulassungsprüfung, Admin-Prüfung |
| `lib/github.ts` (ändern) | `collaboratorPermission` auf `GitHub` |
| `lib/permissions.ts` (neu) | `canWrite` mit Fünf-Minuten-Cache, `invalidate` |
| `lib/webhook.ts` (ändern) | `permissionInvalidationRefsFor` für `member` und `installation_repositories` |
| `lib/login.ts` (neu) | Code gegen GitHub-Identität tauschen (User-to-Server-Flow) |
| `server.ts` (ändern) | `/auth/github/login`, `/auth/github/callback`, `POST /auth/logout`, `GET /me`; Webhook ruft jetzt auch die Rechte-Invalidierung |
| `README.md` (ändern) | neue Umgebungsvariablen, die drei neuen Routen |

---

### Task 1: Vier neue Umgebungsvariablen

**Files:**
- Modify: `lib/config.ts`
- Test: `lib/config.test.ts`
- Modify: `lib/appAuth.test.ts` (die `CONFIG`-Fixture braucht die neuen Pflichtfelder, sonst kompiliert die Datei nicht mehr)
- Modify: `bin/reindex.test.ts` (die `PEM_ENV`-Fixture braucht die drei neuen Variablen, sonst wirft `buildClient` „missing environment variables" in einem Test, der das nicht erwartet)

**Interfaces:**
- Consumes: nichts.
- Produces: `type AppConfig` bekommt `clientId: string`, `clientSecret: string`, `signingKey: string`, `adminLogins: string[]`.

- [ ] **Step 1: Write the failing test**

An `lib/config.test.ts` anhängen. `COMPLETE` am Kopf der Datei um die vier neuen Variablen erweitern:

```ts
const COMPLETE = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: B64,
  GITHUB_WEBHOOK_SECRET: 'shhh',
  BASE_URL: 'https://release-log.czpt.de',
  GITHUB_CLIENT_ID: 'Iv1.deadbeef',
  GITHUB_CLIENT_SECRET: 'client-secret-value',
  SIGNING_KEY: 'a-long-random-signing-key',
  ADMIN_LOGINS: 'czepter, someone-else',
};
```

Dann:

```ts
test('readConfig passes clientId, clientSecret and signingKey through unchanged', () => {
  const config = readConfig(COMPLETE);
  assert.equal(config.clientId, 'Iv1.deadbeef');
  assert.equal(config.clientSecret, 'client-secret-value');
  assert.equal(config.signingKey, 'a-long-random-signing-key');
});

test('readConfig splits ADMIN_LOGINS on commas and trims whitespace', () => {
  const config = readConfig(COMPLETE);
  assert.deepEqual(config.adminLogins, ['czepter', 'someone-else']);
});

test('readConfig rejects an ADMIN_LOGINS that names nobody after trimming', () => {
  assert.throws(
    () => readConfig({ ...COMPLETE, ADMIN_LOGINS: ' , , ' }),
    /ADMIN_LOGINS/,
  );
});

test('readConfig names all four new variables when missing, alongside the old ones', () => {
  try {
    readConfig({});
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    for (const name of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SIGNING_KEY', 'ADMIN_LOGINS']) {
      assert.ok(message.includes(name), `expected ${name} in: ${message}`);
    }
  }
});

test('the thrown message never contains the client secret or signing key on missing variables', () => {
  try {
    readConfig({ ...COMPLETE, GITHUB_CLIENT_SECRET: undefined, BASE_URL: undefined });
    assert.fail('expected readConfig to throw');
  } catch (err) {
    const message = (err as Error).message;
    assert.ok(!message.includes('a-long-random-signing-key'), 'the signing key must not appear in an error');
  }
});
```

**Fällt, wenn:** Test 1 — `clientId`/`clientSecret`/`signingKey` nicht oder unter anderem Namen zurückgegeben werden. Test 2 — das Splitten/Trimmen von `ADMIN_LOGINS` entfällt (dann steht `'czepter, someone-else'` als ein einzelner Eintrag da). Test 3 — die Leer-nach-Trim-Prüfung fehlt (dann würde ein System ausgeliefert, das niemand je zulassen kann — genau das Henne-Ei-Problem, das `ADMIN_LOGINS` lösen soll). Test 4 — eine der vier neuen Variablen fehlt in `REQUIRED`. Test 5 — `SIGNING_KEY` versehentlich in die Fehlermeldung gerät.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `config.clientId` ist `undefined`, oder `readConfig({})` nennt die vier neuen Namen noch nicht.

- [ ] **Step 3: Write the implementation**

`lib/config.ts` komplett ersetzen:

```ts
// Read once, at startup, and fail with every problem at once. A service
// that starts and then discovers its third missing variable on the first
// request wastes a deploy cycle per variable.

export type AppConfig = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  baseUrl: string;
  // The GitHub App's OAuth identity, distinct from appId: appId signs the
  // app's own JWT, clientId/clientSecret run the user-to-server login flow
  // (spec §5, role 1). Both exist on the same App's settings page.
  clientId: string;
  clientSecret: string;
  // Signs the session cookie. Nothing but this process ever needs to read
  // or write with it.
  signingKey: string;
  // Who is allowed to sign in without ever needing a row in the
  // allowlist table — solves the chicken-and-egg problem of an empty
  // table locking everyone out forever (spec §5, decision 15).
  adminLogins: string[];
};

const REQUIRED = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'BASE_URL',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'SIGNING_KEY',
  'ADMIN_LOGINS',
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

  const adminLogins = (env.ADMIN_LOGINS as string).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (adminLogins.length === 0) {
    // A non-empty variable that trims down to nothing is the same
    // lockout ADMIN_LOGINS exists to prevent — fail loudly at startup,
    // not silently at the first denied login.
    throw new Error('ADMIN_LOGINS must name at least one GitHub login');
  }

  return {
    appId: env.GITHUB_APP_ID as string,
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET as string,
    baseUrl: env.BASE_URL as string,
    clientId: env.GITHUB_CLIENT_ID as string,
    clientSecret: env.GITHUB_CLIENT_SECRET as string,
    signingKey: env.SIGNING_KEY as string,
    adminLogins,
  };
}
```

In `lib/appAuth.test.ts` die `CONFIG`-Konstante erweitern:

```ts
const CONFIG: AppConfig = {
  appId: '12345',
  privateKey,
  webhookSecret: 'shhh',
  baseUrl: 'https://example.test',
  clientId: 'Iv1.test',
  clientSecret: 'test-client-secret',
  signingKey: 'test-signing-key',
  adminLogins: ['tester'],
};
```

In `bin/reindex.test.ts` die `PEM_ENV`-Konstante erweitern:

```ts
const PEM_ENV = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_WEBHOOK_SECRET: 'shhh',
  BASE_URL: 'https://example.test',
  GITHUB_CLIENT_ID: 'Iv1.test',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  SIGNING_KEY: 'test-signing-key',
  ADMIN_LOGINS: 'tester',
};
```

(Die genaue Position und Umgebung dieser beiden Fixtures in ihren Dateien: `CONFIG` steht am Kopf von `lib/appAuth.test.ts` direkt nach dem generierten Schlüsselpaar; `PEM_ENV` steht in `bin/reindex.test.ts` kurz vor dem Test `'buildClient produces a GitHub client that talks through the given http'`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS — alle bisherigen 261 Tests plus die 5 neuen, keine Kompilierfehler in `appAuth.test.ts` oder `reindex.test.ts`.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne das Trimmen/Filtern aus der `ADMIN_LOGINS`-Verarbeitung (`.split(',')` ohne `.map`/`.filter`) — Test 2 muss fallen. Setze zurück. Entferne `'SIGNING_KEY'` aus `REQUIRED` — Test 4 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/config.ts lib/config.test.ts lib/appAuth.test.ts bin/reindex.test.ts
git commit -m "feat: read the login and signing configuration"
```

---

### Task 2: Drei neue Tabellen

**Files:**
- Modify: `lib/db/schema.ts`
- Test: `lib/db/client.test.ts`
- Create: neue Migrationsdateien unter `drizzle/` (von `drizzle-kit generate` erzeugt, siehe Step 3)

**Interfaces:**
- Consumes: nichts.
- Produces: `export const account`, `export const allowlist`, `export const repoPermission` (Drizzle-Tabellen, spiegeln Spec §4s Schema-Tabelle).

- [ ] **Step 1: Write the failing test**

An `lib/db/client.test.ts` anhängen. Am Kopf der Datei zusätzlich `account`, `allowlist`, `repoPermission` aus `./schema.ts` importieren:

```ts
import { log, account, allowlist, repoPermission } from './schema.ts';
```

```ts
test('an account round-trips by its github user id', () => {
  withDb((db) => {
    db.insert(account).values({
      githubUserId: 42, login: 'octocat', avatarUrl: 'https://example.test/a.png', lastSeenAt: '2026-09-14T00:00:00.000Z',
    }).run();
    const rows = db.select().from(account).where(eq(account.githubUserId, 42)).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].login, 'octocat');
  });
});

test('a second account row for the same github user id is rejected', () => {
  withDb((db) => {
    const row = { githubUserId: 1, login: 'a', avatarUrl: null, lastSeenAt: '2026-09-14T00:00:00.000Z' };
    db.insert(account).values(row).run();
    assert.throws(() => db.insert(account).values(row).run());
  });
});

test('an allowlist row round-trips by its github login', () => {
  withDb((db) => {
    db.insert(allowlist).values({
      githubLogin: 'octocat', addedBy: 'admin-login', addedAt: '2026-09-14T00:00:00.000Z', note: null,
    }).run();
    const rows = db.select().from(allowlist).where(eq(allowlist.githubLogin, 'octocat')).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].addedBy, 'admin-login');
  });
});

test('a repo_permission row is keyed by account and log together', () => {
  withDb((db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'r', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    }).run();
    db.insert(repoPermission).values({
      accountId: 42, logId: 'log1', canWrite: true, checkedAt: '2026-09-14T00:00:00.000Z',
    }).run();
    const rows = db.select().from(repoPermission).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canWrite, true);
  });
});

test('a second repo_permission row for the same account and log is rejected', () => {
  withDb((db) => {
    db.insert(log).values({
      publicId: 'log2', repoOwner: 'o2', repoName: 'r2', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null,
      state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
    }).run();
    const row = { accountId: 7, logId: 'log2', canWrite: false, checkedAt: '2026-09-14T00:00:00.000Z' };
    db.insert(repoPermission).values(row).run();
    assert.throws(() => db.insert(repoPermission).values(row).run());
  });
});
```

**Fällt, wenn:** Test 1 — die `account`-Tabelle fehlt oder eine Spalte heißt anders. Test 2 — `githubUserId` ist nicht der Primärschlüssel. Test 3 — die `allowlist`-Tabelle fehlt. Test 4 — `repo_permission`s `can_write`-Spalte nicht als Boolean-Modus angelegt ist (dann käme `1`/`0` statt `true`/`false` zurück und `assert.equal(..., true)` fiele). Test 5 — der zusammengesetzte Primärschlüssel `(account_id, log_id)` fehlt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module` oder `no such table: account` (die Migration existiert noch nicht).

- [ ] **Step 3: Write the implementation**

An `lib/db/schema.ts` anhängen:

```ts
// Whoever has signed in successfully. Admin right is not a column here —
// it is ADMIN_LOGINS from the environment, checked fresh every time, never
// stored (spec §5).
export const account = sqliteTable('account', {
  githubUserId: integer('github_user_id').primaryKey(),
  login: text('login').notNull(),
  avatarUrl: text('avatar_url'),
  lastSeenAt: text('last_seen_at').notNull(),
});

// Who may sign in at all, beyond ADMIN_LOGINS. Starts empty; nothing in
// this plan writes to it yet — only a future admin UI (Plan 6) does.
export const allowlist = sqliteTable('allowlist', {
  githubLogin: text('github_login').primaryKey(),
  addedBy: text('added_by').notNull(),
  addedAt: text('added_at').notNull(),
  note: text('note'),
});

// A cached answer to "does this account have write access to this log's
// repository", good for five minutes (spec §5). Keyed by the pair, not by
// account alone: one person can hold different rights on different logs.
export const repoPermission = sqliteTable('repo_permission', {
  accountId: integer('account_id').notNull(),
  logId: text('log_id').notNull(),
  canWrite: integer('can_write', { mode: 'boolean' }).notNull(),
  checkedAt: text('checked_at').notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.logId] })]);
```

Dann die Migration erzeugen:

```bash
npm run db:generate
```

Das legt eine neue `drizzle/000N_<zufälliger-name>.sql` sowie eine passende `drizzle/meta/000N_snapshot.json` an und aktualisiert `drizzle/meta/_journal.json`. Alle drei gehören ins Repo — `openDb()` wendet sie beim Öffnen automatisch an, aber nur, wenn sie committet sind.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Ändere `repoPermission`s Primärschlüssel-Definition, sodass nur `accountId` als Schlüssel zählt (`primaryKey({ columns: [t.accountId] })`) — Test 5 muss fallen (der zweite Insert würde dann nicht mehr abgelehnt, weil eine andere `logId` schon reicht, um als „neue Zeile" durchzugehen — probiere es aus und beobachte, was tatsächlich passiert; melde im Report, welchen Test es bricht, auch wenn es nicht exakt Test 5 ist). Setze zurück. Ändere `canWrite`s Spaltendefinition auf `integer('can_write')` ohne `{ mode: 'boolean' }` — Test 4 muss fallen. Setze zurück, Suite grün, `npm run db:generate` erneut laufen lassen um zu bestätigen, dass es keine neue Migration mehr vorschlägt (leerer `git status` für `drizzle/`).

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts lib/db/client.test.ts drizzle/
git commit -m "feat: add the account, allowlist and repo_permission tables"
```

---

### Task 3: Session-Cookie und Zulassungsprüfung

**Files:**
- Create: `lib/session.ts`
- Test: `lib/session.test.ts`

**Interfaces:**
- Consumes: `type Db` aus `./db/client.ts`, `allowlist` aus `./db/schema.ts`.
- Produces: `type SessionPayload = { accountId: number }`, `function createSessionCookie(signingKey: string, accountId: number, nowSeconds?: number): string`, `function verifySessionCookie(signingKey: string, cookie: string | undefined, nowSeconds?: number): SessionPayload | null`, `function isAdmin(login: string, adminLogins: string[]): boolean`, `function isAllowed(db: Db, login: string, adminLogins: string[]): boolean`.

- [ ] **Step 1: Write the failing test**

`lib/session.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { allowlist } from './db/schema.ts';
import { createSessionCookie, verifySessionCookie, isAdmin, isAllowed } from './session.ts';

const KEY = 'test-signing-key-do-not-use-in-production';
const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000;

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-session-'));
  try {
    fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a cookie verifies back to the account id it was created for', () => {
  const cookie = createSessionCookie(KEY, 42, NOW);
  assert.deepEqual(verifySessionCookie(KEY, cookie, NOW), { accountId: 42 });
});

test('a cookie signed with a different key does not verify', () => {
  const cookie = createSessionCookie(KEY, 42, NOW);
  assert.equal(verifySessionCookie('a-different-signing-key', cookie, NOW), null);
});

test('a tampered payload does not verify, even with the right signature format', () => {
  const cookie = createSessionCookie(KEY, 42, NOW);
  const [payload, signature] = cookie.split('.');
  const forged = Buffer.from(JSON.stringify({ accountId: 99, exp: NOW + 30 * DAY }), 'utf8').toString('base64url');
  assert.equal(verifySessionCookie(KEY, `${forged}.${signature}`, NOW), null);
  void payload;
});

test('a cookie is valid at 29 days and expired at 31 days', () => {
  const cookie = createSessionCookie(KEY, 42, NOW);
  assert.notEqual(verifySessionCookie(KEY, cookie, NOW + 29 * DAY), null);
  assert.equal(verifySessionCookie(KEY, cookie, NOW + 31 * DAY), null);
});

test('a missing, empty or malformed cookie does not verify', () => {
  assert.equal(verifySessionCookie(KEY, undefined, NOW), null);
  assert.equal(verifySessionCookie(KEY, '', NOW), null);
  assert.equal(verifySessionCookie(KEY, 'not-a-cookie-at-all', NOW), null);
  assert.equal(verifySessionCookie(KEY, 'onlyonepart', NOW), null);
  assert.equal(verifySessionCookie(KEY, '....', NOW), null);
});

test('isAdmin checks ADMIN_LOGINS only, nothing else', () => {
  assert.equal(isAdmin('czepter', ['czepter', 'other']), true);
  assert.equal(isAdmin('nobody', ['czepter', 'other']), false);
});

test('isAllowed says yes for an admin login even with an empty allowlist table', () => {
  withDb((db) => {
    assert.equal(isAllowed(db, 'czepter', ['czepter']), true);
  });
});

test('isAllowed says yes for a login the allowlist table names', () => {
  withDb((db) => {
    db.insert(allowlist).values({ githubLogin: 'someone', addedBy: 'czepter', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    assert.equal(isAllowed(db, 'someone', ['czepter']), true);
  });
});

test('isAllowed says no for a login in neither place', () => {
  withDb((db) => {
    db.insert(allowlist).values({ githubLogin: 'someone', addedBy: 'czepter', addedAt: '2026-09-14T00:00:00.000Z', note: null }).run();
    assert.equal(isAllowed(db, 'a-stranger', ['czepter']), false);
  });
});
```

**Fällt, wenn:** Test 1 — die Signaturbildung oder das Kodieren des Payloads sich ändert, sodass Rundtrip nicht mehr stimmt. Test 2 und 3 sind die eigentliche Sicherheitsaussage und fallen, sobald der Signaturvergleich immer wahr liefert oder das Payload ungeprüft übernommen wird. Test 4 — die `exp`-Prüfung fehlt oder die 30-Tage-Konstante ändert sich. Test 5 — irgendeine der fünf Formen ungeprüft durchgeht (etwa `JSON.parse` wirft unabgefangen statt `null` zu liefern). Test 6 — `isAdmin` die Datenbank anfasst statt nur die übergebene Liste zu prüfen. Test 7 — `isAllowed` erst in der Tabelle nachschaut, bevor es `isAdmin` prüft, und dabei bei leerer Tabelle `false` liefert. Test 8 — `isAllowed` die Tabelle gar nicht abfragt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './session.ts'`.

- [ ] **Step 3: Write the implementation**

`lib/session.ts`:

```ts
// Wer angemeldet ist, und wer sich überhaupt anmelden darf. Beides sitzt
// hier zusammen, weil eine Session ohne Zulassungsprüfung sinnlos wäre —
// spec §9 nennt genau diese Kombination als eine Datei ("Cookie-Session,
// Zulassungsprüfung").

import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { allowlist } from './db/schema.ts';

export type SessionPayload = { accountId: number };

// 30 Tage, wörtlich aus Spec §5.
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function sign(signingKey: string, data: string): string {
  return createHmac('sha256', signingKey).update(data).digest('base64url');
}

export function createSessionCookie(
  signingKey: string,
  accountId: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload = JSON.stringify({ accountId, exp: nowSeconds + SESSION_MAX_AGE_SECONDS });
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  return `${encoded}.${sign(signingKey, encoded)}`;
}

export function verifySessionCookie(
  signingKey: string,
  cookie: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (typeof cookie !== 'string' || cookie === '') return null;
  const dot = cookie.indexOf('.');
  if (dot === -1) return null;
  const encoded = cookie.slice(0, dot);
  const signature = cookie.slice(dot + 1);
  if (encoded === '' || signature === '') return null;

  const expected = Buffer.from(sign(signingKey, encoded), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  // Length first: timingSafeEqual throws on a mismatch, and the length of
  // a signature is public anyway — comparing it leaks nothing an attacker
  // could not compute themselves.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: { accountId?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.accountId !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= nowSeconds) return null;
  return { accountId: payload.accountId };
}

// Adminrecht ist ausschließlich Zulassung, keine Datenbankspalte (spec §5,
// Global Constraints): jemanden zum Admin zu machen heißt, ADMIN_LOGINS zu
// ändern, nicht eine Zeile zu schreiben.
export function isAdmin(login: string, adminLogins: string[]): boolean {
  return adminLogins.includes(login);
}

export function isAllowed(db: Db, login: string, adminLogins: string[]): boolean {
  // ADMIN_LOGINS zuerst und ohne Datenbankzugriff: es existiert genau
  // dafür, das System erreichbar zu halten, wenn die Tabelle leer ist
  // (spec §5, Henne-Ei-Problem) — ein Tabellen-Miss könnte diese Antwort
  // nie in ein Nein verwandeln.
  if (isAdmin(login, adminLogins)) return true;
  return db.select().from(allowlist).where(eq(allowlist.githubLogin, login)).all().length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Ersetze in `verifySessionCookie` die `timingSafeEqual`-Prüfung durch `true` — Test 2 und 3 müssen fallen. Setze zurück. Entferne die `exp`-Prüfung — Test 4 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/session.ts lib/session.test.ts
git commit -m "feat: sign session cookies and check who may sign in"
```

---

### Task 4: `collaboratorPermission` auf der GitHub-Naht

**Files:**
- Modify: `lib/github.ts`
- Test: `lib/github.test.ts`

**Interfaces:**
- Consumes: alles Bestehende aus `lib/github.ts`.
- Produces: `GitHub` bekommt eine vierte Methode `collaboratorPermission(ref: RepoRef, login: string): Promise<'admin' | 'write' | 'read' | 'none' | null>`; `fakeGitHub` erfüllt sie ebenfalls.

`null` heißt „keine Antwort möglich" — keine Installation, oder GitHub kennt Repo oder Login nicht (404) — und ist damit dieselbe sichere Richtung wie überall sonst in dieser Datei: der Aufrufer (Task 5) behandelt `null` wie `'none'`, nie wie Schreibrecht.

- [ ] **Step 1: Write the failing test**

An `lib/github.test.ts` anhängen:

```ts
test('collaboratorPermission maps the response to the four known levels', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/collaborators/alice/permission': { body: { permission: 'write' } },
  });
  const level = await githubClient(withToken('t'), http).collaboratorPermission(REF, 'alice');
  assert.equal(level, 'write');
});

test('an unrecognised permission value normalises to none, not a throw', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/collaborators/alice/permission': { body: { permission: 'triage' } },
  });
  const level = await githubClient(withToken('t'), http).collaboratorPermission(REF, 'alice');
  assert.equal(level, 'none');
});

test('a 404 on the collaborator lookup yields null, not a throw', async () => {
  const http = fakeHttp({});
  const level = await githubClient(withToken('t'), http).collaboratorPermission(REF, 'alice');
  assert.equal(level, null);
});

test('no installation token yields null, without a request', async () => {
  const http = fakeHttp({});
  const level = await githubClient(withToken(null), http).collaboratorPermission(REF, 'alice');
  assert.equal(level, null);
  assert.deepEqual(http.calls, []);
});

test('an unexpected server error throws rather than reading as no access', async () => {
  const http = fakeHttp({ 'GET /repos/o/r/collaborators/alice/permission': { status: 500 } });
  await assert.rejects(
    () => githubClient(withToken('t'), http).collaboratorPermission(REF, 'alice'),
    /HTTP 500/,
  );
});

test('a login with characters a URL path cannot carry raw is encoded', async () => {
  const http = fakeHttp({
    'GET /repos/o/r/collaborators/weird%20name/permission': { body: { permission: 'admin' } },
  });
  const level = await githubClient(withToken('t'), http).collaboratorPermission(REF, 'weird name');
  assert.equal(level, 'admin');
});

test('fakeGitHub grants write on a repository it knows, null on one it does not', async () => {
  const gh = fakeGitHub({ 'o/r': { 'release-log.json': '{}' } });
  assert.equal(await gh.collaboratorPermission({ owner: 'o', repo: 'r' }, 'anyone'), 'write');
  assert.equal(await gh.collaboratorPermission({ owner: 'o', repo: 'gone' }, 'anyone'), null);
});
```

**Fällt, wenn:** Test 1 — der `permission`-Wert falsch gelesen wird. Test 2 — ein unbekannter Wert wirft statt auf `'none'` abzubilden. Test 3 — 404 anders als `null` behandelt wird. Test 4 — ohne Token trotzdem eine Anfrage rausgeht, oder etwas anderes als `null` zurückkommt. Test 5 — 500 verschluckt statt geworfen wird — das wäre der Unterschied zwischen „diese Person darf nicht schreiben" und „GitHub war gerade nicht erreichbar", und beides als dasselbe Ergebnis zu behandeln verschleiert einen echten Fehlerzustand. Test 6 — `login` ungekodet in den Pfad interpoliert wird. Test 7 — `fakeGitHub`s neue Methode fehlt oder liefert für ein bekanntes Repo `null`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `collaboratorPermission is not a function`.

- [ ] **Step 3: Write the implementation**

In `lib/github.ts`, `type GitHub` erweitern:

```ts
export type GitHub = {
  probe(ref: RepoRef): Promise<RepoState>;
  tree(ref: RepoRef, commit: string): Promise<TreeEntry[]>;
  blob(ref: RepoRef, sha: string): Promise<Buffer | null>;
  // GitHub entscheidet über Rechte, nicht diese App (spec §5, Entscheidung
  // 14). null heißt "keine Antwort möglich" -- der Aufrufer behandelt das
  // wie 'none', nie wie Schreibrecht.
  collaboratorPermission(ref: RepoRef, login: string): Promise<'admin' | 'write' | 'read' | 'none' | null>;
};
```

In `fakeGitHub`s zurückgegebenem Objekt ergänzen:

```ts
    async collaboratorPermission(ref) {
      return entriesOf(ref) === null ? null : 'write';
    },
```

In `githubClient`s zurückgegebenem Objekt ergänzen:

```ts
    async collaboratorPermission(ref, login) {
      const res = await authed(ref, `/repos/${ref.owner}/${ref.repo}/collaborators/${encodeURIComponent(login)}/permission`);
      if (res === null || res.status === 404) return null;
      if (!res.ok) throw new Error(`collaborator permission lookup failed: HTTP ${res.status}`);
      const body = (await res.json()) as { permission?: string };
      return body.permission === 'admin' || body.permission === 'write' || body.permission === 'read'
        ? body.permission
        : 'none';
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Ändere `res.status === 404` auf `res.status === 999` (die 404-Bedingung entfernen) — Test 3 muss fallen. Setze zurück. Entferne `encodeURIComponent` um `login` — Test 6 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/github.ts lib/github.test.ts
git commit -m "feat: ask GitHub whether a login can write to a repository"
```

---

### Task 5: Rechteprüfung mit Fünf-Minuten-Cache

**Files:**
- Create: `lib/permissions.ts`
- Test: `lib/permissions.test.ts`

**Interfaces:**
- Consumes: `type Db` aus `./db/client.ts`, `type GitHub`, `type RepoRef` aus `./github.ts`.
- Produces: `type Permissions = { canWrite(accountId: number, login: string, logId: string, ref: RepoRef): Promise<boolean>; invalidate(ref: RepoRef): void }`, `function permissions(db: Db, gh: GitHub, nowMs?: () => number): Permissions`.

- [ ] **Step 1: Write the failing test**

`lib/permissions.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { log } from './db/schema.ts';
import type { GitHub, RepoRef } from './github.ts';
import { permissions } from './permissions.ts';

const REF: RepoRef = { owner: 'o', repo: 'r' };

function withDb(fn: (db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-perm-'));
  return fn(openDb(join(dir, 'test.sqlite'))).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function insertLog(db: ReturnType<typeof openDb>, publicId: string, owner: string, repo: string): void {
  db.insert(log).values({
    publicId, repoOwner: owner, repoName: repo, product: 'P',
    view: 'full', visibility: 'public', curationNotes: null,
    state: 'active', headSha: null, configBlobSha: null, indexedAt: null,
  }).run();
}

// Ein GitHub-Double, das zählt, wie oft es tatsächlich gefragt wurde — das
// ist die Assertion, die trägt: was `canWrite` zurückgibt, wäre auch mit
// einem Cache gleich, der nie greift.
function counting(level: 'admin' | 'write' | 'read' | 'none' | null): { gh: GitHub; calls: () => number } {
  let calls = 0;
  const gh: GitHub = {
    probe: async () => ({ kind: 'gone' }),
    tree: async () => [],
    blob: async () => null,
    async collaboratorPermission() { calls += 1; return level; },
  };
  return { gh, calls: () => calls };
}

test('write or admin grants canWrite, read or none does not', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    for (const [level, expected] of [['admin', true], ['write', true], ['read', false], ['none', false]] as const) {
      const { gh } = counting(level);
      const perms = permissions(db, gh);
      assert.equal(await perms.canWrite(1, 'alice', 'log1', REF), expected, `level ${level}`);
    }
  });
});

test('a null level (no signal from GitHub) is treated as no access', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh } = counting(null);
    assert.equal(await permissions(db, gh).canWrite(1, 'alice', 'log1', REF), false);
  });
});

test('a second call within five minutes does not ask GitHub again', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh, calls } = counting('write');
    let clock = 1_000_000;
    const perms = permissions(db, gh, () => clock);
    assert.equal(await perms.canWrite(1, 'alice', 'log1', REF), true);
    clock += 60_000;
    assert.equal(await perms.canWrite(1, 'alice', 'log1', REF), true);
    assert.equal(calls(), 1, 'the second call must be served from the cache');
  });
});

test('a call after five minutes asks GitHub again', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh, calls } = counting('write');
    let clock = 1_000_000;
    const perms = permissions(db, gh, () => clock);
    await perms.canWrite(1, 'alice', 'log1', REF);
    clock += 5 * 60_000 + 1;
    await perms.canWrite(1, 'alice', 'log1', REF);
    assert.equal(calls(), 2, 'the cache must expire after five minutes');
  });
});

test('two different accounts on the same log are cached separately', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh, calls } = counting('write');
    const perms = permissions(db, gh, () => 1_000_000);
    await perms.canWrite(1, 'alice', 'log1', REF);
    await perms.canWrite(2, 'bob', 'log1', REF);
    assert.equal(calls(), 2, 'a cache hit for one account must not answer for another');
  });
});

test('invalidate clears the cache for every account on that log, keyed by repository', async () => {
  await withDb(async (db) => {
    insertLog(db, 'log1', 'o', 'r');
    const { gh, calls } = counting('write');
    const perms = permissions(db, gh, () => 1_000_000);
    await perms.canWrite(1, 'alice', 'log1', REF);
    await perms.canWrite(2, 'bob', 'log1', REF);
    perms.invalidate(REF);
    await perms.canWrite(1, 'alice', 'log1', REF);
    await perms.canWrite(2, 'bob', 'log1', REF);
    assert.equal(calls(), 4, 'both accounts must be re-checked, not just the one the event happened to name');
  });
});

test('invalidate on a repository with no log is a no-op, not a throw', async () => {
  await withDb(async (db) => {
    const { gh } = counting(null);
    permissions(db, gh).invalidate({ owner: 'nobody', repo: 'here' });
  });
});
```

**Fällt, wenn:** Test 1 — `canWrite` `'admin'`/`'write'` nicht auf `true` oder `'read'`/`'none'` nicht auf `false` abbildet. Test 2 — `null` als Schreibrecht gewertet wird. Test 3 — der Cache fehlt (dann `calls === 2`). Test 4 — die Fünf-Minuten-Schwelle fehlt oder falsch herum steht. Test 5 — der Cache-Schlüssel nicht die Konto-ID einschließt (dann `calls === 1` statt `2`, weil Bobs Anfrage Alices Cache-Treffer nutzt). Test 6 — `invalidate` nur eine Konto-Zeile statt aller Zeilen des Logs löscht (dann `calls === 3` statt `4`). Test 7 — `invalidate` bei unbekanntem Repo wirft.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './permissions.ts'`.

- [ ] **Step 3: Write the implementation**

`lib/permissions.ts`:

```ts
// Repo-Rechte werden gegen GitHub geprüft, nie lokal erfunden (spec §5,
// Entscheidung 14): das Repo ist die Wahrheit, also sind es auch seine
// Rechte. Die Prüfung kostet einen Netzwerk-Umlauf, deshalb liegt die
// Antwort fünf Minuten je (Konto, Log) im Cache und wird früher
// invalidiert, wenn die zwei Ereignisse eintreffen, die sie veralten
// lassen können (spec §5) -- siehe lib/webhook.ts.

import { and, eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, repoPermission } from './db/schema.ts';
import type { GitHub, RepoRef } from './github.ts';

const CACHE_MS = 5 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

export type Permissions = {
  canWrite(accountId: number, login: string, logId: string, ref: RepoRef): Promise<boolean>;
  invalidate(ref: RepoRef): void;
};

export function permissions(db: Db, gh: GitHub, nowMs: () => number = Date.now): Permissions {
  return {
    async canWrite(accountId, login, logId, ref) {
      const cached = db.select().from(repoPermission)
        .where(and(eq(repoPermission.accountId, accountId), eq(repoPermission.logId, logId))).all()[0];
      if (cached && nowMs() - Date.parse(cached.checkedAt) < CACHE_MS) {
        return cached.canWrite;
      }
      const level = await gh.collaboratorPermission(ref, login);
      const canWrite = level === 'admin' || level === 'write';
      db.insert(repoPermission).values({ accountId, logId, canWrite, checkedAt: now() })
        .onConflictDoUpdate({
          target: [repoPermission.accountId, repoPermission.logId],
          set: { canWrite, checkedAt: now() },
        })
        .run();
      return canWrite;
    },

    invalidate(ref) {
      const row = db.select().from(log)
        .where(and(eq(log.repoOwner, ref.owner), eq(log.repoName, ref.repo))).all()[0];
      if (!row) return;
      // Grob mit Absicht: jede gecachte Zeile dieses Logs, nicht nur ein
      // Konto. Eine Mitgliedschaftsänderung kann mehr betreffen als die
      // eine Person, die das Ereignis zufällig nennt, und ein erneuter
      // Check kostet höchstens eine Anfrage je Konto beim nächsten
      // Gebrauch -- billig gegen das Risiko, ein veraltetes "ja" auszuliefern.
      db.delete(repoPermission).where(eq(repoPermission.logId, row.publicId)).run();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne die Cache-Prüfung (`if (cached && ...)`) komplett, sodass jeder Aufruf neu fragt — Test 3 muss fallen. Setze zurück. Ändere `invalidate`, sodass es nur `accountId: 1` mitlöscht statt aller Konten des Logs — Test 6 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/permissions.ts lib/permissions.test.ts
git commit -m "feat: cache repo-write checks against GitHub for five minutes"
```

---

### Task 6: Rechte-Invalidierung aus dem Webhook

**Files:**
- Modify: `lib/webhook.ts`
- Test: `lib/webhook.test.ts`

**Interfaces:**
- Consumes: `type Delivery`, `type RepoRef` — beide schon in der Datei.
- Produces: `function permissionInvalidationRefsFor(delivery: Delivery): RepoRef[]`.

Eine eigene Funktion, bewusst getrennt von `refsFor`: `member` darf nie einen Inhalts-Abgleich auslösen (an den Dateien hat sich nichts geändert), und es in `refsFor` mit hineinzunehmen zwänge jeden Aufrufer, es wieder herauszufiltern.

- [ ] **Step 1: Write the failing test**

An `lib/webhook.test.ts` anhängen:

```ts
test('member names the one repository it happened on', () => {
  assert.deepEqual(
    permissionInvalidationRefsFor({ event: 'member', payload: { action: 'added', repository: { full_name: 'o/r' } } }),
    [{ owner: 'o', repo: 'r' }],
  );
});

test('installation_repositories names both what was added and what was removed', () => {
  assert.deepEqual(
    permissionInvalidationRefsFor({
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

test('push and repository name nothing -- a content change is not a rights change', () => {
  assert.deepEqual(permissionInvalidationRefsFor({ event: 'push', payload: { repository: { full_name: 'o/r' } } }), []);
  assert.deepEqual(permissionInvalidationRefsFor({ event: 'repository', payload: { repository: { full_name: 'o/r' } } }), []);
});

test('ping and anything unknown name nothing', () => {
  assert.deepEqual(permissionInvalidationRefsFor({ event: 'ping', payload: {} }), []);
  assert.deepEqual(permissionInvalidationRefsFor({ event: 'star', payload: { repository: { full_name: 'o/r' } } }), []);
});

test('a malformed member payload names nothing instead of throwing', () => {
  assert.deepEqual(permissionInvalidationRefsFor({ event: 'member', payload: null }), []);
  assert.deepEqual(permissionInvalidationRefsFor({ event: 'member', payload: {} }), []);
  assert.deepEqual(permissionInvalidationRefsFor({ event: 'member', payload: { repository: { full_name: 'not-a-valid-name' } } }), []);
});
```

**Fällt, wenn:** Test 1 — `member` nicht abgebildet wird oder auf das falsche Feld zugreift. Test 2 — `installation_repositories` nur eine der beiden Listen liest. Test 3 — `push`/`repository` versehentlich auch etwas zurückgeben (das wäre ein unnötiger Cache-Wisch bei jedem Push, nicht falsch im Sinne von Datenverlust, aber genau die Vermischung, die dieser Task vermeiden soll — der Test macht sie sichtbar). Test 4 — ein unbekanntes Ereignis durchgereicht wird. Test 5 — die Funktion einer Zusicherung über die Form des Payloads traut.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `permissionInvalidationRefsFor is not a function`.

- [ ] **Step 3: Write the implementation**

An `lib/webhook.ts` anhängen (`refOf` und `listOf` sind bereits private Helfer in dieser Datei und werden hier weiterverwendet, nicht neu geschrieben):

```ts
// Eine eigene Funktion, bewusst getrennt von refsFor: 'member' darf nie
// einen Inhalts-Abgleich auslösen, nur den Rechte-Cache treffen. Es in
// refsFor mit hineinzunehmen zwänge jeden Aufrufer, es dort wieder
// herauszufiltern.
export function permissionInvalidationRefsFor(delivery: Delivery): RepoRef[] {
  const payload = (delivery.payload ?? {}) as Record<string, unknown>;
  if (typeof payload !== 'object') return [];

  switch (delivery.event) {
    case 'member': {
      const ref = refOf(payload.repository);
      return ref ? [ref] : [];
    }
    // Dieselbe Zuordnung, die refsFor für den Abgleich benutzt -- ein
    // Installationswechsel kann Rechte genauso verändern wie er Inhalte
    // erreichbar macht.
    case 'installation_repositories':
      return [...listOf(payload.repositories_added), ...listOf(payload.repositories_removed)];
    default:
      return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Entferne den `case 'member'`-Zweig — Test 1 muss fallen. Setze zurück. Entferne `listOf(payload.repositories_removed)` aus dem `installation_repositories`-Zweig — Test 2 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/webhook.ts lib/webhook.test.ts
git commit -m "feat: invalidate cached permissions on member and installation changes"
```

---

### Task 7: Code gegen GitHub-Identität tauschen

**Files:**
- Create: `lib/login.ts`
- Test: `lib/login.test.ts`

**Interfaces:**
- Consumes: `type Http` aus `./http.ts`.
- Produces: `type GithubIdentity = { id: number; login: string; avatarUrl: string | null }`, `function exchangeCodeForIdentity(http: Http, clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<GithubIdentity | null>`.

Rein bis auf die injizierte `Http`: kein Cookie, keine Datenbank, keine Uhr. Server.ts (Task 8) ruft das auf und entscheidet, was mit dem Ergebnis passiert. Das zurückgetauschte Nutzer-Token verlässt diese Funktion nie — es wird genau einmal benutzt, um `GET /user` zu fragen, und dann verworfen (spec §5: kein anderer Zugriff läuft je über ein Nutzer-Token außer `create_log`, das außerhalb dieses Plans liegt).

- [ ] **Step 1: Write the failing test**

`lib/login.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHttp } from './http.ts';
import { exchangeCodeForIdentity } from './login.ts';

test('a successful exchange returns the identity from GET /user', async () => {
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 'gho_abc', token_type: 'bearer' } },
    'GET /user': { body: { id: 42, login: 'octocat', avatar_url: 'https://example.test/a.png' } },
  });
  const identity = await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'the-code', 'https://example.test/auth/github/callback');
  assert.deepEqual(identity, { id: 42, login: 'octocat', avatarUrl: 'https://example.test/a.png' });
});

test('the user token reaches GET /user as a bearer header and nowhere else', async () => {
  const seen: string[] = [];
  const inner = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 'gho_secret_value' } },
    'GET /user': { body: { id: 1, login: 'a', avatar_url: null } },
  });
  const http = Object.assign(
    (url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''));
      return inner(url, init);
    },
    { calls: inner.calls },
  );
  await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'the-code', 'https://example.test/cb');
  assert.deepEqual(seen, ['', 'Bearer gho_secret_value']);
});

test('a missing avatar_url becomes null, not undefined or a throw', async () => {
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 't' } },
    'GET /user': { body: { id: 1, login: 'a' } },
  });
  const identity = await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'code', 'https://example.test/cb');
  assert.equal(identity?.avatarUrl, null);
});

test('a token exchange that fails yields null, not a throw', async () => {
  const http = fakeHttp({ 'POST /login/oauth/access_token': { status: 401 } });
  assert.equal(await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'bad-code', 'https://example.test/cb'), null);
});

test('a response with no access_token yields null', async () => {
  const http = fakeHttp({ 'POST /login/oauth/access_token': { body: { error: 'bad_verification_code' } } });
  assert.equal(await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'bad-code', 'https://example.test/cb'), null);
});

test('a GET /user that fails yields null, not a throw', async () => {
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 't' } },
    'GET /user': { status: 401 },
  });
  assert.equal(await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'code', 'https://example.test/cb'), null);
});

test('a user response missing id or login yields null', async () => {
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 't' } },
    'GET /user': { body: { login: 'a' } },
  });
  assert.equal(await exchangeCodeForIdentity(http, 'client-id', 'client-secret', 'code', 'https://example.test/cb'), null);
});
```

**Fällt, wenn:** Test 1 — irgendein Feld falsch gelesen wird. Test 2 — der Token an die falsche Anfrage gerät, oder das Token-Tausch selbst schon einen `authorization`-Header trägt (es gibt zu diesem Zeitpunkt noch kein Nutzer-Token — der erste Eintrag muss leer sein). Test 3 — `avatar_url: undefined` statt `null` durchgereicht wird. Test 4 — ein fehlgeschlagener Tausch wirft statt `null` zu liefern. Test 5 — ein Tausch ohne `access_token`-Feld trotzdem versucht, `GET /user` zu fragen (dann würde `http.calls` einen zweiten Eintrag zeigen, den es nicht geben darf — ergänze diese Prüfung, falls sie im obigen Testtext fehlt). Test 6 — ein fehlgeschlagenes `GET /user` wirft. Test 7 — fehlende Pflichtfelder in der Nutzerantwort nicht abgefangen werden.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './login.ts'`.

- [ ] **Step 3: Write the implementation**

`lib/login.ts`:

```ts
// Der User-to-Server-Flow der GitHub App (spec §5, Rolle 1): einen
// Autorisierungscode gegen die Identität der Person tauschen, die sich
// gerade anmeldet. Das dabei entstehende Nutzer-Token wird genau hier,
// genau einmal benutzt, um GET /user zu fragen -- und dann nie wieder
// angefasst. Jeder andere Repo-Zugriff läuft über die Installation
// (spec §5); die einzige, offengelegte Ausnahme ist create_log's
// dauerhaftes, verschlüsseltes Nutzer-Token aus Entscheidung 23, das
// außerhalb dieses Moduls liegt.

import type { Http } from './http.ts';

export type GithubIdentity = { id: number; login: string; avatarUrl: string | null };

export async function exchangeCodeForIdentity(
  http: Http,
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<GithubIdentity | null> {
  const tokenRes = await http('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!tokenRes.ok) return null;
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  if (typeof tokenBody.access_token !== 'string') return null;

  const userRes = await http('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'release-log-hub',
      authorization: `Bearer ${tokenBody.access_token}`,
    },
  });
  if (!userRes.ok) return null;
  const userBody = (await userRes.json()) as { id?: number; login?: string; avatar_url?: string | null };
  if (typeof userBody.id !== 'number' || typeof userBody.login !== 'string') return null;
  return { id: userBody.id, login: userBody.login, avatarUrl: userBody.avatar_url ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Ändere `if (!tokenRes.ok) return null;` zu einem auskommentierten No-Op — Test 4 muss fallen. Setze zurück. Entferne den `authorization`-Header beim `GET /user`-Aufruf — Test 2 muss fallen (die gesehene Kopfzeile wäre leer statt `Bearer gho_secret_value`). Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/login.ts lib/login.test.ts
git commit -m "feat: trade an authorization code for who is signing in"
```

---

### Task 8: Anmeldung, Abmeldung, `/me` — und der Webhook ruft jetzt auch die Rechte-Invalidierung

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: alles aus den Tasks 1–7.
- Produces: `type Auth = { db: Db; clientId: string; clientSecret: string; signingKey: string; adminLogins: string[]; baseUrl: string; http: Http }`; `createApp(reader: Reader, hooks?: Hooks, auth?: Auth): Server`; `Hooks` bekommt `onPermissionInvalidation?(refs: RepoRef[]): void`.

- [ ] **Step 1: Write the failing test**

An `server.test.ts` anhängen. Der bestehende Helfer `withServer(reader, fn, hooks?)` bekommt einen vierten, optionalen Parameter:

```ts
async function withServer(
  reader: Reader,
  fn: (base: string) => Promise<void>,
  hooks?: Hooks,
  auth?: Auth,
): Promise<void> {
  const server = createApp(reader, hooks, auth);
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

`mkdtempSync`, `rmSync`, `tmpdir`, `join` und `createHmac` stehen bereits am Kopf der Datei — für die neuen Tests unten reichen sie unverändert. `import type { Hooks } from './server.ts';` steht dort ebenfalls schon; die Zeile daneben um `Auth` erweitern: `import type { Hooks, Auth } from './server.ts';`. Neu zu importieren sind sonst nur:

```ts
import { openDb } from './lib/db/client.ts';
import { account } from './lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import { fakeHttp } from './lib/http.ts';
import { createSessionCookie } from './lib/session.ts';
```

Dann:

```ts
const SIGNING_KEY = 'test-signing-key';

function withAuth(fn: (auth: Auth, db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-auth-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const http = fakeHttp({
    'POST /login/oauth/access_token': { body: { access_token: 'gho_test' } },
    'GET /user': { body: { id: 42, login: 'octocat', avatar_url: 'https://example.test/a.png' } },
  });
  return fn(
    { db, clientId: 'client-id', clientSecret: 'client-secret', signingKey: SIGNING_KEY, adminLogins: ['octocat'], baseUrl: 'https://example.test', http },
    db,
  ).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  for (const line of setCookies) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

test('GET /auth/github/login sets a state cookie and redirects with the same state', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location') as string);
      assert.equal(location.origin, 'https://github.com');
      assert.equal(location.pathname, '/login/oauth/authorize');
      assert.equal(location.searchParams.get('client_id'), 'client-id');
      assert.equal(location.searchParams.get('redirect_uri'), 'https://example.test/auth/github/callback');
      const state = location.searchParams.get('state');
      assert.ok(state, 'a state parameter must be present');
      const cookieState = cookieValue(res.headers.getSetCookie(), 'oauth_state');
      assert.equal(cookieState, state);
    }, undefined, auth);
  });
});

test('two logins in a row get two different states', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const a = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      const b = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      const stateA = new URL(a.headers.get('location') as string).searchParams.get('state');
      const stateB = new URL(b.headers.get('location') as string).searchParams.get('state');
      assert.notEqual(stateA, stateB);
    }, undefined, auth);
  });
});

test('the callback rejects a state that does not match the cookie', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=wrong`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 400);
      assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('session=')), false);
    }, undefined, auth);
  });
});

test('a successful login for an allowed login sets a session cookie and redirects to /me', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/me');
      const sessionCookie = cookieValue(res.headers.getSetCookie(), 'session');
      assert.ok(sessionCookie, 'a session cookie must be set');
      const rows = db.select().from(account).where(eq(account.githubUserId, 42)).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].login, 'octocat');
    }, undefined, auth);
  });
});

test('a successful GitHub identity that is not allowed gets a denial page and no session', async () => {
  await withAuth(async (auth) => {
    // octocat is the only admin in this fixture -- swap it out so the
    // login that comes back from the fake is nobody's admin and is not
    // in the allowlist table either.
    const deniedAuth = { ...auth, adminLogins: ['somebody-else'] };
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('session=')), false);
    }, undefined, deniedAuth);
  });
});

test('a failed token exchange yields a 502 and no session', async () => {
  await withAuth(async (auth) => {
    const brokenHttp = fakeHttp({ 'POST /login/oauth/access_token': { status: 401 } });
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/callback?code=abc&state=right`, {
        redirect: 'manual',
        headers: { cookie: 'oauth_state=right' },
      });
      assert.equal(res.status, 502);
      assert.equal(res.headers.getSetCookie().some((c) => c.startsWith('session=')), false);
    }, undefined, { ...auth, http: brokenHttp });
  });
});

test('GET /me without a session answers 401', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/me`);
      assert.equal(res.status, 401);
    }, undefined, auth);
  });
});

test('GET /me with a valid session answers with the login and admin flag', async () => {
  await withAuth(async (auth, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-14T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/me`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { login: 'octocat', isAdmin: true });
    }, undefined, auth);
  });
});

test('GET /me with a session whose account row is gone answers 401, not a throw', async () => {
  await withAuth(async (auth) => {
    const cookie = createSessionCookie(SIGNING_KEY, 999);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/me`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 401);
    }, undefined, auth);
  });
});

test('POST /auth/logout clears the session cookie', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/logout`, { method: 'POST' });
      const cleared = res.headers.getSetCookie().find((c) => c.startsWith('session='));
      assert.ok(cleared, 'a session cookie must be sent to clear the old one');
      assert.match(cleared as string, /Max-Age=0/);
    }, undefined, auth);
  });
});

test('without auth configured, the login and /me routes do not exist', async () => {
  await withServer(reader, async (base) => {
    assert.equal((await fetch(`${base}/auth/github/login`, { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${base}/me`)).status, 404);
  });
});

test('a member webhook delivery calls onPermissionInvalidation, not onDelivery', async () => {
  const delivered: unknown[] = [];
  const invalidated: unknown[] = [];
  const body = JSON.stringify({ action: 'added', repository: { full_name: 'o/r' } });
  const secret = 'hook-secret';
  const sig = `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
  await withServer(reader, async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'x-github-event': 'member', 'x-hub-signature-256': sig },
      body,
    });
    assert.equal(res.status, 202);
    assert.deepEqual(delivered, []);
    assert.deepEqual(invalidated, [{ owner: 'o', repo: 'r' }]);
  }, {
    webhookSecret: secret,
    onDelivery: (refs) => { delivered.push(...refs); },
    onPermissionInvalidation: (refs) => { invalidated.push(...refs); },
  });
});
```

**Fällt, wenn:** Test 1 und 2 sind die CSRF-Absicherung und fallen, sobald `state` fest verdrahtet statt zufällig erzeugt wird. Test 3 fällt, sobald die Zustandsprüfung entfällt oder immer wahr liefert. Test 4 fällt, sobald die Session vor der Zulassungsprüfung gesetzt wird, oder die Konto-Zeile nicht angelegt wird. Test 5 fällt, sobald die Zulassungsprüfung fehlt oder immer durchlässt. Test 6 fällt, sobald ein Fehlschlag beim Token-Tausch stillschweigend als Erfolg behandelt wird. Test 7 und 9 fallen, sobald `/me` die Session gar nicht prüft. Test 8 fällt, sobald `isAdmin` falsch verdrahtet ist. Test 10 fällt, sobald eine fehlende Konto-Zeile nicht abgefangen wird. Test 11 fällt, sobald `POST /auth/logout` das Cookie nicht wirklich löscht (fehlendes `Max-Age=0`). Test 12 fällt, sobald die Routen auch ohne `auth` erreichbar bleiben. Test 13 fällt, sobald der Webhook-Pfad `permissionInvalidationRefsFor` nicht aufruft, oder es mit `refsFor` verwechselt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `/auth/github/login` antwortet 404, `Auth` ist kein Export von `server.ts`.

- [ ] **Step 3: Write the implementation**

In `server.ts` die Importe ergänzen:

```ts
import { randomBytes } from 'node:crypto';
import type { Db } from './lib/db/client.ts';
import { account } from './lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import type { Http } from './lib/http.ts';
import { createSessionCookie, verifySessionCookie, isAdmin, isAllowed } from './lib/session.ts';
import { exchangeCodeForIdentity } from './lib/login.ts';
import { permissionInvalidationRefsFor } from './lib/webhook.ts';
import { permissions } from './lib/permissions.ts';
```

`Hooks` erweitern:

```ts
export type Hooks = {
  webhookSecret: string;
  onDelivery(refs: RepoRef[]): void;
  onPermissionInvalidation?(refs: RepoRef[]): void;
};

export type Auth = {
  db: Db;
  clientId: string;
  clientSecret: string;
  signingKey: string;
  adminLogins: string[];
  baseUrl: string;
  http: Http;
};
```

Der Webhook-Handler in `createApp` bekommt nach der bestehenden Zeile `hooks.onDelivery(refsFor({ event, payload }));` eine zweite:

```ts
        hooks.onDelivery(refsFor({ event, payload }));
        hooks.onPermissionInvalidation?.(permissionInvalidationRefsFor({ event, payload }));
```

`createApp`s Signatur:

```ts
export function createApp(reader: Reader, hooks?: Hooks, auth?: Auth): Server {
```

Ein Cookie-Parser als private Hilfsfunktion, oberhalb von `createApp`:

```ts
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
```

Zwei kleine HTML-Antworten als Konstanten, oberhalb von `createApp`:

```ts
function htmlPage(title: string, body: string): string {
  return `<!doctype html><title>${title}</title><p>${body}</p>`;
}
```

Innerhalb von `createApp`, nach dem `/webhook`-Block und vor dem Medien-Block, die vier neuen Routen. Jede prüft zuerst `if (!auth) { 404 }`, genau wie der `/webhook`-Block das für `hooks` schon tut:

```ts
    if (pathname === '/auth/github/login' && method === 'GET') {
      if (!auth) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const state = randomBytes(32).toString('base64url');
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.searchParams.set('client_id', auth.clientId);
      authorize.searchParams.set('redirect_uri', `${auth.baseUrl}/auth/github/callback`);
      authorize.searchParams.set('state', state);
      res.writeHead(302, {
        location: authorize.toString(),
        'set-cookie': `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/github`,
      });
      res.end();
      return;
    }

    if (pathname === '/auth/github/callback' && method === 'GET') {
      if (!auth) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const cookieState = cookieValue(req.headers.cookie, 'oauth_state');
      // Ein zufälliger, cookie-gebundener Wert -- ein Angreifer kann ihn
      // weder lesen noch raten, also verteidigt hier kein Geheimnis gegen
      // viele Versuche, und einfache Gleichheit reicht (Plan, "Abweichungen").
      if (!code || !state || !cookieState || state !== cookieState) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage('Anmeldung fehlgeschlagen', 'Der Anmeldevorgang ist ungültig oder abgelaufen. Bitte erneut versuchen.'));
        return;
      }

      const identity = await exchangeCodeForIdentity(
        auth.http, auth.clientId, auth.clientSecret, code, `${auth.baseUrl}/auth/github/callback`,
      );
      if (!identity) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage('GitHub nicht erreichbar', 'Die Anmeldung bei GitHub ist fehlgeschlagen. Bitte erneut versuchen.'));
        return;
      }

      if (!isAllowed(auth.db, identity.login, auth.adminLogins)) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end(htmlPage('Kein Zugriff', 'Dieses GitHub-Konto ist für diesen Dienst nicht zugelassen.'));
        return;
      }

      const nowIso = new Date().toISOString();
      auth.db.insert(account)
        .values({ githubUserId: identity.id, login: identity.login, avatarUrl: identity.avatarUrl, lastSeenAt: nowIso })
        .onConflictDoUpdate({
          target: account.githubUserId,
          set: { login: identity.login, avatarUrl: identity.avatarUrl, lastSeenAt: nowIso },
        })
        .run();

      const session = createSessionCookie(auth.signingKey, identity.id);
      res.writeHead(302, {
        location: '/me',
        'set-cookie': [
          'oauth_state=; Max-Age=0; Path=/auth/github',
          `session=${session}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`,
        ],
      });
      res.end();
      return;
    }

    if (pathname === '/auth/logout' && method === 'POST') {
      if (!auth) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': 'session=; Max-Age=0; Path=/',
      });
      res.end(JSON.stringify({ loggedOut: true }));
      return;
    }

    if (pathname === '/me' && method === 'GET') {
      if (!auth) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const session = verifySessionCookie(auth.signingKey, cookieValue(req.headers.cookie, 'session'));
      const row = session
        ? auth.db.select().from(account).where(eq(account.githubUserId, session.accountId)).all()[0]
        : undefined;
      if (!row) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ login: row.login, isAdmin: isAdmin(row.login, auth.adminLogins) }));
      return;
    }
```

Im `import.meta.main`-Block, nach der bestehenden `queue`/`startReconcile`-Verdrahtung und vor `createApp(...)`:

```ts
  const perms = permissions(db, gh);
  const authHttp: Http = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
```

und der `createApp(...)`-Aufruf bekommt ein drittes Argument:

```ts
  createApp(indexReader(db), {
    webhookSecret: config.webhookSecret,
    onDelivery: (refs) => { for (const ref of refs) queue.enqueue(ref); },
    onPermissionInvalidation: (refs) => { for (const ref of refs) perms.invalidate(ref); },
  }, {
    db,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    signingKey: config.signingKey,
    adminLogins: config.adminLogins,
    baseUrl: config.baseUrl,
    http: authHttp,
  }).listen(port, '127.0.0.1', () => {
```

(die Zeile `console.log(...)` und die schließenden Klammern danach bleiben unverändert).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verify two of the "Fällt, wenn" lines live**

Ersetze `randomBytes(32).toString('base64url')` durch die feste Zeichenkette `'fixed-state'` — Test 2 muss fallen. Setze zurück. Vertausche die Reihenfolge, sodass die Session VOR der `isAllowed`-Prüfung gesetzt wird — Test 5 muss fallen (eine nicht zugelassene Person bekäme trotzdem ein Session-Cookie). Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: sign in with GitHub, check the allowlist, serve /me"
```

---

### Task 9: Dokumentation nachziehen

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nichts.
- Produces: keine neuen Exporte.

- [ ] **Step 1: README ergänzen**

Im Abschnitt „Betrieb" (von Plan 4) die Umgebungsvariablen-Tabelle um vier Zeilen erweitern:

```markdown
| `GITHUB_CLIENT_ID` | Client-ID der GitHub App, für die Anmeldung |
| `GITHUB_CLIENT_SECRET` | Client-Secret der GitHub App, für die Anmeldung |
| `SIGNING_KEY` | signiert das Session-Cookie |
| `ADMIN_LOGINS` | GitHub-Logins mit Adminrecht, kommagetrennt — mindestens einer ist Pflicht |
```

Einen neuen Unterabschnitt „Anmeldung" ergänzen:

```markdown
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
```

- [ ] **Step 2: Die README-Zeilen gegen den tatsächlichen Code zurücklesen**

Prüfe Zeile für Zeile: heißen die Routen wirklich so, antwortet `/me` wirklich mit genau diesen zwei Feldern, ist die Session-Laufzeit wirklich 30 Tage in `lib/session.ts`? Eine Dokumentationszeile, die nicht stimmt, ist schlechter als keine.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe how signing in and the allowlist work"
```

---

## Nach dem letzten Task: Prüfung von Hand

Diese Prüfung braucht echte Zugangsdaten und einen echten Browser und gehört dem Menschen. **Nicht von einem Agenten ausführen.**

Vor dem ersten Start müssen bei der GitHub App unter „General" eine Callback-URL `$BASE_URL/auth/github/callback` eingetragen sein (der Setup-Assistent aus Plan 3 hat das schon getan) und `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` von derselben Seite in `.env` stehen, dazu ein selbst gewähltes `SIGNING_KEY` (ein langer Zufallswert reicht, `openssl rand -hex 32`) und `ADMIN_LOGINS` mit dem eigenen GitHub-Login.

```bash
cd /Users/christian/www/release-log && npm start
```

1. Im Browser `http://127.0.0.1:8787/auth/github/login` öffnen (nicht `curl` — der Ablauf braucht GitHubs eigene Anmeldeseite und Cookies). Landet man nach der GitHub-Bestätigung auf `/me` mit `{"login":"<eigener-login>","isAdmin":true}`?
2. `document.cookie` im Browser zeigt **kein** `session`-Cookie (es ist `HttpOnly` und darf für JavaScript unsichtbar sein) — das ist der Erfolg, nicht ein Fehler.
3. Denselben Link mit einem GitHub-Konto öffnen, das weder in `ADMIN_LOGINS` noch in der `allowlist`-Tabelle steht: die Seite muss „Kein Zugriff" zeigen, und `sqlite3 release-log.sqlite 'select * from account'` darf dafür keine neue Zeile zeigen.
4. In einem Repo mit installierter App einen Mitarbeiter hinzufügen oder entfernen (ein `member`-Ereignis auslösen) und in den Logs des Diensts beobachten, dass nichts synchronisiert wird — nur ein Abgleich-Zeitstempel im Rechte-Cache sollte sich (beim nächsten `canWrite`-Aufruf, den heute noch nichts auslöst) ändern. Da nichts diesen Pfad aufruft, ist der einzige direkte Beleg an dieser Stelle: die Zustellung im „Advanced"-Tab der App zeigt 202, und `sqlite3 release-log.sqlite 'select * from repo_permission'` bleibt für dieses Log leer, solange niemand `canWrite` aufgerufen hat.
5. Ein zweites Mal `/auth/github/login` in einer neuen Sitzung (privates Fenster) öffnen: das Session-Cookie eines Fensters darf im anderen nicht erscheinen.
6. `curl -i -X POST http://127.0.0.1:8787/auth/logout` prüft das Löschen des Cookies unabhängig vom Browser.

Punkt 1 und 3 sind die einzigen, die kein Test abdecken kann: ob der User-to-Server-Flow wirklich `GET /user` mit dem zurückgegebenen Token akzeptiert, und ob `GET /repos/{owner}/{repo}/collaborators/{login}/permission` mit einem Installations-Token wirklich antwortet, ist eine Annahme dieses Plans, nicht durch den Spike aus Plan 3 abgedeckt — der prüfte App-JWT und Installations-Token, nicht diesen Flow. Weicht das Verhalten ab, ist das ein echter Fund und gehört gemeldet, nicht stillschweigend umgangen.

---

## Selbstprüfung

**Spec-Abdeckung.** §5 „Zulassung": Task 3 (`isAllowed`), Task 8 (Verdrahtung in `/auth/github/callback`). §5 „Wer erreicht welchen Log": Task 4 (`collaboratorPermission`) und Task 5 (`canWrite`, Cache, Invalidierung). §5 „Rolle 1": Task 7 (Code-Tausch), Task 8 (Routen, Session-Cookie mit den genannten Flags und der 30-Tage-Laufzeit). §5 „Sofort invalidiert ... bei `installation_repositories` und `member`": Task 6. §12 Betriebstabelle: `SIGNING_KEY`, `ADMIN_LOGINS` — Task 1, Task 9. §5 „Rolle 2" und alles unter „Festlegungen" (PKCE, Authorization Codes, Dynamic Client Registration, `/mcp`, Token-Hashing, Ratenbegrenzung): bewusst nicht Teil dieses Plans, siehe „Abweichungen" Punkt 1.

**Nicht abgedeckt und bewusst offen:** das dauerhafte, verschlüsselte GitHub-Nutzer-Token aus Entscheidung 23 (`create_log`, `TOKEN_ENCRYPTION_KEY`, `github_user_token`-Tabelle) — gehört zu einem Plan, der `create_log` selbst baut. Eine Admin-Oberfläche für die Zulassungsliste — Spec §8, Plan 6 (Dashboard). Das Verdrahten von `viewer` in `lib/public.ts`/`route()` gegen echte Sessions, damit private Logs für Mitglieder sichtbar werden — auch Plan 6, da es Rendering-Entscheidungen berührt, die dieser Plan nicht anfasst.

**Typkonsistenz.** `RepoRef` (aus `lib/github.ts`, unverändert) durchläuft `permissionInvalidationRefsFor` (Task 6), `Permissions.invalidate` (Task 5) und `server.ts`s Webhook-Verdrahtung (Task 8) mit demselben Namen und derselben Form. `GithubIdentity` (Task 7) wird nur in Task 8 verbraucht, mit exakt den drei Feldern, die dort gelesen werden. `AppConfig` (Task 1) liefert `clientId`/`clientSecret`/`signingKey`/`adminLogins` — genau die vier Namen, die `server.ts`s `import.meta.main`-Verdrahtung in Task 8 von `config.*` liest.

**Testzahl.** Aktuell 261. Nach diesem Plan werden es ungefähr 315–320 sein.
