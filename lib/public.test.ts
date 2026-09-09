import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from './public.ts';
import type { Reader } from './store.ts';
import type { LogConfig, ReleaseDoc, Change } from './document.ts';

const CONFIG: LogConfig = {
  id: 'abc123', product: 'Demo', view: 'full',
  visibility: 'public', curation_notes: null,
};

function change(type: 'feat' | 'fix', breaking = false): Change {
  return {
    type, breaking, scope: null, title: 'T', description: 'D',
    pr: null, issues: [], commit: 'abc1234', date: '2026-01-01',
  };
}

function rel(version: string, date: string, published: boolean, changes: Change[] = []): ReleaseDoc {
  return {
    version, tag: null, date,
    published_at: published ? `${date}T00:00:00Z` : null,
    commits: 1, headline: `H ${version}`, body: ['B'],
    image: { src: 'media/x.png', alt: 'a' }, covered: ['deadbeef'], changes,
  };
}

function reader(config: LogConfig, releases: ReleaseDoc[]): Reader {
  return {
    config: (id) => (id === config.id ? config : null),
    releases: (id) => (id === config.id ? releases : []),
    media: () => null,
    errors: () => [],
    problems: () => [],
    etag: () => null,
  };
}

const P = new URLSearchParams();

test('versions lists published releases newest first', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true), rel('1.1.0', '2026-02-01', true)]);
  const reply = route('GET', '/l/abc123/versions', P, r, 'public');
  assert.equal(reply.status, 200);
  const body = reply.body as { latest: string; versions: { version: string }[] };
  assert.equal(body.latest, '1.1.0');
  assert.deepEqual(body.versions.map((v) => v.version), ['1.1.0', '1.0.0']);
});

test('versions hides drafts from the public', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true), rel('1.1.0', '2026-02-01', false)]);
  const body = route('GET', '/l/abc123/versions', P, r, 'public').body as { versions: unknown[] };
  assert.equal(body.versions.length, 1);
});

test('versions shows drafts to a member', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true), rel('1.1.0', '2026-02-01', false)]);
  const body = route('GET', '/l/abc123/versions', P, r, 'member').body as { versions: unknown[] };
  assert.equal(body.versions.length, 2);
});

test('a member\'s latest skips a draft newer than the newest published release', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true), rel('1.1.0', '2026-02-01', false)]);
  const body = route('GET', '/l/abc123/versions', P, r, 'member').body as { latest: string };
  // The draft 1.1.0 sorts first by date; latest must still be the newest
  // published release. Picking sorted[0] unconditionally for a member (the
  // bug) would report '1.1.0' here instead.
  assert.equal(body.latest, '1.0.0');
});

test('a release detail carries sections and never carries covered', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true, [change('feat'), change('fix', true)])]);
  const reply = route('GET', '/l/abc123/releases/1.0.0', P, r, 'public');
  assert.equal(reply.status, 200);
  const body = reply.body as Record<string, unknown>;
  assert.equal('covered' in body, false);
  const sections = body.sections as { key: string }[];
  assert.deepEqual(sections.map((s) => s.key), ['important', 'new']);
});

test('a release detail absolutises the image path', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true)]);
  const body = route('GET', '/l/abc123/releases/1.0.0', P, r, 'public').body as
    { image: { src: string } };
  assert.equal(body.image.src, '/l/abc123/media/media/x.png');
});

test('the image URL encodes path segments and decodes back to the source path', () => {
  const withSpecialImage: ReleaseDoc = {
    ...rel('1.0.0', '2026-01-01', true),
    image: { src: 'media/my file 100%.png', alt: 'a' },
  };
  const r = reader(CONFIG, [withSpecialImage]);
  const body = route('GET', '/l/abc123/releases/1.0.0', P, r, 'public').body as { image: { src: string } };
  const prefix = '/l/abc123/media/';
  assert.equal(body.image.src.startsWith(prefix), true);
  assert.equal(decodeURIComponent(body.image.src.slice(prefix.length)), 'media/my file 100%.png');
});

