// The only file with a socket. Everything it decides is decided in
// lib/public.ts, with one exception: the media route below checks
// visibility itself. A media response is bytes, not a route() reply,
// so there is no JSON shape to carry that decision through — the check has
// to live here, in transport, where the bytes actually get written. It
// applies the same rule as every other content route (public, or signed in
// with write access), reading the `viewer` this handler already computed.

import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { route } from './lib/public.ts';
import type { Viewer } from './lib/public.ts';
import type { Reader } from './lib/store.ts';
import { verifySignature, refsFor, permissionInvalidationRefsFor } from './lib/webhook.ts';
import type { RepoRef } from './lib/github.ts';
import { openDb } from './lib/db/client.ts';
import type { Db } from './lib/db/client.ts';
import { account, log, syncError, release, media, repoPermission, allowlist } from './lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import { escapeHtml, page } from './lib/render.ts';
import { publicPage, renderReleaseFull, renderTimeline } from './lib/renderPublic.ts';
import { sortReleases } from './lib/order.ts';
import type { GitHub } from './lib/github.ts';
import type { Permissions } from './lib/permissions.ts';
import { indexReader } from './lib/indexReader.ts';
import { readConfig } from './lib/config.ts';
import { parseConfig } from './lib/document.ts';
import { installations } from './lib/appAuth.ts';
import { githubClient } from './lib/github.ts';
import { withRetry } from './lib/http.ts';
import type { Http } from './lib/http.ts';
import { createSessionCookie, verifySessionCookie, isAdmin, isAllowed, SESSION_MAX_AGE_SECONDS } from './lib/session.ts';
import { exchangeCodeForIdentity } from './lib/login.ts';
import { permissions } from './lib/permissions.ts';
import { syncLog, MEDIA_MAX_BYTES } from './lib/index.ts';
import { mediaTypeOf } from './lib/mediaTypes.ts';
import { syncQueue } from './lib/syncQueue.ts';
import { startReconcile } from './lib/reconcile.ts';
import { registerClient, findClient, mintAuthorizationCode, redeemAuthorizationCode, mintTokenPair, rotateRefreshToken, listConnectedClients, revokeAllForClient, lookupAccessToken } from './lib/oauth.ts';
import { buildMcpServer } from './lib/mcpTools.ts';
import { rateLimiter } from './lib/rateLimit.ts';
import {
  createMcpHandler, McpServer, requireBearerAuth, OAuthError, OAuthErrorCode,
  oauthMetadataResponse, getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/server';
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

const MEDIA_CACHE = 'public, max-age=31536000, immutable';
// Die Bytes eines privaten Logs hängen an der Session des Abrufenden, nicht
// am Pfad: ein geteilter Cache darf sie nie aufbewahren, und auch der
// Browser soll sie nicht ein Jahr lang behalten, nachdem der Zugriff endet.
const MEDIA_CACHE_PRIVATE = 'private, no-store';
const JSON_CACHE = 'public, max-age=60';

// A GitHub delivery is typically a few kilobytes; one megabyte is generous
// while still bounding what a stranger can write into this process's memory
// before anything has been checked.
const WEBHOOK_MAX_BYTES = 1024 * 1024;

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
  gh: GitHub;
  perms: Permissions;
  // Called after a dashboard write action (Task 5, Task 6) commits
  // successfully -- the same reconcile the webhook otherwise triggers, only
  // right away instead of only after delivery.
  onRepoWrite(ref: RepoRef): void;
};

type LoggedIn = { accountId: number; login: string };

// Read the session cookie, look up the account -- exactly what /me already
// does, now in one place for every dashboard route.
function currentAccount(req: import('node:http').IncomingMessage, auth: Auth): LoggedIn | null {
  const session = verifySessionCookie(auth.signingKey, cookieValue(req.headers.cookie, 'session'));
  if (!session) return null;
  const row = auth.db.select().from(account).where(eq(account.githubUserId, session.accountId)).all()[0];
  return row ? { accountId: session.accountId, login: row.login } : null;
}

