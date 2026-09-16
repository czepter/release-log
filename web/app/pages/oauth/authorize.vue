<script setup lang="ts">
import { GitBranch, ShieldCheck } from '@lucide/vue'

definePageMeta({ layout: 'public' })
useHead({ title: 'Verbindung erlauben' })

type Consent =
  | { kind: 'error'; reason: 'unknown_client' | 'bad_redirect_uri' }
  | { kind: 'redirect' | 'login'; location: string }
  | { kind: 'ok'; clientName: string; scope: string; logs: Array<{ product: string; repo: string }>; form: Record<string, string> }

const query = useRequestURL().search.replace(/^\?/, '')
const { data } = await useFetch<Consent>(`/api/oauth/consent?${query}`)
// Weiterleitungen gehen an eine geprüfte redirect_uri oder zum Login --
// nie an etwas, das nur in der Query stand.
if (data.value?.kind === 'redirect' || data.value?.kind === 'login') {
  await navigateTo(data.value.location, { external: true, redirectCode: 302 })
}

const SCOPES: Record<string, string> = { 'logs:read': 'Logs und Releases lesen, auch Entwürfe', 'logs:write': 'Releases schreiben, veröffentlichen, Bilder hochladen, Logs anlegen' }
const ERRORS = {
  unknown_client: { title: 'Unbekannter Client', text: 'Dieser Client ist nicht registriert.' },
  bad_redirect_uri: { title: 'Ungültige Redirect-URI', text: 'Diese Redirect-URI ist für diesen Client nicht registriert.' },
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
    <Card v-if="data?.kind === 'error'" class="w-full max-w-md">
      <CardHeader>
        <CardTitle>{{ ERRORS[data.reason].title }}</CardTitle>
        <CardDescription>{{ ERRORS[data.reason].text }}</CardDescription>
      </CardHeader>
    </Card>

    <Card v-else-if="data?.kind === 'ok'" class="w-full max-w-md">
      <CardHeader>
        <span class="mb-2 flex size-10 items-center justify-center rounded-lg bg-muted"><ShieldCheck class="size-5" /></span>
        <CardTitle class="text-xl">{{ data.clientName }} verbinden</CardTitle>
        <CardDescription>Dieser Client möchte in deinem Namen auf release-log zugreifen.</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-5">
        <div class="flex flex-col gap-2">
          <h2 class="text-sm font-medium">Rechte</h2>
          <ul class="flex flex-col gap-2">
            <li v-for="s in data.scope.split(' ')" :key="s" class="flex flex-col rounded-lg border px-3 py-2">
              <code class="font-mono text-xs">{{ s }}</code>
              <span class="text-[13px] text-muted-foreground">{{ SCOPES[s] ?? s }}</span>
            </li>
          </ul>
        </div>
        <div class="flex flex-col gap-2">
          <h2 class="text-sm font-medium">Betroffene Logs</h2>
          <ul v-if="data.logs.length" class="flex flex-col gap-1.5">
            <li v-for="l in data.logs" :key="l.repo" class="flex items-center justify-between gap-3 text-sm">
              <span>{{ l.product }}</span>
              <span class="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground"><GitBranch class="size-3" />{{ l.repo }}</span>
            </li>
          </ul>
          <p v-else class="text-[13px] text-muted-foreground">Aktuell keine Logs mit Schreibrecht.</p>
        </div>
      </CardContent>
      <CardFooter>
        <form method="POST" action="/oauth/authorize" class="grid w-full grid-cols-2 gap-2">
          <input v-for="(value, name) in data.form" :key="name" type="hidden" :name="name" :value="value">
          <Button type="submit" name="decision" value="deny" variant="outline" size="lg">Ablehnen</Button>
          <Button type="submit" name="decision" value="allow" size="lg">Zulassen</Button>
        </form>
      </CardFooter>
    </Card>
  </main>
</template>
