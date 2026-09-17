import { loadShowcase } from '../../../lib/showcase.ts'

// Fünf Minuten Cache, auch für ein Nein: ein toter Quellserver kostet so
// höchstens einen Abruf alle fünf Minuten. Das Objekt drumherum, weil ein
// nackter null-Body im Cache wie ein fehlender Eintrag aussehen kann.
// Im Dev-Modus liegt Nitros Cache auf der Platte und überlebt einen
// Neustart mit geänderter RL_SHOWCASE_URL; dort wird er übersprungen.
export default defineCachedEventHandler(
  async () => ({ showcase: await loadShowcase(process.env.RL_SHOWCASE_URL, fetch) }),
  { name: 'showcase', maxAge: 300, shouldBypassCache: () => import.meta.dev },
)