// A tiny request-cookie parser: Node's IncomingMessage never splits the
// `cookie` header for you, and pulling in a dependency for "find one
// name=value pair" would be the opposite of lazy.
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// The last-resort net: log the message only (never the whole error object,
// since some error shapes -- e.g. a failed fetch -- can carry request
// internals) and answer 500 if nothing has gone out yet. Shared by the
// outer listener wrapper below and the /webhook 'end' handler, which is a
// separate callback the outer try/catch's dynamic scope has already
// finished by the time it fires and so cannot catch on its own.
function respondInternalError(res: ServerResponse, err: unknown): void {
  console.error('request failed:', err instanceof Error ? err.message : err);
  if (!res.headersSent) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  }
}

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

const ALLOWED_SCOPES = ['logs:read', 'logs:write'];

// Task 4's isAcceptableRedirectUri checks a value being REGISTERED (must be
// https, or http on loopback). This checks a value PRESENTED at /oauth/authorize
// against what was registered -- exact match, except the redirect_uri's port
// may vary from what was registered when both are loopback (RFC 8252): a
// native client picks its callback port at OS-assigned random each run, so
// pinning one exact port at registration time would be unusable.
function redirectUriMatches(registered: string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let presentedUrl: URL;
  try {
    presentedUrl = new URL(presented);
  } catch {
    return false;
  }
  if (presentedUrl.protocol !== 'http:') return false;
  // URL.hostname returns the bracketed form for IPv6 ('[::1]', not '::1');
  // both are listed so an already-unbracketed value still matches.
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(presentedUrl.hostname)) return false;
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

