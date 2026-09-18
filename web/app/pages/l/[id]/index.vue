<script setup lang="ts">
import { useWindowScroll } from '@vueuse/core'

definePageMeta({ layout: 'public' })

const route = useRoute()
const id = String(route.params.id)
const { m, t } = useI18n()
const { data, error } = await useFetch<{ log: PublicLogHead; releases: PublicRelease[] }>(`/api/public/logs/${encodeURIComponent(id)}`)
// Privat und fehlend sind dieselbe 404 (spec §7).
if (error.value || !data.value) throw createError({ statusCode: 404, statusMessage: 'not_found' })

const log = computed(() => data.value!.log)
// Der Kopf bleibt oben stehen und schrumpft, sobald der erste Release hochgescrollt ist.
const { y } = useWindowScroll()
const compact = computed(() => y.value > 80)

useHead({
  title: () => t(m.value.publicLog.title, { product: log.value.product }),
  meta: () => (log.value.visibility === 'private' ? [{ name: 'robots', content: 'noindex' }] : []),
})
</script>

<template>
  <div class="mx-auto flex max-w-[1000px] flex-col px-4 pb-12 sm:px-6">
    <header
      class="fixed inset-x-0 top-0 z-30 flex items-center justify-center border-b bg-background/85 backdrop-blur transition-[height,background-color,border-color] duration-300 ease-out motion-reduce:transition-none"
      :class="compact ? 'h-16 border-border' : 'h-64 border-transparent bg-background'"
    >
      <div class="flex max-w-[1000px] flex-col items-center px-4 text-center sm:px-6">
        <span
          class="inline-flex items-center gap-2 overflow-hidden rounded-full border text-[13px] text-muted-foreground transition-all duration-300 ease-out motion-reduce:transition-none"
          :class="compact ? 'h-0 border-transparent px-0 opacity-0' : 'mb-3.5 h-7 px-3 opacity-100'"
        >
          <span class="size-1.5 shrink-0 rounded-full bg-green-500" />{{ m.publicLog.badge }}
        </span>
        <h1
          class="font-semibold tracking-tight transition-all duration-300 ease-out motion-reduce:transition-none"
          :class="compact ? 'text-lg' : 'mb-3.5 text-4xl sm:text-[44px]'"
        >
          {{ log.product }}
        </h1>
        <p
          class="max-w-xl overflow-hidden text-[17px] leading-7 text-muted-foreground transition-all duration-300 ease-out motion-reduce:transition-none"
          :class="compact ? 'max-h-0 opacity-0' : 'max-h-28 opacity-100'"
        >
          {{ m.publicLog.intro }}
        </p>
      </div>
    </header>
    <!-- Platzhalter für den fixierten Kopf: die Liste soll beim Schrumpfen nicht springen. -->
    <div class="mb-20 h-64 shrink-0" aria-hidden="true" />

    <p v-if="data!.releases.length === 0" class="text-center text-muted-foreground">{{ m.publicLog.empty }}</p>
    <ol v-else class="flex flex-col">
      <AppReleaseEntry
        v-for="(release, i) in data!.releases" :key="release.version"
        :log-id="log.id" :release="release" :collapsible="log.view === 'timeline'" :last="i === data!.releases.length - 1"
      />
    </ol>

    <footer class="mt-8 flex flex-wrap items-center justify-between gap-3 border-t pt-6 text-[13px] text-muted-foreground">
      <AppLanguageSwitch class="order-last sm:order-none" />
      <span>{{ m.publicLog.alsoJson }} <a :href="`/l/${encodeURIComponent(log.id)}/releases`" class="font-mono text-xs text-foreground/80 hover:underline">/l/{{ log.id }}/releases</a></span>
      <span>{{ m.publicLog.poweredBy }}</span>
    </footer>
  </div>
</template>
