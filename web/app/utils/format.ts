const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' })
const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', Infinity],
]

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'nie'
  let value = (Date.parse(iso) - now) / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return rtf.format(Math.round(value), unit)
    value /= size
  }
  return iso
}

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
export function formatDate(ymd: string): string {
  const t = Date.parse(`${ymd}T00:00:00Z`)
  return Number.isNaN(t) ? ymd : dateFmt.format(t)
}

// Fehlerkörper der API sind {error, message}; alles andere wird generisch.
export function apiMessage(err: unknown, fallback = 'Etwas ist schiefgegangen.'): string {
  const data = (err as { data?: { message?: unknown } })?.data
  return typeof data?.message === 'string' ? data.message : fallback
}
export function apiError(err: unknown): string | null {
  const data = (err as { data?: { error?: unknown } })?.data
  return typeof data?.error === 'string' ? data.error : null
}
