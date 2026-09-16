<script setup lang="ts">
definePageMeta({ layout: 'public' })

const route = useRoute()
const id = String(route.params.id)
const { data, error } = await useFetch<{ log: PublicLogHead; releases: PublicRelease[] }>(`/api/public/logs/${encodeURIComponent(id)}`)
// Privat und fehlend sind dieselbe 404 (spec §7).
if (error.value || !data.value) throw createError({ statusCode: 404, statusMessage: 'Nicht gefunden', fatal: true })

const log = computed(() => data.value!.log)
useHead({
  title: () => `${log.value.product} · Changelog`,
  meta: () => (log.value.visibility === 'private' ? [{ name: 'robots', content: 'noindex' }] : []),
})
</script>

<template>
  <div class="mx-auto flex max-w-[1000px] flex-col px-4 pt-24 pb-12 sm:px-6">
    <header class="mb-20 flex flex-col items-center gap-3.5 text-center">
      <span class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] text-muted-foreground">
        <span class="size-1.5 rounded-full bg-green-500" />Changelog
      </span>
      <h1 class="text-4xl font-semibold tracking-tight sm:text-[44px]">{{ log.product }}</h1>
      <p class="max-w-xl text-[17px] leading-7 text-muted-foreground">Was neu ist, was sich geändert hat und was behoben wurde, Release für Release.</p>
    </header>

    <p v-if="data!.releases.length === 0" class="text-center text-muted-foreground">Noch keine veröffentlichten Releases.</p>
    <ol v-else class="flex flex-col">
      <AppReleaseEntry
        v-for="(release, i) in data!.releases" :key="release.version"
        :log-id="log.id" :release="release" :collapsible="log.view === 'timeline'" :last="i === data!.releases.length - 1"
      />
    </ol>

    <footer class="mt-8 flex flex-wrap justify-between gap-3 border-t pt-6 text-[13px] text-muted-foreground">
      <span>Auch als JSON: <a :href="`/l/${encodeURIComponent(log.id)}/releases`" class="font-mono text-xs text-foreground/80 hover:underline">/l/{{ log.id }}/releases</a></span>
      <span>Geführt mit release-log</span>
    </footer>
  </div>
</template>
