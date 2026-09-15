// Die einzige Stelle, an der eine dynamische Zeichenkette in HTML landet,
// läuft über escapeHtml -- ausnahmslos. Bis hierher hat dieses Projekt nur
// JSON ausgeliefert; ab dieser Datei ist eine ungeschützte Einsetzung ein
// echtes XSS, das vorher nicht existierte.

// & zuerst: jede andere Ersetzung fügt ein &, das eine spätere &-Ersetzung
// sonst noch einmal träfe und aus "&lt;" ein "&amp;lt;" machte.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Kein Framework, kein Build-Schritt (Entscheidung 19) -- eine Zeichenkette
// als Hülle reicht für ein internes Werkzeug. prefers-color-scheme deckt
// den dunklen Modus ab, ohne dass irgendwer ihn umschalten muss.
const STYLE = `
body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.5}
h1,h2{font-weight:600}
form{margin:1rem 0}
label{display:block;margin:.6rem 0 .2rem;font-weight:600}
input,select,textarea{width:100%;padding:.4rem;box-sizing:border-box;font:inherit;border:1px solid #999;border-radius:3px}
textarea{min-height:6rem}
button{padding:.5rem 1.2rem;margin-top:.6rem;cursor:pointer}
table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{padding:.35rem .5rem;border-bottom:1px solid #ddd;text-align:left}
.error{color:#b00020}
.muted{color:#666;font-size:.9em}
.badge{display:inline-block;padding:.1rem .5rem;border-radius:3px;font-size:.85em;background:#eee}
@media (prefers-color-scheme: dark) {
  body{background:#151515;color:#e8e8e8}
  input,select,textarea{background:#1e1e1e;color:#e8e8e8;border-color:#555}
  td,th{border-color:#333}
  .badge{background:#2a2a2a}
}
`;

export function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${bodyHtml}</body></html>`;
}
