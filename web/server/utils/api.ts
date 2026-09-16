import type { H3Event } from 'h3'
import { accountFromCookie } from '../../../lib/access.ts'
import type { LoggedIn } from '../../../lib/access.ts'
import type { Core, Reply } from '../../../lib/api/core.ts'
import { useCore } from './core.ts'

function send(event: H3Event, reply: Reply): unknown {
  setResponseStatus(event, reply.status)
  setHeader(event, 'cache-control', 'no-store')
  return reply.body
}

// Mutierende Aufrufe nur als JSON (Medien: mit x-filename): beides erzwingt
// bei einer fremden Seite einen CORS-Preflight, den niemand beantwortet.
// Zusammen mit SameSite=Lax ist das der CSRF-Schutz (Entscheidung 31).
function crossSiteSafe(event: H3Event): boolean {
  const method = event.method
  if (method === 'GET' || method === 'HEAD') return true
  if (getRequestHeader(event, 'x-filename') !== undefined) return true
  return (getRequestHeader(event, 'content-type') ?? '').startsWith('application/json')
}

export async function apiSession(
  event: H3Event,
  fn: (core: Core, who: LoggedIn) => Reply | Promise<Reply>,
): Promise<unknown> {
  if (!crossSiteSafe(event)) return send(event, { status: 415, body: { error: 'unsupported_media_type', message: 'JSON erwartet.' } })
  const { api } = await useCore()
  const who = accountFromCookie(api.auth, getRequestHeader(event, 'cookie'))
  if (!who) return send(event, { status: 401, body: { error: 'unauthorized', message: 'Nicht angemeldet.' } })
  return send(event, await fn(api, who))
}

export async function apiOptional(
  event: H3Event,
  fn: (core: Core, who: LoggedIn | null) => Reply | Promise<Reply>,
): Promise<unknown> {
  const { api } = await useCore()
  return send(event, await fn(api, accountFromCookie(api.auth, getRequestHeader(event, 'cookie'))))
}

export function param(event: H3Event, name: string): string {
  return decodeURIComponent(getRouterParam(event, name, { decode: false }) ?? '')
}
