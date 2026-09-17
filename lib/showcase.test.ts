import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShowcaseUrl, loadShowcase } from './showcase.ts';

const BASE = 'https://releases.example.com/l/abc123';
const FEED = `${BASE}/releases?per_page=3`;
const COUNTS = [{ key: 'new', label: 'Neu', count: 2 }];

function item(version: string) {
  return {
    version, tag: `v${version}`, date: '2026-09-17', published_at: '2026-09-17T09:00:00Z', commits: 2,
    headline: `H ${version}`, body: ['B'], url: `/l/abc123/releases/${version}`, image: null, sections: COUNTS,
  };
}
function feed(...versions: string[]) {
  return { product: 'Demo', page: 1, per_page: 3, total: versions.length, total_pages: 1, releases: versions.map(item) };
}
const ENTRY = {
  type: 'feat', breaking: false, scope: 'dashboard', title: 'T', description: 'D',
  pr: null, issues: [], commit: 'abc1234', date: '2026-09-17',
};
function detail(version: string, src = '/l/abc123/media/shot%201.png') {
  return { ...item(version), image: { src, alt: 'Screenshot' }, sections: [{ key: 'new', label: 'Neu', items: [ENTRY] }] };
}

type Route = { status?: number; body?: unknown; raw?: string; error?: Error };
function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('{"error":"not_found"}', { status: 404 });
    if (route.error) throw route.error;
    return new Response(route.raw ?? JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

test('parseShowcaseUrl liest Origin und Log-Kennung, mit und ohne abschließenden Schrägstrich', () => {
  const expected = { origin: 'https://releases.example.com', logId: 'abc123', pageUrl: BASE };
  assert.deepEqual(parseShowcaseUrl(BASE), expected);
  assert.deepEqual(parseShowcaseUrl(`${BASE}/`), expected);
});

test('parseShowcaseUrl lehnt alles ab, was keine Log-Seite über http(s) ist', () => {
  for (const raw of [undefined, '', '   ', 'keine url', 'ftp://x.example/l/abc', 'https://x.example/l/abc/r/1.0.0', 'https://x.example/dashboard', 'https://x.example/l/']) {
    assert.equal(parseShowcaseUrl(raw), null, String(raw));
  }
});

test('loadShowcase: neuestes Release mit Einträgen, ältere mit Zählern, alle Links auf die Quelle', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { impl, calls } = fakeFetch({
    [FEED]: { body: feed('0.3.0', '0.2.0', '0.1.0', '0.0.1') },
    [`${BASE}/releases/0.3.0`]: { body: detail('0.3.0') },
  });
  const showcase = await loadShowcase(BASE, impl);
  assert.ok(showcase);
  assert.equal(showcase.product, 'Demo');
  assert.equal(showcase.pageUrl, BASE);
  assert.equal(showcase.feedUrl, `${BASE}/releases`);
  assert.deepEqual(showcase.latest.sections, [{ key: 'new', label: 'Neu', items: [ENTRY] }]);
  assert.deepEqual(showcase.latest.image, { src: 'https://releases.example.com/l/abc123/media/shot%201.png', alt: 'Screenshot' });
  assert.equal(showcase.latest.href, `${BASE}/r/0.3.0`);
  assert.deepEqual(
    showcase.older.map((o) => [o.version, o.href, o.headline, o.sections]),
    [['0.2.0', `${BASE}/r/0.2.0`, 'H 0.2.0', COUNTS], ['0.1.0', `${BASE}/r/0.1.0`, 'H 0.1.0', COUNTS]],
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.init?.signal instanceof AbortSignal), 'jeder Abruf hat ein Zeitlimit');
});

test('loadShowcase kodiert die Version im Detailpfad', async () => {
  const version = '1.0.0-beta+1';
  const { impl, calls } = fakeFetch({
    [FEED]: { body: feed(version) },
    [`${BASE}/releases/1.0.0-beta%2B1`]: { body: detail(version) },
  });
  const showcase = await loadShowcase(BASE, impl);
  assert.equal(calls[1]?.url, `${BASE}/releases/1.0.0-beta%2B1`);
  assert.equal(showcase?.latest.href, `${BASE}/r/1.0.0-beta%2B1`);
});

test('loadShowcase verwirft ein Bild, dessen Adresse kein http(s) ist', async () => {
  const { impl } = fakeFetch({
    [FEED]: { body: feed('0.3.0') },
    [`${BASE}/releases/0.3.0`]: { body: detail('0.3.0', 'javascript:alert(1)') },
  });
  assert.equal((await loadShowcase(BASE, impl))?.latest.image, null);
});

test('loadShowcase ohne gültige Variable fragt nichts ab', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { impl, calls } = fakeFetch({});
  assert.equal(await loadShowcase(undefined, impl), null);
  assert.equal(await loadShowcase('https://x.example/dashboard', impl), null);
  assert.equal(calls.length, 0);
});

test('loadShowcase liefert null bei leerem Feed, ohne Detailabruf', async () => {
  const { impl, calls } = fakeFetch({ [FEED]: { body: feed() } });
  assert.equal(await loadShowcase(BASE, impl), null);
  assert.equal(calls.length, 1);
});

test('loadShowcase liefert null bei jedem Fehler der Quelle', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const cases: Record<string, Record<string, Route>> = {
    'Feed 500': { [FEED]: { status: 500, body: {} } },
    'Feed 404 (privat)': {},
    'Status ≠ 200 trotz Feed-Körper': { [FEED]: { status: 203, body: feed('0.3.0') }, [`${BASE}/releases/0.3.0`]: { body: detail('0.3.0') } },
    'Zeitlimit': { [FEED]: { error: new DOMException('timeout', 'TimeoutError') } },
    'kaputtes JSON': { [FEED]: { raw: 'nicht json' } },
    'Feed ohne releases': { [FEED]: { body: { product: 'Demo' } } },
    'Detail 404': { [FEED]: { body: feed('0.3.0') } },
    'Detail ohne sections': { [FEED]: { body: feed('0.3.0') }, [`${BASE}/releases/0.3.0`]: { body: { version: '0.3.0' } } },
  };
  for (const [name, routes] of Object.entries(cases)) {
    assert.equal(await loadShowcase(BASE, fakeFetch(routes).impl), null, name);
  }
});
