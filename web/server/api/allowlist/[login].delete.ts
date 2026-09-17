import { deleteAllowlist } from '../../../../lib/api/account.ts'
export default defineEventHandler((event) => apiSession(event, (core, who) => deleteAllowlist(core, who, param(event, 'login'))))
