<script setup lang="ts">
import { Plus } from '@lucide/vue'

const open = ref(false)
const session = useSession()
const { m, t, viewOptions, visibilityOptions, apiText } = useI18n()
const form = reactive({ product: '', repo_name: '', view: 'timeline', visibility: 'public' })
const pending = ref(false)
const error = ref<{ message: string; reauth: boolean } | null>(null)

// Vorschläge: Repos auf dem eigenen Konto, die die GitHub App sehen darf.
// Bei jedem Öffnen frisch geladen (hasLog ändert sich mit jedem Anlegen);
// ohne Liste bleibt das Feld frei tippbar.
type Candidate = { name: string; private: boolean; hasLog: boolean }
const candidates = ref<Candidate[]>([])
const candidatesError = ref<{ message: string; reauth: boolean } | null>(null)
// null = noch nicht gefragt. false heißt: die App ist auf diesem Konto nicht
// installiert -- eine leere Liste mit einem Grund, nicht ohne.
const installed = ref<boolean | null>(null)
watch(open, async (isOpen) => {
  if (!isOpen) return
  candidatesError.value = null
  try {
    const listed = await $fetch<{ repos: Candidate[]; installed: boolean }>('/api/github/repos')
    candidates.value = listed.repos
    installed.value = listed.installed
  } catch (err) {
    candidatesError.value = { message: apiText(err), reauth: apiError(err) === 'reauth_required' }
  }
})
const match = computed(() => candidates.value.find((c) => c.name.toLowerCase() === form.repo_name.trim().toLowerCase()))
const existing = computed(() => match.value !== undefined && !match.value.hasLog)
const taken = computed(() => match.value?.hasLog === true)

// Eigene Vorschlagsliste statt <datalist>: Safari zeigt dort nur das Label
// der Option statt des Repo-Namens, in einem schmalen Menü.
const listOpen = ref(false)
const active = ref(0)
const suggestions = computed(() => {
  const q = form.repo_name.trim().toLowerCase()
  return candidates.value
    .filter((c) => !c.hasLog && c.name.toLowerCase().includes(q) && c.name.toLowerCase() !== q)
    .slice(0, 8)
})
watch(suggestions, () => { active.value = 0 })
function choose(c: Candidate) {
  form.repo_name = c.name
  listOpen.value = false
}
function onRepoKey(e: KeyboardEvent) {
  const n = suggestions.value.length
  if (e.key === 'ArrowDown' && n > 0) { e.preventDefault(); listOpen.value = true; active.value = (active.value + 1) % n }
  else if (e.key === 'ArrowUp' && n > 0) { e.preventDefault(); listOpen.value = true; active.value = (active.value - 1 + n) % n }
  else if (e.key === 'Enter' && listOpen.value && n > 0) { e.preventDefault(); choose(suggestions.value[active.value]!) }
  // Nur die Liste schließen, nicht den ganzen Dialog.
  else if (e.key === 'Escape' && listOpen.value && n > 0) { e.preventDefault(); e.stopPropagation(); listOpen.value = false }
}

