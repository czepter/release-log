import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCorePath } from './corePaths.ts';

// Fällt, wenn die gehostete Seite /l/<id> an den Kern geht (dort gibt es
// sie nicht mehr) oder die JSON-Fläche an Nuxt fällt.
test('the hosted log page is Nuxt, its JSON and media are the core', () => {
  assert.equal(isCorePath('GET', '/l/abc'), false);
  assert.equal(isCorePath('GET', '/l/abc/'), false);
  assert.equal(isCorePath('GET', '/l/abc/r/1.0.0'), false);
  assert.equal(isCorePath('GET', '/l/abc/versions'), true);
  assert.equal(isCorePath('GET', '/l/abc/releases'), true);
  assert.equal(isCorePath('GET', '/l/abc/releases/1.0.0'), true);
  assert.equal(isCorePath('GET', '/l/abc/media/a%20b.png'), true);
  assert.equal(isCorePath('GET', '/l/abc/mediax'), false);
});

test('protocol routes are the core, pages and the page API are Nuxt', () => {
  for (const path of ['/health', '/webhook', '/mcp', '/me', '/auth/github/login', '/auth/github/callback', '/auth/logout', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/upload/tok', '/oauth/register', '/oauth/token']) {
    assert.equal(isCorePath('POST', path), true, path);
  }
  for (const path of ['/', '/dashboard', '/dashboard/logs/abc', '/konto', '/api/logs', '/anmeldung', '/_nuxt/entry.js']) {
    assert.equal(isCorePath('GET', path), false, path);
  }
});

test('the consent screen is Nuxt, its submission is the core', () => {
  assert.equal(isCorePath('GET', '/oauth/authorize'), false);
  assert.equal(isCorePath('POST', '/oauth/authorize'), true);
});
