// Nur `nuxt dev` mit RL_DEV_FAKE=1: ein Kern ohne GitHub, gefüllt aus
// logs/demo, damit sich die Oberfläche ohne GitHub-App bedienen lässt.
// import.meta.dev ist im Produktions-Build false; useCore ruft das dort nie.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { bootCore } from '../../../lib/boot.ts'
import { fakeGitHub } from '../../../lib/github.ts'
import { syncLog } from '../../../lib/index.ts'

function filesOf(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else out[relative(dir, full)] = readFileSync(full)
    }
  }
  walk(dir)
  return out
}

export async function devBoot(migrationsFolder: string) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const env = {
    DB_PATH: process.env.DB_PATH ?? ':memory:',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey.export({ type: 'pkcs1', format: 'pem' }) as string).toString('base64'),
    GITHUB_WEBHOOK_SECRET: 'dev',
    BASE_URL: process.env.BASE_URL ?? 'http://localhost:3000',
    GITHUB_CLIENT_ID: 'dev',
    GITHUB_CLIENT_SECRET: 'dev',
    SIGNING_KEY: 'dev-signing-key',
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_LOGINS: 'admin',
  }
  const repos: Record<string, Record<string, Buffer>> = { 'dev/demo': filesOf(join(process.cwd(), 'logs/demo')) }
  const fake = fakeGitHub(repos)
  const gh = {
    ...fake,
    // Schreibt wirklich in den Fake, damit Speichern im Editor sichtbar wird.
    async putFile(ref: { owner: string; repo: string }, path: string, content: Buffer) {
      repos[`${ref.owner}/${ref.repo}`][path] = content
      queueMicrotask(() => { void syncLog(booted.db, gh, ref) })
      return { kind: 'committed' as const, sha: 'dev' }
    },
  }
  // Zwei Repos ohne Log, damit „bestehendes Repo übernehmen“ im Dialog
  // etwas vorzuschlagen hat (Anmeldung ?as=admin).
  repos['admin/website'] = {}
  repos['admin/shop'] = { 'README.md': Buffer.from('# Shop\n') }
  const booted = bootCore(env, { migrationsFolder, gh })
  booted.auth.users.tokenFor = async () => ({ ok: true, token: 'dev' })
  booted.auth.listRepos = async (_token, owner) => ({
    kind: 'ok',
    selection: 'all',
    repos: Object.keys(repos).filter((k) => k.startsWith(`${owner}/`)).map((k) => ({ name: k.slice(owner.length + 1), private: false })),
  })
  await syncLog(booted.db, gh, { owner: 'dev', repo: 'demo' })
  return booted
}
