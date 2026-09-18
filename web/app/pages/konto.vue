<script setup lang="ts">
import { LogOut, Plug } from '@lucide/vue'
import { toast } from 'vue-sonner'

definePageMeta({ layout: 'app', middleware: 'auth' })
const { m, t, formatDateTime, apiText } = useI18n()
useHead({ title: () => m.value.account.title })

const session = useSession()
type Client = { clientId: string; clientName: string; scope: string }
type Entry = { githubLogin: string; note: string | null; addedBy: string; addedAt: string }

const { data: clients, refresh: refreshClients } = await useFetch<{ clients: Client[] }>('/api/clients')
const { data: allowlist, refresh: refreshAllowlist } = await useFetch<{ entries: Entry[] }>('/api/allowlist', {
  immediate: session.value?.isAdmin === true,
})

async function revoke(client: Client) {
  try {
    await $fetch(`/api/clients/${encodeURIComponent(client.clientId)}`, { method: 'DELETE', body: {} })
    toast.success(t(m.value.account.disconnected, { name: client.clientName }))
    await refreshClients()
  } catch (err) {
    toast.error(apiText(err))
  }
}

const newEntry = reactive({ github_login: '', note: '' })
async function allow() {
  try {
    await $fetch('/api/allowlist', { method: 'POST', body: newEntry })
    toast.success(t(m.value.account.allowed, { login: newEntry.github_login }))
    newEntry.github_login = ''
    newEntry.note = ''
    await refreshAllowlist()
  } catch (err) {
    toast.error(apiText(err))
  }
}
async function remove(entry: Entry) {
  try {
    await $fetch(`/api/allowlist/${encodeURIComponent(entry.githubLogin)}`, { method: 'DELETE', body: {} })
    await refreshAllowlist()
  } catch (err) {
    toast.error(apiText(err))
  }
}

const when = (iso: string | null) => formatDateTime(iso)
</script>

<template>
  <div v-if="session" class="grid items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
    <Card class="gap-5 p-6">
      <div class="flex items-center gap-3.5">
        <Avatar class="size-14">
          <AvatarImage v-if="session.avatarUrl" :src="session.avatarUrl" alt="" />
          <AvatarFallback class="text-lg">{{ session.login.slice(0, 1).toUpperCase() }}</AvatarFallback>
        </Avatar>
        <div class="flex flex-col gap-1">
          <span class="text-base font-semibold">{{ session.login }}</span>
          <Badge :variant="session.isAdmin ? 'default' : 'secondary'">{{ session.isAdmin ? m.account.admin : m.account.member }}</Badge>
        </div>
      </div>
      <dl class="flex flex-col gap-3 text-[13px]">
        <div class="flex justify-between gap-3">
          <dt class="text-muted-foreground">{{ m.account.github }}</dt>
          <dd><a :href="`https://github.com/${session.login}`" class="underline underline-offset-3">github.com/{{ session.login }}</a></dd>
        </div>
        <div class="flex justify-between gap-3"><dt class="text-muted-foreground">{{ m.account.lastSignIn }}</dt><dd>{{ when(session.lastSeenAt) }}</dd></div>
        <div class="flex justify-between gap-3"><dt class="text-muted-foreground">{{ m.account.connectedClients }}</dt><dd>{{ clients?.clients.length ?? 0 }}</dd></div>
      </dl>
      <Separator />
      <Button variant="outline" size="lg" @click="logout"><LogOut /> {{ m.common.signOut }}</Button>
    </Card>

    <div class="flex flex-col gap-6">
      <section class="overflow-hidden rounded-xl border bg-card">
        <div class="flex flex-col gap-0.5 border-b px-5 py-4">
          <h2 class="text-base font-semibold">{{ m.account.connectedClients }}</h2>
          <p class="text-[13px] text-muted-foreground">{{ m.account.clientsHint }}</p>
        </div>
        <p v-if="!clients?.clients.length" class="px-5 py-10 text-center text-sm text-muted-foreground">{{ m.account.noClients }}</p>
        <ul v-else>
          <li v-for="client in clients.clients" :key="client.clientId" class="flex items-center gap-3.5 border-b px-5 py-4 last:border-b-0">
            <span class="flex size-9 items-center justify-center rounded-lg bg-muted"><Plug class="size-[17px]" /></span>
            <div class="flex flex-1 flex-col gap-1">
              <span class="text-sm font-medium">{{ client.clientName }}</span>
              <span class="flex gap-1.5">
                <Badge v-for="s in client.scope.split(' ')" :key="s" variant="outline" class="font-mono text-[11px]">{{ s }}</Badge>
              </span>
            </div>
            <Button variant="outline" size="sm" class="text-destructive" @click="revoke(client)">{{ m.account.disconnect }}</Button>
          </li>
        </ul>
      </section>

      <section v-if="session.isAdmin" class="overflow-hidden rounded-xl border bg-card">
        <div class="flex flex-col gap-0.5 border-b px-5 py-4">
          <h2 class="text-base font-semibold">{{ m.account.allowlist }}</h2>
          <p class="text-[13px] text-muted-foreground">{{ m.account.allowlistHint1 }} <code class="font-mono">ADMIN_LOGINS</code> {{ m.account.allowlistHint2 }}</p>
        </div>
        <form class="grid gap-2.5 border-b bg-muted/40 px-5 py-4 sm:grid-cols-[200px_minmax(0,1fr)_auto]" @submit.prevent="allow">
          <Input v-model="newEntry.github_login" :aria-label="m.account.githubLogin" required :placeholder="m.account.githubLogin" class="bg-background font-mono" />
          <Input v-model="newEntry.note" :aria-label="m.account.note" :placeholder="m.account.notePlaceholder" class="bg-background" />
          <Button type="submit">{{ m.account.allow }}</Button>
        </form>
        <p v-if="!allowlist?.entries.length" class="px-5 py-10 text-center text-sm text-muted-foreground">{{ m.account.nobodyListed }}</p>
        <table v-else class="w-full text-sm">
          <thead>
            <tr class="h-10 border-b text-left text-xs text-muted-foreground">
              <th class="pl-5 font-medium">{{ m.account.login }}</th><th class="font-medium">{{ m.account.note }}</th><th class="font-medium">{{ m.account.added }}</th><th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in allowlist.entries" :key="entry.githubLogin" class="h-14 border-b last:border-b-0">
              <td class="pl-5 font-mono text-[13px]">{{ entry.githubLogin }}</td>
              <td class="text-muted-foreground">{{ entry.note }}</td>
              <td class="text-[13px] text-muted-foreground">{{ entry.addedBy }}, {{ when(entry.addedAt) }}</td>
              <td class="pr-4 text-right"><Button variant="ghost" size="sm" @click="remove(entry)">{{ m.account.remove }}</Button></td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>
