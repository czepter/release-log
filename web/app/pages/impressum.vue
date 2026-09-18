<script setup lang="ts">
// Die Anbieterkennzeichnung nach § 5 DDG. Text in ~/i18n/impressum.ts,
// Aussehen in AppLegalPage.
import { IMPRINT, IMPRINT_META } from '~/i18n/impressum'

definePageMeta({ layout: 'public' })

const { locale } = useI18n()
</script>

<template>
  <AppLegalPage :sections="IMPRINT[locale]" :meta="IMPRINT_META[locale]" />
</template>
