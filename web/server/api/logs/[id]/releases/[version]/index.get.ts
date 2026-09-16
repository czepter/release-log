import { getRelease } from '../../../../../../../lib/api/releases.ts'
export default defineEventHandler((event) => apiSession(event, (core, who) => getRelease(core, who, param(event, 'id'), param(event, 'version'))))
