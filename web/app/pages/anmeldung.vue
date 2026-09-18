<script setup lang="ts">
const route = useRoute()
const { m } = useI18n()
const message = computed(() => {
  const key = String(route.query.fehler ?? '')
  return (m.value.signin as Record<string, { title: string; text: string }>)[key] ?? m.value.signin.state
})
useHead({ title: () => message.value.title })
</script>

<template>
  <main class="flex min-h-screen items-center justify-center px-4">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{{ message.title }}</CardTitle>
        <CardDescription>{{ message.text }}</CardDescription>
      </CardHeader>
      <CardFooter class="flex-col items-stretch gap-3">
        <Button as="a" href="/auth/github/login" class="w-full">{{ m.common.signIn }}</Button>
        <AppLanguageSwitch class="self-center" />
        <NuxtLink to="/datenschutz" class="self-center text-xs text-muted-foreground hover:text-foreground">{{ m.landing.navPrivacy }}</NuxtLink>
      </CardFooter>
    </Card>
  </main>
</template>
