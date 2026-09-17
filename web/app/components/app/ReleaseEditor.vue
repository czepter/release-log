<script setup lang="ts">
import { ArrowLeft, Eye, TriangleAlert } from '@lucide/vue'
import { toast } from 'vue-sonner'
import type EditorJS from '@editorjs/editorjs'
import type { ReleaseDoc } from '../../../../lib/document.ts'
import type { Block, Head } from '~/utils/releaseBlocks'

const props = defineProps<{ logId: string; version: string | null }>()

type LogDetail = { product: string; state: string; media: string[]; releases: Array<{ version: string }> }
type Loaded = { document: ReleaseDoc; blob_sha: string }

const enc = encodeURIComponent
const logPath = `/api/logs/${enc(props.logId)}`
const { data: log, refresh: refreshLog } = await useFetch<LogDetail>(logPath)
const { data: loaded, error: loadError } = props.version
  ? await useFetch<Loaded>(`${logPath}/releases/${enc(props.version)}`)
  : { data: ref<Loaded | null>(null), error: ref(null) }
if ((loadError.value as { statusCode?: number } | null)?.statusCode === 404) {
  throw createError({ statusCode: 404, statusMessage: 'Dieses Release gibt es nicht.' })
}

const today = new Date().toISOString().slice(0, 10)
const initial = loaded.value ? toBlocks(loaded.value.document) : { head: { version: '', tag: '', date: today, headline: '' }, blocks: [] as Block[] }
const head = reactive<Head>({ ...initial.head })
const previous = ref<ReleaseDoc | null>(loaded.value?.document ?? null)
const blobSha = ref<string | null>(loaded.value?.blob_sha ?? null)
const isNew = computed(() => previous.value === null)
const published = computed(() => previous.value?.published_at != null)
const frozen = computed(() => log.value?.state === 'frozen')

useHead({ title: () => (isNew.value ? 'Neues Release' : `${log.value?.product ?? ''} ${head.version}`) })

// Tag folgt der Version, bis jemand ihn selbst ändert.
watch(() => head.version, (v, old) => {
  if (isNew.value && (head.tag === '' || head.tag === `v${old}`)) head.tag = v ? `v${v}` : ''
})

const holder = ref<HTMLElement | null>(null)
let editor: EditorJS | null = null
const blocks = ref<Block[]>(initial.blocks)
const dirty = ref(false)
const saving = ref(false)
const publishing = ref(false)
const problem = ref<{ kind: 'conflict' | 'invalid' | 'error'; message: string } | null>(null)

const mediaUrl = (path: string) => `/l/${enc(props.logId)}/media/${path.split('/').map(enc).join('/')}`

async function uploadImage(file: File): Promise<string> {
  try {
    const res = await $fetch<{ path: string }>(`${logPath}/media`, {
      method: 'POST', body: file,
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': enc(file.name) },
    })
    // Bis der Abgleich das Bild indiziert, liefert /l/…/media es nicht aus.
    await waitFor(async () => { await refreshLog(); return log.value?.media.includes(res.path) ?? false })
    return res.path
  } catch (err) {
    throw new Error(apiMessage(err, 'Hochladen fehlgeschlagen.'))
  }
}

onMounted(async () => {
  const [{ default: Editor }, { default: Paragraph }, { default: ChangeTool }, { default: ReleaseImageTool }] = await Promise.all([
    import('@editorjs/editorjs'), import('@editorjs/paragraph'), import('~/editor/ChangeTool'), import('~/editor/ReleaseImageTool'),
  ])
  editor = new Editor({
    holder: holder.value!,
    placeholder: 'Tippe, oder „+" für einen Absatz, eine Änderung oder ein Bild',
    minHeight: 80,
    readOnly: frozen.value,
    tools: {
      paragraph: { class: Paragraph as never, inlineToolbar: ['bold', 'italic', 'link'] },
      change: { class: ChangeTool as never, config: { date: () => head.date } },
      releaseImage: { class: ReleaseImageTool as never, config: { media: () => log.value?.media ?? [], mediaUrl, upload: uploadImage } },
    },
    data: { blocks: initial.blocks as never },
    onChange: () => { markChanged() },
    i18n: {
      messages: {
        ui: {
          blockTunes: { toggler: { 'Click to tune': 'Einstellungen', 'or drag to move': 'oder ziehen' } },
          inlineToolbar: { converter: { 'Convert to': 'Umwandeln in' } },
          toolbar: { toolbox: { Add: 'Hinzufügen' } },
          popover: { Filter: 'Filtern', 'Nothing found': 'Nichts gefunden' },
        },
        toolNames: { Text: 'Absatz', Bold: 'Fett', Italic: 'Kursiv', Link: 'Link' },
        blockTunes: {
          delete: { Delete: 'Löschen', 'Click to delete': 'Zum Löschen klicken' },
          moveUp: { 'Move up': 'Nach oben' },
          moveDown: { 'Move down': 'Nach unten' },
        },
      },
    },
  })
})
onBeforeUnmount(() => { editor?.destroy() })

