// Winzige DOM-Helfer für die Editor.js-Tools. Die Tools leben außerhalb von
// Vue (Editor.js verwaltet ihr DOM selbst), also ohne Templates.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', attrs: Record<string, string> = {}, children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  for (const child of children) node.append(child)
  return node
}

// Eine einzeilige oder mehrzeilige Textfläche ohne HTML: was der Nutzer
// eingibt, landet als Klartext im Dokument (title, description).
export function plainField(value: string, className: string, placeholder: string, label: string, multiline = false): HTMLDivElement {
  const node = el('div', `rl-plain outline-none ${className}`, {
    contenteditable: 'plaintext-only', role: 'textbox', 'aria-label': label, 'data-placeholder': placeholder,
    ...(multiline ? { 'aria-multiline': 'true' } : {}),
  })
  node.textContent = value
  if (!multiline) {
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation() } })
  } else {
    // Enter bleibt im Feld: ein Absatz der Beschreibung, kein neuer Block.
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.stopPropagation() })
  }
  // Nur Text einfügen, nie fremdes Markup.
  node.addEventListener('paste', (e) => {
    e.preventDefault()
    document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '')
  })
  return node
}

export function readPlain(node: HTMLElement): string {
  return (node.innerText ?? node.textContent ?? '').replace(/ /g, ' ')
}

export const ICON = {
  change: '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M3 12h18"/></svg>',
  image: '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>',
  alert: '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  type: '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>',
}
