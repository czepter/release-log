import { el, ICON } from './dom.ts'
import type { Messages } from '../i18n/messages.ts'
import de from '../i18n/de.ts'

export type ImageText = Messages['editor']['image']

export type ImageToolConfig = {
  media: () => string[]
  mediaUrl: (path: string) => string
  upload: (file: File) => Promise<string>
  text?: () => ImageText
}

// Wie in ChangeTool: der Werkzeugkasten fragt den Titel statisch ab.
let toolboxText: ImageText = de.editor.image
export function setImageText(text: ImageText): void {
  toolboxText = text
}

type Options = { data: { src?: string; alt?: string }; config: ImageToolConfig }

// Das eine Bild eines Release (image {src, alt}). Wählt aus den Medien des
// Logs oder lädt ein neues hoch; der Pfad bleibt repo-relativ (media/…).
export default class ReleaseImageTool {
  static get toolbox() {
    return { title: toolboxText.toolbox, icon: ICON.image }
  }

  private src: string
  private alt: string
  private config: ImageToolConfig
  private text: ImageText
  private root!: HTMLElement

  constructor({ data, config }: Options) {
    this.src = data.src ?? ''
    this.alt = data.alt ?? ''
    this.config = config
    this.text = config.text?.() ?? toolboxText
  }

  render(): HTMLElement {
    this.root = el('figure', 'rl-image my-1.5 flex flex-col gap-2')
    this.paint()
    return this.root
  }

  private paint(): void {
    this.root.replaceChildren()
    this.root.dispatchEvent(new Event('input', { bubbles: true }))
    if (this.src) {
      const img = el('img', 'min-h-24 w-full rounded-xl border border-zinc-200 bg-zinc-100', { src: this.config.mediaUrl(this.src), alt: '' })
      const alt = el('input', 'w-full border-0 border-b border-dashed border-zinc-200 bg-transparent px-0.5 py-1 text-[13px] text-zinc-600 outline-none focus:border-zinc-900', {
        placeholder: this.text.altPlaceholder, 'aria-label': this.text.altLabel,
      })
      alt.value = this.alt
      alt.addEventListener('input', () => { this.alt = alt.value })
      const change = el('button', 'self-start text-xs text-zinc-500 underline underline-offset-2 cursor-pointer', { type: 'button' }, [this.text.pickOther])
      change.addEventListener('click', () => { this.src = ''; this.paint() })
      this.root.append(img, el('div', 'flex items-center gap-3', {}, [alt]), change)
      return
    }

    const grid = el('div', 'grid grid-cols-4 gap-2')
    for (const path of this.config.media()) {
      const pick = el('button', 'group flex flex-col gap-1 text-left cursor-pointer', { type: 'button', title: path }, [
        el('img', 'aspect-square w-full rounded-md border border-zinc-200 object-cover group-hover:border-zinc-900', { src: this.config.mediaUrl(path), alt: '' }),
        el('span', 'truncate font-mono text-[11px] text-zinc-500', {}, [path.replace(/^media\//, '')]),
      ])
      pick.addEventListener('click', () => { this.src = path; this.paint() })
      grid.append(pick)
    }
    const status = el('span', 'text-xs text-zinc-500')
    const input = el('input', 'sr-only', { type: 'file', accept: '.png,.jpg,.jpeg,.webp' })
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      status.textContent = this.text.uploading
      try {
        this.src = await this.config.upload(file)
        this.paint()
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : this.text.uploadFailed
      }
    })
    const uploadLabel = el('label', 'inline-flex h-8 cursor-pointer items-center rounded-md border border-zinc-200 bg-white px-3 text-[13px] font-medium hover:bg-zinc-50', {}, [this.text.uploadNew, input])
    this.root.append(el('div', 'flex flex-col gap-3 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-4', {}, [
      el('span', 'text-sm font-medium', {}, [this.text.heading]),
      ...(this.config.media().length ? [grid] : [el('span', 'text-xs text-zinc-500', {}, [this.text.noMedia])]),
      el('div', 'flex items-center gap-3', {}, [uploadLabel, status]),
    ]))
  }

  save(): { src: string; alt: string } {
    return { src: this.src, alt: this.alt }
  }

  validate(data: { src: string }): boolean {
    return data.src !== ''
  }
}