export function createApp(reader: Reader, hooks?: Hooks, auth?: Auth): Server {
  const oauthRegisterLimiter = rateLimiter(10, 60 * 60 * 1000); // 10 je Stunde
  const oauthTokenLimiter = rateLimiter(60, 60 * 1000); // 60 je Minute
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
  const mcpNodeHandler = toNodeHandler(createMcpHandler(
    auth
      ? buildMcpServer({ db: auth.db, reader, perms: auth.perms, gh: auth.gh, onRepoWrite: auth.onRepoWrite, baseUrl: auth.baseUrl })
      : () => new McpServer({ name: 'release-log-hub', version: '1.0.0' }),
  ));
  return createServer(async (req, res) => {
    // Everything below runs inside one try/catch: a synchronous throw
    // anywhere in here -- e.g. isAllowed's db.select() on a locked or
    // corrupted sqlite file, which runs for every /auth/github/callback
    // caller before the allowlist decision is even made -- would otherwise
    // escape the listener as an unhandled rejection and crash the whole
    // process, silently (no log line), for every in-flight request, not
    // just the one that triggered it. This does NOT reach the /webhook
    // branch's req.on('end', ...) callback below: that callback runs on a
    // later tick, after this try's dynamic scope has already finished, so
    // it carries its own try/catch (using the same respondInternalError).
    try {
      const method = req.method ?? 'GET';

      // Base is a constant: only pathname and searchParams are ever read from
      // this URL, so req.headers.host (attacker-controlled) has no business
      // being part of it. That alone is not enough — a malformed request
      // target (e.g. "//[/x", which Node's HTTP parser passes through as
      // req.url unvalidated) still throws here. Answer 400 instead of letting
      // the exception escape the listener, which would crash the process.
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'bad_request' }));
        return;
      }
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
        return;
      }

      if (pathname === '/webhook') {
        // Falling through to route() here would answer 405 (it checks method
        // before pathname), not 404 -- an unconfigured deployment would then
        // leak that /webhook is a real route, just one that rejects the verb.
        // The interface promises a route that plain does not exist without a
        // secret, so that has to be decided right here, not by the generic
        // fallback below.
        if (!hooks || method !== 'POST') {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'not_found' }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let refused = false;
        req.on('data', (chunk: Buffer) => {
          if (refused) return;
          size += chunk.length;
          if (size > WEBHOOK_MAX_BYTES) {
            // Abort instead of reading on: the rest of the body is no use to
            // anyone at that point, and buffering it anyway would be exactly
            // what the limit exists to prevent.
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
          // This callback fires on its own later tick, outside the dynamic
          // scope of the try/catch wrapping the rest of this listener (that
          // try has already returned, via the `return` a few lines below the
          // req.on registrations, by the time 'end' fires) -- so it needs its
          // own net. hooks.onDelivery and onPermissionInvalidation both run
          // synchronous sqlite statements with nothing above them catching a
          // throw (e.g. a locked/corrupted database), which would otherwise
          // crash the process from inside an event handler, silently.
          try {
            const body = Buffer.concat(chunks);
            // Verify before parsing (spec §10). Everything below this line
            // handles bytes known to have come from GitHub; everything above
            // it only touches them to count them.
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
            // Accepted, not done: the reconcile runs afterward, off the queue.
            // GitHub needs a fast answer, and whether the reconcile succeeds
            // doesn't change the fact that the delivery arrived.
            hooks.onDelivery(refsFor({ event, payload }));
            hooks.onPermissionInvalidation?.(permissionInvalidationRefsFor({ event, payload }));
            res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ accepted: true }));
          } catch (err) {
            respondInternalError(res, err);
          }
        });
        return;
      }

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
        const nextParam = url.searchParams.get('next');
        // Genau ein Ziel ist erlaubt: /oauth/authorize mit seiner eigenen
        // Query. Kein allgemeiner Rückweg -- der wäre ein offenes
        // Weiterleitungsziel (Abweichung 8).
        const loginNextCookie = nextParam !== null && nextParam.startsWith('/oauth/authorize?')
          ? `login_next=${encodeURIComponent(nextParam)}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/github`
          : null;
        authorize.searchParams.set('state', state);
        res.writeHead(302, {
          location: authorize.toString(),
          'set-cookie': loginNextCookie
            ? [`oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/github`, loginNextCookie]
            : `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/github`,
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
        // A random, cookie-bound value an attacker can neither read nor guess
        // -- there is no secret here for a timing side-channel to extract, so
        // plain equality is deliberate, not an oversight (plan, "Abweichungen").
        if (!code || !state || !cookieState || state !== cookieState) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Anmeldung fehlgeschlagen', '<p>Der Anmeldevorgang ist ungültig oder abgelaufen. Bitte erneut versuchen.</p>'));
          return;
        }

        // exchangeCodeForIdentity documents a returned null for every failure
        // it recognizes, but a genuine network failure (fetch rejecting, the
        // timeout firing, a non-JSON response body) surfaces as a REJECTED
        // promise, not a null -- and this is the only file with a socket, so
        // letting that escape the listener would crash the whole process on
        // an attacker-controlled request (code/state are both unauthenticated
        // input). To the caller a throw and a null mean the same thing --
        // GitHub could not be reached correctly -- so both get the same 502.
        let identity;
        try {
          identity = await exchangeCodeForIdentity(
            auth.http, auth.clientId, auth.clientSecret, code, `${auth.baseUrl}/auth/github/callback`,
          );
        } catch {
          identity = null;
        }
        if (!identity) {
          res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('GitHub nicht erreichbar', '<p>Die Anmeldung bei GitHub ist fehlgeschlagen. Bitte erneut versuchen.</p>'));
          return;
        }

        // The allowlist check runs before anything is written: a denied
        // person must leave zero trace -- no account row, no session cookie.
        if (!isAllowed(auth.db, identity.login, auth.adminLogins)) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Kein Zugriff', '<p>Dieses GitHub-Konto ist für diesen Dienst nicht zugelassen.</p>'));
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
          // A frozen log is never "writable" for anyone -- GitHub answers a
          // permission lookup on a deleted repo with 404, which
          // collaboratorPermission reads as null. Without this exception a
          // frozen log would become permanently unreachable in the
          // dashboard, including for deletion (spec, plan deviation 7).
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
          <p><a href="/dashboard/connections">Verbundene Clients</a></p>
        `;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page('Dashboard', body));
        return;
      }

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
        // Same frozen-admin exception as /dashboard: a deleted repo answers
        // every permission lookup as 404/null, which would otherwise lock
        // even an admin out of a frozen log's own page (spec, plan deviation 7).
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

        const releases = auth.db.select().from(release).where(eq(release.logId, logId)).all();
        const releaseRows = releases.map((r) =>
          `<tr><td>${escapeHtml(r.version)}</td><td>${escapeHtml(r.date)}</td><td>${r.publishedAt ? 'Veröffentlicht' : 'Entwurf'}</td></tr>`,
        ).join('');

        // Nur hier, hinter canWrite/der frozen-admin-Ausnahme oben: diese
        // Route ist nicht die anonyme Fläche, für die Spec §7 identische
        // 404s verlangt (lib/github.ts's Kommentar dazu) -- ein angemeldetes,
        // berechtigtes Konto darf den Installationsstand live sehen (Plan,
        // Abweichung 5).
        const probeResult = await auth.gh.probe(ref);
        const installationLabel = probeResult.kind === 'no_installation'
          ? 'keine Installation'
          : probeResult.kind === 'gone'
          ? 'Repo nicht mehr auffindbar'
          : 'erreichbar';

        const body = `
          <p><a href="/dashboard">&larr; alle Logs</a></p>
          <h1>${escapeHtml(row.product)}</h1>
          <p class="muted">${escapeHtml(row.repoOwner)}/${escapeHtml(row.repoName)} &middot; ${row.state === 'frozen' ? 'eingefroren' : 'aktiv'} &middot; zuletzt abgeglichen: ${row.indexedAt ? escapeHtml(row.indexedAt) : 'nie'} &middot; <span class="badge">${installationLabel}</span></p>

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

          ${releases.length > 0
            ? `<h2>Releases</h2><table><thead><tr><th>Version</th><th>Datum</th><th>Status</th></tr></thead><tbody>${releaseRows}</tbody></table>`
            : ''}

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
        // URLSearchParams.get returns '' (never null) for a present-but-empty
        // field, but putFile treats null as "create new" and anything else
        // (including '') as a sha to check against GitHub -- so an empty
        // submitted value must become null here, not pass through as "".
        const expectedSha = form.get('expected_sha') || null;
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
        let targetLogin: string;
        try {
          targetLogin = decodeURIComponent(allowlistDeleteMatch[1]);
        } catch {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page('Ungültige Anfrage', '<p>Der Login in der URL ist kein gültiges Percent-Encoding.</p>'));
          return;
        }
        auth.db.delete(allowlist).where(eq(allowlist.githubLogin, targetLogin)).run();
        res.writeHead(302, { location: '/admin/allowlist' });
        res.end();
        return;
      }

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
        // Unknown client or an unregistered redirect_uri: never redirect --
        // there is no validated destination to send the error to (spec §5,
        // "redirect URIs are checked exactly").
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

        // From here on redirectUri is validated -- every further error may go there.
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
        // response_type only applies to the initial request (GET) -- it is
        // not one of the fields the consent form round-trips (see the hidden
        // fields below), so requiring it again on POST would reject every
        // decision submission before it ever reaches the allow/deny check.
        if ((method === 'GET' && params.get('response_type') !== 'code') || codeChallenge === '' || codeChallengeMethod !== 'S256') {
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

        // GET, signed in: consent screen. Lists the logs this account
        // currently has write access to -- purely informational, the actual
        // enforcement stays live against GitHub (as in the dashboard, plan
        // 6) and never depends on this display.
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

        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
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

      // url.pathname is percent-encoded (new URL never decodes it), so a media
      // filename with a space or non-ASCII character only matches the file on
      // disk once decoded. Decode the captured path exactly once, here, and
      // never transform it again — a second decode is how a path guard gets
      // bypassed (%252e%252e%252f survives one decode as %2e%2e%2f, and a
      // second decode turns that into ../). decodeURIComponent throws on
      // malformed input like %zz; that is a 404, not a crashed request.
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

      const mediaMatch = /^\/l\/([^/]+)\/media\/(.+)$/.exec(pathname);
      if (mediaMatch && (method === 'GET' || method === 'HEAD')) {
        let mediaPath: string;
        try {
          mediaPath = decodeURIComponent(mediaMatch[2]);
        } catch {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'not_found' }));
          return;
        }

        // mediaMatch[1] (the log id) is looked up undecoded, unlike mediaPath above.
        // That is deliberate, not an oversight: undecoded is the safe
        // direction here, since a decode could only ever turn a non-matching
        // id into a different non-matching id. route() below makes the same
        // choice for the log id segment it extracts from pathname. Do not
        // add a decode here to "match" the media path -- that would be a
        // second decode on a segment nothing has decoded once yet.
        const config = reader.config(mediaMatch[1]);
        // Dieselbe Sichtbarkeitsregel wie jede andere Inhaltsroute dieses
        // Logs (JSON-Feed, gehostete Seite): öffentlich, oder angemeldet mit
        // Schreibrecht -- genau das, was `viewer` oben schon entschieden hat.
        // Vorher prüfte diese Route nur 'public' und ließ damit die Bilder
        // eines privaten Logs für JEDEN verschwinden, auch für das Mitglied,
        // das dessen Entwürfe ohnehin sieht. Seit die gehostete Seite
        // <img>-Tags auf diese Route rendert, war das als kaputtes Bild
        // sichtbar.
        const isPublic = config !== null && config.visibility === 'public';
        const blob = config && (isPublic || viewer === 'member')
          ? reader.media(mediaMatch[1], mediaPath)
          : null;
        if (blob) {
          res.writeHead(200, {
            'content-type': blob.type,
            'content-length': blob.bytes.length,
            'cache-control': isPublic ? MEDIA_CACHE : MEDIA_CACHE_PRIVATE,
            'access-control-allow-origin': '*',
          });
          res.end(method === 'HEAD' ? undefined : blob.bytes);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'not_found' }));
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
    } catch (err) {
      respondInternalError(res, err);
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const dbPath = process.env.DB_PATH ?? './release-log.sqlite';
  const db = openDb(dbPath);

  const config = readConfig(process.env);
  // Node has no default fetch timeout: a hung connection would block this
  // process's single in-flight sync indefinitely, stalling every
  // repository's sync, not just the hung one. 30s is generous for a
  // single GitHub API call, including the blobs a sync fetches one at a
  // time. Same treatment as bin/reindex.ts, for the same reason.
  const FETCH_TIMEOUT_MS = 30_000;
  const gh = githubClient(
    installations(config, withRetry((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }))),
    withRetry((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })),
  );
  const queue = syncQueue(
    async (ref) => { await syncLog(db, gh, ref); },
    (ref, err) => { console.error(`${ref.owner}/${ref.repo}: ${(err as Error).message}`); },
  );
  startReconcile(db, queue);

  const perms = permissions(db, gh);
  const authHttp: Http = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  // Bind an explicit address: without a host Node listens on :: and takes
  // IPv4 only while nothing else holds it, so a busy port turns into a
  // silent IPv6-only start instead of an error (spec §12).
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
    gh,
    perms,
    onRepoWrite: (ref) => { queue.enqueue(ref); },
  }).listen(port, '127.0.0.1', () => {
    console.log(`release-log-hub on http://127.0.0.1:${port}, index at ${dbPath}`);
  });
}
