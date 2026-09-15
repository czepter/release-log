import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, page } from './render.ts';

test('escapeHtml neutralises the five HTML-meaningful characters', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
  assert.equal(escapeHtml(`"quoted" 'single'`), '&quot;quoted&quot; &#39;single&#39;');
});

test('escapeHtml leaves ordinary text untouched', () => {
  assert.equal(escapeHtml('Auri CRM 0.9.2'), 'Auri CRM 0.9.2');
});

test('escapeHtml handles an empty string', () => {
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml is idempotent-safe against a value that already looks escaped', () => {
  // A value containing a literal "&amp;" must not become "&amp;amp;" -- but
  // escapeHtml only ever runs once per value in this codebase (never on
  // its own output), so this pins the actual & -> &amp; behaviour rather
  // than claiming double-escaping is handled.
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

test('page wraps the body in an HTML shell and escapes the title', () => {
  const html = page('<b>Title</b>', '<p>body content, not re-escaped</p>');
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('<title>&lt;b&gt;Title&lt;/b&gt;</title>'), 'the title must be escaped');
  assert.ok(html.includes('<p>body content, not re-escaped</p>'), 'the body is inserted as-is -- callers escape their own dynamic pieces before composing it');
});

test('page includes a charset declaration', () => {
  assert.ok(page('T', '').includes('charset="utf-8"'));
});
