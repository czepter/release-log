<script setup lang="ts">
const route = useRoute()
const MESSAGES: Record<string, { title: string; text: string }> = {
  state: { title: 'Anmeldung abgelaufen', text: 'Der Anmeldevorgang ist ungültig oder abgelaufen. Bitte erneut versuchen.' },
  github: { title: 'GitHub nicht erreichbar', text: 'Die Anmeldung bei GitHub ist fehlgeschlagen. Bitte erneut versuchen.' },
  denied: { title: 'Kein Zugriff', text: 'Dieses GitHub-Konto ist für diesen Dienst nicht zugelassen. Ein Admin kann es auf die Zulassungsliste setzen.' },
  logout: { title: 'Abgemeldet', text: 'Du bist abgemeldet.' },
}
const message = computed(() => MESSAGES[String(route.query.fehler ?? '')] ?? MESSAGES.state)
useHead({ title: () => message.value.title })
</script>

<template>
  <main class="flex min-h-screen items-center justify-center px-4">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{{ message.title }}</CardTitle>
        <CardDescription>{{ message.text }}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button as="a" href="/auth/github/login" class="w-full">Mit GitHub anmelden</Button>
      </CardFooter>
    </Card>
  </main>
</template>
