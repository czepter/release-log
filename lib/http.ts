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
