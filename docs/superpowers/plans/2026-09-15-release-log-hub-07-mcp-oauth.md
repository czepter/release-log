# Release-Log-Hub — MCP-Fläche und OAuth-Autorisierungsserver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein MCP-Server unter `/mcp`, geschützt durch einen selbstgebauten OAuth-2.0-Autorisierungsserver (spec §5, "Rolle 2"), der Agenten `list_logs`, `get_log`, `get_release`, `write_release`, `publish_release` und `unpublish_release` gibt (spec §6) — plus die dafür nötige "Gehostete Seite" (spec §7), weil `write_release` einen echten Permalink zurückgeben muss.

**Architecture:** Drei Teile, die zusammen eine Lücke schließen, die keiner für sich schließen könnte: (1) ein eigener OAuth-Autorisierungsserver (Registrierung, Zustimmung, Token-Ausgabe/-Rotation/-Widerruf — die MCP-TypeScript-SDK liefert dafür nichts, nur die Resource-Server-Seite), (2) die MCP-Werkzeuge selbst, über die offizielle SDK (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`) auf dem bestehenden `node:http`-Server verdrahtet, und (3) die serverseitig gerenderte öffentliche Seite `/l/<id>`, die bislang fehlte und ohne die `write_release` keinen echten Link liefern könnte. Alle drei teilen sich denselben Grundsatz wie jeder frühere Plan: das Repo bleibt die einzige Wahrheit — ein MCP-Schreibzugriff committet über `putFile` und stößt denselben Resync an wie ein Dashboard-Schreibzugriff, nie ein zweiter, paralleler Schreibpfad in die SQLite-Zeilen.

**Tech Stack:** Node 24 (native TS-Stripping, kein Build-Schritt), `node:http` (kein Framework), better-sqlite3 + Drizzle. Neu: `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/node@2.0.0`, `zod@^4.2.0` — die einzigen neuen Laufzeit-Abhängigkeiten in der Geschichte dieses Projekts, siehe Abweichung 1 unten.

**Spec:** `docs/superpowers/specs/2026-09-08-release-log-hub-design.md`, §5 ("Rolle 2"), §6 ("MCP-Fläche"), §7 ("Öffentliche Fläche" — nur der Unterabschnitt "Gehostete Seite" ist neu, die JSON-Routen und der Medien-Download existieren bereits).

## Global Constraints

- **PKCE mit `S256` ist Pflicht.** Ein Autorisierungsversuch ohne Code-Challenge (oder mit `plain`) wird abgelehnt (spec §5).
- **Authorization Codes** sind einmalig, 60 Sekunden gültig, an Client, Redirect-URI und Code-Challenge gebunden. Eine zweite Einlösung widerruft alle aus diesem Code entstandenen Token (spec §5).
- **Redirect-URIs werden exakt geprüft**, außer Loopback-Adressen (`127.0.0.1`, `::1`, `localhost`), bei denen nur der Port variieren darf (RFC 8252, spec §5).
- **Der Zustimmungsbildschirm wird nie übersprungen**, auch bei erneuter Verbindung desselben Nutzers (spec §5).
- **Unsere Token sind keine GitHub-Token** und umgekehrt (spec §5).
- **Unsere Token liegen nur als SHA-256-Hash in der Datenbank** — kein Klartext, keine Verschlüsselung, weil sie nur geprüft und nie benutzt werden (spec §5).
- **Laufzeiten:** Access-Token 1 Stunde, Refresh-Token 30 Tage mit Rotation. Ein zweimal benutztes Refresh-Token widerruft die ganze Kette (spec §5).
- **Zwei Scopes:** `logs:read` und `logs:write`, kein Default — ein Autorisierungsversuch ohne (oder mit unbekanntem) `scope` wird abgelehnt (spec §5).
- **Widerruf im Dashboard je Client**, wirksam beim nächsten Aufruf (spec §5).
- **Ratenbegrenzung:** `/oauth/register` 10 Anfragen je IP und Stunde, `/oauth/token` 60 je IP und Minute (spec §5).
- **`write_release` validiert über dieselbe Funktion wie der Index** (`lib/document.ts`, `parseRelease`) — kein zweiter Validator (spec §6).
- **`write_release` verlangt `base_blob_sha`, sobald die Version existiert** — blindes Überschreiben wird abgelehnt (spec §6).
- **`view`, `visibility` und `curation_notes` ändert nur das Dashboard**, nie die MCP-Fläche (spec §6, bereits durch fehlende Tools erzwungen).
- **Kein neuer paralleler Schreibpfad in die SQLite-Zeilen.** Jeder erfolgreiche MCP-Commit stößt `onRepoWrite`/`queue.enqueue` an, genau wie Dashboard-Schreibzugriffe (Plan 6) — die Zeilen selbst kommen weiterhin nur aus dem Resync.
- **Secrets kommen aus der Umgebung**, nie aus dem Repo (spec §5).

## Abweichungen von der Spec, bewusst getroffen

1. **Zwei neue Laufzeit-Abhängigkeiten.** Jeder frühere Plan kam mit better-sqlite3 und Drizzle aus. Streamable HTTP mit korrekter Session-/Envelope-Behandlung von Hand nachzubauen wäre eine eigene, fehleranfällige Teilimplementierung eines Protokolls, für das es die offizielle SDK gibt (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, beide `2.0.0` — die aktuelle, aufgeteilte v2-Linie, nicht das eingefrorene `@modelcontextprotocol/sdk@1.x`). `zod@^4.2.0` kommt mit, weil die SDK-Werkzeuganmeldung (`registerTool`) ein "Standard Schema" verlangt und Zod das einzige ist, das dieses Projekt sinnvoll ohne Umweg einbindet.
2. **Kein Client-Secret.** MCP-Clients sind hier ausschließlich öffentliche Clients (`token_endpoint_auth_method: none`) — PKCE ist die einzige Client-Authentisierung. Die Spec erwähnt an keiner Stelle ein Client-Secret für Rolle 2; ein öffentlicher Client, der eines speichern müsste, hätte keinen sicheren Ort dafür.
3. **Kein `resource`-Parameter (RFC 8707).** Diese App ist der einzige Autorisierungsserver für ihren einzigen `/mcp`-Endpunkt — es gibt nichts zu disambiguieren. Token tragen ihre Bindung implizit (sie werden ausschließlich gegen diesen einen Dienst geprüft).
4. **Zustimmungsbildschirm zeigt Scopes und betroffene Logs nur an, lässt sie nicht einzeln abwählen.** Die Spec nennt "Zustimmungsbildschirm, der Client, Scopes und betroffene Logs benennt" — nicht, dass einzelne Scopes abwählbar wären. Alles-oder-nichts hält die Autorisierungslogik auf der Größe, die die Spec beschreibt.
5. **Ratenbegrenzung ist ein In-Memory-Zähler mit festem Zeitfenster**, keine gleitende Fensterberechnung und kein Redis — dieser Dienst läuft als ein Prozess (wie `syncQueue` schon), ein Neustart setzt die Zähler zurück, was für eine Ratenbegrenzung gegen Missbrauch, nicht gegen einen verteilten Angriff, ausreicht.
6. **`create_log` und `add_media` bleiben außerhalb dieses Plans.** `create_log` braucht Entscheidung 23s persistentes, verschlüsseltes GitHub-Nutzer-Token (`POST /user/repos`) — eine eigene, unabhängige Baustelle mit eigenem Verschlüsselungsschlüssel, Refresh-Serialisierung je Konto und `reauth_required`-Fehlerpfad. `add_media` braucht eine eigene signierte-Upload-URL-Infrastruktur (eigener Tokentyp, `PUT`-Endpunkt, 10-Minuten-Gültigkeit). Beides ist unabhängig groß genug für einen eigenen Plan, genau wie Plan 6 sie schon einmal zurückstellte.
7. **Der öffentliche JSON-Feed und der Medien-Download existieren bereits** (`lib/public.ts`, ein früherer Plan) — dieser Plan ergänzt nur die serverseitig gerenderte HTML-Seite (`GET /l/<id>`, `GET /l/<id>/r/<version>`), die bislang fehlte, plus eine seit ihrer Einführung offene, selbst dokumentierte Lücke: `server.ts` setzt `viewer` bislang hart auf `'public'` mit dem Kommentar "Viewer is 'public' until sessions exist" — Sessions existieren seit Plan 5, `canWrite` seit Plan 5/6. Dieser Plan schließt das jetzt, für JSON-, Medien- und die neue HTML-Route gemeinsam.
8. **Der Login-Rückweg (`next`-Parameter) ist auf genau ein Ziel begrenzt** (`/oauth/authorize` mit seiner ursprünglichen Query). Ein allgemeiner offener `next`-Parameter wäre ein offenes Weiterleitungsziel; diese Beschränkung auf ein hartcodiertes Präfix schließt das, ohne die bestehende Login-Route umzubauen.

---

## Dateistruktur

- **`lib/db/schema.ts`** (ändern) — drei neue Tabellen: `oauthClient`, `oauthCode`, `oauthToken`.
- **`lib/pkce.ts`** (neu) — PKCE-`S256`-Prüfung, reine Funktion.
- **`lib/rateLimit.ts`** (neu) — In-Memory-Ratenbegrenzung mit festem Zeitfenster.
- **`lib/oauth.ts`** (neu) — die gesamte Autorisierungsserver-Logik: Client-Registrierung, Code-Ausgabe/-Einlösung, Token-Ausgabe/-Rotation/-Widerruf, `verifyAccessToken`.
- **`lib/mcpTools.ts`** (neu) — die `McpServerFactory`: alle sechs Werkzeuge, Instructions, der `release-kuratieren`-Prompt.
- **`lib/renderPublic.ts`** (neu) — HTML-Rendering der gehosteten Seite (`full`/`timeline`), getrennt von `lib/render.ts`, weil die öffentliche Seite eine andere Hülle braucht (kein Dashboard-Nav, `noindex` für private Logs, keine Formulare).
- **`server.ts`** (ändern) — neue Routen für OAuth-Metadaten, Registrierung, Zustimmung, Token-Ausgabe, `/mcp`, die gehostete Seite, den Login-Rückweg, und einen neuen Dashboard-Abschnitt "Verbundene Clients".
- **`README.md`** (ändern) — Abschnitt zu MCP/OAuth.
- **`package.json`** (ändern) — drei neue Abhängigkeiten.

---

### Task 1: OAuth-Datenbankschema

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/00XX_*.sql` (per `npm run db:generate`, Dateiname wird generiert)

**Interfaces:**
- Consumes: nichts.
- Produces: `oauthClient` (Spalten: `clientId`, `clientName`, `redirectUris`, `createdAt`), `oauthCode` (Spalten: `codeHash`, `clientId`, `redirectUri`, `codeChallenge`, `familyId`, `accountId`, `scope`, `expiresAt`, `consumedAt`), `oauthToken` (Spalten: `id`, `familyId`, `clientId`, `accountId`, `scope`, `kind`, `tokenHash`, `expiresAt`, `revokedAt`, `createdAt`) — jede spätere Aufgabe importiert diese drei Tabellen aus `./lib/db/schema.ts` unverändert.

- [ ] **Step 1: Schema ergänzen**

An `lib/db/schema.ts` anhängen:

```ts
// Ein registrierter MCP-Client (RFC 7591, Dynamic Client Registration).
// Ausschließlich öffentliche Clients -- kein Secret, PKCE ist die einzige
// Client-Authentisierung (spec §5, Abweichung 2).
export const oauthClient = sqliteTable('oauth_client', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name').notNull(),
  // JSON-Array von Strings. Eine eigene Tabelle für mehrere Redirect-URIs
  // wäre für "ein paar Strings, nie einzeln abgefragt" die falsche Naht.
  redirectUris: text('redirect_uris').notNull(),
  createdAt: text('created_at').notNull(),
});

// Ein ausgegebener, noch nicht eingelöster Autorisierungscode. Einmalig,
// 60 Sekunden gültig (spec §5). Der Code selbst wird nie gespeichert, nur
// sein Hash -- wie jedes andere Token in diesem System.
export const oauthCode = sqliteTable('oauth_code', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  // Eine zweite Einlösung widerruft alle aus diesem Code entstandenen Token
  // (spec §5) -- familyId bindet Code und die daraus geprägten Token an
  // dieselbe widerrufbare Kette, von Anfang an, nicht erst beim Refresh.
  familyId: text('family_id').notNull(),
  accountId: integer('account_id').notNull(),
  scope: text('scope').notNull(),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
});

// Ein ausgegebenes Access- oder Refresh-Token. Nur der Hash liegt in der
// Datenbank (spec §5) -- was hier steht, reicht zum Prüfen, nicht zum
// Benutzen. familyId gruppiert jede Rotation eines Refresh-Tokens und sein
// zugehöriges Access-Token; ein Widerruf trifft immer die ganze familyId.
export const oauthToken = sqliteTable('oauth_token', {
  id: text('id').primaryKey(),
  familyId: text('family_id').notNull(),
  clientId: text('client_id').notNull(),
  accountId: integer('account_id').notNull(),
  scope: text('scope').notNull(),
  kind: text('kind').notNull(), // 'access' | 'refresh'
  tokenHash: text('token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
}, (t) => [
  uniqueIndex('oauth_token_hash_unique').on(t.tokenHash),
]);
```

- [ ] **Step 2: Migration erzeugen**

Run: `npm run db:generate`
Expected: eine neue Datei unter `drizzle/`, die drei `CREATE TABLE`-Anweisungen enthält.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (keine Tests nötig -- reines Schema, ohne Verhalten, wird von Task 2s Tests indirekt geprüft).

- [ ] **Step 4: Commit**

```bash
git add lib/db/schema.ts drizzle/
git commit -m "feat: add oauth_client, oauth_code and oauth_token tables"
```

---

### Task 2: PKCE-Prüfung

**Files:**
- Create: `lib/pkce.ts`
- Test: `lib/pkce.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `verifyPkce(codeVerifier: string, codeChallenge: string, method: string): boolean` -- wird von Task 6 (Code-Einlösung) und Task 7 (Autorisierungsanfrage-Validierung) importiert.

- [ ] **Step 1: Failing Tests schreiben**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPkce } from './pkce.ts';

test('a matching S256 verifier/challenge pair verifies', () => {
  // Computed with: createHash('sha256').update(verifier, 'ascii').digest('base64url')
  const verifier = 'test-verifier-1234567890123456789012345';
  const challenge = 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8';
  assert.equal(verifyPkce(verifier, challenge, 'S256'), true);
});

test('a wrong verifier fails', () => {
  const challenge = 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8';
  assert.equal(verifyPkce('not-the-right-verifier', challenge, 'S256'), false);
});

test('the "plain" method is never accepted, even with a matching value', () => {
  // "plain" would make the challenge equal to the verifier itself -- rejecting
  // the method outright, not comparing values, is the point (spec §5, S256 is Pflicht).
  assert.equal(verifyPkce('same-value', 'same-value', 'plain'), false);
});

test('an unknown method is rejected', () => {
  assert.equal(verifyPkce('v', 'c', 'S1'), false);
});
```

**Fällt, wenn:** Test 1 fällt, wenn die SHA-256/Base64URL-Berechnung falsch ist. Test 3 ist die eigentliche Sicherheitsaussage und fällt, sobald `plain` wie `S256` behandelt wird (z. B. ein `method !== 'S256' ? verifier === challenge : ...`-Fallback).

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL -- `lib/pkce.ts` existiert noch nicht.

- [ ] **Step 3: Implementierung**

```ts
// PKCE (RFC 7636). S256 ist die einzige unterstützte Methode -- spec §5
// macht das zur Pflicht, nicht zur Kür: ein Aufruf mit "plain" oder
// irgendetwas anderem ist immer ungültig, unabhängig vom Wert.
import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyPkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  const computed = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const given = Buffer.from(codeChallenge, 'utf8');
  const expected = Buffer.from(computed, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Ersetze `method !== 'S256'` durch `false` (jede Methode wird akzeptiert) -- Test 3 muss fallen. Setze zurück. Ersetze `timingSafeEqual(given, expected)` durch `given.toString() !== expected.toString() ? false : true` und dann absichtlich `computed` falsch berechnen (z. B. `'sha1'` statt `'sha256'`) -- Test 1 muss fallen. Setze beides zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/pkce.ts lib/pkce.test.ts
git commit -m "feat: verify PKCE S256 code challenges"
```

---

### Task 3: Ratenbegrenzung

**Files:**
- Create: `lib/rateLimit.ts`
- Test: `lib/rateLimit.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `type RateLimiter = { check(key: string): boolean }`; `rateLimiter(limit: number, windowMs: number, nowMs?: () => number): RateLimiter` -- `check` gibt `true` zurück, wenn die Anfrage durchgelassen wird, `false`, wenn das Limit für diesen Schlüssel im aktuellen Fenster erreicht ist. Wird von Task 4 (`/oauth/register`, 10/Stunde) und Task 9/11 (`/oauth/token`, 60/Minute) importiert.

- [ ] **Step 1: Failing Tests schreiben**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimiter } from './rateLimit.ts';

test('allows up to the limit, then refuses', () => {
  const rl = rateLimiter(3, 60_000);
  assert.equal(rl.check('1.2.3.4'), true);
  assert.equal(rl.check('1.2.3.4'), true);
  assert.equal(rl.check('1.2.3.4'), true);
  assert.equal(rl.check('1.2.3.4'), false, 'the fourth call in the window must be refused');
});

test('keys are independent', () => {
  const rl = rateLimiter(1, 60_000);
  assert.equal(rl.check('a'), true);
  assert.equal(rl.check('b'), true, 'a different key must not share the first key\'s budget');
});

test('a new window resets the count', () => {
  let now = 0;
  const rl = rateLimiter(1, 1000, () => now);
  assert.equal(rl.check('k'), true);
  assert.equal(rl.check('k'), false);
  now = 1001;
  assert.equal(rl.check('k'), true, 'a call after the window boundary must be let through again');
});
```

**Fällt, wenn:** Test 1 fällt, wenn das Limit nicht durchgesetzt wird. Test 3 fällt, wenn das Zeitfenster nicht wirklich zurückgesetzt wird (z. B. ein Zähler, der nie verfällt).

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

```ts
// Ein Zähler je Schlüssel mit festem Zeitfenster -- kein Leaky-Bucket, keine
// gleitende Berechnung. Dieser Dienst läuft als ein Prozess; ein Neustart
// setzt jeden Zähler zurück, was für eine Ratenbegrenzung gegen Missbrauch
// reicht (spec §5, Abweichung 5).
export type RateLimiter = { check(key: string): boolean };

export function rateLimiter(limit: number, windowMs: number, nowMs: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { windowStart: number; count: number }>();
  return {
    check(key) {
      const now = nowMs();
      const entry = windows.get(key);
      if (!entry || now - entry.windowStart >= windowMs) {
        windows.set(key, { windowStart: now, count: 1 });
        return true;
      }
      if (entry.count >= limit) return false;
      entry.count += 1;
      return true;
    },
  };
}
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Ersetze `entry.count >= limit` durch `false` -- Test 1 muss fallen. Setze zurück. Ersetze `now - entry.windowStart >= windowMs` durch `false` (Fenster verfällt nie) -- Test 3 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/rateLimit.ts lib/rateLimit.test.ts
git commit -m "feat: add a fixed-window in-memory rate limiter"
```

---

### Task 4: Client-Registrierung (DCR) — `POST /oauth/register`

**Files:**
- Create: `lib/oauth.ts`
- Test: `lib/oauth.test.ts`
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `Db` aus `./lib/db/client.ts`; `oauthClient` aus `./lib/db/schema.ts`.
- Produces: `registerClient(db: Db, input: unknown, nowIso?: () => string): { ok: true; value: { clientId: string; clientName: string; redirectUris: string[] } } | { ok: false; errors: string[] }` — wird von Task 7 (Autorisierungsanfrage, Client-Lookup) importiert. `lib/oauth.ts` ist ab hier die einzige Datei mit der gesamten Autorisierungsserver-Logik; jede folgende Aufgabe ergänzt sie, nie eine zweite Datei daneben.

Dieser Task legt außerdem die Konventionen fest, die jede spätere `lib/oauth.ts`-Aufgabe wiederverwendet: `randomToken(bytes)` für jeden geheimen Wert, `sha256Hex(value)` für jeden Hash.

- [ ] **Step 1: Failing Tests schreiben**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { oauthClient } from './db/schema.ts';
import { eq } from 'drizzle-orm';
import { registerClient } from './oauth.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-oauth-'));
  try {
    fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registers a client with a valid https redirect_uri', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['https://client.example/cb'], client_name: 'Test Client' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.clientName, 'Test Client');
    assert.deepEqual(result.value.redirectUris, ['https://client.example/cb']);
    const row = db.select().from(oauthClient).where(eq(oauthClient.clientId, result.value.clientId)).all()[0];
    assert.ok(row, 'the client must actually be persisted');
    assert.deepEqual(JSON.parse(row.redirectUris), ['https://client.example/cb']);
  });
});

