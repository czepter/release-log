import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/client.ts';
import { oauthClient } from './db/schema.ts';
import { eq } from 'drizzle-orm';
import { registerClient } from './oauth.ts';

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-oauth-'));
  try {
    fn(openDb(join(dir, 'test.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registers a client with a valid https redirect_uri', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['https://client.example/cb'], client_name: 'Test Client' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.clientName, 'Test Client');
    assert.deepEqual(result.value.redirectUris, ['https://client.example/cb']);
    const row = db.select().from(oauthClient).where(eq(oauthClient.clientId, result.value.clientId)).all()[0];
    assert.ok(row, 'the client must actually be persisted');
    assert.deepEqual(JSON.parse(row.redirectUris), ['https://client.example/cb']);
  });
});

test('a loopback http redirect_uri is accepted (RFC 8252 native clients)', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['http://127.0.0.1:51234/cb'] });
    assert.equal(result.ok, true);
  });
});

test('a plain http redirect_uri on a non-loopback host is rejected', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['http://client.example/cb'] });
    assert.equal(result.ok, false);
  });
});

test('an empty redirect_uris list is rejected, and nothing is persisted', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: [] });
    assert.equal(result.ok, false);
    assert.equal(db.select().from(oauthClient).all().length, 0);
  });
});

test('a missing client_name defaults to a placeholder, never crashes', () => {
  withDb((db) => {
    const result = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.clientName, 'Unnamed MCP client');
  });
});

test('two registrations produce two distinct client ids', () => {
  withDb((db) => {
    const a = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    const b = registerClient(db, { redirect_uris: ['https://client.example/cb'] });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.value.clientId, b.value.clientId);
  });
});
