import { session } from '../../../lib/api/account.ts'
export default defineEventHandler((event) => apiSession(event, (core, who) => session(core, who)))
