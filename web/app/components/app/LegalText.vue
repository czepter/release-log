<script setup lang="ts">
// Ein Absatz Rechtstext, in Stücke zerlegt: Fließtext, Link nach außen,
// Link auf die andere Rechtsseite, Code. Eigene Komponente, weil dieselbe
// Schleife sonst in Absatz und Aufzählung doppelt stünde.
defineProps<{
  parts: Array<{ text: string; href?: string; to?: string; code?: boolean; tail?: string }>
}>()
</script>

<template>
  <template v-for="(part, k) in parts" :key="k">
    <a
      v-if="part.href"
      :href="part.href"
      rel="noopener noreferrer"
      target="_blank"
      class="break-all underline underline-offset-2 hover:text-foreground"
    >{{ part.text }}</a><template v-if="part.href && part.tail">{{ part.tail }}</template>
    <NuxtLink
      v-else-if="part.to"
      :to="part.to"
      class="underline underline-offset-2 hover:text-foreground"
    >{{ part.text }}</NuxtLink>
    <code v-else-if="part.code" class="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">{{ part.text }}</code>
    <template v-else>{{ part.text }}</template>
  </template>
</template>
