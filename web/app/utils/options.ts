export const VIEW_OPTIONS = [
  { value: 'full', label: 'Vollständig', hint: 'Jedes Release mit allen Einträgen untereinander.' },
  { value: 'timeline', label: 'Zeitstrahl', hint: 'Kompakter Strom, jedes Release klappt auf.' },
]
export const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'Öffentlich', hint: 'Jeder mit dem Link sieht veröffentlichte Releases.' },
  { value: 'private', label: 'Privat', hint: 'Nur wer Schreibrechte aufs Repository hat. Nicht indexiert.' },
]
export const VIEW_LABEL: Record<string, string> = { full: 'Vollständig', timeline: 'Zeitstrahl' }
