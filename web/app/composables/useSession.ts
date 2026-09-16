export type Session = { login: string; isAdmin: boolean; avatarUrl: string | null; lastSeenAt: string | null }

export function useSession() {
  return useState<Session | null>('session', () => null)
}

export async function logout(): Promise<void> {
  await $fetch('/auth/logout', { method: 'POST' })
  useSession().value = null
  await navigateTo('/anmeldung?fehler=logout')
}
