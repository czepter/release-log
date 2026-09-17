<script setup lang="ts">
import { Plus } from '@lucide/vue'

const open = ref(false)
const session = useSession()
const form = reactive({ product: '', repo_name: '', view: 'timeline', visibility: 'public' })
const pending = ref(false)
const error = ref<{ message: string; reauth: boolean } | null>(null)

async function submit() {
  pending.value = true
  error.value = null
  try {
    const created = await $fetch<{ logId: string }>('/api/logs', { method: 'POST', body: form })
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
            Legt ein Repository auf deinem GitHub-Konto an, schreibt die erste
            <code class="rounded bg-muted px-1 py-px font-mono text-xs text-foreground">release-log.json</code>
            hinein und nimmt es in den Index auf.
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
          <div class="flex h-9 overflow-hidden rounded-md border shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
            <span class="flex items-center border-r bg-muted px-3 font-mono text-[13px] text-muted-foreground">{{ session?.login }} /</span>
            <input
              id="repo" v-model="form.repo_name" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
              placeholder="release-log" class="min-w-0 flex-1 bg-transparent px-3 font-mono text-[13px] outline-none"
            >
          </div>
          <p class="text-xs text-muted-foreground">Buchstaben, Ziffern, <code class="font-mono">. _ -</code> · Die GitHub App muss das neue Repository sehen dürfen.</p>
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
          <Button type="submit" size="lg" :disabled="pending">{{ pending ? 'Wird angelegt…' : 'Log anlegen' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
