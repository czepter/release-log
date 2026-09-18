<script setup lang="ts">
// Die Datenschutzerklärung. Text in ~/i18n/datenschutz.ts, Aussehen in
// AppLegalPage -- hier steht nur, welches von beidem zusammenkommt.
import { PRIVACY, PRIVACY_META } from '~/i18n/datenschutz'

definePageMeta({ layout: 'public' })

const { locale } = useI18n()
</script>

<template>
  <AppLegalPage :sections="PRIVACY[locale]" :meta="PRIVACY_META[locale]" />
</template>
