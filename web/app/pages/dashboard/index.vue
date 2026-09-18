<script setup lang="ts">
import { ChevronRight, GitBranch, Globe, Lock, Plug, Search, Snowflake, Copy, Check } from '@lucide/vue'

definePageMeta({ layout: 'app', middleware: 'auth' })
const { m, t, p: plural, viewLabel, relativeTime, apiText } = useI18n()
useHead({ title: () => m.value.dashboard.title })

type LogSummary = { id: string; product: string; owner: string; repo: string; view: string; visibility: string; state: string; indexedAt: string | null }
const { data, error } = await useFetch<{ logs: LogSummary[] }>('/api/logs')

const filter = ref('')
const logs = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const all = data.value?.logs ?? []
  return q ? all.filter((l) => `${l.product} ${l.owner}/${l.repo}`.toLowerCase().includes(q)) : all
})
const frozenCount = computed(() => (data.value?.logs ?? []).filter((l) => l.state === 'frozen').length)

const mcpUrl = useRequestURL().origin + '/mcp'
const now = useNow()
onMounted(() => { now.value = Date.now() })
const copied = ref(false)
async function copy() {
  await navigator.clipboard.writeText(mcpUrl)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div class="flex flex-col gap-1.5">
        <h1 class="text-3xl font-semibold tracking-tight">{{ m.dashboard.title }}</h1>
        <p class="text-sm text-muted-foreground">{{ m.dashboard.subtitle }}</p>
      </div>
      <AppNewLogDialog />
    </div>

    <Alert v-if="error" variant="destructive">
      <AlertDescription>{{ apiText(error, m.dashboard.loadFailed) }}</AlertDescription>
    </Alert>

    <template v-else-if="(data?.logs.length ?? 0) > 0">
      <div class="flex items-center gap-3">
        <div class="relative w-full max-w-xs">
          <Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="filter" type="search" :aria-label="m.dashboard.filterLabel" :placeholder="m.dashboard.filterPlaceholder" class="bg-background pl-9" />
        </div>
        <span class="text-[13px] text-muted-foreground">{{ plural(m.dashboard.logCount, logs.length) }}</span>
      </div>

      <div class="overflow-x-auto rounded-xl border bg-card">
        <table class="w-full min-w-[760px] text-sm">
          <thead>
            <tr class="h-11 border-b text-left text-xs font-medium text-muted-foreground">
              <th class="pl-5 font-medium">{{ m.dashboard.colProduct }}</th>
              <th class="font-medium">{{ m.dashboard.colRepo }}</th>
              <th class="font-medium">{{ m.dashboard.colView }}</th>
              <th class="font-medium">{{ m.dashboard.colVisibility }}</th>
              <th class="font-medium">{{ m.dashboard.colState }}</th>
              <th class="font-medium">{{ m.dashboard.colSynced }}</th>
              <th class="w-10" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="log in logs" :key="log.id"
              class="group relative h-[72px] border-b last:border-b-0 transition-colors hover:bg-muted/40"
            >
              <td class="pl-5">
                <NuxtLink :to="`/dashboard/logs/${encodeURIComponent(log.id)}`" class="flex flex-col gap-0.5 after:absolute after:inset-0">
                  <span class="font-medium">{{ log.product }}</span>
                  <span class="font-mono text-xs text-muted-foreground">{{ log.id }}</span>
                </NuxtLink>
              </td>
              <td>
                <span class="inline-flex items-center gap-2 font-mono text-[13px] text-foreground/80">
                  <GitBranch class="size-3.5 text-muted-foreground" />{{ log.owner }}/{{ log.repo }}
                </span>
              </td>
              <td><Badge variant="outline">{{ viewLabel(log.view) }}</Badge></td>
              <td>
                <span class="inline-flex items-center gap-1.5 text-[13px] text-foreground/80">
                  <Globe v-if="log.visibility === 'public'" class="size-3.5" /><Lock v-else class="size-3.5" />
                  {{ log.visibility === 'public' ? m.common.public : m.common.private }}
                </span>
              </td>
              <td>
                <AppStatusDot v-if="log.state === 'frozen'" tone="amber"><span class="text-amber-800">{{ m.common.frozen }}</span></AppStatusDot>
                <AppStatusDot v-else tone="green">{{ m.common.active }}</AppStatusDot>
              </td>
              <td class="text-[13px] text-muted-foreground">{{ relativeTime(log.indexedAt, now) }}</td>
              <td class="pr-4 text-right text-muted-foreground"><ChevronRight class="ml-auto size-4" /></td>
            </tr>
            <tr v-if="logs.length === 0">
              <td colspan="7" class="h-24 text-center text-sm text-muted-foreground">{{ t(m.dashboard.noMatch, { query: filter }) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div v-else class="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card px-6 py-20 text-center">
      <span class="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground"><GitBranch class="size-5" /></span>
      <h2 class="text-base font-semibold">{{ m.dashboard.emptyTitle }}</h2>
      <p class="max-w-sm text-sm leading-relaxed text-muted-foreground">{{ m.dashboard.emptyText }}</p>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <Card class="flex-row items-start gap-4 p-5">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"><Plug class="size-[18px]" /></span>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <h2 class="text-sm font-semibold">{{ m.dashboard.mcpTitle }}</h2>
          <p class="text-[13px] leading-5 text-muted-foreground">{{ m.dashboard.mcpText }}</p>
          <div class="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3 font-mono text-[13px]">
            <span class="truncate">{{ mcpUrl }}</span>
            <Button size="sm" variant="outline" type="button" class="font-sans" @click="copy">
              <Check v-if="copied" /><Copy v-else />{{ copied ? m.common.copied : m.common.copy }}
            </Button>
          </div>
        </div>
      </Card>
      <Card v-if="frozenCount > 0" class="flex-row items-start gap-4 p-5">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-800"><Snowflake class="size-[18px]" /></span>
        <div class="flex flex-col gap-2">
          <h2 class="text-sm font-semibold">{{ plural(m.dashboard.frozenTitle, frozenCount) }}</h2>
          <p class="text-[13px] leading-5 text-muted-foreground">{{ m.dashboard.frozenText }}</p>
        </div>
      </Card>
    </div>
  </div>
</template>
