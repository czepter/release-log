import { listAllowlist } from '../../../../lib/api/account.ts'
export default defineEventHandler((event) => apiSession(event, listAllowlist))
