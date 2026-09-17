import { logDetail } from '../../../../../lib/api/logs.ts'
export default defineEventHandler((event) => apiSession(event, (core, who) => logDetail(core, who, param(event, 'id'))))
