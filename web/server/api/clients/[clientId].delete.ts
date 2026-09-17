import { revokeClient } from '../../../../lib/api/account.ts'
export default defineEventHandler((event) => apiSession(event, (core, who) => revokeClient(core, who, param(event, 'clientId'))))
