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
