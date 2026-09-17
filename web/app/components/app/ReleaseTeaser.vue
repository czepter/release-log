<script setup lang="ts">
import { ArrowRight } from '@lucide/vue'

// Ein älteres Release auf der Startseite: Kopf und Anzahl je Abschnitt,
// denn der Feed liefert keine Einträge (lib/public.ts).
defineProps<{ release: ShowcaseTeaser }>()
</script>

<template>
  <li class="grid grid-cols-[minmax(0,1fr)] gap-3 border-t border-dashed pt-8 sm:grid-cols-[150px_48px_minmax(0,1fr)] sm:gap-0">
    <div class="flex items-center gap-2 sm:flex-col sm:items-end sm:gap-2 sm:pt-0.5">
      <span class="rounded-md bg-muted px-2 py-0.5 font-mono text-xs font-medium">v{{ release.version }}</span>
      <time :datetime="release.date" class="text-[13px] text-muted-foreground">{{ formatDate(release.date) }}</time>
    </div>
    <div class="hidden justify-center sm:flex" aria-hidden="true">
      <span class="mt-[7px] size-[13px] rounded-full border-[3px] border-zinc-300 bg-background" />
    </div>
    <a :href="release.href" class="group flex min-w-0 items-center justify-between gap-6">
      <span class="flex min-w-0 flex-col gap-2.5">
        <span class="text-lg leading-[26px] font-semibold tracking-tight group-hover:underline">{{ release.headline }}</span>
        <span class="flex flex-wrap gap-2">
          <span v-for="s in release.sections" :key="s.key" class="rounded-md px-2 py-0.5 text-xs font-medium" :class="SECTION_TONE[s.key]">{{ s.label }} · {{ s.count }}</span>
        </span>
      </span>
      <span class="hidden size-11 shrink-0 items-center justify-center rounded-lg border sm:flex" aria-hidden="true"><ArrowRight class="size-4" /></span>
    </a>
  </li>
</template>
