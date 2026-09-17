import { consent } from '../../../../lib/api/consent.ts'
export default defineEventHandler((event) => apiOptional(event, (core, who) => {
  const search = getRequestURL(event).search.replace(/^\?/, '')
  return consent(core, who, search)
}))
