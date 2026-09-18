<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <Toaster rich-colors position="bottom-right" />
</template>

<script setup lang="ts">
import { Toaster } from '@/components/ui/sonner'
import 'vue-sonner/style.css'

// Die Sprache steht im <html>-Tag, damit Vorleseprogramme und der
// Übersetzer des Browsers dieselbe Sprache sehen wie der Text.
const { locale } = useI18n()
useHead({ htmlAttrs: { lang: () => locale.value } })
</script>
