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
