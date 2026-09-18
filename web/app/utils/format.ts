// Fehlerkörper der API sind {error, message}; alles andere bekommt den
// übergebenen Text -- die Sprache entscheidet der Aufrufer (useI18n).
export function apiMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: { message?: unknown } })?.data
  return typeof data?.message === 'string' ? data.message : fallback
}
export function apiError(err: unknown): string | null {
  const data = (err as { data?: { error?: unknown } })?.data
  return typeof data?.error === 'string' ? data.error : null
}
