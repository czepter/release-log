<script setup lang="ts">
import { ChevronRight, ExternalLink, GitBranch, Plus, TriangleAlert, Trash2, Upload, ImageIcon, Code2 } from '@lucide/vue'
import { toast } from 'vue-sonner'

definePageMeta({ layout: 'app', middleware: 'auth' })

type Detail = {
  id: string; product: string; owner: string; repo: string; view: string; visibility: string; state: string
  indexedAt: string | null; curationNotes: string | null; configBlobSha: string | null
  installation: 'reachable' | 'no_installation' | 'gone'
  errors: Array<{ path: string; message: string }>
  releases: Array<{ version: string; date: string; published_at: string | null; headline: string }>
  media: string[]
}

const route = useRoute()
const id = computed(() => String(route.params.id))
const { data, error, refresh } = await useFetch<Detail>(() => `/api/logs/${encodeURIComponent(id.value)}`)
if (error.value?.statusCode === 404) throw createError({ statusCode: 404, statusMessage: 'Dieses Log gibt es nicht.' })
useHead({ title: () => data.value?.product ?? 'Log' })

const now = useNow()
onMounted(() => { now.value = Date.now() })
const frozen = computed(() => data.value?.state === 'frozen')
const drafts = computed(() => (data.value?.releases ?? []).filter((r) => r.published_at === null).length)

// Einstellungen
const settings = reactive({ view: 'full', visibility: 'public', curation_notes: '' })
watchEffect(() => {
  if (!data.value) return
  settings.view = data.value.view
  settings.visibility = data.value.visibility
  settings.curation_notes = data.value.curationNotes ?? ''
})
const saving = ref(false)
async function saveSettings() {
  saving.value = true
  try {
    await $fetch(`/api/logs/${encodeURIComponent(id.value)}/settings`, {
      method: 'PUT', body: { ...settings, expected_sha: data.value?.configBlobSha ?? '' },
    })
    toast.success('Gespeichert. Der Abgleich übernimmt die Änderung gleich.')
    setTimeout(() => refresh(), 1500)
  } catch (err) {
    toast.error(apiMessage(err))
  } finally {
    saving.value = false
  }
}

