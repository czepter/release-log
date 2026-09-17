import { createLogApi } from '../../../../lib/api/logs.ts'
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  return apiSession(event, (core, who) => createLogApi(core, who, body))
})
