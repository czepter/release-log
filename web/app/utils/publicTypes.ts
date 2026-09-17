export type PublicChange = {
  type: 'feat' | 'perf' | 'fix'; breaking: boolean; scope: string | null; title: string; description: string
  pr: number | null; issues: number[]
}
export type PublicSection = { key: string; label: string; items: PublicChange[] }
export type PublicRelease = {
  version: string; tag: string | null; date: string; published_at: string | null; headline: string; body: string[]
  image: { src: string; alt: string } | null; sections: PublicSection[]
}
export type PublicLogHead = { id: string; product: string; view: 'full' | 'timeline'; visibility: 'public' | 'private' }

// Farben je Abschnitt, wie im Canvas: Wichtig rot, Neu grün, Änderungen blau, Behoben orange.
export const SECTION_TONE: Record<string, string> = {
  important: 'bg-red-100 text-red-700',
  new: 'bg-green-100 text-green-700',
  changed: 'bg-blue-100 text-blue-700',
  fixed: 'bg-orange-100 text-orange-700',
}
