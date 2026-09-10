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

test('a name that is nothing but an extension is a dotfile, not an image', () => {
  // The gate this feeds used node:path extname, which does not treat a bare
  // leading dot as an extension. Serving "media/.png" would be a widening.
  assert.equal(mediaTypeOf('media/.png'), null);
});

test('a dot in a directory name is not an extension', () => {
  assert.equal(mediaTypeOf('media/v1.2/shot.png'), 'image/png');
  assert.equal(mediaTypeOf('media/v1.png/notes'), null);
});
