import { listRepoCandidates } from '../../../../lib/api/logs.ts'
export default defineEventHandler((event) => apiSession(event, listRepoCandidates))
