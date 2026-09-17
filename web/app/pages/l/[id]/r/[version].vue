<script setup lang="ts">
import { ArrowLeft } from '@lucide/vue'

definePageMeta({ layout: 'public' })

const route = useRoute()
const id = String(route.params.id)
const version = String(route.params.version)
const { data, error } = await useFetch<{ log: PublicLogHead; release: PublicRelease }>(
  `/api/public/logs/${encodeURIComponent(id)}/r/${encodeURIComponent(version)}`,
)
if (error.value || !data.value) throw createError({ statusCode: 404, statusMessage: 'Nicht gefunden' })

useHead({
  title: () => `${data.value!.log.product} ${data.value!.release.version}`,
  meta: () => (data.value!.log.visibility === 'private' ? [{ name: 'robots', content: 'noindex' }] : []),
})
</script>

<template>
  <div class="mx-auto flex max-w-[1000px] flex-col gap-12 px-4 pt-16 pb-12 sm:px-6">
    <NuxtLink :to="`/l/${encodeURIComponent(id)}`" class="inline-flex items-center gap-2 self-start text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft class="size-4" /> {{ data!.log.product }}
    </NuxtLink>
    <ol>
      <AppReleaseEntry :log-id="id" :release="data!.release" :collapsible="false" last permalink />
    </ol>
  </div>
</template>
