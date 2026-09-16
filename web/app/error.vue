<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const notFound = computed(() => props.error.statusCode === 404)
useHead({ title: () => (notFound.value ? 'Nicht gefunden' : 'Fehler') })
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-muted/30 px-4">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <p class="font-mono text-xs text-muted-foreground">{{ error.statusCode }}</p>
        <CardTitle>{{ notFound ? 'Nicht gefunden' : 'Etwas ist schiefgegangen' }}</CardTitle>
        <CardDescription>
          {{ notFound ? 'Diese Seite gibt es nicht, oder sie ist nicht öffentlich.' : 'Bitte lade die Seite neu. Hält der Fehler an, liegt er bei uns.' }}
        </CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" class="w-full" @click="clearError({ redirect: '/dashboard' })">Zum Dashboard</Button>
      </CardFooter>
    </Card>
  </main>
</template>
