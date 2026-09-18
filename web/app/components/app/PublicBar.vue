<script setup lang="ts">
import { ArrowRight, ScrollText } from '@lucide/vue'

// Die Leiste steht über jedem öffentlichen Log: sie sagt, wer die Seite
// führt, und bringt Angemeldete zurück in die App. Die Sitzung wird hier
// nur dafür gelesen; 401 heißt „nicht angemeldet" und nicht „Fehler".
const { m } = useI18n()
const session = useSession()
if (!session.value) {
  const request = useRequestFetch()
  const { data } = await useAsyncData('public-bar-session', () => request<Session>('/api/session').catch(() => null))
  session.value = data.value
}
</script>

<template>
  <header class="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
    <div class="mx-auto flex h-14 max-w-[1000px] items-center justify-between gap-4 px-4 sm:px-6">
      <NuxtLink to="/" class="flex items-center gap-2 text-sm font-semibold whitespace-nowrap">
        <span class="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground"><ScrollText class="size-4" /></span>
        release-log
      </NuxtLink>
      <Button v-if="session" as="a" href="/dashboard" size="sm" class="h-9">
        {{ m.publicLog.toApp }} <ArrowRight class="size-4" />
      </Button>
      <Button v-else as="a" href="/" variant="outline" size="sm" class="h-9">
        <span class="hidden sm:inline">{{ m.publicLog.ownLog }}</span>
        <span class="sm:hidden">{{ m.publicLog.ownLogShort }}</span>
        <ArrowRight class="size-4" />
      </Button>
    </div>
  </header>
</template>
