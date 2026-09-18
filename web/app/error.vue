<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()
const { m } = useI18n()
const notFound = computed(() => props.error.statusCode === 404)
useHead({ title: () => (notFound.value ? m.value.error.titleNotFound : m.value.error.titleGeneric) })
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-muted/30 px-4">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <p class="font-mono text-xs text-muted-foreground">{{ error.statusCode }}</p>
        <CardTitle>{{ notFound ? m.error.headingNotFound : m.error.headingGeneric }}</CardTitle>
        <CardDescription>{{ notFound ? m.error.textNotFound : m.error.textGeneric }}</CardDescription>
      </CardHeader>
      <CardFooter class="flex-col items-stretch gap-3">
        <Button variant="outline" class="w-full" @click="clearError({ redirect: '/dashboard' })">{{ m.error.toDashboard }}</Button>
        <AppLanguageSwitch class="self-center" />
      </CardFooter>
    </Card>
  </main>
</template>
