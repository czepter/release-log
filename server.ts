// The only file with a socket. Everything it decides is decided in
// lib/public.ts, with one exception: the media route below checks
// config.visibility itself. A media response is bytes, not a route() reply,
// so there is no JSON shape to carry that decision through — the check has
// to live here, in transport, where the bytes actually get written.

import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { route } from './lib/public.ts';
import type { Reader } from './lib/store.ts';
import { verifySignature, refsFor, permissionInvalidationRefsFor } from './lib/webhook.ts';
import type { RepoRef } from './lib/github.ts';
import { openDb } from './lib/db/client.ts';
import type { Db } from './lib/db/client.ts';
import { account, log, syncError } from './lib/db/schema.ts';
import { eq } from 'drizzle-orm';
import { escapeHtml, page } from './lib/render.ts';
import type { GitHub } from './lib/github.ts';
import type { Permissions } from './lib/permissions.ts';
import { indexReader } from './lib/indexReader.ts';
import { readConfig } from './lib/config.ts';
import { installations } from './lib/appAuth.ts';
import { githubClient } from './lib/github.ts';
import { withRetry } from './lib/http.ts';
import type { Http } from './lib/http.ts';
import { createSessionCookie, verifySessionCookie, isAdmin, isAllowed, SESSION_MAX_AGE_SECONDS } from './lib/session.ts';
import { exchangeCodeForIdentity } from './lib/login.ts';
import { permissions } from './lib/permissions.ts';
import { syncLog } from './lib/index.ts';
import { syncQueue } from './lib/syncQueue.ts';
import { startReconcile } from './lib/reconcile.ts';

const MEDIA_CACHE = 'public, max-age=31536000, immutable';
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

function htmlPage(title: string, body: string): string {
  return `<!doctype html><title>${title}</title><p>${body}</p>`;
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

export function createApp(reader: Reader, hooks?: Hooks, auth?: Auth): Server {
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
        // A random, cookie-bound value an attacker can neither read nor guess
        // -- there is no secret here for a timing side-channel to extract, so
        // plain equality is deliberate, not an oversight (plan, "Abweichungen").
        if (!code || !state || !cookieState || state !== cookieState) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
          res.end(htmlPage('Anmeldung fehlgeschlagen', 'Der Anmeldevorgang ist ungültig oder abgelaufen. Bitte erneut versuchen.'));
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
          res.end(htmlPage('GitHub nicht erreichbar', 'Die Anmeldung bei GitHub ist fehlgeschlagen. Bitte erneut versuchen.'));
          return;
        }

        // The allowlist check runs before anything is written: a denied
        // person must leave zero trace -- no account row, no session cookie.
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

      // Viewer is 'public' until sessions exist. Drafts and private logs stay
      // invisible until then, which is the safe direction.
      const viewer = 'public';

      // url.pathname is percent-encoded (new URL never decodes it), so a media
      // filename with a space or non-ASCII character only matches the file on
      // disk once decoded. Decode the captured path exactly once, here, and
      // never transform it again — a second decode is how a path guard gets
      // bypassed (%252e%252e%252f survives one decode as %2e%2e%2f, and a
      // second decode turns that into ../). decodeURIComponent throws on
      // malformed input like %zz; that is a 404, not a crashed request.
      const media = /^\/l\/([^/]+)\/media\/(.+)$/.exec(pathname);
      if (media && (method === 'GET' || method === 'HEAD')) {
        let mediaPath: string;
        try {
          mediaPath = decodeURIComponent(media[2]);
        } catch {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'not_found' }));
          return;
        }

        // media[1] (the log id) is looked up undecoded, unlike mediaPath above.
        // That is deliberate, not an oversight: undecoded is the safe
        // direction here, since a decode could only ever turn a non-matching
        // id into a different non-matching id. route() below makes the same
        // choice for the log id segment it extracts from pathname. Do not
        // add a decode here to "match" the media path -- that would be a
        // second decode on a segment nothing has decoded once yet.
        const config = reader.config(media[1]);
        const blob = config && config.visibility === 'public'
          ? reader.media(media[1], mediaPath)
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
