import { listLogs } from '../../../../lib/api/logs.ts'
export default defineEventHandler((event) => apiSession(event, listLogs))
