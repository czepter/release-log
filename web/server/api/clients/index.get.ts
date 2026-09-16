import { listClients } from '../../../../lib/api/account.ts'
export default defineEventHandler((event) => apiSession(event, listClients))
