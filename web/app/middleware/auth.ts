// Seiten hinter der Anmeldung. Die API selbst prüft jede Anfrage erneut;
// das hier sorgt nur dafür, dass ein Browser ohne Sitzung zum Login geht,
// statt eine leere Seite mit 401-Fehlern zu sehen.
export default defineNuxtRouteMiddleware(async () => {
  const session = useSession()
  if (session.value) return
  try {
    session.value = await useRequestFetch()('/api/session')
  } catch {
    return navigateTo('/auth/github/login', { external: true })
  }
})
