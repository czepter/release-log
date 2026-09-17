<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'

const props = defineProps<{ logId?: string; release: PublicRelease; collapsible: boolean; last?: boolean; permalink?: boolean; href?: string }>()

// Zeitstrahl: nur der erste Abschnitt steht offen. Vollständig: alle.
const open = ref<Record<string, boolean>>(Object.fromEntries(
  props.release.sections.map((s, i) => [s.key, !props.collapsible || i === 0]),
))
const paragraphs = (text: string) => text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
const refs = (c: PublicChange) => [c.pr !== null ? `PR #${c.pr}` : null, ...c.issues.map((n) => `#${n}`)].filter(Boolean).join(' · ')
</script>

<template>
  <li class="grid grid-cols-[minmax(0,1fr)] gap-x-0 pb-16 sm:grid-cols-[150px_48px_minmax(0,1fr)]">
    <div class="mb-3 flex items-center gap-2 sm:sticky sm:top-24 sm:mb-0 sm:flex-col sm:items-end sm:gap-2 sm:self-start sm:pt-0.5">
      <span class="rounded-md bg-primary px-2 py-0.5 font-mono text-xs font-medium text-primary-foreground">v{{ release.version }}</span>
      <time :datetime="release.date" class="text-[13px] text-muted-foreground">{{ formatDate(release.date) }}</time>
      <Badge v-if="release.published_at === null" variant="outline" class="text-muted-foreground">Entwurf</Badge>
    </div>

    <div class="relative hidden justify-center sm:flex" aria-hidden="true">
      <span v-if="!last" class="absolute top-3.5 -bottom-16 w-px bg-border" />
      <span class="sticky top-24 mt-[7px] size-[13px] shrink-0 rounded-full border-[3px] border-primary bg-background" />
    </div>

    <article class="flex min-w-0 flex-col gap-4">
      <h2 class="text-[22px] leading-[30px] font-semibold tracking-tight">
        <a v-if="href" :href="href" class="hover:underline">{{ release.headline }}</a>
        <NuxtLink v-else-if="!permalink && logId" :to="`/l/${encodeURIComponent(logId)}/r/${encodeURIComponent(release.version)}`" class="hover:underline">{{ release.headline }}</NuxtLink>
        <template v-else>{{ release.headline }}</template>
      </h2>
      <p v-for="(p, i) in release.body" :key="i" class="text-[15px] leading-[25px] text-muted-foreground">{{ p }}</p>
      <img v-if="release.image" :src="release.image.src" :alt="release.image.alt" class="w-full rounded-xl border" loading="lazy">

      <div class="flex flex-col border-t">
        <section v-for="section in release.sections" :key="section.key" class="border-b">
          <h3>
            <button
              type="button" class="group flex min-h-[52px] w-full items-center justify-between text-left"
              :aria-expanded="open[section.key]" @click="open[section.key] = !open[section.key]"
            >
              <span class="flex items-center gap-2">
                <span class="rounded-md px-2 py-0.5 text-xs font-medium" :class="SECTION_TONE[section.key]">{{ section.label }}</span>
                <span class="text-xs text-muted-foreground">{{ section.items.length }} {{ section.items.length === 1 ? 'Eintrag' : 'Einträge' }}</span>
              </span>
              <ChevronDown class="size-4 text-muted-foreground transition-transform group-hover:text-foreground" :class="open[section.key] && 'rotate-180'" />
            </button>
          </h3>
          <ul v-show="open[section.key]" class="flex flex-col gap-4 pb-5">
            <li v-for="(change, i) in section.items" :key="i" class="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5 text-sm leading-[22px]">
              <span class="mt-[9px] size-[5px] rounded-full bg-zinc-400" />
              <div class="flex flex-col gap-1.5">
                <p>
                  <span v-if="change.scope" class="mr-1.5 font-mono text-xs text-muted-foreground">{{ change.scope }}</span>
                  <strong class="font-medium">{{ change.title }}</strong>
                </p>
                <p v-for="(p, j) in paragraphs(change.description)" :key="j" class="text-muted-foreground">{{ p }}</p>
                <p v-if="refs(change)" class="font-mono text-xs text-muted-foreground">{{ refs(change) }}</p>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </article>
  </li>
</template>
