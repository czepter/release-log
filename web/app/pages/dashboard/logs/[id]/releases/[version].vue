<script setup lang="ts">
definePageMeta({ layout: 'bare', middleware: 'auth' })
const route = useRoute()
</script>

<template>
  <AppReleaseEditor :key="String(route.params.version)" :log-id="String(route.params.id)" :version="String(route.params.version)" />
</template>
