<script setup lang="ts">
// Impressum und Datenschutzerklärung sind dieselbe Seite mit anderem Text.
// Deshalb steht das Aussehen einmal hier und nicht zweimal in pages/.
import type { LegalMeta, Section } from '~/i18n/legal'
import { CONTROLLER } from '~/i18n/legal'

const props = defineProps<{
  sections: Section[]
  meta: LegalMeta
}>()

const { t } = useI18n()

// {provider}, {location} und {authority} stehen im Rechtstext, ihre Werte
// in CONTROLLER: eine Anschrift ist keine Übersetzung und soll nicht
// zweimal gepflegt werden.
function fill(text: string): string {
  return t(text, {
    provider: CONTROLLER.hostingProvider,
    location: CONTROLLER.hostingLocation,
    authority: CONTROLLER.authority,
  })
}

// Eine nackte URL soll anklickbar sein, ein Verweis auf die jeweils andere
// Rechtsseite auch, und ein `Bezeichner` als Code lesbar. Ein
// Markdown-Parser wäre für diese drei Fälle die falsche Größe.
// ponytail: erkennt nur http(s):// mit Punkt darin, die zwei bekannten
// internen Pfade und Backticks. Der Punkt in der URL ist Pflicht, damit
// das nackte „https://" im Satz über die Verschlüsselung kein Link wird.
type Part = { text: string; href?: string; to?: string; code?: boolean; tail?: string }
function parts(text: string): Part[] {
  return fill(text)
    .split(/(https?:\/\/[^\s)"'“”„]*\.[^\s)"'“”„]+|\/(?:datenschutz|impressum)\b|`[^`]+`)/g)
    .filter((piece) => piece !== '')
    .map((piece): Part => {
      // Ein Satzzeichen direkt hinter der URL gehört zum Satz, nicht zur
      // Adresse: „…de." ist ein anderer Link als „…de".
      if (piece.startsWith('http')) {
        const url = piece.replace(/[.,;:!?]+$/, '')
        return { text: url, href: url, tail: piece.slice(url.length) }
      }
      if (piece.startsWith('/')) return { text: piece, to: piece }
      if (piece.startsWith('`')) return { text: piece.slice(1, -1), code: true }
      return { text: piece }
    })
}

const sections = computed(() => props.sections)

useHead({
  title: () => props.meta.title,
  meta: () => [{ name: 'description', content: props.meta.description }],
})
</script>

<template>
  <main class="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-4 py-14 sm:px-6 sm:py-20">
    <header class="flex flex-col gap-3">
      <NuxtLink to="/" class="text-sm text-muted-foreground hover:text-foreground">&larr; {{ meta.back }}</NuxtLink>
      <h1 class="text-[32px] leading-[38px] font-semibold tracking-tight sm:text-[40px] sm:leading-[46px]">{{ meta.intro }}</h1>
      <p class="text-sm text-muted-foreground">{{ t(meta.updated, { date: CONTROLLER.updated }) }}</p>
    </header>

    <section v-for="section in sections" :key="section.heading" class="flex flex-col gap-4">
      <h2 class="text-xl font-semibold tracking-tight">{{ section.heading }}</h2>
      <template v-for="(block, i) in section.blocks" :key="i">
        <ul v-if="Array.isArray(block)" class="flex list-disc flex-col gap-2 pl-5 text-[15px] leading-7 text-muted-foreground">
          <li v-for="(item, j) in block" :key="j">
            <AppLegalText :parts="parts(item)" />
          </li>
        </ul>
        <p v-else class="text-[15px] leading-7 text-muted-foreground">
          <AppLegalText :parts="parts(block)" />
        </p>
        <address v-if="section.contact && i === 0" class="rounded-lg border bg-muted/40 px-5 py-4 text-[15px] leading-7 not-italic">
          {{ CONTROLLER.name }}<br>
          {{ CONTROLLER.street }}<br>
          {{ CONTROLLER.city }}<br>
          {{ CONTROLLER.country }}<br>
          <a :href="`mailto:${CONTROLLER.email}`" class="underline underline-offset-2">{{ CONTROLLER.email }}</a>
        </address>
      </template>
    </section>

    <footer class="flex items-center justify-between border-t pt-6 text-sm text-muted-foreground">
      <NuxtLink to="/" class="hover:text-foreground">release-log</NuxtLink>
      <AppLanguageSwitch />
    </footer>
  </main>
</template>