// Medien
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const dragging = ref(false)
async function upload(file: File | undefined) {
  if (!file) return
  uploading.value = true
  try {
    const res = await $fetch<{ path: string }>(`/api/logs/${encodeURIComponent(id.value)}/media`, {
      method: 'POST', body: file,
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
    })
    toast.success(`${res.path} hochgeladen.`)
    setTimeout(() => refresh(), 1500)
  } catch (err) {
    toast.error(apiMessage(err))
  } finally {
    uploading.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}
// Wie lib/public.ts: der Repo-Pfad (media/…) hängt ganz hinter /media/.
const mediaUrl = (path: string) => `/l/${encodeURIComponent(id.value)}/media/${path.split('/').map(encodeURIComponent).join('/')}`

// Einbinden: die öffentliche Seite im iframe, oder der JSON-Feed direkt.
// Die Adresse kommt aus der Anfrage, damit Snippets in dev wie in Produktion
// dieselbe Herkunft zeigen wie die Seite, auf der sie stehen.
const origin = useRequestURL().origin
const base = computed(() => `${origin}/l/${encodeURIComponent(id.value)}`)
const embedMode = ref('iframe')
const EMBED_OPTIONS = [{ value: 'iframe', label: 'Als iframe' }, { value: 'api', label: 'Über die JSON-API' }]
// Ein echtes Beispiel liest sich besser als ein Platzhalter.
const sampleVersion = computed(() => data.value?.releases[0]?.version ?? '1.0.0')
const iframeSnippet = computed(() => [
  '<iframe',
  `  src="${base.value}"`,
  `  title="Changelog ${data.value?.product ?? ''}"`,
  '  loading="lazy"',
  '  style="width:100%;height:760px;border:0"',
  '></iframe>',
].join('\n'))
const fetchSnippet = computed(() => [
  '// "Was ist neu?" markieren, sobald eine neue Version erschienen ist.',
  `const res = await fetch('${base.value}/versions')`,
  'const { product, latest, versions } = await res.json()',
  "const seen = localStorage.getItem('changelog-seen')",
  'if (latest && latest !== seen) showBadge(product, latest)',
].join('\n'))

// Löschen
const confirmName = ref('')
const deleting = ref(false)
async function deleteLog() {
  deleting.value = true
  try {
    await $fetch(`/api/logs/${encodeURIComponent(id.value)}`, { method: 'DELETE', body: { confirm_name: confirmName.value } })
    toast.success('Log gelöscht.')
    await navigateTo('/dashboard')
  } catch (err) {
    toast.error(apiMessage(err))
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div v-if="error && !data" class="flex flex-col gap-4">
    <Alert variant="destructive"><AlertDescription>{{ apiMessage(error, 'Das Log konnte nicht geladen werden.') }}</AlertDescription></Alert>
    <NuxtLink to="/dashboard" class="text-sm underline">Zurück zu den Logs</NuxtLink>
  </div>

  <div v-else-if="data" class="flex flex-col gap-7">
    <nav aria-label="Brotkrumen" class="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <NuxtLink to="/dashboard" class="hover:text-foreground">Logs</NuxtLink>
      <ChevronRight class="size-3.5" />
      <span class="text-foreground">{{ data.product }}</span>
    </nav>

    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex flex-col gap-2.5">
        <h1 class="text-3xl font-semibold tracking-tight">{{ data.product }}</h1>
        <div class="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <a :href="`https://github.com/${data.owner}/${data.repo}`" class="inline-flex items-center gap-1.5 font-mono hover:text-foreground">
            <GitBranch class="size-3.5" />{{ data.owner }}/{{ data.repo }}
          </a>
          <span class="text-border">·</span>
          <Badge v-if="frozen" class="bg-amber-100 text-amber-800">Eingefroren</Badge>
          <Badge v-else class="bg-green-50 text-green-700"><span class="size-1.5 rounded-full bg-green-500" />Aktiv</Badge>
          <span class="text-border">·</span>
          <span>Zuletzt abgeglichen {{ relativeTime(data.indexedAt, now) }}</span>
        </div>
      </div>
      <Button as-child variant="outline" size="lg">
        <a :href="`/l/${encodeURIComponent(data.id)}`" target="_blank" rel="noopener">Öffentliche Seite <ExternalLink /></a>
      </Button>
    </div>

    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div class="flex flex-col gap-6">
        <Alert v-if="data.installation === 'no_installation'" variant="destructive">
          <TriangleAlert />
          <AlertTitle>Kein Zugriff auf das Repository</AlertTitle>
          <AlertDescription>
            Die GitHub App ist auf {{ data.owner }}/{{ data.repo }} nicht installiert. Bis sie wieder installiert ist, schlagen Speichern, Hochladen und Abgleich fehl.
            <a :href="`https://github.com/${data.owner}/${data.repo}/settings/installations`" target="_blank" rel="noopener" class="underline">Installationen auf GitHub öffnen</a>
          </AlertDescription>
        </Alert>
        <Alert v-else-if="data.installation === 'gone'" variant="destructive">
          <TriangleAlert />
          <AlertTitle>Repository nicht auffindbar</AlertTitle>
          <AlertDescription>{{ data.owner }}/{{ data.repo }} gibt es auf GitHub nicht mehr, es wurde gelöscht oder umbenannt.</AlertDescription>
        </Alert>
        <Alert v-if="data.errors.length > 0" variant="destructive">
          <TriangleAlert />
          <AlertTitle>{{ data.errors.length }} Abgleichfehler</AlertTitle>
          <AlertDescription>
            <dl class="mt-1 grid grid-cols-[minmax(0,220px)_minmax(0,1fr)] gap-x-3 gap-y-1">
              <template v-for="e in data.errors" :key="e.path">
                <dt class="truncate font-mono">{{ e.path }}</dt>
                <dd>{{ e.message }}</dd>
              </template>
            </dl>
          </AlertDescription>
        </Alert>

        <section class="overflow-hidden rounded-xl border bg-card">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
            <div class="flex flex-col gap-0.5">
              <h2 class="text-base font-semibold">Releases</h2>
              <p class="text-[13px] text-muted-foreground">Hier im Editor oder über MCP geschrieben; öffentlich erst nach dem Veröffentlichen.</p>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-[13px] text-muted-foreground">{{ data.releases.length }} {{ data.releases.length === 1 ? 'Release' : 'Releases' }} · {{ drafts }} {{ drafts === 1 ? 'Entwurf' : 'Entwürfe' }}</span>
              <Button v-if="!frozen" as-child size="sm">
                <NuxtLink :to="`/dashboard/logs/${encodeURIComponent(data.id)}/releases/new`"><Plus /> Neues Release</NuxtLink>
              </Button>
            </div>
          </div>
          <div v-if="data.releases.length === 0" class="px-5 py-12 text-center text-sm text-muted-foreground">Noch keine Releases.</div>
          <ul v-else>
            <li v-for="r in data.releases" :key="r.version" class="relative border-b last:border-b-0 hover:bg-muted/40">
              <NuxtLink
                :to="`/dashboard/logs/${encodeURIComponent(data.id)}/releases/${encodeURIComponent(r.version)}`"
                class="grid h-[60px] grid-cols-[110px_minmax(0,1fr)_110px_120px] items-center gap-4 px-5 text-sm"
              >
                <span><span class="rounded-md bg-primary px-2 py-0.5 font-mono text-xs text-primary-foreground">{{ r.version }}</span></span>
                <span class="truncate">{{ r.headline }}</span>
                <span class="text-[13px] text-muted-foreground">{{ formatDate(r.date) }}</span>
                <AppStatusDot v-if="r.published_at" tone="green"><span class="text-green-700">Veröffentlicht</span></AppStatusDot>
                <AppStatusDot v-else tone="gray"><span class="text-muted-foreground">Entwurf</span></AppStatusDot>
              </NuxtLink>
            </li>
          </ul>
        </section>

        <section class="flex flex-col gap-4 rounded-xl border bg-card p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex flex-col gap-0.5">
              <h2 class="flex items-center gap-2 text-base font-semibold"><Code2 class="size-4" /> Einbinden</h2>
              <p class="text-[13px] text-muted-foreground">Die öffentliche Seite in deiner App zeigen, oder die Releases selbst abfragen.</p>
            </div>
            <AppSegmented v-model="embedMode" label="Art der Einbindung" :options="EMBED_OPTIONS" class="w-[280px]" />
          </div>

          <Alert v-if="data.visibility === 'private'">
            <TriangleAlert />
            <AlertDescription>
              Das Log ist privat. Seite und API antworten für alle, die keine Schreibrechte auf
              {{ data.owner }}/{{ data.repo }} haben, mit 404 — auch im iframe. Für eine öffentliche Einbindung die
              Sichtbarkeit rechts auf <strong class="text-foreground">Öffentlich</strong> stellen.
            </AlertDescription>
          </Alert>

          <template v-if="embedMode === 'iframe'">
            <AppCopyBlock :code="iframeSnippet" label="HTML" />
            <p class="text-[13px] leading-5 text-muted-foreground">
              Die Seite setzt kein <code class="font-mono">X-Frame-Options</code>, lässt sich also von jeder Domain
              einbetten. Sie bringt ihr eigenes Layout mit und wächst mit der Zahl der Releases — gib dem
              <code class="font-mono">iframe</code> darum eine feste Höhe und lass ihn intern scrollen, oder rendere
              in der Ansicht <strong class="text-foreground">Zeitstrahl</strong>, die kompakter baut.
            </p>
          </template>

          <template v-else>
            <div class="flex flex-col gap-2">
              <span class="text-[13px] font-medium">Endpunkte</span>
              <ul class="flex flex-col gap-2.5 text-[13px]">
                <li class="flex flex-col gap-0.5">
                  <code class="overflow-x-auto font-mono whitespace-nowrap">GET {{ base }}/versions</code>
                  <span class="text-muted-foreground">Produktname, <code class="font-mono">latest</code> und alle Versionen mit Datum und Überschrift.</span>
                </li>
                <li class="flex flex-col gap-0.5">
                  <code class="overflow-x-auto font-mono whitespace-nowrap">GET {{ base }}/releases?page=1&amp;per_page=10</code>
                  <span class="text-muted-foreground">Seitenweiser Feed; je Release die Abschnitte mit Anzahl statt Einträgen.</span>
                </li>
                <li class="flex flex-col gap-0.5">
                  <code class="overflow-x-auto font-mono whitespace-nowrap">GET {{ base }}/releases/{{ sampleVersion }}</code>
                  <span class="text-muted-foreground">Ein Release vollständig, mit allen Einträgen und Bild.</span>
                </li>
              </ul>
            </div>
            <AppCopyBlock :code="fetchSnippet" label="JavaScript" />
            <p class="text-[13px] leading-5 text-muted-foreground">
              Die Antworten sind <code class="font-mono">access-control-allow-origin: *</code>, gehen also direkt aus dem
              Browser. Sie tragen ein <code class="font-mono">ETag</code> des abgeglichenen Commits und dürfen 60 Sekunden
              zwischengespeichert werden. Die <code class="font-mono">url</code>-Felder kommen als Pfad ohne Host — davor gehört der Origin dieser Instanz.
              Entwürfe erscheinen nie, veröffentlichte Releases sofort nach dem Abgleich.
            </p>
          </template>
        </section>
      </div>

      <div class="flex flex-col gap-6">
        <Card class="gap-4 p-5">
          <h2 class="text-base font-semibold">Einstellungen</h2>
          <form class="flex flex-col gap-4" @submit.prevent="saveSettings">
            <div class="flex flex-col gap-2">
              <span class="text-sm font-medium">Ansicht</span>
              <AppSegmented v-model="settings.view" label="Ansicht" :options="VIEW_OPTIONS" />
            </div>
            <div class="flex flex-col gap-2">
              <span class="text-sm font-medium">Sichtbarkeit</span>
              <AppSegmented v-model="settings.visibility" label="Sichtbarkeit" :options="VISIBILITY_OPTIONS" />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="notes">Kurationshinweise</Label>
              <Textarea id="notes" v-model="settings.curation_notes" rows="4" placeholder="Hinweise für den MCP-Client: Tonfall, was ins Log gehört, was nicht." />
              <p class="text-xs text-muted-foreground">Landet in <code class="font-mono">release-log.json</code> im Repository.</p>
            </div>
            <Button type="submit" size="lg" :disabled="saving || frozen">{{ saving ? 'Speichert…' : 'Speichern' }}</Button>
          </form>
        </Card>

        <Card class="gap-3.5 p-5">
          <h2 class="text-base font-semibold">Medien</h2>
          <label
            class="relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors"
            :class="dragging ? 'border-primary bg-muted' : 'bg-muted/40 hover:bg-muted/70'"
            @dragover.prevent="dragging = true" @dragleave="dragging = false"
            @drop.prevent="dragging = false; upload($event.dataTransfer?.files[0])"
          >
            <Upload class="size-5 text-muted-foreground" />
            <span class="text-sm font-medium">{{ uploading ? 'Lädt hoch…' : 'Bild hierher ziehen oder auswählen' }}</span>
            <span class="text-xs text-muted-foreground">PNG, JPG oder WebP</span>
            <input ref="fileInput" type="file" accept=".png,.jpg,.jpeg,.webp" class="sr-only" :disabled="uploading || frozen" @change="upload(($event.target as HTMLInputElement).files?.[0])">
          </label>
          <ul v-if="data.media.length > 0" class="grid grid-cols-3 gap-2">
            <li v-for="path in data.media" :key="path" class="flex flex-col gap-1">
              <img :src="mediaUrl(path)" :alt="path" class="aspect-square w-full rounded-md border object-cover" loading="lazy">
              <span class="truncate font-mono text-[11px] text-muted-foreground" :title="path">{{ path.replace(/^media\//, '') }}</span>
            </li>
          </ul>
          <p v-else class="flex items-center gap-2 text-xs text-muted-foreground"><ImageIcon class="size-3.5" /> Noch keine Bilder.</p>
        </Card>

        <Card class="gap-3 border-destructive/30 p-5">
          <h2 class="text-base font-semibold text-destructive">Log löschen</h2>
          <p class="text-[13px] leading-5 text-muted-foreground">
            Entfernt das Log endgültig aus dem Index. Das Repository auf GitHub bleibt. Gib zur Bestätigung
            <strong class="text-foreground">{{ data.product }}</strong> ein.
          </p>
          <Input v-model="confirmName" aria-label="Produktname zur Bestätigung" />
          <Button variant="destructive" size="lg" :disabled="confirmName !== data.product || deleting" @click="deleteLog">
            <Trash2 /> Endgültig löschen
          </Button>
        </Card>
      </div>
    </div>
  </div>
</template>
