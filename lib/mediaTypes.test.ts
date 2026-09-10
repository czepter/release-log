import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaTypeOf } from './mediaTypes.ts';

test('mediaTypeOf maps the allowed extensions', () => {
  assert.equal(mediaTypeOf('media/shot.png'), 'image/png');
  assert.equal(mediaTypeOf('media/shot.jpg'), 'image/jpeg');
  assert.equal(mediaTypeOf('media/shot.webp'), 'image/webp');
});

test('mediaTypeOf is case-insensitive', () => {
  assert.equal(mediaTypeOf('media/SHOT.PNG'), 'image/png');
});

test('mediaTypeOf rejects anything else', () => {
  assert.equal(mediaTypeOf('media/notes.txt'), null);
  assert.equal(mediaTypeOf('media/noextension'), null);
});