async function submit() {
  pending.value = true
  error.value = null
  try {
    const body = existing.value ? { ...form, repo_name: match.value!.name, existing: true } : form
    const created = await $fetch<{ logId: string }>('/api/logs', { method: 'POST', body })
    open.value = false
    await navigateTo(`/dashboard/logs/${encodeURIComponent(created.logId)}`)
  } catch (err) {
    error.value = { message: apiText(err), reauth: apiError(err) === 'reauth_required' }
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button size="lg"><Plus /> {{ m.newLog.trigger }}</Button>
    </DialogTrigger>
    <DialogContent class="sm:max-w-[520px]">
      <form class="flex flex-col gap-5" @submit.prevent="submit">
        <DialogHeader>
          <DialogTitle>{{ m.newLog.title }}</DialogTitle>
          <DialogDescription>
            <template v-if="existing">
              {{ m.newLog.descriptionExisting1 }}
              <code class="rounded bg-muted px-1 py-px font-mono text-xs text-foreground">release-log.json</code>
              {{ m.newLog.descriptionExisting2 }}
            </template>
            <template v-else>
              {{ m.newLog.descriptionNew1 }}
              <code class="rounded bg-muted px-1 py-px font-mono text-xs text-foreground">release-log.json</code>
              {{ m.newLog.descriptionNew2 }}
            </template>
          </DialogDescription>
        </DialogHeader>

        <Alert v-if="error" variant="destructive">
          <AlertDescription>
            {{ error.message }}
            <a v-if="error.reauth" href="/auth/github/login" class="mt-1 block font-medium underline">{{ m.newLog.reauth }}</a>
          </AlertDescription>
        </Alert>

        <div class="flex flex-col gap-2">
          <Label for="product">{{ m.newLog.product }}</Label>
          <Input id="product" v-model="form.product" required maxlength="200" :placeholder="m.newLog.productPlaceholder" />
        </div>

        <div class="flex flex-col gap-2">
          <Label for="repo">{{ m.newLog.repo }}</Label>
          <div class="relative">
            <div class="flex h-9 overflow-hidden rounded-md border shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
              <span class="flex items-center border-r bg-muted px-3 font-mono text-[13px] text-muted-foreground">{{ session?.login }} /</span>
              <input
                id="repo" v-model="form.repo_name" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
                autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="repo-suggestions"
                :aria-expanded="listOpen && suggestions.length > 0"
                :aria-activedescendant="listOpen && suggestions.length > 0 ? `repo-option-${active}` : undefined"
                placeholder="release-log" class="min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] outline-none"
                @focus="listOpen = true" @input="listOpen = true" @blur="listOpen = false" @keydown="onRepoKey"
              >
            </div>
            <ul
              v-if="listOpen && suggestions.length > 0" id="repo-suggestions" role="listbox"
              class="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              <li
                v-for="(c, i) in suggestions" :id="`repo-option-${i}`" :key="c.name" role="option" :aria-selected="i === active"
                class="flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 font-mono text-[13px]"
                :class="i === active ? 'bg-accent text-accent-foreground' : ''"
                @mousedown.prevent="choose(c)" @mouseenter="active = i"
              >
                <span class="truncate">{{ c.name }}</span>
                <span class="shrink-0 font-sans text-xs text-muted-foreground">{{ c.private ? m.newLog.repoPrivate : m.newLog.repoPublic }}</span>
              </li>
            </ul>
          </div>
          <p v-if="taken" class="text-xs text-destructive">{{ m.newLog.taken }}</p>
          <p v-else-if="existing" class="text-xs text-muted-foreground">{{ m.newLog.existing1 }} <code class="font-mono">release-log.json</code>{{ m.newLog.existing2 }}</p>
          <p v-else class="text-xs text-muted-foreground">
            {{ m.newLog.charsHint }} <code class="font-mono">. _ -</code>
            <template v-if="installed === false">
              {{ m.newLog.notInstalled }}
              <a href="https://github.com/settings/installations" target="_blank" rel="noreferrer" class="font-medium underline">{{ m.newLog.installApp }}</a>
            </template>
            <template v-if="candidatesError">
              {{ t(m.newLog.listFailed, { message: candidatesError.message }) }}
              <a v-if="candidatesError.reauth" href="/auth/github/login" class="font-medium underline">{{ m.newLog.reauthShort }}</a>
            </template>
          </p>
        </div>

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-2 text-sm font-medium">{{ m.newLog.view }}</legend>
          <AppChoiceCards v-model="form.view" name="view" :options="viewOptions" />
        </fieldset>

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-2 text-sm font-medium">{{ m.newLog.visibility }}</legend>
          <AppChoiceCards v-model="form.visibility" name="visibility" :options="visibilityOptions" />
        </fieldset>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline" size="lg">{{ m.common.cancel }}</Button>
          </DialogClose>
          <Button type="submit" size="lg" :disabled="pending || taken">
            {{ pending ? (existing ? m.newLog.submitAdopting : m.newLog.submitCreating) : (existing ? m.newLog.submitAdopt : m.newLog.submitCreate) }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