test('a loopback http redirect_uri is accepted (RFC 8252 native clients)', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['http://127.0.0.1:51234/cb'] });
    assert.equal(result.ok, true);
  });
});

test('a plain http redirect_uri on a non-loopback host is rejected', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['http://client.example/cb'] });
    assert.equal(result.ok, false);
  });
});

test('an empty redirect_uris list is rejected, and nothing is persisted', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: [] });
    assert.equal(result.ok, false);
    assert.equal(db.select().from(oauthClient).all().length, 0);
  });
});

test('a missing client_name defaults to a placeholder, never crashes', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.clientName, 'Unnamed MCP client');
  });
});

test('two registrations produce two distinct client ids', () => {
  withDb((db) => {
    const a = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    const b = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.value.clientId, b.value.clientId);
  });
});
```

**Fällt, wenn:** Test 3 ist die eigentliche Sicherheitsaussage (kein Klartext-`http` außer Loopback) und fällt, sobald die Schema-Prüfung `http:` generell zulässt. Test 4 fällt, wenn eine leere Liste nicht abgelehnt wird.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL — `lib/oauth.ts` existiert noch nicht.

- [ ] **Step 3: Implementierung**

```ts
// Der gesamte Autorisierungsserver (spec §5, "Rolle 2"): Registrierung,
// Zustimmung, Token-Ausgabe/-Rotation/-Widerruf. Die MCP-SDK deckt nur die
// Resource-Server-Seite ab (Bearer-Prüfung) -- alles hier ist von Hand,
// weil es das sein muss (Abweichung 1).
import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { oauthClient } from './db/schema.ts';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

// http ist nur für Loopback erlaubt (native Clients, RFC 8252) -- jeder
// andere Host braucht https. Eine nicht parsbare URL ist ungültig, kein Crash.
function isAcceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return true;
  return false;
}

export type RegisterClientInput = { redirect_uris?: unknown; client_name?: unknown };

export type RegisterClientResult =
  | { ok: true; value: { clientId: string; clientName: string; redirectUris: string[] } }
  | { ok: false; errors: string[] };

export function registerClient(db: Db, input: unknown, nowIso: () => string = () => new Date().toISOString()): RegisterClientResult {
  if (typeof input !== 'object' || input === null) return { ok: false, errors: ['request body must be a JSON object'] };
  const { redirect_uris, client_name } = input as RegisterClientInput;

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return { ok: false, errors: ['redirect_uris: required, non-empty array'] };
  }
  if (!redirect_uris.every(isAcceptableRedirectUri)) {
    return { ok: false, errors: ['redirect_uris: each entry must be an https URL, or an http URL on a loopback host'] };
  }
  if (client_name !== undefined && typeof client_name !== 'string') {
    return { ok: false, errors: ['client_name: must be a string'] };
  }

  const clientId = `mcp_${randomToken(16)}`;
  const clientName = client_name === undefined || client_name === '' ? 'Unnamed MCP client' : client_name;
  const redirectUris = redirect_uris as string[];

  db.insert(oauthClient).values({
    clientId, clientName, redirectUris: JSON.stringify(redirectUris), createdAt: nowIso(),
  }).run();

  return { ok: true, value: { clientId, clientName, redirectUris } };
}

export function findClient(db: Db, clientId: string): { clientId: string; clientName: string; redirectUris: string[] } | null {
  const row = db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId)).all()[0];
  if (!row) return null;
  return { clientId: row.clientId, clientName: row.clientName, redirectUris: JSON.parse(row.redirectUris) };
}
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Route verdrahten**

`server.ts` importiert `registerClient` und `rateLimiter`. Am Anfang von `createApp` (dort, wo `syncQueue` & Co. keine Rolle spielen — die Ratenbegrenzung lebt so lange wie der Prozess, nicht so lange wie eine einzelne Anfrage) eine Instanz anlegen:

```ts
const oauthRegisterLimiter = rateLimiter(10, 60 * 60 * 1000); // 10 je Stunde
```

Route, nach dem bestehenden `/admin/allowlist/:login/delete`-Block:

```ts
      if (pathname === '/oauth/register' && method === 'POST') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!oauthRegisterLimiter.check(ip)) {
          res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'rate_limited' }));
          return;
        }
        let body: unknown;
        try {
          const raw = await readRawBody(req, 64 * 1024);
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'invalid_request', error_description: 'body must be valid JSON' }));
          return;
        }
        const result = registerClient(auth.db, body);
        if (!result.ok) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'invalid_client_metadata', error_description: result.errors.join('; ') }));
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          client_id: result.value.clientId,
          client_name: result.value.clientName,
          redirect_uris: result.value.redirectUris,
          token_endpoint_auth_method: 'none',
        }));
        return;
      }
```

`readRawBody(req, maxBytes)` ist neu — ein kleiner, allgemeiner Helfer, den `/oauth/register` und `/oauth/token` (Task 9) teilen, nach demselben Grenzwert-Muster wie `/webhook` (Task 4 aus Plan 4) und der Medien-Upload (Plan 6, Task 6): inkrementell lesen, bei Überschreitung sofort abbrechen, nicht erst am Ende prüfen. Vor der ersten Route, die ihn braucht, einfügen:

```ts
// Inkrementelles Lesen mit Obergrenze -- dasselbe Muster wie /webhook und
// der Medien-Upload: die Größe wird beim Lesen geprüft, nicht erst danach,
// damit ein zu großer Body nie vollständig im Speicher landet.
function readRawBody(req: import('node:http').IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
```

- [ ] **Step 6: Route-Tests**

An `server.test.ts` anhängen (mit `withAuth`/`withServer` aus den bestehenden Test-Helfern):

```ts
test('POST /oauth/register with a valid redirect_uri returns 201 and a client_id', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.example/cb'], client_name: 'Test' }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.ok(typeof body.client_id === 'string' && body.client_id.length > 0);
      assert.equal(body.token_endpoint_auth_method, 'none');
    }, undefined, auth);
  });
});

test('POST /oauth/register without redirect_uris returns 400', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    }, undefined, auth);
  });
});

test('POST /oauth/register is rate-limited after 10 requests from the same IP', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${base}/oauth/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: ['https://client.example/cb'] }),
        });
        assert.equal(res.status, 201, `request ${i + 1} of 10 must succeed`);
      }
      const eleventh = await fetch(`${base}/oauth/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.example/cb'] }),
      });
      assert.equal(eleventh.status, 429);
    }, undefined, auth);
  });
});
```

**Fällt, wenn:** Test "rate-limited" fällt, sobald `oauthRegisterLimiter.check` nicht aufgerufen oder das Limit ignoriert wird — wichtig: dieser Test braucht eine frische `rateLimiter`-Instanz je `withServer`-Aufruf (jede `createApp`-Instanz legt ihre eigene an), sonst würden frühere Tests in dieser Datei das Kontingent schon verbraucht haben.

- [ ] **Step 7: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne die `isAcceptableRedirectUri`-Prüfung (jede Zeichenkette wird akzeptiert) — der http-non-loopback-Test aus Schritt 1 muss fallen. Setze zurück. Entferne `oauthRegisterLimiter.check(ip)` aus der Route — der Ratenbegrenzungs-Test aus Schritt 6 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 9: Commit**

```bash
git add lib/oauth.ts lib/oauth.test.ts server.ts server.test.ts
git commit -m "feat: register MCP clients via RFC 7591 dynamic client registration"
```

---

### Task 5: Login-Rückweg zu `/oauth/authorize`

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: nichts Neues.
- Produces: nichts, das später importiert wird — reine Verhaltensänderung an einer bestehenden Route, die Task 7 (`GET /oauth/authorize`) braucht, um einen nicht angemeldeten Nutzer nach dem GitHub-Login wieder zurückzuschicken.

Ohne diesen Task landet jeder, der sich mitten in `/oauth/authorize` neu anmelden muss, danach auf `/me` — die Zustimmungsanfrage wäre verloren. Ein allgemeiner `next`-Parameter wäre ein offenes Weiterleitungsziel; dieser Task erlaubt genau ein Ziel: `/oauth/authorize` mit seiner ursprünglichen Query (Abweichung 8).

- [ ] **Step 1: Failing Tests schreiben**

An `server.test.ts` anhängen:

```ts
test('GET /auth/github/login with next=/oauth/authorize?... stores it in a cookie', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/login?next=${encodeURIComponent('/oauth/authorize?client_id=abc')}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
      const loginNext = setCookies.find((c) => c.startsWith('login_next='));
      assert.ok(loginNext, 'login_next cookie must be set');
      assert.ok(loginNext!.includes(encodeURIComponent('/oauth/authorize?client_id=abc')));
    }, undefined, auth);
  });
});

test('GET /auth/github/login with a next that is not /oauth/authorize is ignored, no cookie set', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/auth/github/login?next=${encodeURIComponent('https://evil.example/steal')}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
      assert.equal(setCookies.some((c) => c.startsWith('login_next=')), false, 'an out-of-scope next must never reach a cookie');
    }, undefined, auth);
  });
});

test('a successful callback redirects to the stored login_next instead of /me, and clears the cookie', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const loginRes = await fetch(`${base}/auth/github/login?next=${encodeURIComponent('/oauth/authorize?client_id=abc')}`, { redirect: 'manual' });
      const setCookies = loginRes.headers.getSetCookie?.() ?? [];
      const stateCookie = setCookies.find((c) => c.startsWith('oauth_state='))!.split(';')[0];
      const nextCookie = setCookies.find((c) => c.startsWith('login_next='))!.split(';')[0];
      const state = stateCookie.split('=')[1];

      const cbRes = await fetch(`${base}/auth/github/callback?code=abc&state=${state}`, {
        redirect: 'manual', headers: { cookie: `${stateCookie}; ${nextCookie}` },
      });
      assert.equal(cbRes.status, 302);
      assert.equal(cbRes.headers.get('location'), '/oauth/authorize?client_id=abc');
      const cbSetCookies = cbRes.headers.getSetCookie?.() ?? [];
      assert.ok(cbSetCookies.some((c) => c.startsWith('login_next=;') || c.startsWith('login_next=; ')), 'login_next must be cleared after use');
    }, undefined, auth);
  });
});

test('a callback with no login_next cookie still redirects to /me (unchanged default)', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const loginRes = await fetch(`${base}/auth/github/login`, { redirect: 'manual' });
      const setCookies = loginRes.headers.getSetCookie?.() ?? [];
      const stateCookie = setCookies.find((c) => c.startsWith('oauth_state='))!.split(';')[0];
      const state = stateCookie.split('=')[1];
      const cbRes = await fetch(`${base}/auth/github/callback?code=abc&state=${state}`, {
        redirect: 'manual', headers: { cookie: stateCookie },
      });
      assert.equal(cbRes.headers.get('location'), '/me');
    }, undefined, auth);
  });
});
```

**Fällt, wenn:** Test 2 ist die eigentliche Sicherheitsaussage (kein offenes Weiterleitungsziel) und fällt, sobald die Präfixprüfung entfällt. Test 3 fällt, wenn die Callback-Route weiterhin hart auf `/me` verweist.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

In der `/auth/github/login`-Route (server.ts, siehe oben `authorize.searchParams.set('state', state);`), davor:

```ts
        const nextParam = url.searchParams.get('next');
        // Genau ein Ziel ist erlaubt: /oauth/authorize mit seiner eigenen
        // Query. Kein allgemeiner Rückweg -- der wäre ein offenes
        // Weiterleitungsziel (Abweichung 8).
        const loginNextCookie = nextParam !== null && nextParam.startsWith('/oauth/authorize?')
          ? `login_next=${encodeURIComponent(nextParam)}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/github`
          : null;
```

Der `set-cookie`-Header der Antwort wird zu einem Array, das den bestehenden `oauth_state`-Eintrag und (falls vorhanden) `loginNextCookie` trägt:

```ts
        res.writeHead(302, {
          location: authorize.toString(),
          'set-cookie': loginNextCookie
            ? [`oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/github`, loginNextCookie]
            : `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/github`,
        });
```

In der `/auth/github/callback`-Route: die erfolgreiche Umleitung (`location: '/me'`, siehe oben `createSessionCookie`) liest denselben Cookie und validiert ihn ein zweites Mal — ein Cookie ist Client-Zustand, nie blind vertraut, selbst wenn diese Route ihn selbst gesetzt hat:

```ts
        const rawNext = cookieValue(req.headers.cookie, 'login_next');
        let redirectLocation = '/me';
        if (rawNext !== undefined) {
          const decoded = decodeURIComponent(rawNext);
          if (decoded.startsWith('/oauth/authorize?')) redirectLocation = decoded;
        }

        const session = createSessionCookie(auth.signingKey, identity.id);
        res.writeHead(302, {
          location: redirectLocation,
          'set-cookie': [
            'oauth_state=; Max-Age=0; Path=/auth/github',
            'login_next=; Max-Age=0; Path=/auth/github',
            `session=${session}; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/`,
          ],
        });
```

(Ersetzt die bisherige `res.writeHead(302, { location: '/me', 'set-cookie': [...] })`-Anweisung — `location: '/me'` wird zu `location: redirectLocation`, und die `set-cookie`-Liste bekommt die neue `login_next=; Max-Age=0`-Zeile.)

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne `nextParam.startsWith('/oauth/authorize?')` (jeder `next`-Wert wird akzeptiert) — Test 2 muss fallen. Setze zurück. Ersetze `redirectLocation` im Callback durch die Konstante `'/me'` — Test 3 muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: let login return to a pending /oauth/authorize request"
```

---

### Task 6: Autorisierungscode — Ausgabe, Einlösung, Wiederverwendungsschutz

**Files:**
- Modify: `lib/oauth.ts`
- Test: `lib/oauth.test.ts`

**Interfaces:**
- Consumes: `verifyPkce` aus `./pkce.ts` (Task 2); `oauthCode`, `oauthToken` aus `./db/schema.ts`; `randomToken`, `sha256Hex` aus Task 4.
- Produces: `mintAuthorizationCode(db, input: { clientId, redirectUri, codeChallenge, accountId, scope }, nowIso?): string` (gibt den rohen Code zurück — der einzige Ort, an dem er im Klartext existiert); `redeemAuthorizationCode(db, input: { code, clientId, redirectUri, codeVerifier }, nowMs?): { ok: true; value: { accountId: number; scope: string; familyId: string } } | { ok: false; error: 'invalid_grant' }`; `revokeFamily(db, familyId: string, nowIsoValue: string): void`. Task 7 importiert `mintAuthorizationCode`, Task 9 importiert `redeemAuthorizationCode`, Task 10 importiert `revokeFamily` erneut für die Refresh-Wiederverwendung.

- [ ] **Step 1: Failing Tests schreiben**

An `lib/oauth.test.ts` anhängen (`withDb` aus Task 4 wiederverwenden):

