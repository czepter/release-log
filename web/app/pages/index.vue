<script setup lang="ts">
import { ArrowDown, ArrowRight, ChevronDown, Globe, Pencil, Plug, ScrollText } from '@lucide/vue'

definePageMeta({ layout: 'public' })

// Die Sitzung entscheidet nur, wohin die Knöpfe führen (Spec, Entscheidung
// 33). useAsyncData reicht das Ergebnis vom Server durch; ein nackter
// Abruf liefe beim Hydratisieren ein zweites Mal und stünde als 401 in
// der Konsole.
const session = useSession()
if (!session.value) {
  const request = useRequestFetch()
  // 401 heißt: nicht angemeldet, die Seite rendert.
  const { data } = await useAsyncData('landing-session', () => request<Session>('/api/session').catch(() => null))
  session.value = data.value
}

const { data } = await useFetch<{ showcase: Showcase | null }>('/api/showcase')
const showcase = computed(() => data.value?.showcase ?? null)

useHead({
  title: 'release-log · Release Notes aus deinen Commits',
  meta: [{ name: 'description', content: 'release-log lässt deinen MCP-Client die Commits in Release Notes übersetzen. Du liest gegen und veröffentlichst, ohne selbst eine Datei im Repo anzufassen.' }],
})

// Angemeldete lesen die Startseite wie alle anderen; für sie führt jeder
// Knopf ins Dashboard statt in eine zweite Anmeldung.
const cta = computed(() => (session.value
  ? { href: '/dashboard', label: 'Zum Dashboard', short: 'Dashboard' }
  : { href: '/auth/github/login', label: 'Mit GitHub anmelden', short: 'Anmelden' }))

const pains = [
  { title: 'Release Notes schreibt keiner gern', text: 'Nach dem Release hängt der Kopf schon am nächsten Ticket. Die Notes entstehen spät, knapp oder gar nicht.' },
  { title: 'Die CHANGELOG.md hinkt immer hinterher', text: 'Eigentlich müsste jeder Pull Request sie mitändern. Meistens denkt erst beim Release jemand daran, und dann fehlt die Hälfte.' },
  { title: 'Commit-Messages sind für Entwickler', text: 'Sie beschreiben, was im Code passiert ist. Deine Nutzer wollen wissen, was sich für sie ändert.' },
]

// Echte Commits dieses Repos vom 17.09.2026 und was daraus für Nutzer wird.
const commits = [
  { type: 'feat', message: 'suggest the app\'s repositories in "Neues Log" and adopt an existing one' },
  { type: 'feat', message: 'replace the installation badge with actionable alerts on the log page' },
  { type: 'feat', message: 'ask before leaving the release editor in a dialog, not window.confirm' },
  { type: 'style', message: 'widen the editor gutter and fit the block settings menu' },
  { type: 'chore', message: 'ignore SQLite WAL side files' },
]
const notes = [
  'Beim Anlegen eines Logs schlägt release-log deine Repositories vor. Liegt dort schon ein Log, übernimmst du es.',
  'Fehlt die GitHub App, sagt dir die Log-Seite, was zu tun ist.',
  'Verlässt du den Editor mit ungespeicherten Änderungen, fragt er vorher nach.',
]

const steps = [
  { title: 'Repository verbinden', text: 'Lege im Dashboard ein neues Log an. Liegt in einem Repository schon eins, übernimmst du es.' },
  { title: 'Release schreiben lassen', text: 'Bitte deinen MCP-Client, die Commits seit dem letzten Release zusammenzufassen. Du kannst auch selbst im Editor schreiben.' },
  { title: 'Veröffentlichen', text: 'Danach steht das Release auf der Seite und im Feed. Vorher sehen den Entwurf nur Leute mit Schreibrecht.' },
]

