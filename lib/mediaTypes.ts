// One definition of what counts as media, shared by the sync that stores
// it and the readers that serve it. Two copies drifted apart once: the
// sync lower-cased the extension and the file reader did not, so
// "shot.PNG" was found by one and missed by the other.

export const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function mediaTypeOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  return MEDIA_TYPES[path.slice(dot).toLowerCase()] ?? null;
}
