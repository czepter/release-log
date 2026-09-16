import { upsertAllowlist } from '../../../../lib/api/account.ts'
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  return apiSession(event, (core, who) => upsertAllowlist(core, who, body))
})