// Zwei Quellen, ein Ergebnis: Editor.js meldet Verschieben und Löschen über
// onChange, Tippen kommt verlässlich als natives input-Event aus dem Block.
let summaryTimer: ReturnType<typeof setTimeout> | undefined
function markChanged() {
  dirty.value = true
  clearTimeout(summaryTimer)
  summaryTimer = setTimeout(async () => {
    if (editor) blocks.value = (await editor.save()).blocks as Block[]
  }, 300)
}

// Was die öffentliche Seite daraus macht, dieselbe Gruppierung wie lib/sections.ts.
const summary = computed(() => {
  const changes = blocks.value.filter((b) => b.type === 'change').map((b) => b.data as ReleaseDoc['changes'][number])
  const rows = [
    { key: 'important', label: 'Wichtig', count: changes.filter((c) => c.breaking).length },
    { key: 'new', label: 'Neu', count: changes.filter((c) => !c.breaking && c.type === 'feat').length },
    { key: 'changed', label: 'Änderungen', count: changes.filter((c) => !c.breaking && c.type === 'perf').length },
    { key: 'fixed', label: 'Behoben', count: changes.filter((c) => !c.breaking && c.type === 'fix').length },
  ]
  return rows.filter((r) => r.count > 0)
})
const imageBlocks = computed(() => blocks.value.filter((b) => b.type === 'releaseImage').length)

