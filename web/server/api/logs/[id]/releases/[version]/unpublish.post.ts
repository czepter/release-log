import { publishRelease } from '../../../../../../../lib/api/releases.ts'
export default defineEventHandler((event) => apiSession(event, (core, who) => publishRelease(core, who, param(event, 'id'), param(event, 'version'), false)))
