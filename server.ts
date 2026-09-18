// The only file with a socket. Everything it decides is decided in
// lib/public.ts, with one exception: the media route below checks
// visibility itself. A media response is bytes, not a route() reply,
// so there is no JSON shape to carry that decision through — the check has
// to live here, in transport, where the bytes actually get written. It
// applies the same rule as every other content route (public, or signed in
// with write access), reading the `viewer` this handler already computed.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { route } from './lib/public.ts';
import type { Viewer } from './lib/public.ts';
import type { Reader } from './lib/store.ts';
import { verifySignature, refsFor, permissionInvalidationRefsFor } from './lib/webhook.ts';
import type { RepoRef } from './lib/github.ts';
import type { Db } from './lib/db/client.ts';
import { account, log } from './lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import type { GitHub } from './lib/github.ts';
import type { Permissions } from './lib/permissions.ts';
import type { Http } from './lib/http.ts';
import { createSessionCookie, verifySessionCookie, isAdmin, isAllowed, SESSION_MAX_AGE_SECONDS } from './lib/session.ts';
import { exchangeCodeForLogin } from './lib/login.ts';
import { MEDIA_MAX_BYTES } from './lib/index.ts';
import { bootCore } from './lib/boot.ts';
import { registerClient, mintAuthorizationCode, redeemAuthorizationCode, mintTokenPair, rotateRefreshToken, lookupAccessToken } from './lib/oauth.ts';
import { accountFromCookie, cookieValue } from './lib/access.ts';
import type { LoggedIn } from './lib/access.ts';
import { checkAuthorizeRequest, denyLocation } from './lib/oauthRequest.ts';
import { redeemUploadToken } from './lib/uploads.ts';
import type { UserTokens } from './lib/userTokens.ts';
import type { AppInstallUrl, CreateUserRepo, ListInstalledRepos } from './lib/github.ts';
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
  // Jedes GitHub-Konto darf sich anmelden (OPEN_SIGNUP).
  openSignup: boolean;
  maxLogsPerOwner: number;
  baseUrl: string;
  http: Http;
  gh: GitHub;
  perms: Permissions;
  // Das GitHub-Nutzer-Token je Konto (Entscheidung 23). Nur create_log
  // benutzt es, und nur für POST /user/repos.
  users: UserTokens;
  createRepo: CreateUserRepo;
  // Vorschläge für „bestehendes Repo übernehmen“, ebenfalls mit dem Nutzer-Token.
  listRepos: ListInstalledRepos;
  // Die Installationsseite dieser App. Nur gefragt, wenn sie fehlt.
  installUrl: AppInstallUrl;
  // Called after a dashboard write action (Task 5, Task 6) commits
  // successfully -- the same reconcile the webhook otherwise triggers, only
  // right away instead of only after delivery.
  onRepoWrite(ref: RepoRef): void;
  // Wie onRepoWrite, nur abwartend: create_log darf erst antworten, wenn
  // der neue Log im Index steht -- sonst zeigt seine Antwort auf eine URL,
  // die noch 404 gibt.
  syncNow(ref: RepoRef): Promise<void>;
};

function currentAccount(req: IncomingMessage, auth: Auth): LoggedIn | null {
  return accountFromCookie(auth, req.headers.cookie);
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

// Wie readRawBody, aber für Routen, die eine Ablehnung noch beantworten
// können sollen: Die 413 geht raus, BEVOR die Verbindung fällt -- wer
// hochlädt, sieht sonst nur einen Abbruch ohne Grund. null heißt "schon
// beantwortet", nicht "leerer Body".
function readBodyWithin(
  req: import('node:http').IncomingMessage, res: ServerResponse, maxBytes: number,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Abbrechen statt weiterlesen: der Rest des Bodys nützt niemandem
        // mehr, und ihn trotzdem zu puffern wäre genau das, was die Grenze
        // verhindern soll.
        refused = true;
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!refused) resolve(Buffer.concat(chunks)); });
    // Nach req.destroy() folgt oft noch ein 'error' -- das ist der Abbruch,
    // den diese Funktion selbst ausgelöst hat, kein neuer Fehler.
    req.on('error', (err) => { if (!refused) reject(err); });
  });
}

export type CoreHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createApp(reader: Reader, hooks?: Hooks, auth?: Auth): Server {
  return createServer(createHandler(reader, hooks, auth));
}