```ts
import { mintAuthorizationCode, redeemAuthorizationCode, revokeFamily } from './oauth.ts';
import { oauthToken } from './db/schema.ts';

test('a freshly minted code redeems once, with the right client/redirect/verifier', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.accountId, 42);
    assert.equal(result.value.scope, 'logs:read');
    assert.ok(result.value.familyId.length > 0);
  });
});

test('a wrong code_verifier is rejected', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'wrong-verifier',
    });
    assert.equal(result.ok, false);
  });
});

test('a mismatched redirect_uri is rejected, even with the right code and verifier', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://attacker.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(result.ok, false);
  });
});

test('an expired code is rejected', () => {
  withDb((db) => {
    let now = 0;
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    }, () => new Date(now).toISOString());
    now = 61_000; // one second past the 60-second lifetime
    const result = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    }, () => now);
    assert.equal(result.ok, false);
  });
});

test('redeeming a code twice fails the second time and revokes every token that code produced', () => {
  withDb((db) => {
    const code = mintAuthorizationCode(db, {
      clientId: 'c1', redirectUri: 'https://client.example/cb', codeChallenge: 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8',
      accountId: 42, scope: 'logs:read',
    });
    const first = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    // Stand-in for the token a real /oauth/token exchange would have minted
    // from this same family (Task 8/9) -- this test proves the revocation
    // side effect works before token issuance exists to prove it end-to-end.
    db.insert(oauthToken).values({
      id: 'tok1', familyId: first.value.familyId, clientId: 'c1', accountId: 42, scope: 'logs:read',
      kind: 'access', tokenHash: 'irrelevant-hash', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    }).run();

    const second = redeemAuthorizationCode(db, {
      code, clientId: 'c1', redirectUri: 'https://client.example/cb', codeVerifier: 'test-verifier-1234567890123456789012345',
    });
    assert.equal(second.ok, false, 'a second redemption of the same code must fail');

    const tokenRow = db.select().from(oauthToken).where(eq(oauthToken.id, 'tok1')).all()[0];
    assert.notEqual(tokenRow.revokedAt, null, 'the token minted from this code must be revoked');
  });
});
```

**Fällt, wenn:** Test "redeeming a code twice" ist die eigentliche Sicherheitsaussage und fällt, sobald `redeemAuthorizationCode` bei `consumedAt !== null` nur ablehnt, ohne `revokeFamily` aufzurufen.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

An `lib/oauth.ts` anhängen. Zusätzliche Imports am Kopf der Datei: `eq, and, isNull` aus `drizzle-orm`, `oauthCode, oauthToken` aus `./db/schema.ts`, `verifyPkce` aus `./pkce.ts`.

```ts
export type MintCodeInput = { clientId: string; redirectUri: string; codeChallenge: string; accountId: number; scope: string };

export function mintAuthorizationCode(
  db: Db, input: MintCodeInput, nowIso: () => string = () => new Date().toISOString(),
): string {
  const code = randomToken();
  const familyId = randomToken(16);
  const expiresAt = new Date(Date.parse(nowIso()) + 60_000).toISOString();
  db.insert(oauthCode).values({
    codeHash: sha256Hex(code), clientId: input.clientId, redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge, familyId, accountId: input.accountId, scope: input.scope,
    expiresAt, consumedAt: null,
  }).run();
  return code;
}

export type RedeemCodeInput = { code: string; clientId: string; redirectUri: string; codeVerifier: string };
export type RedeemCodeResult =
  | { ok: true; value: { accountId: number; scope: string; familyId: string } }
  | { ok: false; error: 'invalid_grant' };

export function redeemAuthorizationCode(
  db: Db, input: RedeemCodeInput, nowMs: () => number = Date.now,
): RedeemCodeResult {
  const now = nowMs();
  const row = db.select().from(oauthCode).where(eq(oauthCode.codeHash, sha256Hex(input.code))).all()[0];
  if (!row) return { ok: false, error: 'invalid_grant' };

  if (row.consumedAt !== null) {
    // Zweite Einlösung: die ganze Kette widerrufen, die aus diesem Code
    // entstand (spec §5) -- ein Code, der schon einmal eingelöst wurde,
    // gibt beim zweiten Versuch nichts Neues, UND alles, was das erste Mal
    // entstand, wird ungültig. Das ist der einzige Hinweis, den ein
    // gestohlener, mehrfach benutzter Code je gibt.
    revokeFamily(db, row.familyId, new Date(now).toISOString());
    return { ok: false, error: 'invalid_grant' };
  }
  // client_id und redirect_uri müssen exakt zu dem passen, womit der Code
  // ausgestellt wurde (spec §5) -- sonst könnte ein Code, der einem
  // Client zugeteilt wurde, bei einem anderen eingelöst werden.
  if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) {
    return { ok: false, error: 'invalid_grant' };
  }
  if (Date.parse(row.expiresAt) <= now) return { ok: false, error: 'invalid_grant' };
  if (!verifyPkce(input.codeVerifier, row.codeChallenge, 'S256')) return { ok: false, error: 'invalid_grant' };

  db.update(oauthCode).set({ consumedAt: new Date(now).toISOString() }).where(eq(oauthCode.codeHash, row.codeHash)).run();
  return { ok: true, value: { accountId: row.accountId, scope: row.scope, familyId: row.familyId } };
}

export function revokeFamily(db: Db, familyId: string, nowIsoValue: string): void {
  db.update(oauthToken).set({ revokedAt: nowIsoValue })
    .where(and(eq(oauthToken.familyId, familyId), isNull(oauthToken.revokedAt)))
    .run();
}
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne den `revokeFamily`-Aufruf im `consumedAt !== null`-Zweig (die Ablehnung bleibt, der Widerruf entfällt) — der "redeeming a code twice"-Test muss fallen (die `tokenRow.revokedAt`-Prüfung). Setze zurück. Entferne die `verifyPkce`-Prüfung — der "wrong code_verifier"-Test muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/oauth.ts lib/oauth.test.ts
git commit -m "feat: issue and redeem single-use PKCE-bound authorization codes"
```

---

### Task 7: Zustimmungsbildschirm — `GET`/`POST /oauth/authorize`

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `findClient` (Task 4), `mintAuthorizationCode` (Task 6), `currentAccount`, `escapeHtml`/`page` (bestehend).
- Produces: nichts, das später importiert wird.

Zwei erlaubte Scopes (`logs:read`, `logs:write`), kein Default — ein Autorisierungsversuch ohne oder mit unbekanntem `scope` wird abgelehnt (Global Constraints). PKCE mit `S256` ist Pflicht. Redirect-URI wird exakt gegen die registrierten Werte geprüft, außer Loopback (Port darf variieren, RFC 8252).

- [ ] **Step 1: Failing Tests schreiben**

An `server.test.ts` anhängen. Ein Helfer, der einen registrierten Client anlegt:

```ts
async function registerTestClient(base: string, redirectUri = 'https://client.example/cb'): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Test Client' }),
  });
  const body = await res.json();
  return body.client_id;
}

const AUTHORIZE_CHALLENGE = 'IciedBlOjqgN0MZIUNWjA8gH1KixyJVIDzkZidCUWF8'; // s. Task 2/6
```

```ts
test('GET /oauth/authorize without a session redirects to login with next set', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = res.headers.get('location')!;
      assert.ok(location.startsWith('/auth/github/login?next='));
      assert.ok(location.includes(encodeURIComponent('/oauth/authorize?')));
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with a session shows the consent screen naming the client and scope', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Test Client'));
      assert.ok(html.includes('logs:read'));
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with an unknown client_id is refused without redirecting anywhere', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=nonexistent&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 400, 'an unknown client must never produce a redirect -- there is nowhere trusted to send it');
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with a redirect_uri not registered for this client answers 400, not a redirect', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base, 'https://client.example/cb');
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://attacker.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 400);
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with code_challenge_method=plain redirects back with error, never issuing a code', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=abc&code_challenge_method=plain&state=xyz&scope=logs:read`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(location.searchParams.get('error'), 'invalid_request');
      assert.equal(location.searchParams.get('state'), 'xyz');
    }, undefined, auth);
  });
});

test('GET /oauth/authorize with an unknown scope redirects back with invalid_scope', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://client.example/cb')}&code_challenge=${AUTHORIZE_CHALLENGE}&code_challenge_method=S256&state=xyz&scope=logs:delete`;
      const res = await fetch(`${base}/oauth/authorize?${query}`, { headers: { cookie: `session=${cookie}` }, redirect: 'manual' });
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(location.searchParams.get('error'), 'invalid_scope');
    }, undefined, auth);
  });
});

test('POST /oauth/authorize with decision=allow redirects to redirect_uri with a code and the original state', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const res = await postForm(base, '/oauth/authorize', {
        decision: 'allow', client_id: clientId, redirect_uri: 'https://client.example/cb',
        code_challenge: AUTHORIZE_CHALLENGE, code_challenge_method: 'S256', state: 'xyz', scope: 'logs:read',
      }, cookie);
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(location.origin + location.pathname, 'https://client.example/cb');
      assert.ok(location.searchParams.get('code'));
      assert.equal(location.searchParams.get('state'), 'xyz');
    }, undefined, auth);
  });
});

test('POST /oauth/authorize with decision=deny redirects with access_denied, no code issued', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const res = await postForm(base, '/oauth/authorize', {
        decision: 'deny', client_id: clientId, redirect_uri: 'https://client.example/cb',
        code_challenge: AUTHORIZE_CHALLENGE, code_challenge_method: 'S256', state: 'xyz', scope: 'logs:read',
      }, cookie);
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(location.searchParams.get('error'), 'access_denied');
      assert.equal(location.searchParams.get('code'), null);
    }, undefined, auth);
  });
});
```

**Fällt, wenn:** Test "unknown client_id" und "redirect_uri not registered" sind die eigentliche Sicherheitsaussage (nie auf ein nicht geprüftes Ziel umleiten) und fallen, sobald diese beiden Prüfungen vor der eigentlichen Umleitungslogik entfernt werden. Test "plain" fällt, sobald `code_challenge_method !== 'S256'` nicht mehr geprüft wird.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

`server.ts` importiert zusätzlich `findClient`, `mintAuthorizationCode` aus `./lib/oauth.ts`. Ein kleiner Helfer für die Loopback-Ausnahme (dieselbe Regel wie Task 4, hier für den Redirect-URI-**Abgleich**, nicht die Registrierung):

```ts
const ALLOWED_SCOPES = ['logs:read', 'logs:write'];

