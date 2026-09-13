// The only file with a socket. Everything it decides is decided in
// lib/public.ts, with one exception: the media route below checks
// config.visibility itself. A media response is bytes, not a route() reply,
// so there is no JSON shape to carry that decision through — the check has
// to live here, in transport, where the bytes actually get written.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { route } from './lib/public.ts';
import type { Reader } from './lib/store.ts';
import { verifySignature, refsFor } from './lib/webhook.ts';
import type { RepoRef } from './lib/github.ts';
import { openDb } from './lib/db/client.ts';
import { indexReader } from './lib/indexReader.ts';
import { readConfig } from './lib/config.ts';
import { installations } from './lib/appAuth.ts';
import { githubClient } from './lib/github.ts';
import { withRetry } from './lib/http.ts';
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
};

export function createApp(reader: Reader, hooks?: Hooks): Server {
  return createServer((req, res) => {
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
        const body = Buffer.concat(chunks);
        // Verify before parsing (spec §10). Everything below this line
        // handles bytes known to have come from GitHub; everything above it
        // only touches them to count them.
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
        res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ accepted: true }));
      });
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
  });
}

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
