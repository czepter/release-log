import { resolve } from 'node:path'
import { bootCore } from '../../../lib/boot.ts'
import type { Core as Booted } from '../../../lib/boot.ts'
import { createHandler } from '../../../server.ts'
import type { CoreHandler } from '../../../server.ts'
import type { Core } from '../../../lib/api/core.ts'
import { devBoot } from './devCore.ts'

type Running = Booted & { handler: CoreHandler; api: Core }

let running: Promise<Running> | null = null

// Einmal je Prozess: Datenbank, Warteschlange und Reconcile-Timer dürfen
// nicht pro Anfrage entstehen.
export function useCore(): Promise<Running> {
  running ??= (async () => {
    const migrationsFolder = resolve(process.env.MIGRATIONS_DIR ?? 'drizzle')
    const booted = import.meta.dev && process.env.RL_DEV_FAKE === '1'
      ? await devBoot(migrationsFolder)
      : bootCore(process.env, { migrationsFolder })
    return {
      ...booted,
      handler: createHandler(booted.reader, booted.hooks, booted.auth),
      api: { auth: booted.auth, reader: booted.reader },
    }
  })()
  return running
}
