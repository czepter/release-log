// Welche Anfragen der Kern selbst beantwortet (Spec, Entscheidung 26).
// Alles andere rendert Nuxt. Maschinen-Clients -- MCP, OAuth, GitHub,
// Einbindungen des JSON -- sehen dadurch dieselben Verträge wie vorher.

const LOG_DATA = /^\/l\/[^/]+\/(versions|releases|media)(\/|$)/;

export function isCorePath(method: string, rawPathname: string): boolean {
  const pathname = rawPathname.replace(/\/+$/, '') || '/';
  if (pathname === '/health' || pathname === '/webhook' || pathname === '/mcp' || pathname === '/me') return true;
  if (pathname.startsWith('/auth/') || pathname.startsWith('/.well-known/') || pathname.startsWith('/upload/')) return true;
  if (pathname === '/oauth/register' || pathname === '/oauth/token') return true;
  // Die Zustimmung zeigt Nuxt; eingelöst wird sie im Kern.
  if (pathname === '/oauth/authorize') return method === 'POST';
  return LOG_DATA.test(pathname);
}
