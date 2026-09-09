// Grouping for both the JSON detail view and, later, the rendered page.
// A breaking entry appears only under "Wichtig", never a second time in its
// own type section (spec §7).

import type { Change } from './document.ts';

export type Section = { key: string; label: string; items: Change[] };

const GROUPS = [
  { key: 'new', label: 'Neu', type: 'feat' },
  { key: 'changed', label: 'Änderungen', type: 'perf' },
  { key: 'fixed', label: 'Behoben', type: 'fix' },
];

export function sectionsOf(changes: Change[]): Section[] {
  const breaking = changes.filter((c) => c.breaking);
  const rest = changes.filter((c) => !c.breaking);

  const sections: Section[] = [];
  if (breaking.length > 0) {
    sections.push({ key: 'important', label: 'Wichtig', items: breaking });
  }
  for (const group of GROUPS) {
    const items = rest.filter((c) => c.type === group.type);
    if (items.length > 0) sections.push({ key: group.key, label: group.label, items });
  }
  return sections;
}
