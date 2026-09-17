<script setup lang="ts">
definePageMeta({ layout: 'bare', middleware: 'auth' })
const route = useRoute()
</script>

<template>
  <AppReleaseEditor :log-id="String(route.params.id)" :version="null" />
</template>