// Der ganze Kern als eine Funktion über Nodes req/res: server.ts lauscht
// damit selbst (Tests, npm start), Nuxt ruft ihn für die Protokoll-Routen
// im selben Prozess auf (Entscheidung 24).
export function createHandler(reader: Reader, hooks?: Hooks, auth?: Auth): CoreHandler {
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
      ? buildMcpServer({
        db: auth.db, reader, perms: auth.perms, gh: auth.gh, onRepoWrite: auth.onRepoWrite,
        baseUrl: auth.baseUrl, users: auth.users, createRepo: auth.createRepo, syncNow: auth.syncNow,
        maxLogsPerOwner: auth.maxLogsPerOwner,
      })
      : () => new McpServer({ name: 'release-log-hub', version: '1.0.0' }),
  ));
  return async (req, res) => {
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

      // Der Weg zur Installation läuft über uns, nicht direkt auf
      // github.com: GitHub schickt nach der Installation auf die
      // Callback-URL zurück, und die verlangt einen state, der zu einem
      // Cookie passt. Ein Link, den die Oberfläche selbst setzt, könnte
      // beides nicht -- das Cookie ist HttpOnly. Also wird hier derselbe
      // state geprägt wie bei der Anmeldung und an die Installations-URL
      // gehängt, die GitHub unverändert zurückgibt.
      if (pathname === '/auth/github/install' && method === 'GET') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const page = await auth.installUrl();
        if (page === null) {
          // Ohne Adresse gibt es kein Ziel. Zurück, statt irgendwohin.
          res.writeHead(302, { location: '/dashboard' });
          res.end();
          return;
        }
        const state = randomBytes(32).toString('base64url');
        const target = new URL(page);
        target.searchParams.set('state', state);
        res.writeHead(302, {
          location: target.toString(),
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
        // A random, cookie-bound value an attacker can neither read nor guess
        // -- there is no secret here for a timing side-channel to extract, so
        // plain equality is deliberate, not an oversight (plan, "Abweichungen").
        if (!code || !state || !cookieState || state !== cookieState) {
          res.writeHead(302, { location: '/anmeldung?fehler=state' });
          res.end();
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
        let login;
        try {
          login = await exchangeCodeForLogin(
            auth.http, auth.clientId, auth.clientSecret, code, `${auth.baseUrl}/auth/github/callback`,
          );
        } catch {
          login = null;
        }
        if (!login) {
          res.writeHead(302, { location: '/anmeldung?fehler=github' });
          res.end();
          return;
        }

        const identity = login.identity;
        // The allowlist check runs before anything is written: a denied
        // person must leave zero trace -- no account row, no session cookie.
        if (!isAllowed(auth.db, identity.login, auth.adminLogins, auth.openSignup)) {
          res.writeHead(302, { location: '/anmeldung?fehler=denied' });
          res.end();
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

        // Das Nutzer-Token gehört zu dieser Anmeldung und ersetzt, was
        // vorher da lag (Entscheidung 23). Es steht verschlüsselt in der
        // Datenbank, nicht gehasht -- es wird benutzt, nicht geprüft.
        auth.users.store(identity.id, login.tokens);

        const rawNext = cookieValue(req.headers.cookie, 'login_next');
        let redirectLocation = '/dashboard';
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

      // Der Upload-Weg von add_media (spec §6): das Token in der URL IST
      // der Ausweis -- kein Cookie, kein Bearer. Es ist einmalig, zehn
      // Minuten gültig und an Log, Zielpfad und Konto gebunden, und was es
      // erlaubt, wird hier noch einmal live geprüft: ein Konto, dem das
      // Schreibrecht in der Zwischenzeit entzogen wurde, lädt nicht hoch.
      const uploadMatch = /^\/upload\/([A-Za-z0-9_-]+)$/.exec(pathname);
      if (uploadMatch && method === 'PUT') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const redeemed = redeemUploadToken(auth.db, uploadMatch[1]);
        if (!redeemed.ok) {
          // Unbekannt, abgelaufen, schon benutzt -- eine Antwort für alle
          // drei. Was davon zutrifft, hilft nur dem, der rät.
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'invalid_token', message: 'this upload URL is unknown, expired or already used; call add_media again' }));
          return;
        }
        const { logId, path: mediaPath, accountId, contentType } = redeemed.value;
        const row = auth.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
        if (!row) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        if (row.state === 'frozen') {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'log_frozen' }));
          return;
        }
        const uploader = auth.db.select().from(account).where(eq(account.githubUserId, accountId)).all()[0];
        const ref = { owner: row.repoOwner, repo: row.repoName };
        const allowed = uploader !== undefined
          && await auth.perms.canWrite(accountId, uploader.login, row.publicId, ref);
        if (!allowed) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          return;
        }

        const bytes = await readBodyWithin(req, res, MEDIA_MAX_BYTES);
        if (bytes === null) return;
        if (bytes.length === 0) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'empty_body' }));
          return;
        }
        // Denselben expectedSha-null-Grund wie beim Dashboard-Upload: ein
        // Bild wird angelegt, nie ersetzt.
        const result = await auth.gh.putFile(ref, mediaPath, bytes, `add ${mediaPath} via MCP`, null);
        if (result.kind === 'conflict') {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'path_exists' }));
          return;
        }
        if (result.kind === 'no_installation') {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'no_installation' }));
          return;
        }
        auth.onRepoWrite(ref);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: mediaPath, content_type: contentType, commit_sha: result.sha }));
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

      // Die Zustimmungsseite (GET) rendert Nuxt über lib/api/consent.ts;
      // hier wird nur die Entscheidung eingelöst.
      if (pathname === '/oauth/authorize' && method === 'POST') {
        if (!auth) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        const params = await readFormBody(req);
        const check = checkAuthorizeRequest(auth, 'POST', params, url.search.slice(1), currentAccount(req, auth));
        if (check.kind === 'error') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'invalid_request', error_description: check.reason }));
          return;
        }
        if (check.kind === 'redirect' || check.kind === 'login') {
          res.writeHead(302, { location: check.location });
          res.end();
          return;
        }
        const { client, redirectUri, state, scope, codeChallenge, who } = check;

        if (params.get('decision') !== 'allow') {
          res.writeHead(302, { location: denyLocation(redirectUri, state) });
          res.end();
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
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8787);
  const { reader, hooks, auth, dbPath } = bootCore(process.env);
  // Bind an explicit address: without a host Node listens on :: and takes
  // IPv4 only while nothing else holds it, so a busy port turns into a
  // silent IPv6-only start instead of an error (spec §12).
  createServer(createHandler(reader, hooks, auth)).listen(port, '127.0.0.1', () => {
    console.log(`release-log-hub on http://127.0.0.1:${port}, index at ${dbPath}`);
  });
}
