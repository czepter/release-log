import { putRelease } from '../../../../../../../lib/api/releases.ts'
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  return apiSession(event, (core, who) => putRelease(core, who, param(event, 'id'), param(event, 'version'), body))
})
