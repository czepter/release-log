<script setup lang="ts">
import { Plus } from '@lucide/vue'

const open = ref(false)
const session = useSession()
const form = reactive({ product: '', repo_name: '', view: 'timeline', visibility: 'public' })
const pending = ref(false)
const error = ref<{ message: string; reauth: boolean } | null>(null)

// Vorschläge: Repos auf dem eigenen Konto, die die GitHub App sehen darf.
// Bei jedem Öffnen frisch geladen (hasLog ändert sich mit jedem Anlegen);
// ohne Liste bleibt das Feld frei tippbar.
type Candidate = { name: string; private: boolean; hasLog: boolean }
const candidates = ref<Candidate[]>([])
const candidatesError = ref<{ message: string; reauth: boolean } | null>(null)
watch(open, async (isOpen) => {
  if (!isOpen) return
  candidatesError.value = null
  try {
    candidates.value = (await $fetch<{ repos: Candidate[] }>('/api/github/repos')).repos
  } catch (err) {
    candidatesError.value = { message: apiMessage(err), reauth: apiError(err) === 'reauth_required' }
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
    error.value = { message: apiMessage(err), reauth: apiError(err) === 'reauth_required' }
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button size="lg"><Plus /> Neues Log</Button>
    </DialogTrigger>
    <DialogContent class="sm:max-w-[520px]">
      <form class="flex flex-col gap-5" @submit.prevent="submit">
        <DialogHeader>
          <DialogTitle>Neues Log anlegen</DialogTitle>
          <DialogDescription>
            <template v-if="existing">
              Übernimmt das bestehende Repository, ergänzt bei Bedarf die
              <code class="rounded bg-muted px-1 py-px font-mono text-xs text-foreground">release-log.json</code>
              und nimmt es in den Index auf.
            </template>
            <template v-else>
            Legt ein Repository auf deinem GitHub-Konto an, schreibt die erste
            <code class="rounded bg-muted px-1 py-px font-mono text-xs text-foreground">release-log.json</code>
            hinein und nimmt es in den Index auf.
            </template>
          </DialogDescription>
        </DialogHeader>

        <Alert v-if="error" variant="destructive">
          <AlertDescription>
            {{ error.message }}
            <a v-if="error.reauth" href="/auth/github/login" class="mt-1 block font-medium underline">Neu bei GitHub anmelden</a>
          </AlertDescription>
        </Alert>

        <div class="flex flex-col gap-2">
          <Label for="product">Produkt</Label>
          <Input id="product" v-model="form.product" required maxlength="200" placeholder="z. B. Release Log Hub" />
        </div>

        <div class="flex flex-col gap-2">
          <Label for="repo">Repository</Label>
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
                <span class="shrink-0 font-sans text-xs text-muted-foreground">{{ c.private ? 'privat' : 'öffentlich' }}</span>
              </li>
            </ul>
          </div>
          <p v-if="taken" class="text-xs text-destructive">Dieses Repository ist schon ein Log.</p>
          <p v-else-if="existing" class="text-xs text-muted-foreground">Bestehendes Repository · wird übernommen. Trägt es schon eine <code class="font-mono">release-log.json</code>, gelten deren Einstellungen.</p>
          <p v-else class="text-xs text-muted-foreground">
            Buchstaben, Ziffern, <code class="font-mono">. _ -</code>
            <template v-if="candidatesError">
              Liste nicht geladen: {{ candidatesError.message }}
              <a v-if="candidatesError.reauth" href="/auth/github/login" class="font-medium underline">Neu anmelden</a>
            </template>
          </p>
        </div>

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-2 text-sm font-medium">Ansicht</legend>
          <AppChoiceCards v-model="form.view" name="view" :options="VIEW_OPTIONS" />
        </fieldset>

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-2 text-sm font-medium">Sichtbarkeit</legend>
          <AppChoiceCards v-model="form.visibility" name="visibility" :options="VISIBILITY_OPTIONS" />
        </fieldset>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline" size="lg">Abbrechen</Button>
          </DialogClose>
          <Button type="submit" size="lg" :disabled="pending || taken">
            {{ pending ? (existing ? 'Wird übernommen…' : 'Wird angelegt…') : (existing ? 'Log übernehmen' : 'Log anlegen') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
