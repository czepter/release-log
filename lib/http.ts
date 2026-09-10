// One seam for everything that touches the network. Production passes the
// global fetch; tests pass fakeHttp, so no test in this project opens a
// socket to GitHub.

export type Http = (url: string, init?: RequestInit) => Promise<Response>;

export type FakeRoute = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

function keyOf(url: string, init?: RequestInit): string {
  const parsed = new URL(url);
  // fetch uppercases the method before it goes on the wire. Without the same
  // normalisation here, a caller writing `method: 'post'` would 404 against the
  // fake and succeed against the real API.
  const method = (init?.method ?? 'GET').toUpperCase();
  return `${method} ${parsed.pathname}${parsed.search}`;
}

export function fakeHttp(
  routes: Record<string, FakeRoute | FakeRoute[]>,
): Http & { calls: string[] } {
  const calls: string[] = [];
  const cursors = new Map<string, number>();

  const http = async (url: string, init?: RequestInit): Promise<Response> => {
    const key = keyOf(url, init);
    calls.push(key);
    const route = routes[key];
    if (route === undefined) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    let chosen: FakeRoute;
    if (Array.isArray(route)) {
      const index = cursors.get(key) ?? 0;
      // Past the end, the last entry repeats: a retry test wants "still
      // failing", not "undefined".
      chosen = route[Math.min(index, route.length - 1)];
      cursors.set(key, index + 1);
    } else {
      chosen = route;
    }
    return new Response(chosen.body === undefined ? null : JSON.stringify(chosen.body), {
      status: chosen.status ?? 200,
      headers: { 'content-type': 'application/json', ...(chosen.headers ?? {}) },
    });
  };

  return Object.assign(http, { calls });
}

// Bounded patience. GitHub answers a spent rate limit with 403 plus the
// second at which it resets, and a secondary limit with 429 plus
// Retry-After; a 5xx is worth one more try. Everything else is an answer,
// not a delay (spec §10).

const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
// Longer than this and waiting would block the sync for minutes. Report
// the failure and let the caller decide.
const MAX_WAIT_MS = 60_000;

function waitFor(res: Response, attempt: number, nowMs: () => number): number | null {
  if (res.status === 429) {
    // headers.get returns null, not a missing key, when the header is
    // absent — and Number(null) is 0, a finite number that would pass the
    // guard below and be honoured as a zero-millisecond wait. Check for
    // absence before ever calling Number() on it.
    const afterHeader = res.headers.get('retry-after');
    if (afterHeader === null) return BASE_BACKOFF_MS;
    const after = Number(afterHeader);
    return Number.isFinite(after) && after >= 0 ? after * 1000 : BASE_BACKOFF_MS;
  }
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const resetHeader = res.headers.get('x-ratelimit-reset');
    if (resetHeader === null) return BASE_BACKOFF_MS;
    const reset = Number(resetHeader);
    if (!Number.isFinite(reset)) return BASE_BACKOFF_MS;
    return Math.max(0, reset * 1000 - nowMs());
  }
  if (res.status >= 500) return BASE_BACKOFF_MS * 2 ** attempt;
  return null;
}

export function withRetry(
  http: Http,
  options: { attempts?: number; sleep?: (ms: number) => Promise<void>; nowMs?: () => number } = {},
): Http {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = options.nowMs ?? Date.now;

  return async (url, init) => {
    let last = await http(url, init);
    for (let attempt = 0; attempt < attempts - 1; attempt += 1) {
      const wait = waitFor(last, attempt, nowMs);
      if (wait === null || wait > MAX_WAIT_MS) return last;
      await sleep(wait);
      last = await http(url, init);
    }
    return last;
  };
}