async function waitFor(check: () => Promise<boolean>, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// Nach einem Commit steht der neue Stand erst nach dem Abgleich im Index.
// Bis dahin hätte der nächste Speichervorgang eine veraltete Basis.
async function reload(until: (fresh: Loaded) => boolean): Promise<boolean> {
  return waitFor(async () => {
    try {
      const fresh = await $fetch<Loaded>(`${logPath}/releases/${enc(head.version)}`)
      if (!until(fresh)) return false
      previous.value = fresh.document
      blobSha.value = fresh.blob_sha
      return true
    } catch {
      return false
    }
  })
}

async function save() {
  if (!editor) return
  saving.value = true
  problem.value = null
  try {
    blocks.value = (await editor.save()).blocks as Block[]
    const document = fromBlocks(head, blocks.value, previous.value)
    const before = blobSha.value
    await $fetch(`${logPath}/releases/${enc(head.version.trim())}`, {
      method: 'PUT', body: { document, base_blob_sha: before },
    })
    dirty.value = false
    const synced = await reload((fresh) => fresh.blob_sha !== before)
    toast.success(synced ? 'Gespeichert.' : 'Gespeichert. Der Abgleich dauert noch; vor dem nächsten Speichern neu laden.')
    if (isNew.value === false && props.version === null && synced) {
      await navigateTo(`/dashboard/logs/${enc(props.logId)}/releases/${enc(head.version.trim())}`, { replace: true })
    }
  } catch (err) {
    const code = apiError(err)
    problem.value = code === 'conflict'
      ? { kind: 'conflict', message: isNew.value ? `Version ${head.version} gibt es schon. Wähle eine andere Versionsnummer oder öffne die bestehende.` : 'Das Release wurde inzwischen anderswo geändert (im Repo oder über MCP). Nichts wurde überschrieben.' }
      : code === 'invalid_document'
        ? { kind: 'invalid', message: apiMessage(err) }
        : { kind: 'error', message: apiMessage(err) }
  } finally {
    saving.value = false
  }
}

async function togglePublish() {
  publishing.value = true
  const target = !published.value
  try {
    await $fetch(`${logPath}/releases/${enc(head.version)}/${target ? 'publish' : 'unpublish'}`, { method: 'POST', body: {} })
    await reload((fresh) => (fresh.document.published_at !== null) === target)
    toast.success(target ? 'Veröffentlicht.' : 'Zurückgezogen. Das Release ist wieder ein Entwurf.')
  } catch (err) {
    toast.error(apiMessage(err))
  } finally {
    publishing.value = false
  }
}

onBeforeRouteLeave(() => {
  if (dirty.value && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return false
})
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur sm:px-8">
      <Button as-child variant="ghost" size="icon" aria-label="Zurück zum Log">
        <NuxtLink :to="`/dashboard/logs/${enc(logId)}`"><ArrowLeft /></NuxtLink>
      </Button>
      <nav aria-label="Brotkrumen" class="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
        <NuxtLink :to="`/dashboard/logs/${enc(logId)}`" class="truncate hover:text-foreground">{{ log?.product }}</NuxtLink>
        <span class="text-border">/</span>
        <span class="rounded-md bg-primary px-2 py-0.5 font-mono text-xs text-primary-foreground">{{ isNew ? 'neu' : `v${head.version}` }}</span>
        <Badge v-if="!isNew" :variant="published ? 'default' : 'secondary'" :class="published && 'bg-green-100 text-green-700'">
          {{ published ? 'Veröffentlicht' : 'Entwurf' }}
        </Badge>
        <span class="hidden text-[13px] sm:inline">{{ dirty ? 'Ungespeicherte Änderungen' : isNew ? '' : 'Gespeichert' }}</span>
      </nav>
      <Button v-if="!isNew" as-child variant="ghost">
        <a :href="`/l/${enc(logId)}/r/${enc(head.version)}`" target="_blank" rel="noopener"><Eye /> Vorschau</a>
      </Button>
      <Button variant="outline" :disabled="saving || frozen || !head.version.trim()" @click="save">{{ saving ? 'Speichert…' : 'Speichern' }}</Button>
      <Button v-if="!isNew" :disabled="publishing || dirty || frozen" :title="dirty ? 'Erst speichern' : ''" @click="togglePublish">
        {{ publishing ? '…' : published ? 'Zurückziehen' : 'Veröffentlichen' }}
      </Button>
    </header>

    <div class="grid flex-1 lg:grid-cols-[minmax(0,1fr)_340px]">
      <main class="flex justify-center px-4 pt-12 pb-32 sm:px-8">
        <div class="flex w-full max-w-[760px] flex-col gap-4">
          <Alert v-if="frozen" variant="destructive">
            <TriangleAlert />
            <AlertDescription>Dieses Log ist eingefroren; sein Repository ist nicht erreichbar. Nur lesen.</AlertDescription>
          </Alert>
          <Alert v-if="problem" variant="destructive">
            <TriangleAlert />
            <AlertTitle>{{ problem.kind === 'conflict' ? 'Zwischenzeitlich geändert' : problem.kind === 'invalid' ? 'Das Dokument ist so nicht gültig' : 'Nicht gespeichert' }}</AlertTitle>
            <AlertDescription>
              <p class="whitespace-pre-line">{{ problem.kind === 'invalid' ? problem.message.split('; ').join('\n') : problem.message }}</p>
              <button v-if="problem.kind === 'conflict' && !isNew" type="button" class="mt-2 font-medium underline" @click="dirty = false; reloadNuxtApp()">Neu laden (verwirft deine Änderungen)</button>
            </AlertDescription>
          </Alert>

          <textarea
            v-model="head.headline" rows="1" placeholder="Überschrift des Release" aria-label="Überschrift" :readonly="frozen"
            class="field-sizing-content w-full resize-none bg-transparent text-4xl leading-[46px] font-semibold tracking-tight outline-none placeholder:text-muted-foreground/60"
            @input="dirty = true"
          />
          <div ref="holder" class="-mx-1" @input="markChanged" />
        </div>
      </main>

      <aside class="flex flex-col gap-6 border-l bg-muted/30 px-6 py-8">
        <h2 class="text-sm font-semibold">Release</h2>
        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1.5">
            <Label for="version">Version</Label>
            <Input id="version" v-model="head.version" :readonly="!isNew" placeholder="1.2.0" class="bg-background font-mono" :class="!isNew && 'text-muted-foreground'" @input="dirty = true" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="tag">Tag</Label>
            <Input id="tag" v-model="head.tag" placeholder="v1.2.0" class="bg-background font-mono" :readonly="frozen" @input="dirty = true" />
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="date">Datum</Label>
          <Input id="date" v-model="head.date" type="date" class="bg-background" :readonly="frozen" @input="dirty = true" />
        </div>
        <p v-if="!isNew" class="-mt-3 text-xs text-muted-foreground">Die Version ist der Dateiname und lässt sich nach dem Anlegen nicht mehr ändern.</p>

        <dl class="flex flex-col gap-2.5 border-t pt-5 text-[13px]">
          <div class="flex justify-between"><dt class="text-muted-foreground">Status</dt><dd>{{ isNew ? 'Noch nicht gespeichert' : published ? 'Veröffentlicht' : 'Entwurf' }}</dd></div>
          <div v-if="previous" class="flex justify-between"><dt class="text-muted-foreground">Commits</dt><dd>{{ previous.commits }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-muted-foreground">Datei</dt><dd class="truncate font-mono text-xs">releases/{{ head.version || '…' }}.json</dd></div>
        </dl>

        <div class="flex flex-col gap-2.5 border-t pt-5">
          <h3 class="text-[13px] font-semibold">So erscheint es</h3>
          <p v-if="summary.length === 0" class="text-xs text-muted-foreground">Noch keine Änderungen. „+" → Änderung.</p>
          <div v-for="row in summary" :key="row.key" class="flex items-center justify-between text-[13px]">
            <span class="rounded-md px-2 py-0.5 text-xs font-medium" :class="SECTION_TONE[row.key]">{{ row.label }}</span>
            <span class="text-muted-foreground">{{ row.count }}</span>
          </div>
          <p v-if="imageBlocks > 1" class="text-xs text-amber-700">Ein Release hat ein Bild; nur das erste wird gespeichert.</p>
        </div>

        <p class="rounded-lg border bg-background p-3 text-xs leading-[18px] text-muted-foreground">
          Speichern committet die Datei ins Repository. Hat sich dort inzwischen etwas geändert, bricht der Commit ab und nichts wird überschrieben.
        </p>
      </aside>
    </div>
  </div>
</template>
