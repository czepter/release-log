// One definition of what counts as media, shared by the sync that stores
// it and the readers that serve it. Two copies drifted apart once: the
// sync lower-cased the extension and the file reader did not, so
// "shot.PNG" was found by one and missed by the other.

import { extname } from 'node:path';

export const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

// extname, not a hand-rolled lastIndexOf: it scans the basename rather than
// the whole path, and it agrees with the file reader's previous gate on a
// name that is nothing but an extension — ".png" is a dotfile, not an image.
export function mediaTypeOf(path: string): string | null {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? null;
}
