import { publicLog, viewerFor } from '../../../../../../lib/api/public.ts'
export default defineEventHandler((event) => apiOptional(event, async (core, who) => {
  const id = param(event, 'id')
  return publicLog(core, await viewerFor(core, who, id), id)
}))
