<script setup lang="ts">
// Die Datenschutzerklärung. Der Text liegt in ~/i18n/datenschutz.ts, hier
// steht nur, wie er aussieht -- die Seite kennt keine Inhalte, damit eine
// Textänderung nie eine Vue-Datei anfasst.
import { CONTROLLER, PRIVACY, PRIVACY_META } from '~/i18n/datenschutz'

definePageMeta({ layout: 'public' })

const { t, locale } = useI18n()
const meta = computed(() => PRIVACY_META[locale.value])
const sections = computed(() => PRIVACY[locale.value])

// {hosting} und {authority} stehen im Rechtstext, ihre Werte in CONTROLLER:
// eine Anschrift und ein Hoster sind keine Übersetzung und sollen nicht
// zweimal gepflegt werden.
function fill(text: string): string {
  return t(text, { hosting: CONTROLLER.hosting, authority: CONTROLLER.authority })
}

// Eine nackte URL soll anklickbar sein, ein `Bezeichner` als Code lesbar.
// Ein Markdown-Parser wäre für diese zwei Fälle die falsche Größe.
// ponytail: erkennt nur http(s):// mit Punkt darin und Backticks; reicht,
// solange der Text keine bloßen Domains ohne Schema und kein weiteres
// Markup enthält. Der Punkt ist Pflicht, damit das nackte „https://" im
// Satz über die Verschlüsselung kein Link wird.
type Part = { text: string; href?: string; code?: boolean }
function parts(text: string): Part[] {
  return fill(text)
    .split(/(https?:\/\/[^\s)"'“”„]*\.[^\s)"'“”„]+|`[^`]+`)/g)
    .filter((piece) => piece !== '')
    .map((piece): Part => {
      if (piece.startsWith('http')) return { text: piece, href: piece }
      if (piece.startsWith('`')) return { text: piece.slice(1, -1), code: true }
      return { text: piece }
    })
}

useHead({
  title: () => meta.value.title,
  meta: () => [{ name: 'description', content: meta.value.description }],
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
            <template v-for="(part, k) in parts(item)" :key="k">
              <a v-if="part.href" :href="part.href" rel="noopener noreferrer" target="_blank" class="underline underline-offset-2 hover:text-foreground">{{ part.text }}</a>
              <code v-else-if="part.code" class="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">{{ part.text }}</code>
              <template v-else>{{ part.text }}</template>
            </template>
          </li>
        </ul>
        <p v-else class="text-[15px] leading-7 text-muted-foreground">
          <template v-for="(part, k) in parts(block)" :key="k">
            <a v-if="part.href" :href="part.href" rel="noopener noreferrer" target="_blank" class="break-all underline underline-offset-2 hover:text-foreground">{{ part.text }}</a>
            <code v-else-if="part.code" class="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">{{ part.text }}</code>
            <template v-else>{{ part.text }}</template>
          </template>
        </p>
        <address v-if="section.contact && i === 0" class="rounded-lg border bg-muted/40 px-5 py-4 text-[15px] leading-7 not-italic">
          {{ CONTROLLER.name }}<br>
          {{ CONTROLLER.street }}<br>
          {{ CONTROLLER.city }}<br>
          {{ CONTROLLER.country }}<br>
          {{ CONTROLLER.email }}
        </address>
      </template>
    </section>

    <footer class="flex items-center justify-between border-t pt-6 text-sm text-muted-foreground">
      <NuxtLink to="/" class="hover:text-foreground">release-log</NuxtLink>
      <AppLanguageSwitch />
    </footer>
  </main>
</template>
