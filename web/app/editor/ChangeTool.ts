import type { Change, ChangeType } from '../../../lib/document.ts'
import type { Messages } from '../i18n/messages.ts'
import de from '../i18n/de.ts'
import { el, plainField, readPlain, ICON } from './dom.ts'
import { newChange } from '../utils/releaseBlocks.ts'

// Die Texte kommen aus den Nachrichten der Seite (useI18n), durchgereicht
// als Konfiguration -- ein Editor.js-Werkzeug ist kein Vue-Bauteil und kann
// selbst kein Composable aufrufen.
export type ChangeText = Messages['editor']['change']

const TONES: Record<ChangeType, string> = {
  feat: 'bg-green-100 text-green-700',
  perf: 'bg-blue-100 text-blue-700',
  fix: 'bg-orange-100 text-orange-700',
}
const TYPES: ChangeType[] = ['feat', 'perf', 'fix']
const LABEL: Record<ChangeType, keyof ChangeText> = { feat: 'typeFeat', perf: 'typePerf', fix: 'typeFix' }

// Der Werkzeugkasten von Editor.js fragt den Titel statisch ab, ohne Zugriff
// auf die Konfiguration; die Seite setzt ihn darum vor dem Erzeugen des
// Editors selbst (setChangeText).
let toolboxText: ChangeText = de.editor.change
export function setChangeText(text: ChangeText): void {
  toolboxText = text
}

type Options = { data: Partial<Change>; config?: { date?: () => string; text?: () => ChangeText }; api: { blocks: { getCurrentBlockIndex(): number } } }

const numberList = (text: string): number[] =>
  text.split(/[\s,;#]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0)

// Ein Eintrag unter changes[]: ein Block je Änderung. `breaking` sitzt im
// Block-Menü (⋮⋮), der Typ auf dem farbigen Knopf -- beides wie im Canvas.
export default class ChangeTool {
  static get toolbox() {
    return { title: toolboxText.toolbox, icon: ICON.change }
  }

  static get enableLineBreaks() {
    return true
  }

  private data: Change
  private text: ChangeText
  private root!: HTMLElement
  private typeButton!: HTMLButtonElement
  private breakingBadge!: HTMLElement
  private fields!: { scope: HTMLInputElement; title: HTMLElement; description: HTMLElement; pr: HTMLInputElement; issues: HTMLInputElement; commit: HTMLInputElement; date: HTMLInputElement }

  constructor({ data, config }: Options) {
    const base = newChange(config?.date?.() ?? new Date().toISOString().slice(0, 10))
    this.data = { ...base, ...data, issues: [...(data.issues ?? [])] }
    this.text = config?.text?.() ?? toolboxText
  }

  render(): HTMLElement {
    const small = 'h-7 rounded-md border border-dashed border-zinc-300 bg-transparent px-2 font-mono text-xs text-zinc-600 outline-none focus:border-zinc-900 focus:border-solid'
    this.typeButton = el('button', 'inline-flex h-6 items-center gap-1 rounded-md pr-1.5 pl-2.5 text-xs font-medium cursor-pointer', { type: 'button', title: this.text.switchType })
    this.typeButton.addEventListener('click', () => this.cycleType())
    this.breakingBadge = el('span', 'rounded-md bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700', {}, [this.text.breakingBadge])

    this.fields = {
      scope: el('input', `${small} w-28`, { placeholder: 'scope', 'aria-label': this.text.scopeLabel }),
      title: plainField(this.data.title, 'text-base font-semibold leading-6', this.text.titlePlaceholder, this.text.titleLabel),
      description: plainField(this.data.description, 'min-h-[22px] whitespace-pre-wrap text-sm leading-[22px] text-zinc-600', this.text.descriptionPlaceholder, this.text.descriptionLabel, true),
      pr: el('input', `${small} w-20`, { placeholder: 'PR #', inputmode: 'numeric', 'aria-label': this.text.prLabel }),
      issues: el('input', `${small} w-32`, { placeholder: this.text.issuesPlaceholder, 'aria-label': this.text.issuesLabel }),
      commit: el('input', `${small} w-28`, { placeholder: this.text.commitPlaceholder, 'aria-label': this.text.commitLabel }),
      date: el('input', `${small} w-36 font-sans`, { type: 'date', 'aria-label': this.text.dateLabel }),
    }
    this.fields.scope.value = this.data.scope ?? ''
    this.fields.pr.value = this.data.pr === null ? '' : String(this.data.pr)
    this.fields.issues.value = this.data.issues.join(', ')
    this.fields.commit.value = this.data.commit
    this.fields.date.value = this.data.date

    this.root = el('div', 'rl-change my-1.5 flex flex-col gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 py-3', {}, [
      el('div', 'flex flex-wrap items-center gap-2', {}, [this.typeButton, this.fields.scope, this.breakingBadge, el('span', 'flex-1'), this.fields.pr]),
      this.fields.title,
      this.fields.description,
      el('div', 'mt-1 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2', {}, [this.fields.issues, this.fields.commit, this.fields.date]),
    ])
    this.paint()
    return this.root
  }

  private paint(): void {
    const type = TYPES.includes(this.data.type) ? this.data.type : TYPES[0]!
    this.typeButton.className = `inline-flex h-6 items-center gap-1 rounded-md pr-1.5 pl-2.5 text-xs font-medium cursor-pointer ${TONES[type]}`
    this.typeButton.innerHTML = `${this.text[LABEL[type]]}${ICON.type.replace('width="17" height="17"', 'width="12" height="12"')}`
    this.breakingBadge.hidden = !this.data.breaking
  }

  private cycleType(): void {
    const i = TYPES.indexOf(this.data.type)
    this.data.type = TYPES[(i + 1) % TYPES.length]!
    this.changed()
  }

  // Menüaktionen sind kein Tippen: die Seite erfährt über dasselbe
  // input-Event davon, dass es etwas zu speichern gibt.
  private changed(): void {
    this.paint()
    this.root.dispatchEvent(new Event('input', { bubbles: true }))
  }

  renderSettings() {
    return [
      ...TYPES.map((value) => ({
        icon: ICON.type, title: this.text[LABEL[value]], isActive: () => this.data.type === value, closeOnActivate: true,
        onActivate: () => { this.data.type = value; this.changed() },
      })),
      {
        icon: ICON.alert, title: this.text.breaking, toggle: true, isActive: () => this.data.breaking, closeOnActivate: true,
        onActivate: () => { this.data.breaking = !this.data.breaking; this.changed() },
      },
    ]
  }

  save(): Change {
    const pr = Number(this.fields.pr.value.replace(/[^0-9]/g, ''))
    return {
      type: this.data.type,
      breaking: this.data.breaking,
      scope: this.fields.scope.value.trim() || null,
      title: readPlain(this.fields.title).trim(),
      description: readPlain(this.fields.description).trim(),
      pr: this.fields.pr.value.trim() && Number.isInteger(pr) && pr > 0 ? pr : null,
      issues: numberList(this.fields.issues.value),
      commit: this.fields.commit.value.trim() || 'manuell',
      date: this.fields.date.value || this.data.date,
    }
  }

  // Ein leerer Eintrag ohne Titel wird nicht gespeichert, statt beim
  // Speichern als ungültiges Dokument abgelehnt zu werden.
  validate(data: Change): boolean {
    return data.title !== '' || data.description !== ''
  }
}
