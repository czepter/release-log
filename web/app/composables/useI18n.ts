import { DEFAULT_LOCALE, LOCALES, MESSAGES, interpolate, isLocale, plural, preferredLocale, sectionLabel } from '~/i18n/messages'
import type { Locale, Messages, Plural } from '~/i18n/messages'

const COOKIE = 'rl_lang'

function localeCookie() {
  // Ein Jahr, damit die Wahl den Besuch überlebt; Lax reicht, die Sprache
  // ist keine Anmeldung.
  return useCookie<Locale | null>(COOKIE, { maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', path: '/' })
}

// Die Sprache dieser Sitzung. Der Anfangswert entsteht auf dem Server
// (Cookie, sonst Accept-Language) und kommt über die Payload beim
// Hydratisieren zurück -- sonst rendert der Server deutsch und der Browser
// englisch, und Vue meckert über den Unterschied.
export function useLocale() {
  return useState<Locale>('locale', () => {
    const cookie = localeCookie().value
    if (isLocale(cookie)) return cookie
    return preferredLocale(useRequestHeaders(['accept-language'])['accept-language'])
  })
}

const dateFormats = new Map<string, Intl.DateTimeFormat>()
function dateFormat(locale: Locale, kind: 'day' | 'stamp'): Intl.DateTimeFormat {
  const key = `${locale}:${kind}`
  let fmt = dateFormats.get(key)
  if (!fmt) {
    fmt = kind === 'day'
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
    dateFormats.set(key, fmt)
  }
  return fmt
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', Infinity],
]

export function useI18n() {
  const locale = useLocale()
  const m = computed<Messages>(() => MESSAGES[locale.value])

  function setLocale(next: Locale): void {
    locale.value = next
    localeCookie().value = next
  }

  return {
    locale,
    locales: LOCALES,
    setLocale,
    m,
    /** Platzhalter füllen: t(m.header.signedInAs, { login }) */
    t: interpolate,
    /** Einzahl oder Mehrzahl, {n} wird gefüllt: p(m.dashboard.logCount, 3) */
    p: (forms: Plural, n: number, params?: Record<string, string | number>) => plural(forms, n, params),
    /** Abschnitts-Label der öffentlichen API übersetzen, sonst durchreichen. */
    section: (key: string, fallback: string) => sectionLabel(m.value, key, fallback),

    formatDate: (ymd: string) => {
      const t = Date.parse(`${ymd}T00:00:00Z`)
      return Number.isNaN(t) ? ymd : dateFormat(locale.value, 'day').format(t)
    },
    formatDateTime: (iso: string | null) => (iso ? dateFormat(locale.value, 'stamp').format(new Date(iso)) : '–'),
    relativeTime: (iso: string | null, now = Date.now()) => {
      if (!iso) return m.value.common.never
      const rtf = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
      let value = (Date.parse(iso) - now) / 1000
      for (const [unit, size] of RELATIVE_STEPS) {
        if (Math.abs(value) < size) return rtf.format(Math.round(value), unit)
        value /= size
      }
      return iso
    },

    /** Fehlertext einer API-Antwort: erst der Code, dann der Text des Servers. */
    apiText: (err: unknown, fallback?: string) => {
      const code = apiError(err)
      const known = code ? (m.value.apiErrors as Record<string, string | undefined>)[code] : undefined
      return known ?? apiMessage(err, fallback ?? m.value.common.somethingWrong)
    },

    /** Optionen der Einstellungen, in der aktuellen Sprache. */
    viewOptions: computed(() => [
      { value: 'full', label: m.value.options.viewFull, hint: m.value.options.viewFullHint },
      { value: 'timeline', label: m.value.options.viewTimeline, hint: m.value.options.viewTimelineHint },
    ]),
    visibilityOptions: computed(() => [
      { value: 'public', label: m.value.options.visibilityPublic, hint: m.value.options.visibilityPublicHint },
      { value: 'private', label: m.value.options.visibilityPrivate, hint: m.value.options.visibilityPrivateHint },
    ]),
    viewLabel: (view: string) => (view === 'full' ? m.value.options.viewFull : view === 'timeline' ? m.value.options.viewTimeline : view),
  }
}

export { DEFAULT_LOCALE }
export type { Locale }
