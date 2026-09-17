import { eq } from 'drizzle-orm'
import { account } from '../../../../lib/db/schema.ts'
import { createSessionCookie } from '../../../../lib/session.ts'

// Nur `nuxt dev` mit RL_DEV_FAKE=1: anmelden ohne GitHub. Im
// Produktions-Build ist import.meta.dev false, die Route antwortet 404.
export default defineEventHandler(async (event) => {
  if (!import.meta.dev || process.env.RL_DEV_FAKE !== '1') throw createError({ statusCode: 404 })
  const { auth } = (await useCore()).api
  const login = String(getQuery(event).as ?? 'admin')
  const id = login === 'admin' ? 1 : 2
  if (!auth.db.select().from(account).where(eq(account.githubUserId, id)).all()[0]) {
    auth.db.insert(account).values({ githubUserId: id, login, avatarUrl: null, lastSeenAt: new Date().toISOString() }).run()
  }
  setCookie(event, 'session', createSessionCookie(auth.signingKey, id), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 })
  return sendRedirect(event, '/dashboard')
})
