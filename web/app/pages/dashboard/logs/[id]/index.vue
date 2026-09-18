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
const { m, t, p: plural, viewOptions, visibilityOptions, formatDate, relativeTime, apiText } = useI18n()
if (error.value?.statusCode === 404) throw createError({ statusCode: 404, statusMessage: m.value.error.logNotFound })
useHead({ title: () => data.value?.product ?? m.value.log.fallbackTitle })

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
    toast.success(m.value.log.settingsSaved)
    setTimeout(() => refresh(), 1500)
  } catch (err) {
    toast.error(apiText(err))
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
    toast.success(t(m.value.log.uploaded, { path: res.path }))
    setTimeout(() => refresh(), 1500)
  } catch (err) {
    toast.error(apiText(err))
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
const embedOptions = computed(() => [{ value: 'iframe', label: m.value.log.embedIframe }, { value: 'api', label: m.value.log.embedApi }])
// Ein echtes Beispiel liest sich besser als ein Platzhalter.
const sampleVersion = computed(() => data.value?.releases[0]?.version ?? '1.0.0')
const iframeSnippet = computed(() => [
  '<iframe',
  `  src="${base.value}"`,
  `  title="${t(m.value.log.iframeTitle, { product: data.value?.product ?? '' })}"`,
  '  loading="lazy"',
  '  style="width:100%;height:760px;border:0"',
  '></iframe>',
].join('\n'))
const fetchSnippet = computed(() => [
  m.value.log.snippetComment,
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
    toast.success(m.value.log.deleted)
    await navigateTo('/dashboard')
  } catch (err) {
    toast.error(apiText(err))
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div v-if="error && !data" class="flex flex-col gap-4">
    <Alert variant="destructive"><AlertDescription>{{ apiText(error, m.log.loadFailed) }}</AlertDescription></Alert>
    <NuxtLink to="/dashboard" class="text-sm underline">{{ m.log.backToLogs }}</NuxtLink>
  </div>

  <div v-else-if="data" class="flex flex-col gap-7">
    <nav :aria-label="m.common.breadcrumb" class="flex items-center gap-1.5 text-[13px] text-muted-foreground">
      <NuxtLink to="/dashboard" class="hover:text-foreground">{{ m.header.logs }}</NuxtLink>
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
          <Badge v-if="frozen" class="bg-amber-100 text-amber-800">{{ m.common.frozen }}</Badge>
          <Badge v-else class="bg-green-50 text-green-700"><span class="size-1.5 rounded-full bg-green-500" />{{ m.common.active }}</Badge>
          <span class="text-border">·</span>
          <span>{{ t(m.log.lastSynced, { when: relativeTime(data.indexedAt, now) }) }}</span>
        </div>
      </div>
      <Button as-child variant="outline" size="lg">
        <a :href="`/l/${encodeURIComponent(data.id)}`" target="_blank" rel="noopener">{{ m.log.publicPage }} <ExternalLink /></a>
      </Button>
    </div>

    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div class="flex flex-col gap-6">
        <Alert v-if="data.installation === 'no_installation'" variant="destructive">
          <TriangleAlert />
          <AlertTitle>{{ m.log.noInstallTitle }}</AlertTitle>
          <AlertDescription>
            {{ t(m.log.noInstallText, { repo: `${data.owner}/${data.repo}` }) }}
            <a :href="`https://github.com/${data.owner}/${data.repo}/settings/installations`" target="_blank" rel="noopener" class="underline">{{ m.log.noInstallLink }}</a>
          </AlertDescription>
        </Alert>
        <Alert v-else-if="data.installation === 'gone'" variant="destructive">
          <TriangleAlert />
          <AlertTitle>{{ m.log.goneTitle }}</AlertTitle>
          <AlertDescription>{{ t(m.log.goneText, { repo: `${data.owner}/${data.repo}` }) }}</AlertDescription>
        </Alert>
        <Alert v-if="data.errors.length > 0" variant="destructive">
          <TriangleAlert />
          <AlertTitle>{{ plural(m.log.syncErrors, data.errors.length) }}</AlertTitle>
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
              <h2 class="text-base font-semibold">{{ m.log.releases }}</h2>
              <p class="text-[13px] text-muted-foreground">{{ m.log.releasesHint }}</p>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-[13px] text-muted-foreground">{{ plural(m.log.releaseCount, data.releases.length) }} · {{ plural(m.log.draftCount, drafts) }}</span>
              <Button v-if="!frozen" as-child size="sm">
                <NuxtLink :to="`/dashboard/logs/${encodeURIComponent(data.id)}/releases/new`"><Plus /> {{ m.log.newRelease }}</NuxtLink>
              </Button>
            </div>
          </div>
          <div v-if="data.releases.length === 0" class="px-5 py-12 text-center text-sm text-muted-foreground">{{ m.log.noReleases }}</div>
          <ul v-else>
            <li v-for="r in data.releases" :key="r.version" class="relative border-b last:border-b-0 hover:bg-muted/40">
              <NuxtLink
                :to="`/dashboard/logs/${encodeURIComponent(data.id)}/releases/${encodeURIComponent(r.version)}`"
                class="grid h-[60px] grid-cols-[110px_minmax(0,1fr)_110px_120px] items-center gap-4 px-5 text-sm"
              >
                <span><span class="rounded-md bg-primary px-2 py-0.5 font-mono text-xs text-primary-foreground">{{ r.version }}</span></span>
                <span class="truncate">{{ r.headline }}</span>
                <span class="text-[13px] text-muted-foreground">{{ formatDate(r.date) }}</span>
                <AppStatusDot v-if="r.published_at" tone="green"><span class="text-green-700">{{ m.common.published }}</span></AppStatusDot>
                <AppStatusDot v-else tone="gray"><span class="text-muted-foreground">{{ m.common.draft }}</span></AppStatusDot>
              </NuxtLink>
            </li>
          </ul>
        </section>

        <section class="flex flex-col gap-4 rounded-xl border bg-card p-5">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex flex-col gap-0.5">
              <h2 class="flex items-center gap-2 text-base font-semibold"><Code2 class="size-4" /> {{ m.log.embed }}</h2>
              <p class="text-[13px] text-muted-foreground">{{ m.log.embedHint }}</p>
            </div>
            <AppSegmented v-model="embedMode" :label="m.log.embedMode" :options="embedOptions" class="w-[280px]" />
          </div>

          <Alert v-if="data.visibility === 'private'">
            <TriangleAlert />
            <AlertDescription>
              {{ m.log.privateWarn1 }} {{ data.owner }}/{{ data.repo }} {{ m.log.privateWarn2 }}
              <strong class="text-foreground">{{ m.common.public }}</strong>{{ m.log.privateWarn3 }}
            </AlertDescription>
          </Alert>

          <template v-if="embedMode === 'iframe'">
            <AppCopyBlock :code="iframeSnippet" label="HTML" />
            <p class="text-[13px] leading-5 text-muted-foreground">
              {{ m.log.iframeNote1 }} <code class="font-mono">X-Frame-Options</code>{{ m.log.iframeNote2 }}
              <code class="font-mono">iframe</code> {{ t(m.log.iframeNote3, { view: m.options.viewTimeline }) }}
            </p>
          </template>

          <template v-else>
            <div class="flex flex-col gap-2">
              <span class="text-[13px] font-medium">{{ m.log.endpoints }}</span>
              <ul class="flex flex-col gap-2.5 text-[13px]">
                <li class="flex flex-col gap-0.5">
                  <code class="overflow-x-auto font-mono whitespace-nowrap">GET {{ base }}/versions</code>
                  <span class="text-muted-foreground">{{ m.log.endpointVersions1 }} <code class="font-mono">latest</code> {{ m.log.endpointVersions2 }}</span>
                </li>
                <li class="flex flex-col gap-0.5">
                  <code class="overflow-x-auto font-mono whitespace-nowrap">GET {{ base }}/releases?page=1&amp;per_page=10</code>
                  <span class="text-muted-foreground">{{ m.log.endpointReleases }}</span>
                </li>
                <li class="flex flex-col gap-0.5">
                  <code class="overflow-x-auto font-mono whitespace-nowrap">GET {{ base }}/releases/{{ sampleVersion }}</code>
                  <span class="text-muted-foreground">{{ m.log.endpointRelease }}</span>
                </li>
              </ul>
            </div>
            <AppCopyBlock :code="fetchSnippet" label="JavaScript" />
            <p class="text-[13px] leading-5 text-muted-foreground">
              {{ m.log.apiNote1 }} <code class="font-mono">access-control-allow-origin: *</code>{{ m.log.apiNote2 }}
              <code class="font-mono">ETag</code> {{ m.log.apiNote3 }}
              <code class="font-mono">url</code>{{ m.log.apiNote4 }}
            </p>
          </template>
        </section>
      </div>

      <div class="flex flex-col gap-6">
        <Card class="gap-4 p-5">
          <h2 class="text-base font-semibold">{{ m.log.settings }}</h2>
          <form class="flex flex-col gap-4" @submit.prevent="saveSettings">
            <div class="flex flex-col gap-2">
              <span class="text-sm font-medium">{{ m.log.view }}</span>
              <AppSegmented v-model="settings.view" :label="m.log.view" :options="viewOptions" />
            </div>
            <div class="flex flex-col gap-2">
              <span class="text-sm font-medium">{{ m.log.visibility }}</span>
              <AppSegmented v-model="settings.visibility" :label="m.log.visibility" :options="visibilityOptions" />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="notes">{{ m.log.curationNotes }}</Label>
              <Textarea id="notes" v-model="settings.curation_notes" rows="4" :placeholder="m.log.curationPlaceholder" />
              <p class="text-xs text-muted-foreground">{{ m.log.curationHint1 }} <code class="font-mono">release-log.json</code> {{ m.log.curationHint2 }}</p>
            </div>
            <Button type="submit" size="lg" :disabled="saving || frozen">{{ saving ? m.common.saving : m.common.save }}</Button>
          </form>
        </Card>

        <Card class="gap-3.5 p-5">
          <h2 class="text-base font-semibold">{{ m.log.media }}</h2>
          <label
            class="relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors"
            :class="dragging ? 'border-primary bg-muted' : 'bg-muted/40 hover:bg-muted/70'"
            @dragover.prevent="dragging = true" @dragleave="dragging = false"
            @drop.prevent="dragging = false; upload($event.dataTransfer?.files[0])"
          >
            <Upload class="size-5 text-muted-foreground" />
            <span class="text-sm font-medium">{{ uploading ? m.log.uploading : m.log.dropHint }}</span>
            <span class="text-xs text-muted-foreground">{{ m.log.fileTypes }}</span>
            <input ref="fileInput" type="file" accept=".png,.jpg,.jpeg,.webp" class="sr-only" :disabled="uploading || frozen" @change="upload(($event.target as HTMLInputElement).files?.[0])">
          </label>
          <ul v-if="data.media.length > 0" class="grid grid-cols-3 gap-2">
            <li v-for="path in data.media" :key="path" class="flex flex-col gap-1">
              <img :src="mediaUrl(path)" :alt="path" class="aspect-square w-full rounded-md border object-cover" loading="lazy">
              <span class="truncate font-mono text-[11px] text-muted-foreground" :title="path">{{ path.replace(/^media\//, '') }}</span>
            </li>
          </ul>
          <p v-else class="flex items-center gap-2 text-xs text-muted-foreground"><ImageIcon class="size-3.5" /> {{ m.log.noImages }}</p>
        </Card>

        <Card class="gap-3 border-destructive/30 p-5">
          <h2 class="text-base font-semibold text-destructive">{{ m.log.deleteTitle }}</h2>
          <p class="text-[13px] leading-5 text-muted-foreground">
            {{ m.log.deleteText1 }}
            <strong class="text-foreground">{{ data.product }}</strong>{{ m.log.deleteText2 }}
          </p>
          <Input v-model="confirmName" :aria-label="m.log.deleteConfirmLabel" />
          <Button variant="destructive" size="lg" :disabled="confirmName !== data.product || deleting" @click="deleteLog">
            <Trash2 /> {{ m.log.deleteButton }}
          </Button>
        </Card>
      </div>
    </div>
  </div>
</template>
