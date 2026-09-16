// Die gehostete Seite eines Logs, als Daten für die Nuxt-Seite. Dieselben
// Regeln wie die JSON-Fläche (lib/public.ts): privat und fehlend antworten
// identisch, Entwürfe sieht nur, wer ins Repo schreiben darf (spec §7).

import { eq } from 'drizzle-orm';
import { log } from '../db/schema.ts';
import type { Viewer } from '../public.ts';
import { detail } from '../public.ts';
import { sortReleases } from '../order.ts';
import type { LoggedIn } from '../access.ts';
import type { Core, Reply } from './core.ts';
import { ok, fail } from './core.ts';

const NOT_FOUND = fail(404, 'not_found', 'not found');

export async function viewerFor({ auth }: Core, who: LoggedIn | null, logId: string): Promise<Viewer> {
  if (!who) return 'public';
  const row = auth.db.select().from(log).where(eq(log.publicId, logId)).all()[0];
  if (!row) return 'public';
  return await auth.perms.canWrite(who.accountId, who.login, row.publicId, { owner: row.repoOwner, repo: row.repoName }) ? 'member' : 'public';
}

function visibleLog({ reader }: Core, viewer: Viewer, logId: string) {
  const config = reader.config(logId);
  if (!config || (config.visibility === 'private' && viewer !== 'member')) return null;
  const all = reader.releases(logId);
  return { config, releases: sortReleases(viewer === 'member' ? all : all.filter((r) => r.published_at !== null)) };
}

function head(config: { id: string; product: string; view: string; visibility: string }) {
  return { id: config.id, product: config.product, view: config.view, visibility: config.visibility };
}

export function publicLog(core: Core, viewer: Viewer, logId: string): Reply {
  const found = visibleLog(core, viewer, logId);
  if (!found) return NOT_FOUND;
  return ok({ log: head(found.config), releases: found.releases.map((r) => detail(r, found.config)) });
}

export function publicRelease(core: Core, viewer: Viewer, logId: string, version: string): Reply {
  const found = visibleLog(core, viewer, logId);
  const release = found?.releases.find((r) => r.version === version);
  if (!found || !release) return NOT_FOUND;
  return ok({ log: head(found.config), release: detail(release, found.config) });
}