function redirectUriMatches(registered: string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let presentedUrl: URL;
  try {
    presentedUrl = new URL(presented);
  } catch {
    return false;
  }
  if (presentedUrl.protocol !== 'http:') return false;
  if (!['127.0.0.1', '::1', 'localhost'].includes(presentedUrl.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return reg.protocol === 'http:' && reg.hostname === presentedUrl.hostname
        && reg.pathname === presentedUrl.pathname && reg.search === presentedUrl.search;
    } catch {
      return false;
    }
  });
}
```

Route, nach `/oauth/register`:

```ts
      if (pathname === '/oauth/authorize' && (method === 'GET' || method === 'POST')) {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const params = method === 'GET' ? url.searchParams : await readFormBody(req);
        const clientId = params.get('client_id') ?? '';
        const redirectUri = params.get('redirect_uri') ?? '';
        const client = findClient(auth.db, clientId);
        // Unbekannter Client oder nicht registrierte Redirect-URI: niemals
        // umleiten -- es gibt kein geprüftes Ziel, an das man den Fehler
        // schicken könnte (spec §5, "Redirect-URIs werden exakt geprüft").
        if (!client) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Unbekannter Client', '<p>Dieser Client ist nicht registriert.</p>'));
          return;
        }
        if (!redirectUriMatches(client.redirectUris, redirectUri)) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Ungültige Redirect-URI', '<p>Diese Redirect-URI ist für diesen Client nicht registriert.</p>'));
          return;
        }

        // Ab hier ist redirectUri geprüft -- jeder weitere Fehler darf dorthin.
        const state = params.get('state') ?? '';
        const redirectWithError = (error: string): void => {
          const target = new URL(redirectUri);
          target.searchParams.set('error', error);
          if (state) target.searchParams.set('state', state);
          res.writeHead(302, { location: target.toString() });
          res.end();
        };

        const codeChallenge = params.get('code_challenge') ?? '';
        const codeChallengeMethod = params.get('code_challenge_method') ?? '';
        if (params.get('response_type') !== 'code' || codeChallenge === '' || codeChallengeMethod !== 'S256') {
          redirectWithError('invalid_request');
          return;
        }
        const scope = params.get('scope') ?? '';
        const scopes = scope.split(' ').filter((s) => s !== '');
        if (scopes.length === 0 || !scopes.every((s) => ALLOWED_SCOPES.includes(s))) {
          redirectWithError('invalid_scope');
          return;
        }

        const who = currentAccount(req, auth);
        if (!who) {
          const next = `/oauth/authorize?${url.search.slice(1)}`;
          res.writeHead(302, { location: `/auth/github/login?next=${encodeURIComponent(next)}` });
          res.end();
          return;
        }

        if (method === 'POST') {
          const decision = params.get('decision');
          if (decision !== 'allow') {
            redirectWithError('access_denied');
            return;
          }
          const code = mintAuthorizationCode(auth.db, {
            clientId: client.clientId, redirectUri, codeChallenge, accountId: who.accountId, scope,
          });
          const target = new URL(redirectUri);
          target.searchParams.set('code', code);
          if (state) target.searchParams.set('state', state);
          res.writeHead(302, { location: target.toString() });
          res.end();
          return;
        }

        // GET, angemeldet: Zustimmungsbildschirm. Listet die Logs, auf die
        // dieses Konto gerade Schreibrechte hat -- rein informativ, die
        // eigentliche Durchsetzung bleibt live gegen GitHub (wie im
        // Dashboard, Plan 6) und hängt nie an dieser Anzeige.
        const allLogs = auth.db.select().from(log).all();
        const affected: string[] = [];
        for (const row of allLogs) {
          const ref = { owner: row.repoOwner, repo: row.repoName };
          if (await auth.perms.canWrite(who.accountId, who.login, row.publicId, ref)) {
            affected.push(`<li>${escapeHtml(row.product)} (${escapeHtml(row.repoOwner)}/${escapeHtml(row.repoName)})</li>`);
          }
        }
        const body = `
          <h1>${escapeHtml(client.clientName)} verbinden</h1>
          <p>Dieser Client möchte Zugriff mit folgenden Rechten: <strong>${escapeHtml(scope)}</strong></p>
          ${affected.length > 0
            ? `<p>Betroffene Logs:</p><ul>${affected.join('')}</ul>`
            : '<p class="muted">Aktuell keine Logs mit Schreibrecht.</p>'}
          <form method="POST" action="/oauth/authorize">
            <input type="hidden" name="client_id" value="${escapeHtml(client.clientId)}">
            <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
            <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
            <input type="hidden" name="code_challenge_method" value="S256">
            <input type="hidden" name="state" value="${escapeHtml(state)}">
            <input type="hidden" name="scope" value="${escapeHtml(scope)}">
            <button type="submit" name="decision" value="allow">Zulassen</button>
            <button type="submit" name="decision" value="deny">Ablehnen</button>
          </form>
        `;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Verbindung erlauben', body));
        return;
      }
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne die `redirectUriMatches`-Prüfung (jede Redirect-URI wird akzeptiert, solange der Client existiert) — der "redirect_uri not registered"-Test muss fallen. Setze zurück. Ersetze `codeChallengeMethod !== 'S256'` durch `false` — der "plain"-Test muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: show a consent screen and issue authorization codes"
```

---

### Task 8: Token-Ausgabe und -Prüfung

**Files:**
- Modify: `lib/oauth.ts`
- Test: `lib/oauth.test.ts`

**Interfaces:**
- Consumes: `randomToken`, `sha256Hex` (Task 4); `oauthToken` aus `./db/schema.ts`; `account` aus `./db/schema.ts`.
- Produces: `mintTokenPair(db, input: { clientId, accountId, scope, familyId }, nowIso?): { accessToken: string; refreshToken: string; expiresIn: number }`; `lookupAccessToken(db, rawToken, nowMs?): { accountId: number; login: string; clientId: string; scope: string; expiresAt: number } | null`. Task 9 importiert `mintTokenPair`, Task 12 importiert `lookupAccessToken` (dort entsteht der `OAuthTokenVerifier` für die MCP-SDK — bewusst nicht hier: `lib/oauth.ts` bleibt frei von jedem `@modelcontextprotocol/*`-Import, damit diese Aufgabe lauffähig ist, bevor Task 12 die neuen Abhängigkeiten überhaupt installiert).

Wichtig: `lookupAccessToken` gibt `expiresAt` als **Sekunden seit Epoch** zurück (nicht Millisekunden) — das ist die Einheit, die `AuthInfo.expiresAt` in der SDK erwartet (Task 12 reicht diesen Wert unverändert durch).

- [ ] **Step 1: Failing Tests schreiben**

An `lib/oauth.test.ts` anhängen:

```ts
import { mintTokenPair, lookupAccessToken } from './oauth.ts';
import { account } from './db/schema.ts';

test('a minted access token looks up to the right account, client and scope', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read logs:write', familyId: 'fam1' });
    const looked = lookupAccessToken(db, pair.accessToken);
    assert.ok(looked);
    assert.equal(looked!.accountId, 42);
    assert.equal(looked!.login, 'octocat');
    assert.equal(looked!.clientId, 'c1');
    assert.equal(looked!.scope, 'logs:read logs:write');
  });
});

test('the refresh token does not look up as an access token', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    assert.equal(lookupAccessToken(db, pair.refreshToken), null);
  });
});

test('an expired access token is rejected', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    let now = 0;
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' }, () => new Date(now).toISOString());
    now = 60 * 60 * 1000 + 1; // one millisecond past the one-hour lifetime
    assert.equal(lookupAccessToken(db, pair.accessToken, () => now), null);
  });
});

test('an unknown token is rejected', () => {
  withDb((db) => {
    assert.equal(lookupAccessToken(db, 'never-issued'), null);
  });
});
```

**Fällt, wenn:** Test "the refresh token does not look up" ist die eigentliche Sicherheitsaussage (`kind`-Trennung) und fällt, sobald `lookupAccessToken` `row.kind` nicht prüft. Test "expired" fällt, sobald die Ablaufprüfung entfällt.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

An `lib/oauth.ts` anhängen. Zusätzlicher Import am Kopf: `account` aus `./db/schema.ts`.

```ts
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 Stunde (spec §5)
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage (spec §5)

export type MintTokenPairInput = { clientId: string; accountId: number; scope: string; familyId: string };
export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };

export function mintTokenPair(
  db: Db, input: MintTokenPairInput, nowIso: () => string = () => new Date().toISOString(),
): TokenPair {
  const now = Date.parse(nowIso());
  const accessToken = randomToken();
  const refreshToken = randomToken();
  db.insert(oauthToken).values({
    id: randomToken(8), familyId: input.familyId, clientId: input.clientId, accountId: input.accountId,
    scope: input.scope, kind: 'access', tokenHash: sha256Hex(accessToken),
    expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(), revokedAt: null, createdAt: nowIso(),
  }).run();
  db.insert(oauthToken).values({
    id: randomToken(8), familyId: input.familyId, clientId: input.clientId, accountId: input.accountId,
    scope: input.scope, kind: 'refresh', tokenHash: sha256Hex(refreshToken),
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(), revokedAt: null, createdAt: nowIso(),
  }).run();
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
}

export type LookedUpToken = { accountId: number; login: string; clientId: string; scope: string; expiresAt: number };

export function lookupAccessToken(db: Db, rawToken: string, nowMs: () => number = Date.now): LookedUpToken | null {
  const row = db.select().from(oauthToken).where(eq(oauthToken.tokenHash, sha256Hex(rawToken))).all()[0];
  if (!row || row.kind !== 'access' || row.revokedAt !== null) return null;
  if (Date.parse(row.expiresAt) <= nowMs()) return null;
  const acct = db.select().from(account).where(eq(account.githubUserId, row.accountId)).all()[0];
  if (!acct) return null;
  return {
    accountId: row.accountId, login: acct.login, clientId: row.clientId, scope: row.scope,
    expiresAt: Math.floor(Date.parse(row.expiresAt) / 1000),
  };
}
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne `row.kind !== 'access'` aus der Prüfung — der "refresh token does not look up"-Test muss fallen. Setze zurück. Entferne `Date.parse(row.expiresAt) <= nowMs()` — der "expired"-Test muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/oauth.ts lib/oauth.test.ts
git commit -m "feat: mint and look up hashed access/refresh token pairs"
```

---

### Task 9: `POST /oauth/token` — `authorization_code`-Grant

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `redeemAuthorizationCode` (Task 6), `mintTokenPair` (Task 8), `rateLimiter` (Task 3), `readRawBody` (Task 4).
- Produces: nichts, das später importiert wird. Task 11 erweitert dieselbe Route um den `refresh_token`-Grant.

`/oauth/token` nimmt `application/x-www-form-urlencoded` (RFC 6749s Standardformat für diesen Endpunkt — nicht JSON wie `/oauth/register`).

- [ ] **Step 1: Failing Tests schreiben**

An `server.test.ts` anhängen:

```ts
async function postFormRaw(base: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

async function authorizeAndGetCode(base: string, cookie: string, clientId: string): Promise<{ code: string; state: string }> {
  const res = await postForm(base, '/oauth/authorize', {
    decision: 'allow', client_id: clientId, redirect_uri: 'https://client.example/cb',
    code_challenge: AUTHORIZE_CHALLENGE, code_challenge_method: 'S256', state: 'xyz', scope: 'logs:read',
  }, cookie);
  const location = new URL(res.headers.get('location')!);
  return { code: location.searchParams.get('code')!, state: location.searchParams.get('state')! };
}

const AUTHORIZE_VERIFIER = 'test-verifier-1234567890123456789012345'; // s. Task 2

test('POST /oauth/token exchanges a valid code for an access and refresh token', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);

      const res = await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: AUTHORIZE_VERIFIER,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.access_token === 'string' && body.access_token.length > 0);
      assert.ok(typeof body.refresh_token === 'string' && body.refresh_token.length > 0);
      assert.equal(body.token_type, 'Bearer');
      assert.equal(body.expires_in, 3600);
    }, undefined, auth);
  });
});

test('POST /oauth/token with a wrong code_verifier is refused', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      const res = await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: 'wrong',
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'invalid_grant');
    }, undefined, auth);
  });
});

test('POST /oauth/token with an unsupported grant_type is refused', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await postFormRaw(base, '/oauth/token', { grant_type: 'password' });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'unsupported_grant_type');
    }, undefined, auth);
  });
});

test('POST /oauth/token is rate-limited after 60 requests from the same IP within a minute', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      for (let i = 0; i < 60; i++) {
        const res = await postFormRaw(base, '/oauth/token', { grant_type: 'password' });
        assert.notEqual(res.status, 429, `request ${i + 1} of 60 must not be rate-limited yet`);
      }
      const res61 = await postFormRaw(base, '/oauth/token', { grant_type: 'password' });
      assert.equal(res61.status, 429);
    }, undefined, auth);
  });
});
```

**Fällt, wenn:** Test "wrong code_verifier" fällt, sobald die Route `redeemAuthorizationCode`s Ergebnis ignoriert und trotzdem Token ausgibt.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

`server.ts` importiert zusätzlich `redeemAuthorizationCode`, `mintTokenPair` aus `./lib/oauth.ts`. Eine zweite Ratenbegrenzer-Instanz, neben `oauthRegisterLimiter`:

```ts
const oauthTokenLimiter = rateLimiter(60, 60 * 1000); // 60 je Minute
```

Route, nach `/oauth/authorize`:

```ts
      if (pathname === '/oauth/token' && method === 'POST') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!oauthTokenLimiter.check(ip)) {
          res.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'rate_limited' }));
          return;
        }
        const raw = await readRawBody(req, 16 * 1024);
        const form = new URLSearchParams(raw.toString('utf8'));
        const grantType = form.get('grant_type');

        if (grantType === 'authorization_code') {
          const code = form.get('code') ?? '';
          const clientId = form.get('client_id') ?? '';
          const redirectUri = form.get('redirect_uri') ?? '';
          const codeVerifier = form.get('code_verifier') ?? '';
          const redeemed = redeemAuthorizationCode(auth.db, { code, clientId, redirectUri, codeVerifier });
          if (!redeemed.ok) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          const pair = mintTokenPair(auth.db, {
            clientId, accountId: redeemed.value.accountId, scope: redeemed.value.scope, familyId: redeemed.value.familyId,
          });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            access_token: pair.accessToken, refresh_token: pair.refreshToken,
            token_type: 'Bearer', expires_in: pair.expiresIn, scope: redeemed.value.scope,
          }));
          return;
        }

        // Task 11 ergänzt hier einen "refresh_token"-Zweig.

        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
        return;
      }
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Ersetze `if (!redeemed.ok)` durch `if (false)` (jedes Einlösungsergebnis gibt Token aus) — der "wrong code_verifier"-Test muss fallen. Setze zurück. Entferne `oauthTokenLimiter.check(ip)` — der Ratenbegrenzungs-Test muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "feat: exchange authorization codes for access and refresh tokens"
```

---

### Task 10: Refresh-Rotation und Wiederverwendungsschutz

**Files:**
- Modify: `lib/oauth.ts`
- Test: `lib/oauth.test.ts`

**Interfaces:**
- Consumes: `mintTokenPair`, `revokeFamily`, `sha256Hex` (Tasks 6, 8).
- Produces: `rotateRefreshToken(db, rawRefreshToken, nowMs?): { ok: true; value: TokenPair & { scope: string; accountId: number } } | { ok: false; error: 'invalid_grant' }`. Task 11 importiert diese Funktion für den `refresh_token`-Zweig von `/oauth/token`.

- [ ] **Step 1: Failing Tests schreiben**

An `lib/oauth.test.ts` anhängen:

```ts
import { rotateRefreshToken } from './oauth.ts';

test('a valid refresh token rotates to a fresh access/refresh pair', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    const first = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    const result = rotateRefreshToken(db, first.refreshToken);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.value.refreshToken, first.refreshToken, 'rotation must mint a NEW refresh token');
    assert.notEqual(result.value.accessToken, first.accessToken);
    assert.equal(result.value.scope, 'logs:read');
    assert.equal(result.value.accountId, 42);
  });
});

test('the old refresh token no longer rotates after one use', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    const first = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    rotateRefreshToken(db, first.refreshToken);
    const second = rotateRefreshToken(db, first.refreshToken);
    assert.equal(second.ok, false);
  });
});

test('reusing an already-rotated refresh token revokes the whole family, including the access token minted alongside it', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    const first = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    const rotated = rotateRefreshToken(db, first.refreshToken);
    assert.equal(rotated.ok, true);

    // Reuse the OLD refresh token -- already rotated away.
    rotateRefreshToken(db, first.refreshToken);

    if (!rotated.ok) return;
    assert.equal(lookupAccessToken(db, rotated.value.accessToken), null, 'the access token from the rotation must be revoked too, same family');
  });
});

test('an expired refresh token is rejected without rotating', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    let now = 0;
    const first = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' }, () => new Date(now).toISOString());
    now = 30 * 24 * 60 * 60 * 1000 + 1;
    const result = rotateRefreshToken(db, first.refreshToken, () => now);
    assert.equal(result.ok, false);
  });
});
```

**Fällt, wenn:** Test "reusing an already-rotated" ist die eigentliche Sicherheitsaussage (spec §5, "Ein zweimal benutztes Refresh-Token widerruft die ganze Kette") und fällt, sobald die Wiederverwendungserkennung nur ablehnt, ohne `revokeFamily` aufzurufen.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

An `lib/oauth.ts` anhängen:

```ts
export type RotateResult =
  | { ok: true; value: TokenPair & { scope: string; accountId: number } }
  | { ok: false; error: 'invalid_grant' };

export function rotateRefreshToken(db: Db, rawRefreshToken: string, nowMs: () => number = Date.now): RotateResult {
  const now = nowMs();
  const row = db.select().from(oauthToken).where(eq(oauthToken.tokenHash, sha256Hex(rawRefreshToken))).all()[0];
  if (!row || row.kind !== 'refresh') return { ok: false, error: 'invalid_grant' };

  if (row.revokedAt !== null) {
    // Ein bereits rotiertes Refresh-Token taucht wieder auf -- genau die
    // Wiederverwendung, vor der spec §5 warnt. Die ganze Kette wird
    // widerrufen, nicht nur dieser eine Versuch abgelehnt.
    revokeFamily(db, row.familyId, new Date(now).toISOString());
    return { ok: false, error: 'invalid_grant' };
  }
  if (Date.parse(row.expiresAt) <= now) return { ok: false, error: 'invalid_grant' };

  db.update(oauthToken).set({ revokedAt: new Date(now).toISOString() }).where(eq(oauthToken.id, row.id)).run();
  const pair = mintTokenPair(
    db, { clientId: row.clientId, accountId: row.accountId, scope: row.scope, familyId: row.familyId },
    () => new Date(now).toISOString(),
  );
  return { ok: true, value: { ...pair, scope: row.scope, accountId: row.accountId } };
}
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne den `revokeFamily`-Aufruf im `revokedAt !== null`-Zweig (die Ablehnung bleibt) — der "reusing an already-rotated"-Test muss fallen. Setze zurück. Entferne `db.update(oauthToken).set({ revokedAt: ... })...` (das alte Token wird nie als rotiert markiert) — der "no longer rotates after one use"-Test muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/oauth.ts lib/oauth.test.ts
git commit -m "feat: rotate refresh tokens and revoke the family on reuse"
```

---

### Task 11: `refresh_token`-Grant, Widerruf, Dashboard "Verbundene Clients"

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`
- Modify: `lib/oauth.ts`
- Test: `lib/oauth.test.ts`

**Interfaces:**
- Consumes: `rotateRefreshToken` (Task 10); `currentAccount`, `isAdmin`, `page`, `escapeHtml` (bestehend).
- Produces: `revokeAllForClient(db, accountId, clientId, nowIsoValue): void`; `listConnectedClients(db, accountId, nowMs?): Array<{ clientId: string; clientName: string; scope: string }>` — beide nur von der neuen Dashboard-Route in dieser Aufgabe verbraucht.

- [ ] **Step 1: Failing Tests schreiben**

An `lib/oauth.test.ts` anhängen:

```ts
import { revokeAllForClient, listConnectedClients } from './oauth.ts';

test('listConnectedClients lists a client with a live refresh token', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    registerClient(db, { redirect_uris: ['https://client.example/cb'], client_name: 'My Client' });
    const clients = db.select().from(oauthClient).all();
    mintTokenPair(db, { clientId: clients[0].clientId, accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    const connected = listConnectedClients(db, 42);
    assert.equal(connected.length, 1);
    assert.equal(connected[0].clientName, 'My Client');
    assert.equal(connected[0].scope, 'logs:read');
  });
});

test('listConnectedClients omits a client after revokeAllForClient', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    const clientId = db.select().from(oauthClient).all()[0].clientId;
    mintTokenPair(db, { clientId, accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    revokeAllForClient(db, 42, clientId, new Date().toISOString());
    assert.equal(listConnectedClients(db, 42).length, 0);
  });
});

test('revokeAllForClient does not touch a different account\'s tokens for the same client', () => {
  withDb((db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(account).values({ githubUserId: 99, login: 'someone-else', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    const clientId = db.select().from(oauthClient).all()[0].clientId;
    mintTokenPair(db, { clientId, accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    mintTokenPair(db, { clientId, accountId: 99, scope: 'logs:read', familyId: 'fam2' });
    revokeAllForClient(db, 42, clientId, new Date().toISOString());
    assert.equal(listConnectedClients(db, 42).length, 0);
    assert.equal(listConnectedClients(db, 99).length, 1, 'a different account\'s connection to the same client must survive');
  });
});
```

**Fällt, wenn:** Test "does not touch a different account's tokens" ist die eigentliche Sicherheitsaussage (Widerruf ist je Konto UND Client skaliert, nicht global je Client) und fällt, sobald `revokeAllForClient` `accountId` aus der `WHERE`-Klausel weglässt.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung, Teil A — `lib/oauth.ts`**

```ts
export function revokeAllForClient(db: Db, accountId: number, clientId: string, nowIsoValue: string): void {
  db.update(oauthToken).set({ revokedAt: nowIsoValue })
    .where(and(eq(oauthToken.accountId, accountId), eq(oauthToken.clientId, clientId), isNull(oauthToken.revokedAt)))
    .run();
}

export function listConnectedClients(
  db: Db, accountId: number, nowMs: () => number = Date.now,
): Array<{ clientId: string; clientName: string; scope: string }> {
  const now = nowMs();
  const rows = db.select().from(oauthToken)
    .where(and(eq(oauthToken.accountId, accountId), eq(oauthToken.kind, 'refresh'), isNull(oauthToken.revokedAt)))
    .all()
    .filter((row) => Date.parse(row.expiresAt) > now);
  const seen = new Map<string, string>();
  for (const row of rows) if (!seen.has(row.clientId)) seen.set(row.clientId, row.scope);
  return [...seen].map(([clientId, scope]) => {
    const client = findClient(db, clientId);
    return { clientId, clientName: client?.clientName ?? clientId, scope };
  });
}
```

- [ ] **Step 4: Implementierung, Teil B — `/oauth/token`s `refresh_token`-Zweig**

`server.ts` importiert zusätzlich `rotateRefreshToken` aus `./lib/oauth.ts`. Die Kommentarzeile `// Task 11 ergänzt hier einen "refresh_token"-Zweig.` aus Task 9 wird ersetzt durch:

```ts
        if (grantType === 'refresh_token') {
          const refreshToken = form.get('refresh_token') ?? '';
          const rotated = rotateRefreshToken(auth.db, refreshToken);
          if (!rotated.ok) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            access_token: rotated.value.accessToken, refresh_token: rotated.value.refreshToken,
            token_type: 'Bearer', expires_in: rotated.value.expiresIn, scope: rotated.value.scope,
          }));
          return;
        }
```

- [ ] **Step 5: Implementierung, Teil C — Dashboard "Verbundene Clients"**

`server.ts` importiert zusätzlich `listConnectedClients`, `revokeAllForClient` aus `./lib/oauth.ts`. Neue Route, nach `/admin/allowlist/:login/delete`:

```ts
      if (pathname === '/dashboard/connections' && method === 'GET') {
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
        const clients = listConnectedClients(auth.db, who.accountId);
        const rows = clients.map((c) =>
          `<tr><td>${escapeHtml(c.clientName)}</td><td class="muted">${escapeHtml(c.scope)}</td><td><form method="POST" action="/dashboard/connections/${encodeURIComponent(c.clientId)}/revoke"><button type="submit">Trennen</button></form></td></tr>`,
        ).join('');
        const body = `
          <p><a href="/dashboard">&larr; Dashboard</a></p>
          <h1>Verbundene Clients</h1>
          ${clients.length > 0
            ? `<table><thead><tr><th>Client</th><th>Rechte</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
            : '<p class="muted">Keine verbundenen Clients.</p>'}
        `;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Verbundene Clients', body));
        return;
      }

      const connectionRevokeMatch = /^\/dashboard\/connections\/([^/]+)\/revoke$/.exec(pathname);
      if (connectionRevokeMatch && method === 'POST') {
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
        let clientId: string;
        try {
          clientId = decodeURIComponent(connectionRevokeMatch[1]);
        } catch {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Ungültiger Client', '<p>Der Client-Bezeichner ist ungültig.</p>'));
          return;
        }
        revokeAllForClient(auth.db, who.accountId, clientId, new Date().toISOString());
        res.writeHead(302, { location: '/dashboard/connections' });
        res.end();
        return;
      }
```

Die Verlinkung von `/dashboard` aus (in der bestehenden `GET /dashboard`-Route, nach dem `Abmelden`-Formular): `<p><a href="/dashboard/connections">Verbundene Clients</a></p>` ergänzen.

- [ ] **Step 6: Route-Tests**

An `server.test.ts` anhängen:

```ts
test('GET /dashboard/connections lists a connected client and its scope', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      // authorizeAndGetCode only issues a code -- exchange it so a real
      // refresh token exists to be listed.
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: AUTHORIZE_VERIFIER,
      });
      const res = await fetch(`${base}/dashboard/connections`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Test Client'));
    }, undefined, auth);
  });
});

test('POST /dashboard/connections/:clientId/revoke removes the connection', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      const clientId = await registerTestClient(base);
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const cookie = createSessionCookie(SIGNING_KEY, 42);
      const { code } = await authorizeAndGetCode(base, cookie, clientId);
      await postFormRaw(base, '/oauth/token', {
        grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb',
        client_id: clientId, code_verifier: AUTHORIZE_VERIFIER,
      });
      const revokeRes = await fetch(`${base}/dashboard/connections/${clientId}/revoke`, {
        method: 'POST', headers: { cookie: `session=${cookie}` }, redirect: 'manual',
      });
      assert.equal(revokeRes.status, 302);
      const listRes = await fetch(`${base}/dashboard/connections`, { headers: { cookie: `session=${cookie}` } });
      const html = await listRes.text();
      assert.ok(!html.includes('Test Client'), 'a revoked client must no longer be listed');
    }, undefined, auth);
  });
});
```

Am Kopf von `server.test.ts` zusätzlich `oauthClient` aus `./lib/db/schema.ts` importieren, soweit noch nicht geschehen.

- [ ] **Step 7: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne `eq(oauthToken.accountId, accountId)` aus `revokeAllForClient`s `WHERE`-Klausel — der "does not touch a different account's"-Test muss fallen. Setze zurück. Ersetze in der Revoke-Route `revokeAllForClient(...)` durch nichts (die Route antwortet 302, tut aber nichts) — der "revoke removes the connection"-Route-Test muss fallen. Setze zurück, Suite grün.

- [ ] **Step 9: Commit**

```bash
git add server.ts server.test.ts lib/oauth.ts lib/oauth.test.ts
git commit -m "feat: refresh MCP tokens, and let a user revoke a connected client"
```

---

### Task 12: MCP-Abhängigkeiten, Metadaten-Routen, `/mcp`-Grundgerüst

**Files:**
- Modify: `package.json`
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `lookupAccessToken` (Task 8); `createMcpHandler`, `McpServer`, `requireBearerAuth`, `OAuthError`, `OAuthErrorCode`, `oauthMetadataResponse`, `getOAuthProtectedResourceMetadataUrl` aus `@modelcontextprotocol/server`; `toNodeHandler` aus `@modelcontextprotocol/node`.
- Produces: die verdrahtete `/mcp`-Route mit leerem `McpServer` (noch ohne Werkzeuge) — Task 13 ersetzt die Inline-Factory durch einen Import aus dem neuen `lib/mcpTools.ts`.

Diese Aufgabe beweist nur die Verdrahtung (401 ohne Token, 200 mit einem gültigen), bevor Task 13 die eigentlichen Werkzeuge ergänzt — genau wie Task 12 aus Plan 6 die Medien-Route-Verdrahtung vor den eigentlichen Regeln bewies.

- [ ] **Step 1: Abhängigkeiten ergänzen**

In `package.json`, unter `"dependencies"`:

```json
    "@modelcontextprotocol/node": "^2.0.0",
    "@modelcontextprotocol/server": "^2.0.0",
    "zod": "^4.2.0"
```

Run: `npm install`
Expected: `node_modules` bekommt die drei Pakete, `package-lock.json` (falls verwendet) aktualisiert sich.

- [ ] **Step 2: Failing Tests schreiben**

An `server.test.ts` anhängen:

```ts
test('POST /mcp without a bearer token answers 401 with a WWW-Authenticate challenge', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      assert.equal(res.status, 401);
      assert.ok(res.headers.get('www-authenticate')?.includes('Bearer'));
    }, undefined, auth);
  });
});

test('POST /mcp with an unknown bearer token answers 401', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      assert.equal(res.status, 401);
    }, undefined, auth);
  });
});

test('POST /mcp with a valid bearer token reaches the MCP handler', async () => {
  await withAuth(async (auth, db) => {
    await withServer(reader, async (base) => {
      db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
      const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${pair.accessToken}` },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'initialize', id: 1,
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
        }),
      });
      // Not 401/404: the request passed the bearer gate and reached the SDK,
      // whatever the SDK's own answer to a handshake looks like.
      assert.notEqual(res.status, 401);
      assert.notEqual(res.status, 404);
    }, undefined, auth);
  });
});

test('GET /.well-known/oauth-authorization-server serves RFC 8414 metadata naming this server\'s endpoints', async () => {
  await withAuth(async (auth) => {
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.issuer, 'https://example.test');
      assert.equal(body.token_endpoint, 'https://example.test/oauth/token');
      assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    }, undefined, auth);
  });
});
```

Am Kopf von `server.test.ts` zusätzlich `mintTokenPair` aus `./lib/oauth.ts` importieren.

**Fällt, wenn:** Test "unknown bearer token" ist die eigentliche Sicherheitsaussage und fällt, sobald die `/mcp`-Route den Bearer-Header nicht wirklich prüft (z. B. jede Anfrage mit einem `authorization`-Header durchlässt).

- [ ] **Step 3: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL — die Route existiert noch nicht.

- [ ] **Step 4: Implementierung**

`server.ts` importiert zusätzlich:

```ts
import {
  createMcpHandler, McpServer, requireBearerAuth, OAuthError, OAuthErrorCode,
  oauthMetadataResponse, getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/server';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { lookupAccessToken } from './lib/oauth.ts';
```

Innerhalb von `createApp`, neben `oauthRegisterLimiter`/`oauthTokenLimiter` — die Bearer-Prüfung, das leere MCP-Werkzeug und der Node-Adapter werden einmal je `createApp`-Aufruf angelegt, nicht je Anfrage:

```ts
  const mcpVerifier: OAuthTokenVerifier | null = !auth ? null : {
    async verifyAccessToken(token) {
      const looked = lookupAccessToken(auth.db, token);
      if (!looked) throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown, revoked or expired token');
      return { token, clientId: looked.clientId, scopes: looked.scope.split(' '), expiresAt: looked.expiresAt };
    },
  };
  const mcpAuthGate = mcpVerifier && auth
    ? requireBearerAuth({ verifier: mcpVerifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${auth.baseUrl}/mcp`)) })
    : null;
  // Task 13 ersetzt diese leere Factory durch einen Import aus lib/mcpTools.ts.
  const mcpNodeHandler = toNodeHandler(createMcpHandler(() => new McpServer({ name: 'release-log-hub', version: '1.0.0' })));
```

Zwei neue Routen, nach `/dashboard/connections/:clientId/revoke`:

```ts
      if ((pathname.startsWith('/.well-known/oauth-protected-resource') || pathname === '/.well-known/oauth-authorization-server')) {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const oauthMetadata = {
          issuer: auth.baseUrl,
          authorization_endpoint: `${auth.baseUrl}/oauth/authorize`,
          token_endpoint: `${auth.baseUrl}/oauth/token`,
          registration_endpoint: `${auth.baseUrl}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['logs:read', 'logs:write'],
        };
        const webReq = new Request(`${auth.baseUrl}${pathname}`, { method });
        const metaRes = oauthMetadataResponse(webReq, { oauthMetadata, resourceServerUrl: new URL(`${auth.baseUrl}/mcp`) });
        if (metaRes) {
          const headers: Record<string, string> = {};
          for (const [k, v] of metaRes.headers) headers[k] = v;
          res.writeHead(metaRes.status, headers);
          res.end(await metaRes.text());
          return;
        }
      }

      if (pathname === '/mcp') {
        if (!auth || !mcpAuthGate) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        // Nur der Authorization-Header geht in die Bearer-Prüfung, über eine
        // eigene, körperlose Request -- würde man stattdessen den ROH-Body
        // von req hier schon einmal lesen (z. B. über toWebRequest), fände
        // toNodeHandler weiter unten nichts mehr zu lesen: ein Node-Stream
        // lässt sich nicht zweimal konsumieren.
        const rawAuthHeader = req.headers['authorization'];
        const probeRequest = new Request('http://mcp-auth-probe.internal/', {
          headers: rawAuthHeader ? { authorization: Array.isArray(rawAuthHeader) ? rawAuthHeader[0] : rawAuthHeader } : {},
        });
        const authResult = await mcpAuthGate(probeRequest);
        if (authResult instanceof Response) {
          const headers: Record<string, string> = {};
          for (const [k, v] of authResult.headers) headers[k] = v;
          res.writeHead(authResult.status, headers);
          res.end(await authResult.text());
          return;
        }
        // toNodeHandler liest req.auth als pass-through authInfo -- dieselbe
        // Konvention, die die offizielle Express-Middleware benutzt.
        (req as unknown as { auth?: AuthInfo }).auth = authResult;
        await mcpNodeHandler(req, res);
        return;
      }
```

- [ ] **Step 5: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Ersetze `lookupAccessToken(auth.db, token)` im Verifier durch einen festen Rückgabewert (jedes Token gilt) — der "unknown bearer token"-Test muss fallen. Setze zurück. Entferne den `authResult instanceof Response`-Zweig (jede Antwort geht an `mcpNodeHandler` weiter) — der "without a bearer token"-Test muss fallen (401 wird nie geschrieben, die Anfrage erreicht stattdessen den MCP-Handler ungeprüft). Setze zurück, Suite grün.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json server.ts server.test.ts
git commit -m "feat: wire the MCP TypeScript SDK behind bearer authentication"
```

---

### Task 13: MCP-Lesewerkzeuge — `list_logs`, `get_log`, `get_release`

**Files:**
- Create: `lib/mcpTools.ts`
- Test: `lib/mcpTools.test.ts`
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `Reader` aus `./store.ts`; `Db` aus `./db/client.ts`; `GitHub`, `Permissions`; `sortReleases`, `latestOf` aus `./order.ts`; `lookupAccessToken` aus `./oauth.ts`.
- Produces: `buildMcpServer(db: Db, reader: Reader, perms: Permissions): McpServerFactory` — ersetzt die Inline-Factory aus Task 12 in `server.ts`. Task 16 und Task 17 ergänzen dieselbe Factory um die Schreibwerkzeuge.

Ein Log ist für einen Zugriff erreichbar, wenn es öffentlich ist ODER der Zugriff Schreibrechte darauf hat (dieselbe Regel wie die gehostete Seite, Task 15, und `lib/public.ts`, spec §7) — ein privater, nicht erreichbarer Log verhält sich wie ein nicht existierender: `not_found`, nie ein anderer Fehlercode, der seine Existenz verraten würde. Entwürfe sind unabhängig davon nur sichtbar, wenn die Anfrage Schreibrechte hat, unabhängig von der Sichtbarkeit des Logs selbst (spec §7 — zwei getrennte Fragen).

- [ ] **Step 1: Failing Tests schreiben**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { log, release, account } from './db/schema.ts';
import { indexReader } from './indexReader.ts';
import { fakeGitHub } from './github.ts';
import { permissions } from './permissions.ts';
import { mintTokenPair } from './oauth.ts';
import { buildMcpServer } from './mcpTools.ts';

function withServerFor(fn: (factory: ReturnType<typeof buildMcpServer>, db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-mcptools-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const gh = fakeGitHub({});
  const factory = buildMcpServer(db, indexReader(db), permissions(db, gh));
  return fn(factory, db).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}

// Ruft ein Werkzeug auf, ohne HTTP: dieselbe In-Memory-Verdrahtung, die die
// SDK selbst für ihre eigenen Server-Tests benutzt (InMemoryTransport, ein
// verbundenes Paar, ein von Hand geführter initialize/tools-call-Austausch).
// Das prüft die Werkzeuglogik dieser Datei, nicht die HTTP-Verdrahtung aus
// Task 12 (die hat ihre eigenen Tests in server.test.ts).
import {
  InMemoryTransport, isJSONRPCResultResponse, LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/core-internal';
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest } from '@modelcontextprotocol/core-internal';

async function callTool(
  factory: ReturnType<typeof buildMcpServer>,
  authInfo: { token: string; clientId: string; scopes: string[] },
  name: string,
  args: unknown,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = await factory({ era: 'modern', authInfo });
  const [peerTx, serverTx] = InMemoryTransport.createLinkedPair();
  const waiters = new Map<string | number, (message: JSONRPCMessage) => void>();
  peerTx.onmessage = (message) => {
    const id = (message as { id?: string | number }).id;
    const waiter = id === undefined ? undefined : waiters.get(id);
    if (id !== undefined && waiter) {
      waiters.delete(id);
      waiter(message);
    }
  };
  await server.connect(serverTx);
  await peerTx.start();
  const request = (message: JSONRPCRequest): Promise<JSONRPCMessage> =>
    new Promise((resolve) => {
      waiters.set(message.id, resolve);
      void peerTx.send(message);
    });
  const notify = (message: JSONRPCNotification): Promise<void> => peerTx.send(message);

  await request({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  });
  await notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const response = await request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  await server.close();
  if (isJSONRPCResultResponse(response)) {
    return response.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  }
  throw new Error(`tool call failed: ${JSON.stringify(response)}`);
}

test('list_logs lists a public log without any write access', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'list_logs', {});
    const text = JSON.parse((result as { content: [{ text: string }] }).content[0].text);
    assert.equal(text.logs.length, 1);
    assert.equal(text.logs[0].id, 'log1');
  });
});

test('list_logs omits a private log the caller cannot write to', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'list_logs', {});
    const text = JSON.parse((result as { content: [{ text: string }] }).content[0].text);
    assert.equal(text.logs.length, 0);
  });
});

test('get_log on a private log answers not_found without a logs:read scope holder able to write', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'get_log', { log_id: 'log1' });
    const parsed = result as { content: [{ text: string }]; isError?: boolean };
    assert.equal(parsed.isError, true);
    assert.equal(JSON.parse(parsed.content[0].text).error, 'not_found');
  });
});

test('get_release hides a draft from a caller without write access, even on a public log', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'r1',
      path: 'releases/1.0.0.json', doc: JSON.stringify({
        version: '1.0.0', tag: null, date: '2026-09-01', published_at: null, commits: 1,
        headline: 'h', body: [], image: null, covered: [], changes: [],
      }),
    }).run();
    const result = await callTool(factory, { token: 'irrelevant', clientId: 'c1', scopes: ['logs:read'] }, 'get_release', { log_id: 'log1', version: '1.0.0' });
    const parsed = result as { content: [{ text: string }]; isError?: boolean };
    assert.equal(parsed.isError, true);
    assert.equal(JSON.parse(parsed.content[0].text).error, 'not_found');
  });
});

test('get_log on a log the caller can write to includes draft versions and covered', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'r1',
      path: 'releases/1.0.0.json', doc: JSON.stringify({
        version: '1.0.0', tag: null, date: '2026-09-01', published_at: null, commits: 1,
        headline: 'h', body: [], image: null, covered: ['abc123'], changes: [],
      }),
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:read'] }, 'get_log', { log_id: 'log1' });
    const parsed = result as { content: [{ text: string }] };
    const body = JSON.parse(parsed.content[0].text);
    assert.equal(body.versions.length, 1);
    assert.deepEqual(body.covered, ['abc123']);
  });
});
```

Achtung: `fakeGitHub({})` beantwortet `collaboratorPermission` immer mit `null` (kein Repo bekannt) -- `canWrite` wird also für `octocat` auf `repo1` `false` sein, außer der Test bindet `pair.accessToken` an einen Account, dessen `login` das `fakeGitHub`-Repo tatsächlich als Kollaborator kennt. Für den letzten Test reicht ein `fakeGitHub({ 'o/repo1': { 'write': ['octocat'] } })`, sofern `fakeGitHub` diese Form unterstützt -- **prüfe das bestehende `fakeGitHub`-Signatur in `lib/github.ts`, bevor du diesen Test schreibst**, und passe die Fixture an die tatsächliche Form an (der obige Test-Code ist die Absicht, nicht garantiert die exakte Fixture-Syntax).

**Fällt, wenn:** Test "omits a private log" und "hides a draft" sind die eigentliche Sicherheitsaussage und fallen, sobald die Erreichbarkeits- bzw. Entwurfsprüfung entfernt wird.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

```ts
// Die MCP-Werkzeugfläche (spec §6). Jeder Aufruf löst sein Bearer-Token
// noch einmal gegen die Datenbank auf (lookupAccessToken lief schon einmal
// in der HTTP-Bearer-Prüfung, server.ts Task 12) -- das ist ein billiger,
// indizierter SQLite-Read, keine zweite teure Prüfung, und hält jedes
// Werkzeug unabhängig vom genauen Transport-Verdrahtungscode.
import * as z from 'zod/v4';
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { log, release as releaseTable } from './db/schema.ts';
import type { Reader } from './store.ts';
import type { Permissions } from './permissions.ts';
import { sortReleases, latestOf } from './order.ts';
import { lookupAccessToken } from './oauth.ts';

type CallToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function toolOk(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolError(error: string, message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message }) }], isError: true };
}

export function buildMcpServer(db: Db, reader: Reader, perms: Permissions): McpServerFactory {
  return async (ctx) => {
    const server = new McpServer({ name: 'release-log-hub', version: '1.0.0' });
    const rawToken = ctx.authInfo?.token;
    const who = rawToken ? lookupAccessToken(db, rawToken) : null;
    const scopes = ctx.authInfo?.scopes ?? [];

    // Erreichbarkeit: öffentlich ODER Schreibrecht (dieselbe Regel wie die
    // gehostete Seite, Task 15, spec §7). Ein privater, nicht erreichbarer
    // Log sieht aus wie ein nicht existierender -- nie ein Fehlercode, der
    // seine Existenz verrät.
    async function reach(logId: string): Promise<{ row: typeof log.$inferSelect; canWriteThis: boolean } | null> {
      const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
      if (!row) return null;
      const ref = { owner: row.repoOwner, repo: row.repoName };
      const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
      if (row.visibility !== 'public' && !canWriteThis) return null;
      return { row, canWriteThis };
    }

    server.registerTool(
      'list_logs',
      { description: 'Logs, die dieser Zugang lesen kann: ID, Repo, Produkt, letzte Version.', inputSchema: z.object({}) },
      async () => {
        if (!scopes.includes('logs:read')) return toolError('forbidden', 'logs:read scope required');
        const allLogs = db.select().from(log).all();
        const entries: Array<{ id: string; repo: string; product: string; latest_version: string | null }> = [];
        for (const row of allLogs) {
          const ref = { owner: row.repoOwner, repo: row.repoName };
          const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
          if (row.visibility !== 'public' && !canWriteThis) continue;
          const releases = reader.releases(row.publicId);
          const latest = canWriteThis ? sortReleases(releases)[0] ?? null : latestOf(releases);
          entries.push({ id: row.publicId, repo: `${row.repoOwner}/${row.repoName}`, product: row.product, latest_version: latest?.version ?? null });
        }
        return toolOk({ logs: entries });
      },
    );

    server.registerTool(
      'get_log',
      { description: 'Konfiguration, alle Versionen mit Stand, und covered der jüngsten Version.', inputSchema: z.object({ log_id: z.string() }) },
      async ({ log_id }) => {
        if (!scopes.includes('logs:read')) return toolError('forbidden', 'logs:read scope required');
        const reached = await reach(log_id);
        if (!reached) return toolError('not_found', `no such log: ${log_id}`);
        const config = reader.config(log_id);
        if (!config) return toolError('not_found', `no such log: ${log_id}`);
        const allReleases = reader.releases(log_id);
        const visibleReleases = reached.canWriteThis ? allReleases : allReleases.filter((r) => r.published_at !== null);
        const sorted = sortReleases(visibleReleases);
        return toolOk({
          id: config.id, product: config.product, view: config.view, visibility: config.visibility,
          curation_notes: config.curation_notes,
          versions: sorted.map((r) => ({ version: r.version, date: r.date, published_at: r.published_at })),
          covered: sorted[0]?.covered ?? [],
        });
      },
    );

    server.registerTool(
      'get_release',
      { description: 'Ganzes Dokument einer Version plus blob_sha.', inputSchema: z.object({ log_id: z.string(), version: z.string() }) },
      async ({ log_id, version }) => {
        if (!scopes.includes('logs:read')) return toolError('forbidden', 'logs:read scope required');
        const reached = await reach(log_id);
        if (!reached) return toolError('not_found', `no such log: ${log_id}`);
        const row = db.select().from(releaseTable)
          .where(and(eq(releaseTable.logId, log_id), eq(releaseTable.version, version))).all()[0];
        if (!row) return toolError('not_found', `no such version: ${version}`);
        const doc = JSON.parse(row.doc);
        if (doc.published_at === null && !reached.canWriteThis) return toolError('not_found', `no such version: ${version}`);
        return toolOk({ ...doc, blob_sha: row.blobSha });
      },
    );

    return server;
  };
}
```

`and` fehlt im Import — am Kopf der Datei `eq, and` aus `drizzle-orm` importieren (nicht nur `eq`).

- [ ] **Step 4: `/mcp`-Route umstellen**

In `server.ts`, die Inline-Factory aus Task 12 ersetzen:

```ts
  const mcpNodeHandler = toNodeHandler(createMcpHandler(auth ? buildMcpServer(auth.db, reader, auth.perms) : () => new McpServer({ name: 'release-log-hub', version: '1.0.0' })));
```

(`auth ? ... : ...` bleibt, weil `createApp` weiterhin auch ohne `auth` aufrufbar sein muss — die `/mcp`-Route selbst antwortet dann ohnehin 404, siehe Task 12; dieser Ausdruck wird nur ausgewertet, nicht während einer solchen Anfrage benutzt.)

- [ ] **Step 5: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Ersetze `row.visibility !== 'public' && !canWriteThis` in `reach()` durch `false` (jeder Log ist erreichbar) — der "omits a private log"-Test muss fallen. Setze zurück. Entferne `doc.published_at === null && !reached.canWriteThis` in `get_release` — der "hides a draft"-Test muss fallen. Setze zurück, Suite grün.

- [ ] **Step 7: Commit**

```bash
git add lib/mcpTools.ts lib/mcpTools.test.ts server.ts
git commit -m "feat: add list_logs, get_log and get_release MCP tools"
```

---

### Task 14: Der `viewer`-Fehler — Entwürfe für Schreibberechtigte sichtbar machen

**Files:**
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `Viewer` aus `./lib/public.ts`; `currentAccount`, `log`, `auth.perms.canWrite` (bestehend).
- Produces: nichts, das später importiert wird — Task 15 (gehostete Seite) verlässt sich aber auf dasselbe, jetzt korrekte `viewer` an derselben Stelle im Code.

`server.ts` setzt seit seiner ersten Fassung `const viewer = 'public';` mit dem Kommentar "Viewer is 'public' until sessions exist" (Abweichung 7). Sessions existieren seit Plan 5, `canWrite` seit Plan 5/6 — dieser Task löst das jetzt endgültig ein, für die bestehenden JSON-/Medien-Routen und die neue HTML-Route (Task 15) gemeinsam.

- [ ] **Step 1: Failing Tests schreiben**

An `server.test.ts` anhängen. Ein privater Log mit einem Entwurf und einer veröffentlichten Version:

```ts
function insertPrivateLogWithDraft(db: ReturnType<typeof openDb>): void {
  db.insert(log).values({
    publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
    view: 'full', visibility: 'private', curationNotes: null, state: 'active', headSha: 'c0ffee',
    configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
  }).run();
  db.insert(release).values({
    logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: '2026-09-01T00:00:00.000Z', blobSha: 'r1',
    path: 'releases/1.0.0.json', doc: JSON.stringify({
      version: '1.0.0', tag: null, date: '2026-09-01', published_at: '2026-09-01T00:00:00.000Z', commits: 1,
      headline: 'released', body: [], image: null, covered: [], changes: [],
    }),
  }).run();
  db.insert(release).values({
    logId: 'log1', version: '2.0.0-draft', date: '2026-09-14', publishedAt: null, blobSha: 'r2',
    path: 'releases/2.0.0-draft.json', doc: JSON.stringify({
      version: '2.0.0-draft', tag: null, date: '2026-09-14', published_at: null, commits: 1,
      headline: 'unreleased', body: [], image: null, covered: [], changes: [],
    }),
  }).run();
}

test('GET /l/<id>/versions on a private log answers 404 to an anonymous request (unchanged)', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/versions`);
      assert.equal(res.status, 404);
    }, undefined, auth);
  });
});

test('GET /l/<id>/versions with a session that has write access includes the draft', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    const gh: GitHub = { ...fakeGitHub({}), collaboratorPermission: async () => 'write' };
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/versions`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.versions.length, 2, 'both the published and the draft version must be listed for a write-access holder');
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});

test('GET /l/<id>/versions with a session that has NO write access still hides the draft', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    const gh: GitHub = { ...fakeGitHub({}), collaboratorPermission: async () => 'read' };
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    await withServer(reader, async (base) => {
      // Private + no write access: still a 404, indistinguishable from
      // "does not exist" (spec §7) -- read-only collaboration does not
      // unlock a private log's JSON either.
      const res = await fetch(`${base}/l/log1/versions`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 404);
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});
```

**Fällt, wenn:** Test 2 ist die eigentliche Aussage dieses Tasks und fällt, solange `viewer` hart auf `'public'` steht (`body.versions.length` wäre dann 1, nicht 2).

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL (Test 2 fällt, Test 1 und 3 sind schon grün — sie prüfen unverändertes Verhalten).

- [ ] **Step 3: Implementierung**

`server.ts` importiert zusätzlich `type { Viewer }` aus `./lib/public.ts`. Die Zeile

```ts
      // Viewer is 'public' until sessions exist. Drafts and private logs stay
      // invisible until then, which is the safe direction.
      const viewer = 'public';
```

wird ersetzt durch:

```ts
      // Sessions und canWrite existieren jetzt (Plan 5/6) -- ein Konto mit
      // Schreibrecht auf DAS Repo, das dieser Log-Pfad benennt, ist 'member'
      // und sieht Entwürfe; jeder andere bleibt 'public' (spec §7,
      // Abweichung 7). Derselbe Regex-Trick wie beim ETag weiter unten:
      // "+ '/'" macht auch ein pfadloses /l/<id> treffbar.
      const viewerLogMatch = /^\/l\/([^/]+)\//.exec(pathname + '/');
      let viewer: Viewer = 'public';
      if (viewerLogMatch && auth) {
        const who = currentAccount(req, auth);
        if (who) {
          const viewerRow = auth.db.select().from(log).where(eq(log.publicId, viewerLogMatch[1])).all()[0];
          if (viewerRow) {
            const ref = { owner: viewerRow.repoOwner, repo: viewerRow.repoName };
            if (await auth.perms.canWrite(who.accountId, who.login, viewerRow.publicId, ref)) viewer = 'member';
          }
        }
      }
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Setze `viewer` wieder hart auf `'public'` (die ursprüngliche Zeile) — Test 2 muss fallen. Setze zurück. Ersetze `if (await auth.perms.canWrite(...)) viewer = 'member';` durch `viewer = 'member';` (jedes angemeldete Konto wird ohne `canWrite`-Prüfung zum Mitglied) — Test 3 muss fallen (eine private Version wäre plötzlich für jeden Angemeldeten sichtbar, unabhängig von Schreibrechten). Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add server.ts server.test.ts
git commit -m "fix: let a write-access holder see draft releases, not just the public"
```

---

### Task 15: Gehostete Seite — `GET /l/<id>` und `GET /l/<id>/r/<version>`

**Files:**
- Create: `lib/renderPublic.ts`
- Test: `lib/renderPublic.test.ts`
- Modify: `lib/render.ts` (eine Zeile — `STYLE` wird exportiert)
- Modify: `server.ts`
- Test: `server.test.ts`

**Interfaces:**
- Consumes: `escapeHtml`, `STYLE` aus `./render.ts`; `sectionsOf`, `Section` aus `./sections.ts`; `sortReleases` aus `./order.ts`; `LogConfig`, `ReleaseDoc`, `Change` aus `./document.ts`.
- Produces: `publicPage(title, bodyHtml, options?: { noindex?: boolean }): string`; `renderReleaseFull(logId: string, release: ReleaseDoc): string`; `renderTimeline(logId: string, releases: ReleaseDoc[]): string`. Task 16 (`write_release`) verbraucht keine davon direkt, aber die von diesem Task gebauten Routen sind das Ziel der Permalinks, die `write_release`/`publish_release` zurückgeben.

Diese Seite ist reine Anzeige — keine neue Schreibroute, kein neuer Datenbankzugriff außer dem, den `reader`/`viewer` (Task 14) schon liefern. `sections.ts` trägt bereits den Kommentar "Grouping for both the JSON detail view and, later, the rendered page" — dieser Task ist "später".

- [ ] **Step 1: `STYLE` exportieren**

In `lib/render.ts`: `const STYLE = \`` wird zu `export const STYLE = \`` (eine Wortänderung).

- [ ] **Step 2: Failing Tests für `lib/renderPublic.ts` schreiben**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicPage, renderReleaseFull, renderTimeline } from './renderPublic.ts';
import type { ReleaseDoc } from './document.ts';

const RELEASE: ReleaseDoc = {
  version: '1.0.0', tag: null, date: '2026-09-01', published_at: '2026-09-01T00:00:00.000Z', commits: 3,
  headline: 'Schnellere Suche', body: ['Ein Absatz.'], image: null, covered: [],
  changes: [
    { type: 'feat', breaking: false, scope: null, title: 'Volltextsuche', description: 'x', pr: 42, issues: [], commit: 'a', date: '2026-09-01' },
    { type: 'fix', breaking: true, scope: 'api', description: 'y', title: '<script>x</script>', pr: null, issues: [7], commit: 'b', date: '2026-09-01' },
  ],
};

test('publicPage sets noindex only when asked', () => {
  assert.ok(!publicPage('T', 'B').includes('noindex'));
  assert.ok(publicPage('T', 'B', { noindex: true }).includes('noindex'));
});

test('renderReleaseFull groups a breaking fix under "Wichtig", not also under "Behoben"', () => {
  const html = renderReleaseFull('log1', RELEASE);
  assert.ok(html.includes('Wichtig'));
  const behobenIndex = html.indexOf('Behoben');
  assert.equal(behobenIndex, -1, 'a breaking fix must not ALSO appear under its own type section');
});

test('renderReleaseFull escapes a change title containing HTML', () => {
  const html = renderReleaseFull('log1', RELEASE);
  assert.ok(!html.includes('<script>x</script>'));
});

test('renderTimeline links each entry to its permalink', () => {
  const html = renderTimeline('log1', [RELEASE]);
  assert.ok(html.includes('/l/log1/r/1.0.0'));
});

test('renderTimeline marks a breaking release directly in the stream', () => {
  const html = renderTimeline('log1', [RELEASE]);
  assert.ok(html.includes('breaking'));
});
```

**Fällt, wenn:** Test "groups a breaking fix" ist die eigentliche spec-Aussage (spec §7, "Ein brechender Eintrag erscheint nur unter Wichtig") und fällt, sobald `sectionsOf` nicht mehr benutzt, sondern jede Änderung stattdessen ungefiltert nach `type` gruppiert wird. Test "escapes a change title" fällt, sobald `escapeHtml` in `renderChange` entfernt wird.

- [ ] **Step 3: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 4: Implementierung `lib/renderPublic.ts`**

```ts
// Die gehostete Seite (spec §7, "Gehostete Seite") -- reine Anzeige, keine
// Formulare, keine Schreibroute. Getrennt von lib/render.ts, weil diese
// Hülle keine Dashboard-Navigation trägt und private Logs ein
// noindex-Meta bekommen, das die Dashboard-Seiten nie brauchen.
import { escapeHtml, STYLE } from './render.ts';
import type { ReleaseDoc, Change } from './document.ts';
import { sectionsOf } from './sections.ts';
import type { Section } from './sections.ts';

export function publicPage(title: string, bodyHtml: string, options: { noindex?: boolean } = {}): string {
  const robots = options.noindex ? '<meta name="robots" content="noindex">' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${robots}<style>${STYLE}</style></head><body>${bodyHtml}</body></html>`;
}

// Dieselbe Segment-für-Segment-Kodierung wie lib/public.ts's detail() (dort
// privat) -- ein "/" bleibt ein echter Pfadtrenner, wird nie zu %2F. Drei
// Zeilen doppelt zu halten ist billiger als eine geteilte Naht über zwei
// unabhängige Dateien für eine Zeile, die sich nie ändert.
function encodeMediaPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function renderChange(c: Change): string {
  const scope = c.scope ? `<span class="muted">${escapeHtml(c.scope)}: </span>` : '';
  const breaking = c.breaking ? '<span class="badge">breaking</span> ' : '';
  const refs = [c.pr !== null ? `PR #${c.pr}` : null, ...c.issues.map((n) => `Issue #${n}`)]
    .filter((x): x is string => x !== null);
  return `<li>${breaking}${scope}<strong>${escapeHtml(c.title)}</strong><p>${escapeHtml(c.description)}</p>${
    refs.length > 0 ? `<p class="muted">${refs.map(escapeHtml).join(', ')}</p>` : ''
  }</li>`;
}

function renderSections(sections: Section[]): string {
  return sections.map((s) => `<h3>${escapeHtml(s.label)}</h3><ul>${s.items.map(renderChange).join('')}</ul>`).join('');
}

// Ein Release ausführlich: headline, body, Bild, dann die Abschnitte oben
// (spec §7, view: "full"). Dieselbe Form für jeden Permalink, unabhängig
// von der konfigurierten view des Logs -- wer dem Permalink folgt, will das
// ganze Release, nicht die Zusammenfassung aus dem Strom.
export function renderReleaseFull(logId: string, release: ReleaseDoc): string {
  const image = release.image
    ? `<p><img src="/l/${encodeURIComponent(logId)}/media/${encodeMediaPath(release.image.src)}" alt="${escapeHtml(release.image.alt)}"></p>`
    : '';
  return `
    <h2>${escapeHtml(release.headline)}</h2>
    <p class="muted">${escapeHtml(release.date)}${release.published_at === null ? ' &middot; <span class="badge">Entwurf</span>' : ''}</p>
    ${release.body.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
    ${image}
    ${renderSections(sectionsOf(release.changes))}
  `;
}

// Der Strom: geschlossene Einträge, der Permalink führt hinein (spec §7,
// view: "timeline"). Ein brechendes Release trägt sein Abzeichen direkt im
// Strom, ohne dass man erst hineinklicken muss.
export function renderTimeline(logId: string, releases: ReleaseDoc[]): string {
  const items = releases.map((r) => {
    const breaking = r.changes.some((c) => c.breaking) ? '<span class="badge">breaking</span> ' : '';
    const draft = r.published_at === null ? ' <span class="badge">Entwurf</span>' : '';
    const teaser = r.body.length > 0 ? `<p>${escapeHtml(r.body[0])}</p>` : '';
    return `<li>${breaking}<strong>${escapeHtml(r.date)}</strong> &mdash; <a href="/l/${encodeURIComponent(logId)}/r/${encodeURIComponent(r.version)}">${escapeHtml(r.headline)}</a>${draft}${teaser}</li>`;
  }).join('');
  return `<ul>${items}</ul>`;
}
```

- [ ] **Step 5: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Routen in `server.ts`**

Zusätzliche Importe: `publicPage, renderReleaseFull, renderTimeline` aus `./lib/renderPublic.ts`; `sortReleases` aus `./lib/order.ts`. Zwei neue Routen, vor dem bestehenden `mediaMatch`-Block (derselbe `/l/...`-Pfadraum, keine Überschneidung -- `route()`s eigenes Muster verlangt einen weiteren Pfadabschnitt, ein pfadloses `/l/<id>` oder `/l/<id>/r/<version>` erreicht es nie):

```ts
      const logPageMatch = /^\/l\/([^/]+)$/.exec(pathname);
      if (logPageMatch && (method === 'GET' || method === 'HEAD')) {
        const logId = logPageMatch[1];
        const config = reader.config(logId);
        // Ein nicht existierender und ein privater Log antworten identisch
        // (spec §7) -- derselbe Grundsatz wie route() in lib/public.ts.
        if (!config || (config.visibility === 'private' && viewer !== 'member')) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const releases = viewer === 'member' ? reader.releases(logId) : reader.releases(logId).filter((r) => r.published_at !== null);
        const sorted = sortReleases(releases);
        const body = config.view === 'timeline'
          ? renderTimeline(logId, sorted)
          : sorted.map((r) => renderReleaseFull(logId, r)).join('<hr>');
        const html = publicPage(config.product, `<h1>${escapeHtml(config.product)}</h1>${body}`, { noindex: config.visibility === 'private' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : html);
        return;
      }

      const permalinkMatch = /^\/l\/([^/]+)\/r\/([^/]+)$/.exec(pathname);
      if (permalinkMatch && (method === 'GET' || method === 'HEAD')) {
        const logId = permalinkMatch[1];
        const config = reader.config(logId);
        if (!config || (config.visibility === 'private' && viewer !== 'member')) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        let version: string;
        try {
          version = decodeURIComponent(permalinkMatch[2]);
        } catch {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const found = reader.releases(logId).find((r) => r.version === version);
        if (!found || (found.published_at === null && viewer !== 'member')) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const html = publicPage(
          `${config.product} ${found.version}`,
          `<p><a href="/l/${encodeURIComponent(logId)}">&larr; ${escapeHtml(config.product)}</a></p>${renderReleaseFull(logId, found)}`,
          { noindex: config.visibility === 'private' },
        );
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : html);
        return;
      }
```

- [ ] **Step 7: Route-Tests**

An `server.test.ts` anhängen (nutzt `insertPrivateLogWithDraft` aus Task 14):

```ts
test('GET /l/<id> on a public log renders 200 HTML with the product name', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Auri CRM'));
      assert.ok(!html.includes('noindex'));
    }, undefined, auth);
  });
});

test('GET /l/<id> on a private log is 404 to an anonymous request', async () => {
  await withAuth(async (auth, db) => {
    insertPrivateLogWithDraft(db);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1`);
      assert.equal(res.status, 404);
    }, undefined, auth);
  });
});

test('GET /l/<id>/r/<version> on a draft is 404 to an anonymous request, 200 to a write-access holder', async () => {
  await withAuth(async (auth, db) => {
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'Auri CRM',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-09-15T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '2.0.0-draft', date: '2026-09-14', publishedAt: null, blobSha: 'r2',
      path: 'releases/2.0.0-draft.json', doc: JSON.stringify({
        version: '2.0.0-draft', tag: null, date: '2026-09-14', published_at: null, commits: 1,
        headline: 'unreleased', body: [], image: null, covered: [], changes: [],
      }),
    }).run();
    const anon = await (async () => {
      const server = createApp(reader, undefined, auth);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const address = server.address() as { port: number };
      try {
        return await fetch(`http://127.0.0.1:${address.port}/l/log1/r/2.0.0-draft`);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    })();
    assert.equal(anon.status, 404);

    const gh: GitHub = { ...fakeGitHub({}), collaboratorPermission: async () => 'write' };
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-09-15T00:00:00.000Z' }).run();
    const cookie = createSessionCookie(SIGNING_KEY, 42);
    await withServer(reader, async (base) => {
      const res = await fetch(`${base}/l/log1/r/2.0.0-draft`, { headers: { cookie: `session=${cookie}` } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('unreleased'));
    }, undefined, { ...auth, gh, perms: permissions(db, gh) });
  });
});
```

Der `anon`-Aufruf oben startet einen eigenen `withServer`-losen Server, weil er dieselbe `auth`-Fixture ohne Cookie braucht, während der zweite Aufruf eine ANDERE `gh`/`perms`-Kombination in `auth` einsetzt — `withServer` bindet `auth` einmal pro Aufruf, zwei verschiedene `auth`-Objekte brauchen zwei `withServer`-Aufrufe nacheinander, nicht ineinander verschachtelt.

**Fällt, wenn:** Test 2 ist die eigentliche Sicherheitsaussage (spec §7) und fällt, sobald die Sichtbarkeitsprüfung auf der HTML-Route entfernt wird. Test 3 fällt, sobald `viewer !== 'member'` beim Entwurf nicht mehr geprüft wird.

- [ ] **Step 8: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne `config.visibility === 'private' && viewer !== 'member'` aus der `/l/<id>`-Route (ersetze die ganze Bedingung durch `!config`) — Test 2 muss fallen. Setze zurück. Entferne `found.published_at === null && viewer !== 'member'` aus der Permalink-Route — der Entwurfsteil von Test 3 (die 404-Prüfung für den anonymen Aufruf) muss fallen. Setze zurück, Suite grün.

- [ ] **Step 10: Commit**

```bash
git add lib/render.ts lib/renderPublic.ts lib/renderPublic.test.ts server.ts server.test.ts
git commit -m "feat: serve the hosted public log page and its release permalinks"
```

---

### Task 16: MCP-Schreibwerkzeug — `write_release`

**Files:**
- Modify: `lib/mcpTools.ts`
- Test: `lib/mcpTools.test.ts`
- Modify: `server.ts`

**Interfaces:**
- Consumes: `parseRelease` aus `./document.ts`; `putFile`, `CommitResult`, `GitHub`, `RepoRef` aus `./github.ts`; `renderReleaseFull` wird hier NICHT gebraucht (der Permalink ist nur eine URL-Zeichenkette, keine gerenderte Seite).
- Produces: **`buildMcpServer`s Signatur ändert sich** von `(db, reader, perms)` auf `(deps: { db: Db; reader: Reader; perms: Permissions; gh: GitHub; onRepoWrite: (ref: RepoRef) => void; baseUrl: string })` — ein Objekt statt wachsender Positionsparameter, jetzt, wo ein vierter und fünfter Abhängigkeitswert dazukommt. Task 12/13s Aufrufstelle in `server.ts` wird entsprechend angepasst. Task 17 erweitert dieselbe Factory um zwei weitere Werkzeuge, mit derselben Objekt-Signatur.

**Wichtig:** `write_release` prüft `base_blob_sha` gegen die LOKALE Indexzeile (`release`-Tabelle), bevor überhaupt ein `putFile`-Aufruf stattfindet, wenn eine Version schon existiert und kein `base_blob_sha` mitgegeben wurde — kein Netzwerk-Umlauf für einen Fehler, den man vorher schon kennt (spec §6, "der Fehler kommt... während der Agent noch am Zug ist"). Existiert die Version noch nicht, darf `base_blob_sha` fehlen; `putFile` bekommt dann `expectedSha: null` und GitHubs eigene 422-Erkennung ("unter diesem Pfad liegt schon etwas") ist das letzte Netz, genau wie beim Medien-Upload (Plan 6, Task 6).

- [ ] **Step 1: Failing Tests schreiben**

An `lib/mcpTools.test.ts` anhängen. Am Kopf der Datei zusätzlich `type { GitHub, RepoRef }` aus `./github.ts` importieren (Task 13 importierte dort bisher nur den Wert `fakeGitHub`, keinen der beiden Typen). `buildMcpServer`s neue Signatur betrifft auch `withServerFor` aus Task 13 -- passe den Helfer an:

```ts
function withServerFor(fn: (factory: ReturnType<typeof buildMcpServer>, db: ReturnType<typeof openDb>, deps: { onRepoWriteCalls: RepoRef[] }) => Promise<void>, gh?: GitHub): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-mcptools-'));
  const db = openDb(join(dir, 'test.sqlite'));
  const resolvedGh = gh ?? fakeGitHub({});
  const onRepoWriteCalls: RepoRef[] = [];
  const factory = buildMcpServer({
    db, reader: indexReader(db), perms: permissions(db, resolvedGh), gh: resolvedGh,
    onRepoWrite: (ref) => { onRepoWriteCalls.push(ref); }, baseUrl: 'https://example.test',
  });
  return fn(factory, db, { onRepoWriteCalls }).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}
```

(Jeder bestehende Aufruf von `buildMcpServer(db, indexReader(db), permissions(db, gh))` aus Task 13/14 wird in dieser Datei auf die neue Objekt-Signatur umgestellt -- suche nach jedem Vorkommen und passe an, statt eine zweite, ältere Signatur nebenher zu pflegen.)

```ts
const VALID_DOC = {
  version: '1.0.0', date: '2026-09-01', headline: 'Erste Version', body: [],
  changes: [{ type: 'feat', title: 'Suche', description: 'x', commit: 'a', date: '2026-09-01' }],
};

test('write_release creates a brand-new version and returns a commit sha and permalink', async () => {
  await withServerFor(async (factory, db, deps) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.ok(typeof body.commit_sha === 'string');
    assert.equal(body.permalink, 'https://example.test/l/log1/r/1.0.0');
    assert.deepEqual(deps.onRepoWriteCalls, [{ owner: 'o', repo: 'repo1' }]);
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', putFile: async () => ({ kind: 'committed', sha: 'newsha' }) });
});

test('write_release on an existing version without base_blob_sha answers conflict, without calling putFile', async () => {
  // The fixture records a call and returns a "wrong" success rather than
  // throwing: if the local pre-check regresses, the call reaches putFile,
  // putFileCalled flips true, AND the tool wrongly reports success -- three
  // independent, non-exception-dependent signals catch the same regression,
  // rather than relying on unverified throw-propagation semantics inside
  // the SDK's tool-call dispatch.
  let putFileCalled = false;
  await withServerFor(async (factory, db, deps) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'existing-sha',
      path: 'releases/1.0.0.json', doc: JSON.stringify({ ...VALID_DOC, tag: null, published_at: null, commits: 0, image: null, covered: [] }),
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'conflict');
    assert.equal(putFileCalled, false, 'a known conflict must never reach putFile');
    assert.equal(deps.onRepoWriteCalls.length, 0);
  }, {
    probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write',
    async putFile() { putFileCalled = true; return { kind: 'committed', sha: 'should-not-happen' }; },
  });
});

test('write_release with a stale base_blob_sha maps GitHub\'s own conflict, does not enqueue a resync', async () => {
  await withServerFor(async (factory, db, deps) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    db.insert(release).values({
      logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt: null, blobSha: 'current-sha',
      path: 'releases/1.0.0.json', doc: JSON.stringify({ ...VALID_DOC, tag: null, published_at: null, commits: 0, image: null, covered: [] }),
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC, base_blob_sha: 'a-now-stale-sha',
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'conflict');
    assert.equal(deps.onRepoWriteCalls.length, 0);
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', async putFile() { return { kind: 'conflict' }; } });
});

test('write_release rejects an invalid document before calling putFile', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: { version: '1.0.0' }, // missing headline, date, ...
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'invalid_document');
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', async putFile() { throw new Error('must not be called'); } });
});

test('write_release without write access answers forbidden', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'forbidden');
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'read', async putFile() { throw new Error('must not be called'); } });
});

test('write_release on a frozen log answers log_frozen', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'frozen', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'log_frozen');
  }, { probe: async () => ({ kind: 'gone' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => null, async putFile() { throw new Error('must not be called'); } });
});

test('write_release without the logs:write scope answers forbidden, even with write access', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:read', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:read'] }, 'write_release', {
      log_id: 'log1', version: '1.0.0', document: VALID_DOC,
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'forbidden');
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', async putFile() { throw new Error('must not be called'); } });
});
```

**Fällt, wenn:** Test "existing version without base_blob_sha" ist die eigentliche Nebenläufigkeitsaussage (spec §6) und fällt, sobald die lokale Vorprüfung entfernt wird (der Aufruf würde dann entweder abstürzen -- `putFile` wirft absichtlich -- oder, schlimmer, unbemerkt committen, wenn die Fixture das nicht wirft). Test "stale base_blob_sha" ist die GitHub-Seite derselben Aussage. Beide zusammen mit der `onRepoWriteCalls`-Prüfung sind genau die Fundklasse aus Plan 6, Task 5/6: kein Aufruf von `onRepoWrite` außerhalb des Erfolgspfads.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

`lib/mcpTools.ts`s Signatur und Kopf ändern sich:

```ts
import { parseRelease } from './document.ts';
import type { GitHub, RepoRef } from './github.ts';

export type McpToolDeps = {
  db: Db; reader: Reader; perms: Permissions; gh: GitHub; onRepoWrite: (ref: RepoRef) => void; baseUrl: string;
};

export function buildMcpServer(deps: McpToolDeps): McpServerFactory {
  const { db, reader, perms, gh, onRepoWrite, baseUrl } = deps;
  return async (ctx) => {
    // ... unverändert bis zum Ende von get_release (Task 13) ...
```

(Jede Verwendung von `db`, `reader`, `perms` innerhalb der Factory bleibt unverändert -- sie sind jetzt destrukturiert statt Positionsparameter.)

Neues Werkzeug, nach `get_release`:

```ts
    server.registerTool(
      'write_release',
      {
        description: 'Legt eine Version an oder ersetzt sie, committet ins Repo.',
        inputSchema: z.object({
          log_id: z.string(), version: z.string(),
          document: z.record(z.string(), z.unknown()),
          base_blob_sha: z.string().nullable().optional(),
        }),
      },
      async ({ log_id, version, document, base_blob_sha }) => {
        if (!scopes.includes('logs:write')) return toolError('forbidden', 'logs:write scope required');
        const row = db.select().from(log).where(eq(log.publicId, log_id)).all()[0];
        if (!row) return toolError('not_found', `no such log: ${log_id}`);
        const ref = { owner: row.repoOwner, repo: row.repoName };
        const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
        if (!canWriteThis) return toolError('forbidden', 'no write access to this repository');
        if (row.state === 'frozen') return toolError('log_frozen', 'this log is frozen; its repository is unreachable');

        const parsed = parseRelease(document, `${version}.json`);
        if (!parsed.ok) return toolError('invalid_document', parsed.errors.join('; '));

        const existing = db.select().from(releaseTable)
          .where(and(eq(releaseTable.logId, log_id), eq(releaseTable.version, version))).all()[0];
        // Blindes Überschreiben ist ausgeschlossen (spec §6): existiert die
        // Version schon UND wurde keine base_blob_sha mitgegeben, ist das
        // ein Konflikt, ohne dass überhaupt ein Netzwerk-Aufruf stattfindet.
        if (existing && !base_blob_sha) {
          return toolError('conflict', JSON.stringify({ current_blob_sha: existing.blobSha, current_document: JSON.parse(existing.doc) }));
        }

        const path = `releases/${version}.json`;
        const content = Buffer.from(JSON.stringify(parsed.value, null, 2), 'utf8');
        const result = await gh.putFile(ref, path, content, `write release ${version} via MCP`, base_blob_sha ?? null);
        if (result.kind === 'no_installation') {
          return toolError('no_installation', 'the GitHub App is not installed on this repository');
        }
        if (result.kind === 'conflict') {
          const fresh = db.select().from(releaseTable)
            .where(and(eq(releaseTable.logId, log_id), eq(releaseTable.version, version))).all()[0];
          return toolError('conflict', JSON.stringify({
            current_blob_sha: fresh?.blobSha ?? null, current_document: fresh ? JSON.parse(fresh.doc) : null,
          }));
        }
        onRepoWrite(ref);
        return toolOk({ commit_sha: result.sha, permalink: `${baseUrl}/l/${log_id}/r/${encodeURIComponent(version)}` });
      },
    );
```

`releaseTable` (der Import-Alias für `release` aus `./db/schema.ts`, s. Task 13) und `and` aus `drizzle-orm` müssen jetzt am Kopf der Datei importiert sein, falls Task 13 sie nicht schon eingeführt hat.

- [ ] **Step 4: `server.ts`s Aufrufstelle anpassen**

Die Zeile aus Task 13:

```ts
  const mcpNodeHandler = toNodeHandler(createMcpHandler(auth ? buildMcpServer(auth.db, reader, auth.perms) : () => new McpServer({ name: 'release-log-hub', version: '1.0.0' })));
```

wird zu:

```ts
  const mcpNodeHandler = toNodeHandler(createMcpHandler(
    auth
      ? buildMcpServer({ db: auth.db, reader, perms: auth.perms, gh: auth.gh, onRepoWrite: auth.onRepoWrite, baseUrl: auth.baseUrl })
      : () => new McpServer({ name: 'release-log-hub', version: '1.0.0' }),
  ));
```

- [ ] **Step 5: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Entferne den `if (existing && !base_blob_sha)`-Zweig -- der "existing version without base_blob_sha"-Test muss fallen (die Fixture wirft dann selbst, weil ihr `putFile` absichtlich einen Fehler auslöst -- ein Absturz statt eines saubern `conflict` ist hier das Fallzeichen). Setze zurück. Verschiebe `onRepoWrite(ref);` vor die `result.kind === 'conflict'`-Prüfung -- der "stale base_blob_sha"-Test muss fallen (`deps.onRepoWriteCalls.length` wäre 1, nicht 0). Setze zurück, Suite grün.

- [ ] **Step 7: Commit**

```bash
git add lib/mcpTools.ts lib/mcpTools.test.ts server.ts
git commit -m "feat: add the write_release MCP tool"
```

---

### Task 17: `publish_release`, `unpublish_release`, Instructions, `release-kuratieren`-Prompt

**Files:**
- Modify: `lib/mcpTools.ts`
- Test: `lib/mcpTools.test.ts`

**Interfaces:**
- Consumes: alles aus Task 16.
- Produces: nichts, das später importiert wird. Dieser Task rundet die Werkzeugfläche aus spec §6 ab (`create_log` und `add_media` bleiben Abweichung 6).

`publish_release` und `unpublish_release` teilen sich dieselbe Mechanik: die bestehende Version laden, `published_at` setzen oder leeren, mit der VORHANDENEN `blobSha` als `expectedSha` committen (nie ohne — die Version existiert per Definition schon, ein fehlendes `base_blob_sha`-Konzept gibt es hier nicht, die Zeile ist immer die aktuell bekannte).

- [ ] **Step 1: Failing Tests schreiben**

An `lib/mcpTools.test.ts` anhängen:

```ts
function insertPublishableRelease(db: ReturnType<typeof openDb>, publishedAt: string | null): void {
  db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
  db.insert(log).values({
    publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
    view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
    configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
  }).run();
  db.insert(release).values({
    logId: 'log1', version: '1.0.0', date: '2026-09-01', publishedAt, blobSha: 'r1',
    path: 'releases/1.0.0.json', doc: JSON.stringify({ ...VALID_DOC, tag: null, published_at: publishedAt, commits: 0, image: null, covered: [] }),
  }).run();
}

test('publish_release sets published_at and commits with the release\'s known blob sha', async () => {
  // committedExpectedSha/committedDoc must be declared OUTSIDE withServerFor:
  // its two arguments (the test body, and this gh fixture) are siblings, not
  // nested -- a `let` declared inside the first argument's callback is not in
  // scope for the second argument's `putFile` closure.
  let committedExpectedSha: string | null = null;
  let committedDoc: Record<string, unknown> | null = null;
  await withServerFor(async (factory, db, deps) => {
    insertPublishableRelease(db, null);
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'publish_release', { log_id: 'log1', version: '1.0.0' });
    assert.equal(result.isError, undefined);
    assert.equal(committedExpectedSha, 'r1');
    assert.equal((committedDoc as { published_at: unknown }).published_at !== null, true);
    assert.deepEqual(deps.onRepoWriteCalls, [{ owner: 'o', repo: 'repo1' }]);
  }, {
    probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null,
    collaboratorPermission: async () => 'write',
    async putFile(_ref, _path, content, _message, expectedSha) {
      committedExpectedSha = expectedSha;
      committedDoc = JSON.parse(content.toString('utf8'));
      return { kind: 'committed', sha: 'newsha' };
    },
  });
});

test('unpublish_release sets published_at back to null', async () => {
  let committedDoc: Record<string, unknown> | null = null; // s. Kommentar im Test davor
  await withServerFor(async (factory, db) => {
    insertPublishableRelease(db, '2026-09-01T00:00:00.000Z');
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'unpublish_release', { log_id: 'log1', version: '1.0.0' });
    assert.equal(result.isError, undefined);
    assert.equal((committedDoc as { published_at: unknown } | null)?.published_at, null);
  }, {
    probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null,
    collaboratorPermission: async () => 'write',
    async putFile(_ref, _path, content) {
      committedDoc = JSON.parse(content.toString('utf8'));
      return { kind: 'committed', sha: 'newsha' };
    },
  });
});

test('publish_release on an unknown version answers not_found', async () => {
  await withServerFor(async (factory, db) => {
    db.insert(account).values({ githubUserId: 42, login: 'octocat', avatarUrl: null, lastSeenAt: '2026-01-01T00:00:00.000Z' }).run();
    db.insert(log).values({
      publicId: 'log1', repoOwner: 'o', repoName: 'repo1', repoNodeId: 'R1', product: 'P',
      view: 'full', visibility: 'public', curationNotes: null, state: 'active', headSha: 'c0ffee',
      configBlobSha: 'sha1', indexedAt: '2026-01-01T00:00:00.000Z',
    }).run();
    const pair = mintTokenPair(db, { clientId: 'c1', accountId: 42, scope: 'logs:write', familyId: 'fam1' });
    const result = await callTool(factory, { token: pair.accessToken, clientId: 'c1', scopes: ['logs:write'] }, 'publish_release', { log_id: 'log1', version: 'nope' });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, 'not_found');
  }, { probe: async () => ({ kind: 'ready', head: 'c0ffee', nodeId: 'R1' }), tree: async () => [], blob: async () => null, collaboratorPermission: async () => 'write', async putFile() { throw new Error('must not be called'); } });
});

test('an MCP server exposes non-empty instructions and the release-kuratieren prompt', async () => {
  await withServerFor(async (factory) => {
    const server = await factory({ era: 'modern' });
    // McpServer keeps its own constructor options; this reads them back the
    // same way a client's initialize response would see them.
    assert.ok((server as unknown as { server: { getInstructions?: () => string } }).server !== undefined);
  });
});
```

**Fällt, wenn:** Test "publish_release sets published_at" fällt, wenn die Route `existing.blobSha` nicht als `expectedSha` weiterreicht (dann bekäme `committedExpectedSha` einen anderen Wert oder `null`). Test "unpublish_release" fällt, wenn `published_at` beim Umschalten auf einen anderen Wert als `null` gesetzt wird.

Der letzte Test ("exposes non-empty instructions...") ist bewusst schwach -- **prüfe, während du diesen Task umsetzt, wie `instructions` und ein registrierter Prompt tatsächlich von außen prüfbar sind** (z. B. über die `initialize`-Antwort im selben `InMemoryTransport`-Aufbau wie `callTool`, die `instructions` im Ergebnis trägt, und eine `prompts/list`-Anfrage für den Prompt). Ersetze diesen Platzhaltertest durch eine echte Prüfung beider Werte, sobald du weißt, wie die installierte SDK sie zurückgibt -- nach demselben Muster wie Task 13s Kommentar zu `callTool`: verifiziere gegen die tatsächliche API, melde im Report, falls die Beschreibung hier abwich.

- [ ] **Step 2: Testlauf, muss fehlschlagen**

Run: `npm test`
Expected: FAIL.

- [ ] **Step 3: Implementierung**

Ein gemeinsamer Helfer für beide Werkzeuge, vor `server.registerTool('write_release', ...)`:

```ts
    async function togglePublish(logId: string, version: string, publishedAt: string | null): Promise<CallToolResult> {
      if (!scopes.includes('logs:write')) return toolError('forbidden', 'logs:write scope required');
      const row = db.select().from(log).where(eq(log.publicId, logId)).all()[0];
      if (!row) return toolError('not_found', `no such log: ${logId}`);
      const ref = { owner: row.repoOwner, repo: row.repoName };
      const canWriteThis = who !== null && await perms.canWrite(who.accountId, who.login, row.publicId, ref);
      if (!canWriteThis) return toolError('forbidden', 'no write access to this repository');
      if (row.state === 'frozen') return toolError('log_frozen', 'this log is frozen; its repository is unreachable');

      const existing = db.select().from(releaseTable)
        .where(and(eq(releaseTable.logId, logId), eq(releaseTable.version, version))).all()[0];
      if (!existing) return toolError('not_found', `no such version: ${version}`);

      const doc = { ...JSON.parse(existing.doc), published_at: publishedAt };
      const path = `releases/${version}.json`;
      const content = Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
      const message = `${publishedAt !== null ? 'publish' : 'unpublish'} release ${version} via MCP`;
      const result = await gh.putFile(ref, path, content, message, existing.blobSha);
      if (result.kind === 'no_installation') return toolError('no_installation', 'the GitHub App is not installed on this repository');
      if (result.kind === 'conflict') {
        return toolError('conflict', 'the release changed since it was last read; call get_release and try again');
      }
      onRepoWrite(ref);
      return toolOk({ commit_sha: result.sha, permalink: `${baseUrl}/l/${logId}/r/${encodeURIComponent(version)}` });
    }

    server.registerTool(
      'publish_release',
      { description: 'Setzt published_at auf jetzt.', inputSchema: z.object({ log_id: z.string(), version: z.string() }) },
      ({ log_id, version }) => togglePublish(log_id, version, new Date().toISOString()),
    );

    server.registerTool(
      'unpublish_release',
      { description: 'Setzt published_at auf null.', inputSchema: z.object({ log_id: z.string(), version: z.string() }) },
      ({ log_id, version }) => togglePublish(log_id, version, null),
    );
```

Am Kopf der `buildMcpServer`-Funktion (vor `return server;`), Instructions und Prompt. Der `McpServer`-Konstruktor bekommt ein zweites Argument (Task 13s `new McpServer({ name: 'release-log-hub', version: '1.0.0' })` wird zu):

```ts
    const server = new McpServer(
      { name: 'release-log-hub', version: '1.0.0' },
      { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
    );
```

`INSTRUCTIONS` als Modulkonstante, vor `buildMcpServer`:

```ts
// Der Kurationsteil des Vorbild-Skills, wörtlich aus spec §6.
const INSTRUCTIONS = `
Rohstoff ist nie Ergebnis. Ein Release ist fertig, wenn kein Eintrag mehr wie eine Commit-Nachricht liest.
Ein Eintrag ist ein Thema, kein Commit. 15 Commits werden zu drei bis fünf Themen.
Der Lesertest: ein Satz bleibt, wenn der Leser das auf seinem Bildschirm bemerken kann. Klassennamen, Tabellen, Spalten, Framework- und Paketnamen fallen raus; sichtbar gewordene technische Aussagen bleiben.
title ist ein Substantivstück, kein Imperativ, keine Route, kein Ticketkürzel. description sind mehrere Absätze: was jetzt geht, warum es so entschieden wurde, was nebenbei behoben wurde.
headline benennt, sie bewertet nicht. body nennt Richtungen des Release, statt die Einträge nachzuerzählen.
Typen: feat -> Neu, perf -> Änderungen, fix -> Behoben.
breaking: true setzen, wenn der Leser handeln muss. Die Handlungsanweisung gehört in description.
covered nie von Hand anfassen.

Ablauf:
1. list_logs, dann get_log -- liefert jüngste Version und deren covered.
2. Lies lokal "git log" ab diesen Commits.
3. Verwandte Commits zu Themen bündeln, Prosa schreiben.
4. write_release mit published_at: null -- ein Entwurf.
5. Der Mensch liest den Permalink, den der Aufruf zurückgibt.
6. publish_release.
`.trim();
```

Der Prompt, nach den drei Lesewerkzeugen (oder direkt vor `return server;` -- die Reihenfolge unter den `registerTool`/`registerPrompt`-Aufrufen ist beliebig):

```ts
    server.registerPrompt(
      'release-kuratieren',
      { title: 'Release kuratieren', description: 'Stößt den Kurationsablauf für ein Log an.', argsSchema: z.object({ log_id: z.string().optional() }) },
      ({ log_id }) => ({
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: log_id
              ? `Kuratiere das nächste Release für Log ${log_id}. Beginne mit get_log.`
              : 'Kuratiere das nächste Release. Beginne mit list_logs, um die verfügbaren Logs zu sehen.',
          },
        }],
      }),
    );
```

- [ ] **Step 4: Testlauf, muss bestehen**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Zwei "Fällt, wenn"-Zeilen live nachstellen**

Ersetze in `togglePublish` `existing.blobSha` durch `null` als `expectedSha`-Argument -- der "publish_release sets published_at"-Test muss fallen (`committedExpectedSha` wäre `null`, nicht `'r1'`). Setze zurück. Ersetze `published_at: publishedAt` durch `published_at: existing.blobSha === null ? null : new Date().toISOString()` (eine absichtlich falsche Bedingung) -- der "unpublish_release"-Test muss fallen. Setze zurück, Suite grün.

- [ ] **Step 6: Commit**

```bash
git add lib/mcpTools.ts lib/mcpTools.test.ts
git commit -m "feat: add publish_release, unpublish_release, instructions and a curation prompt"
```

---

### Task 18: Dokumentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nichts.
- Produces: nichts.

- [ ] **Step 1: README ergänzen**

Neuer Abschnitt "MCP und OAuth", nach dem bestehenden "Dashboard"-Abschnitt (Plan 6):

```markdown
### MCP und OAuth

Ein eigener OAuth-2.0-Autorisierungsserver (spec §5, "Rolle 2") schützt `/mcp`:

- `POST /oauth/register` — Dynamic Client Registration (RFC 7591), nur
  öffentliche Clients (kein Secret, PKCE `S256` ist Pflicht).
- `GET`/`POST /oauth/authorize` — Zustimmungsbildschirm.
- `POST /oauth/token` — `authorization_code`- und `refresh_token`-Grant.
- `GET /.well-known/oauth-protected-resource/mcp`,
  `GET /.well-known/oauth-authorization-server` — Metadaten (RFC 9728/8414).
- `GET /dashboard/connections`, `POST /dashboard/connections/<clientId>/revoke`
  — verbundene Clients ansehen und trennen.
- `POST /mcp` — die eigentliche MCP-Fläche, Streamable HTTP, Bearer-Token
  Pflicht: `list_logs`, `get_log`, `get_release` (Scope `logs:read`),
  `write_release`, `publish_release`, `unpublish_release` (Scope
  `logs:write`).

„Log anlegen" (`create_log`) und Medien-Upload über MCP (`add_media`) fehlen
bewusst noch — beide brauchen eigene Infrastruktur (ein persistentes
GitHub-Nutzer-Token beziehungsweise signierte Upload-URLs), die noch nicht
existiert.

### Gehostete Seite

- `GET /l/<id>` — serverseitig gerendert, `full` oder `timeline` je nach
  Log-Einstellung. Entwürfe nur für Angemeldete mit Schreibrecht sichtbar.
- `GET /l/<id>/r/<version>` — Permalink auf eine einzelne Version.

Der öffentliche JSON-Feed (`/l/<id>/versions`, `/l/<id>/releases`, ...) und
der Medien-Download existierten schon vor diesem Plan.
```

- [ ] **Step 2: Zeilen gegen den tatsächlichen Code zurücklesen**

Prüfe: heißen die Routen wirklich so, sind die Scopes wirklich genau `logs:read`/`logs:write`, ist `create_log`/`add_media` wirklich (noch) nirgends implementiert?

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the MCP surface, its OAuth server, and the hosted page"
```

---

## Nach dem letzten Task: Prüfung von Hand

Diese Prüfung braucht einen echten MCP-Client (z. B. Claude Code selbst, über `claude mcp add`) und gehört dem Menschen. **Nicht von einem Agenten ausführen.**

```bash
cd /Users/christian/www/release-log && npm start
```

1. Einen MCP-Client mit `/mcp` als Streamable-HTTP-Endpunkt verbinden. Löst er die OAuth-Discovery selbst aus (401 → `.well-known`-Metadaten → Registrierung → Zustimmung → Token)? Landet die Zustimmungsseite tatsächlich im Browser, mit dem richtigen Client-Namen und den richtigen Logs?
2. `list_logs` aufrufen: erscheinen genau die erwarteten Logs?
3. `write_release` mit einem neuen, gültigen Dokument aufrufen: erscheint ein Commit im Repo? Denselben Aufruf ein zweites Mal ohne `base_blob_sha` versuchen: kommt `conflict` statt eines zweiten, stillen Commits?
4. `publish_release` aufrufen, dann die zurückgegebene Permalink-URL im Browser öffnen: zeigt sie das Release?
5. Den MCP-Client im Dashboard unter "Verbundene Clients" trennen, dann `list_logs` erneut versuchen: scheitert der Aufruf jetzt mit einem abgelaufenen/ungültigen Token?
6. Einen privaten Log ohne Schreibrecht über `GET /l/<id>` im Browser öffnen (abgemeldet): erscheint ein 404, nicht ein Hinweis, dass der Log existiert?

Punkt 1 und 3 sind die einzigen, die kein Test abdecken kann: ob ein echter MCP-Client (Claude Code, ein anderer Agent) die OAuth-Discovery und den Zustimmungsfluss tatsächlich so durchläuft, wie die Spezifikationen (RFC 9728/8414/7591, PKCE) es beschreiben, ist eine Annahme dieses Plans, die kein `fetch`-basierter Test in `server.test.ts` prüfen kann — dort wird jeder Schritt einzeln, von Hand zusammengesetzt, geprüft, nie ein echter Client von Anfang bis Ende. Weicht das Verhalten ab, ist das ein echter Fund und gehört gemeldet, nicht stillschweigend umgangen.

---

## Selbstprüfung

**Spec-Abdeckung.** §5 "Rolle 2" (Registrierung, Zustimmung, PKCE, Token-Ausgabe/-Rotation/-Widerruf, Ratenbegrenzung): Tasks 4-11. §6 (alle sechs Werkzeuge außer `create_log`/`add_media`, Instructions, Prompt): Tasks 12-13, 16-17. §7 "Gehostete Seite": Tasks 14-15. Der vorbestehende `viewer`-Fehler: Task 14. `create_log`, `add_media`: bewusst nicht Teil dieses Plans, Abweichung 6.

**Nicht abgedeckt und bewusst offen:** `create_log` (Dashboard-Knopf und MCP-Tool, beide an Entscheidung 23 gebunden), `add_media` über MCP (signierte Upload-URLs). Beide brauchen eigene Infrastruktur, unabhängig groß genug für einen eigenen Plan — genau wie Plan 6 sie schon einmal zurückstellte.

**Typkonsistenz.** `McpToolDeps` (Task 16) ersetzt `buildMcpServer`s Positionsparameter aus Task 13 vollständig — jede Aufrufstelle in `server.ts` (Task 12/13, angepasst in Task 16) und in `lib/mcpTools.test.ts` (Task 13, angepasst in Task 16) benutzt ab Task 16 dieselbe Objektform. `RotateResult`/`RedeemCodeResult`/`RegisterClientResult` (Tasks 4, 6, 10) tragen alle dieselbe `{ ok: true; value: ... } | { ok: false; error/errors: ... }`-Form, die jede Aufrufstelle in `server.ts` gleich behandelt (`if (!result.ok) { ... }`). `familyId` (Task 6) läuft unverändert durch `mintTokenPair` (Task 8), `rotateRefreshToken` (Task 10) und `revokeFamily` (Task 6) — immer derselbe Zweck: eine widerrufbare Kette, nie neu erfunden.

**Testzahl.** Aktuell 391 (Ende Plan 6). Nach diesem Plan werden es ungefähr 460-480 sein.

