<script setup lang="ts">
// Zwei Knöpfe statt eines Select: bei zwei Sprachen ist die Auswahl
// schneller sichtbar als aufklappbar. Die Wahl landet im Cookie rl_lang,
// die Seite lädt dabei nicht neu.
defineProps<{ tone?: 'light' | 'dark' }>()
const { locale, locales, m, setLocale } = useI18n()
</script>

<template>
  <div role="radiogroup" :aria-label="m.language.label" class="inline-flex items-center gap-0.5">
    <button
      v-for="code in locales" :key="code"
      type="button" role="radio" :aria-checked="locale === code" :title="m.language[code]"
      class="rounded-md px-1.5 py-0.5 text-xs font-medium uppercase transition-colors"
      :class="locale === code
        ? (tone === 'dark' ? 'bg-zinc-800 text-zinc-50' : 'bg-muted text-foreground')
        : (tone === 'dark' ? 'text-zinc-400 hover:text-zinc-50' : 'text-muted-foreground hover:text-foreground')"
      @click="setLocale(code)"
    >
      {{ code }}
    </button>
  </div>
</template>
