<script setup lang="ts">
import { LogOut, UserRound } from '@lucide/vue'

const session = useSession()
const route = useRoute()
const { m, t } = useI18n()
const links = computed(() => [
  { to: '/dashboard', label: m.value.header.logs, active: route.path.startsWith('/dashboard') },
  { to: '/konto', label: m.value.header.account, active: route.path === '/konto' },
])
const initial = computed(() => (session.value?.login ?? '?').slice(0, 1).toUpperCase())
</script>

<template>
  <header class="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
    <div class="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
      <NuxtLink to="/dashboard" class="flex items-center gap-2.5 text-[15px] font-semibold">
        <span class="flex size-7 items-center justify-center rounded-md bg-primary font-mono text-xs font-medium text-primary-foreground">rl</span>
        release-log
      </NuxtLink>
      <nav class="flex flex-1 items-center gap-1">
        <NuxtLink
          v-for="link in links" :key="link.to" :to="link.to"
          class="rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
          :class="link.active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'"
        >
          {{ link.label }}
        </NuxtLink>
      </nav>
      <AppLanguageSwitch />
      <DropdownMenu v-if="session">
        <DropdownMenuTrigger as-child>
          <button type="button" class="flex items-center gap-2.5 rounded-full text-sm" :aria-label="m.header.accountMenu">
            <span class="hidden font-mono text-[13px] text-muted-foreground sm:inline">{{ session.login }}</span>
            <Avatar class="size-8">
              <AvatarImage v-if="session.avatarUrl" :src="session.avatarUrl" alt="" />
              <AvatarFallback>{{ initial }}</AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-48">
          <DropdownMenuLabel class="font-normal text-muted-foreground">{{ t(m.header.signedInAs, { login: session.login }) }}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem as-child>
            <NuxtLink to="/konto"><UserRound /> {{ m.header.yourAccount }}</NuxtLink>
          </DropdownMenuItem>
          <DropdownMenuItem @select="logout"><LogOut /> {{ m.common.signOut }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </header>
</template>
