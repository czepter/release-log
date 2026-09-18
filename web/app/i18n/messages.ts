// Der browserfreie Teil der Mehrsprachigkeit: Nachschlagen, Platzhalter,
// Mehrzahl. Dieselbe Datei läuft in node --test und im Browser; alles, was
// Nuxt braucht (Cookie, Zustand), sitzt in useI18n.
import de from './de.ts';
import en from './en.ts';

export type Locale = 'de' | 'en';
export type Messages = typeof de;
export type Plural = { one: string; other: string };

export const LOCALES: Locale[] = ['de', 'en'];
export const DEFAULT_LOCALE: Locale = 'de';
export const MESSAGES: Record<Locale, Messages> = { de, en };

export function isLocale(value: unknown): value is Locale {
  return value === 'de' || value === 'en';
}

export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

// ponytail: de und en kennen nur Einzahl und Mehrzahl. Eine Sprache mit
// weiteren Formen (pl, ru) bekommt hier Intl.PluralRules und in den
// Nachrichten die Schlüssel, die select() zurückgibt.
export function plural(forms: Plural, n: number, params?: Record<string, string | number>): string {
  return interpolate(n === 1 ? forms.one : forms.other, { n, ...params });
}

// Die öffentliche JSON-API liefert die Labels der Abschnitte deutsch
// (lib/sections.ts, Maschinen-Fläche). Der `key` ist stabil, also übersetzt
// ihn die Oberfläche selbst; ein unbekannter Key behält das Label der API.
export function sectionLabel(messages: Messages, key: string, fallback: string): string {
  return (messages.sections as Record<string, string | undefined>)[key] ?? fallback;
}

// Sprache des Browsers, aus dem Accept-Language-Header der Anfrage.
export function preferredLocale(acceptLanguage: string | undefined): Locale {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]!.trim().toLowerCase().split('-')[0];
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}