const faqs = [
  { q: 'Brauche ich ein GitHub-Konto?', a: 'Ja. Anmeldung und Rechte laufen über GitHub, und die GitHub App braucht Zugriff auf das Repository deines Logs.' },
  { q: 'Wer bekommt Zugang?', a: 'Nur GitHub-Konten, die ein Admin auf die Zulassungsliste gesetzt hat. Frag den Admin deiner Instanz.' },
  { q: 'Welche MCP-Clients funktionieren?', a: 'Jeder Client, der MCP mit OAuth unterstützt. Beim ersten Verbinden registriert er sich selbst, und du bestätigst den Zugriff einmal im Browser.' },
  { q: 'Kann ich Releases vor der Veröffentlichung prüfen?', a: 'Ja. Jedes Release beginnt als Entwurf und ist nur für Konten mit Schreibrecht auf das Repository sichtbar.' },
  { q: 'Kann ich das Changelog in meine App einbauen?', a: 'Ja, über den JSON-Feed: /l/<id>/versions, /l/<id>/releases und /l/<id>/releases/<version>.' },
]
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="border-b bg-card">
      <div class="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-4 sm:h-[72px] sm:px-6">
        <a href="#top" class="flex items-center gap-2.5 font-semibold">
          <span class="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"><ScrollText class="size-[18px]" /></span>
          release-log
        </a>
        <nav class="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
          <a href="#funktionen" class="hover:text-foreground">Funktionen</a>
          <a href="#ablauf" class="hover:text-foreground">So funktioniert's</a>
          <a v-if="showcase" href="#changelog" class="hover:text-foreground">Changelog</a>
          <a href="#faq" class="hover:text-foreground">FAQ</a>
        </nav>
        <Button as="a" :href="cta.href" class="h-11 sm:h-10">{{ cta.short }}</Button>
      </div>
    </header>

    <section id="top" class="border-b bg-card">
      <div class="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:pt-28 lg:pb-30">
        <div class="flex flex-col items-start gap-5 lg:gap-6">
          <span class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] text-muted-foreground">
            <span class="size-1.5 rounded-full bg-green-500" />Für GitHub-Repos und MCP-Clients
          </span>
          <h1 class="text-[38px] leading-[42px] font-semibold tracking-tight sm:text-6xl sm:leading-[64px]">Deine Nutzer lesen keine Commit-Messages.</h1>
          <p class="max-w-[540px] text-base leading-7 text-muted-foreground sm:text-lg sm:leading-[30px]">Sie wollen wissen, was neu ist und was behoben wurde. release-log lässt deinen MCP-Client die Commits in Release Notes übersetzen. Du liest gegen und veröffentlichst, ohne selbst eine Datei im Repo anzufassen.</p>
          <div class="flex w-full flex-col gap-2.5 pt-1 sm:w-auto sm:flex-row sm:gap-3">
            <Button as="a" :href="cta.href" size="lg" class="h-12 px-6">{{ cta.label }}</Button>
            <Button v-if="showcase" as="a" href="#changelog" variant="outline" size="lg" class="h-12 px-6">Live-Changelog ansehen <ArrowRight class="size-4" /></Button>
          </div>
          <p v-if="!session" class="text-[13px] text-muted-foreground">Anmelden können nur GitHub-Konten, die ein Admin freigeschaltet hat.</p>
        </div>

        <div class="overflow-hidden rounded-2xl border bg-background shadow-[0_24px_48px_-24px_rgba(24,24,27,0.18)]" aria-hidden="true">
          <div class="flex h-11 items-center gap-2 border-b bg-card px-4 text-[13px] text-muted-foreground"><Plug class="size-3.5" />MCP-Client · release-log</div>
          <div class="flex flex-col gap-2.5 p-5 font-mono text-xs leading-5 text-zinc-700 sm:text-[13px]">
            <div><span class="text-muted-foreground">→</span> write_release <span class="text-muted-foreground">log:</span> release-log <span class="text-muted-foreground">version:</span> 0.3.0</div>
            <div class="text-green-700">✓ Entwurf gespeichert</div>
            <div><span class="text-muted-foreground">→</span> publish_release <span class="text-muted-foreground">version:</span> 0.3.0</div>
            <div class="text-green-700">✓ Veröffentlicht unter /l/release-log/r/0.3.0</div>
          </div>
          <div class="mx-5 mb-5 flex flex-col gap-3 rounded-xl border bg-card p-5">
            <div class="flex items-center gap-2.5">
              <span class="rounded-md bg-primary px-2 py-0.5 font-mono text-xs font-medium text-primary-foreground">v0.3.0</span>
              <span class="text-[13px] text-muted-foreground">{{ formatDate('2026-09-17') }}</span>
            </div>
            <div class="text-lg leading-[26px] font-semibold tracking-tight">Bestehende Repositories übernehmen</div>
            <span class="self-start rounded-md px-2 py-0.5 text-xs font-medium" :class="SECTION_TONE.new">Neu · 3</span>
          </div>
        </div>
      </div>
    </section>

    <section id="problem">
      <div class="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6 lg:gap-14 lg:py-26">
        <div class="flex max-w-[760px] flex-col gap-3">
          <span class="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase sm:text-[13px]">Das Problem</span>
          <h2 class="text-[30px] leading-9 font-semibold tracking-tight sm:text-[40px] sm:leading-[48px]">Die Commit-Historie ist korrekt, aber deine Nutzer verstehen sie nicht.</h2>
        </div>
        <div class="grid gap-6 md:grid-cols-3 md:gap-12">
          <div v-for="pain in pains" :key="pain.title" class="flex flex-col gap-1.5 md:gap-2.5">
            <h3 class="text-base font-semibold sm:text-[17px]">{{ pain.title }}</h3>
            <p class="text-[15px] leading-6 text-muted-foreground">{{ pain.text }}</p>
          </div>
        </div>
        <div class="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_56px_minmax(0,1fr)] lg:gap-0">
          <div class="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-5 lg:p-7">
            <span class="text-[13px] font-medium text-muted-foreground">Git-Log seit v0.2.0</span>
            <ul class="flex flex-col gap-3 font-mono text-xs leading-[18px] text-zinc-700 sm:text-[13px] sm:leading-5">
              <li v-for="c in commits" :key="c.message" class="flex gap-2">
                <span :class="c.type === 'feat' ? 'text-green-700' : 'text-muted-foreground'">{{ c.type }}:</span><span>{{ c.message }}</span>
              </li>
            </ul>
          </div>
          <div class="flex items-center justify-center text-zinc-400" aria-hidden="true">
            <ArrowDown class="size-5 lg:hidden" /><ArrowRight class="hidden size-5 lg:block" />
          </div>
          <div class="flex min-w-0 flex-col gap-3.5 rounded-2xl border bg-card p-5 lg:p-7">
            <span class="flex items-center gap-2.5">
              <span class="rounded-md bg-primary px-2 py-0.5 font-mono text-xs font-medium text-primary-foreground">v0.3.0</span>
              <span class="text-[13px] font-medium text-muted-foreground">Release Notes</span>
            </span>
            <span class="text-lg leading-[26px] font-semibold tracking-tight sm:text-xl sm:leading-7">Bestehende Repositories übernehmen</span>
            <span class="self-start rounded-md px-2 py-0.5 text-xs font-medium" :class="SECTION_TONE.new">Neu</span>
            <ul class="flex flex-col gap-2.5">
              <li v-for="note in notes" :key="note" class="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5 text-sm leading-[22px] sm:text-[15px] sm:leading-6">
                <span class="mt-2.5 size-[5px] rounded-full bg-zinc-400" /><span>{{ note }}</span>
              </li>
            </ul>
            <p class="mt-1 text-[13px] leading-5 text-muted-foreground">Die beiden Commits zu style und chore hat der Agent weggelassen, weil sich für Nutzer dadurch nichts ändert.</p>
          </div>
        </div>
      </div>
    </section>

    <section id="funktionen" class="border-y bg-card">
      <div class="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6 lg:gap-14 lg:py-26">
        <div class="flex max-w-[640px] flex-col gap-3">
          <span class="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase sm:text-[13px]">Funktionen</span>
          <h2 class="text-[30px] leading-9 font-semibold tracking-tight sm:text-[40px] sm:leading-[48px]">Was release-log dir abnimmt</h2>
        </div>
        <div class="grid gap-3 md:grid-cols-2 md:gap-5">
          <article class="flex flex-col gap-2 rounded-xl border bg-card p-5 md:gap-3 md:p-7">
            <span class="mb-1 hidden size-10 items-center justify-center rounded-lg bg-muted md:flex"><ScrollText class="size-5" /></span>
            <h3 class="text-base font-semibold md:text-[17px]">Im Repo, ohne dass du es pflegst</h3>
            <p class="text-[15px] leading-6 text-muted-foreground">Das Log liegt als JSON in einem eigenen GitHub-Repository. release-log schreibt die Dateien, du öffnest sie nie von Hand. Änderst du doch mal etwas direkt auf GitHub, übernimmt die Seite den neuen Stand.</p>
          </article>
          <article class="flex flex-col gap-2 rounded-xl border bg-card p-5 md:gap-3 md:p-7">
            <span class="mb-1 hidden size-10 items-center justify-center rounded-lg bg-muted md:flex"><Plug class="size-5" /></span>
            <h3 class="text-base font-semibold md:text-[17px]">MCP-Server mit OAuth</h3>
            <p class="text-[15px] leading-6 text-muted-foreground">Dein MCP-Client meldet sich per OAuth an und schreibt Releases mit <code class="font-mono text-[13px]">write_release</code>. Bilder lädt er mit <code class="font-mono text-[13px]">add_media</code> hoch.</p>
          </article>
          <article class="flex flex-col gap-2 rounded-xl border bg-card p-5 md:gap-3 md:p-7">
            <span class="mb-1 hidden size-10 items-center justify-center rounded-lg bg-muted md:flex"><Pencil class="size-5" /></span>
            <h3 class="text-base font-semibold md:text-[17px]">Gegenlesen im Editor</h3>
            <p class="text-[15px] leading-6 text-muted-foreground">Du änderst Überschrift, Text, Bild und jeden einzelnen Eintrag. Hat inzwischen jemand anderes gespeichert, sagt dir der Editor das, statt dessen Stand zu überschreiben.</p>
          </article>
          <article class="flex flex-col gap-2 rounded-xl border bg-card p-5 md:gap-3 md:p-7">
            <span class="mb-1 hidden size-10 items-center justify-center rounded-lg bg-muted md:flex"><Globe class="size-5" /></span>
            <h3 class="text-base font-semibold md:text-[17px]">Öffentliche Seite und JSON</h3>
            <p class="text-[15px] leading-6 text-muted-foreground">Unter <code class="font-mono text-[13px]">/l/&lt;id&gt;</code> steht das Changelog als Zeitstrahl, deine eigene App holt dieselben Releases als JSON. Ein privates Log sehen nur Leute mit Schreibrecht auf das Repository.</p>
          </article>
        </div>
      </div>
    </section>

    <section id="ablauf" class="border-b">
      <div class="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6 lg:gap-14 lg:py-26">
        <div class="flex max-w-[640px] flex-col gap-3">
          <span class="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase sm:text-[13px]">So funktioniert's</span>
          <h2 class="text-[30px] leading-9 font-semibold tracking-tight sm:text-[40px] sm:leading-[48px]">Vom Commit zur veröffentlichten Seite</h2>
        </div>
        <ol class="grid gap-7 md:grid-cols-3 md:gap-12">
          <li
            v-for="(step, i) in steps" :key="step.title"
            class="flex flex-col gap-2 border-l-2 pl-5 md:gap-3.5 md:border-t-2 md:border-l-0 md:pt-6 md:pl-0"
            :class="i === 0 ? 'border-primary' : 'border-border'"
          >
            <span class="font-mono text-xs text-muted-foreground sm:text-[13px]">0{{ i + 1 }}</span>
            <h3 class="text-lg font-semibold md:text-xl">{{ step.title }}</h3>
            <p class="text-[15px] leading-6 text-muted-foreground">{{ step.text }}</p>
          </li>
        </ol>
      </div>
    </section>

    <section v-if="showcase" id="changelog">
      <div class="mx-auto flex max-w-6xl flex-col gap-7 px-4 py-16 sm:px-6 lg:gap-14 lg:py-26">
        <div class="flex flex-col justify-between gap-6 md:flex-row md:items-end md:gap-12">
          <div class="flex max-w-[640px] flex-col gap-3">
            <span class="inline-flex items-center gap-2 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase sm:text-[13px]"><span class="size-1.5 rounded-full bg-green-500" />Live-Changelog</span>
            <h2 class="text-[30px] leading-9 font-semibold tracking-tight sm:text-[40px] sm:leading-[48px]">Das Changelog von {{ showcase.product }}</h2>
            <p class="text-[15px] leading-6 text-muted-foreground sm:text-[17px] sm:leading-7">
              Wir führen unser eigenes Changelog mit release-log. Oben steht das neueste Release komplett<template v-if="showcase.older.length">, darunter die davor</template>.
            </p>
          </div>
          <Button as="a" :href="showcase.pageUrl" variant="outline" class="h-11 shrink-0 px-4">Alle Releases <ArrowRight class="size-4" /></Button>
        </div>

        <div class="rounded-2xl border bg-card px-5 pt-6 pb-8 sm:px-14 sm:pt-12 sm:pb-12">
          <ol class="flex flex-col [&>li:last-child]:pb-0">
            <AppReleaseEntry :release="showcase.latest" :href="showcase.latest.href" :collapsible="false" last />
            <AppReleaseTeaser v-for="release in showcase.older" :key="release.version" :release="release" />
          </ol>
        </div>
        <p class="-mt-3 font-mono text-xs text-muted-foreground lg:-mt-8">Auch als JSON: <a :href="showcase.feedUrl" class="text-foreground/80 hover:underline">{{ showcase.feedUrl }}</a></p>
      </div>
    </section>

    <section id="faq" class="border-t bg-card">
      <div class="mx-auto grid max-w-6xl gap-6 px-4 py-16 sm:px-6 lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-24 lg:py-26">
        <div class="flex flex-col gap-3">
          <span class="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase sm:text-[13px]">FAQ</span>
          <h2 class="text-[30px] leading-9 font-semibold tracking-tight sm:text-[40px] sm:leading-[48px]">Häufige Fragen</h2>
          <p class="hidden text-[15px] leading-6 text-muted-foreground lg:block">Was du vor der Anmeldung wissen solltest.</p>
        </div>
        <div class="flex flex-col border-t">
          <details v-for="(faq, i) in faqs" :key="faq.q" class="group border-b" :open="i === 0">
            <summary class="flex min-h-[60px] cursor-pointer list-none items-center justify-between gap-6 py-3 text-base leading-[23px] font-medium sm:min-h-[68px] sm:text-[17px] [&::-webkit-details-marker]:hidden">
              {{ faq.q }}
              <ChevronDown class="size-[18px] shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <p class="pb-6 text-[15px] leading-[25px] text-muted-foreground sm:pr-12">{{ faq.a }}</p>
          </details>
        </div>
      </div>
    </section>

    <footer class="flex grow flex-col bg-zinc-950 text-zinc-50">
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 pt-16 pb-14 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:gap-16 lg:pt-28 lg:pb-24">
        <div class="flex max-w-[720px] flex-col gap-4">
          <h2 class="text-[32px] leading-[38px] font-semibold tracking-tight sm:text-[44px] sm:leading-[52px]">Schreib dein nächstes Changelog nicht mehr aus dem Git-Log ab.</h2>
          <p class="text-base leading-[26px] text-zinc-400 sm:text-[17px] sm:leading-7">{{ session ? 'Im Dashboard liegen deine Logs und der Editor.' : 'Melde dich mit GitHub an und verbinde dein erstes Repository.' }}</p>
        </div>
        <Button as="a" :href="cta.href" size="lg" class="h-13 shrink-0 bg-zinc-50 px-6 text-zinc-950 hover:bg-zinc-200">{{ cta.label }}</Button>
      </div>
      <div class="mt-auto border-t border-zinc-800">
        <div class="mx-auto flex max-w-6xl flex-col gap-3.5 px-4 py-6 text-[13px] text-zinc-400 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-7">
          <span class="font-semibold text-zinc-50">release-log</span>
          <nav class="flex flex-wrap gap-5 sm:gap-7">
            <a href="#funktionen" class="hover:text-zinc-50">Funktionen</a>
            <a v-if="showcase" href="#changelog" class="hover:text-zinc-50">Changelog</a>
            <a href="#faq" class="hover:text-zinc-50">FAQ</a>
            <a :href="cta.href" class="hover:text-zinc-50">{{ cta.short }}</a>
          </nav>
        </div>
      </div>
    </footer>
  </div>
</template>
