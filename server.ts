// The only file with a socket. Everything it decides is decided in
// lib/public.ts, with one exception: the media route below checks
// config.visibility itself. A media response is bytes, not a route() reply,
// so there is no JSON shape to carry that decision through — the check has
// to live here, in transport, where the bytes actually get written.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { route } from './lib/public.ts';
import { fileReader } from './lib/store.ts';
import type { Reader } from './lib/store.ts';

const MEDIA_CACHE = 'public, max-age=31536000, immutable';
const JSON_CACHE = 'public, max-age=60';

export function createApp(reader: Reader): Server {
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

    // Viewer is 'public' until sessions exist (Plan 3). Drafts and private
    // logs stay invisible until then, which is the safe direction.
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
  const root = process.env.LOGS_ROOT ?? './logs';
  const port = Number(process.env.PORT ?? 8787);
  // Bind an explicit address: without a host Node listens on :: and takes
  // IPv4 only while nothing else holds it, so a busy port turns into a
  // silent IPv6-only start instead of an error (spec §12).
  createApp(fileReader(root)).listen(port, '127.0.0.1', () => {
    console.log(`release-log-hub on http://127.0.0.1:${port}, logs from ${root}`);
  });
}