test('a release whose version contains a space round-trips through both emitted urls', () => {
  const r = reader(CONFIG, [rel('r 42', '2026-01-01', true)]);

  // Both emitters (detail() and the versions list) have to encode the
  // version, not just the image path. Asserting the literal encoded string
  // catches a missing encodeURIComponent -- a raw space would leave the
  // url unchanged and this equality would fail.
  const detailBody = route('GET', '/l/abc123/releases/r 42', P, r, 'public').body as
    { url: string };
  assert.equal(detailBody.url, '/l/abc123/releases/r%2042');

  const versionsBody = route('GET', '/l/abc123/versions', P, r, 'public').body as
    { versions: { url: string }[] };
  assert.equal(versionsBody.versions[0].url, '/l/abc123/releases/r%2042');

  // Feeding the emitted url straight back into route() proves route()
  // decodes the captured segment: without that decode, one[1] would stay
  // "r%2042" and never match the stored version "r 42", so this would 404.
  const reply = route('GET', versionsBody.versions[0].url, P, r, 'public');
  assert.equal(reply.status, 200);
  assert.equal((reply.body as { version: string }).version, 'r 42');
});

test('a malformed escape in the version segment answers 404 instead of throwing', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true)]);
  // decodeURIComponent('%zz') throws URIError; without the try/catch this
  // would propagate out of route() and crash the request instead of 404ing.
  const reply = route('GET', '/l/abc123/releases/%zz', P, r, 'public');
  assert.equal(reply.status, 404);
});

test('a draft detail is 404 for the public and 200 for a member', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', false)]);
  assert.equal(route('GET', '/l/abc123/releases/1.0.0', P, r, 'public').status, 404);
  assert.equal(route('GET', '/l/abc123/releases/1.0.0', P, r, 'member').status, 200);
});

test('a private log is 404 for the public, exactly like a missing one', () => {
  const r = reader({ ...CONFIG, visibility: 'private' }, [rel('1.0.0', '2026-01-01', true)]);
  assert.equal(route('GET', '/l/abc123/versions', P, r, 'public').status, 404);
  assert.equal(route('GET', '/l/nosuch/versions', P, r, 'public').status, 404);
  assert.equal(route('GET', '/l/abc123/versions', P, r, 'member').status, 200);
});

test('a non-GET method is 405', () => {
  const r = reader(CONFIG, []);
  assert.equal(route('POST', '/l/abc123/versions', P, r, 'public').status, 405);
});

test('health answers without a log', () => {
  const r = reader(CONFIG, []);
  const reply = route('GET', '/health', P, r, 'public');
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { status: 'ok' });
});

function many(n: number): ReleaseDoc[] {
  return Array.from({ length: n }, (_, i) =>
    rel(`1.${i}.0`, `2026-01-${String(i + 1).padStart(2, '0')}`, true, [change('feat')]));
}

test('the feed carries counts per section, not entries', () => {
  const r = reader(CONFIG, [rel('1.0.0', '2026-01-01', true, [change('feat'), change('fix')])]);
  const body = route('GET', '/l/abc123/releases', P, r, 'public').body as
    { releases: { sections: { key: string; count: number }[] }[] };
  assert.deepEqual(body.releases[0].sections, [
    { key: 'new', label: 'Neu', count: 1 },
    { key: 'fixed', label: 'Behoben', count: 1 },
  ]);
});

test('the feed defaults to ten per page', () => {
  const body = route('GET', '/l/abc123/releases', P, reader(CONFIG, many(25)), 'public').body as
    { page: number; per_page: number; total: number; total_pages: number; releases: unknown[] };
  assert.equal(body.per_page, 10);
  assert.equal(body.page, 1);
  assert.equal(body.total, 25);
  assert.equal(body.total_pages, 3);
  assert.equal(body.releases.length, 10);
});

test('the feed honours page and per_page', () => {
  const params = new URLSearchParams({ page: '2', per_page: '5' });
  const body = route('GET', '/l/abc123/releases', params, reader(CONFIG, many(12)), 'public').body as
    { releases: { version: string }[] };
  assert.equal(body.releases.length, 5);
  assert.equal(body.releases[0].version, '1.6.0');
});

test('a page beyond the end is empty, not an error', () => {
  const params = new URLSearchParams({ page: '9' });
  const reply = route('GET', '/l/abc123/releases', params, reader(CONFIG, many(3)), 'public');
  assert.equal(reply.status, 200);
  assert.deepEqual((reply.body as { releases: unknown[] }).releases, []);
});

test('bad pagination values are 400', () => {
  const r = reader(CONFIG, many(3));
  const bads: Record<string, string>[] = [{ page: '0' }, { page: '-1' }, { page: 'x' }, { per_page: '101' }];
  for (const bad of bads) {
    const reply = route('GET', '/l/abc123/releases', new URLSearchParams(bad), r, 'public');
    assert.equal(reply.status, 400, JSON.stringify(bad));
  }
});
