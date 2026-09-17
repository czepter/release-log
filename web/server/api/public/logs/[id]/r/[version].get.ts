import { publicRelease, viewerFor } from '../../../../../../../lib/api/public.ts'
export default defineEventHandler((event) => apiOptional(event, async (core, who) => {
  const id = param(event, 'id')
  return publicRelease(core, await viewerFor(core, who, id), id, param(event, 'version'))
}))
