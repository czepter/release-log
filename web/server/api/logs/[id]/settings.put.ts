import { updateSettings } from '../../../../../lib/api/logs.ts'
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null)
  return apiSession(event, (core, who) => updateSettings(core, who, param(event, 'id'), body))
})
