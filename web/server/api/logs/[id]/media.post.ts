import { uploadMedia } from '../../../../../lib/api/logs.ts'
import { MEDIA_MAX_BYTES } from '../../../../../lib/index.ts'
export default defineEventHandler(async (event) => {
  // Vor dem Lesen: ein zu großer Body landet nie im Speicher.
  if (Number(getRequestHeader(event, 'content-length') ?? 0) > MEDIA_MAX_BYTES) {
    setResponseStatus(event, 413)
    return { error: 'payload_too_large', message: 'Die Datei ist zu groß.' }
  }
  const bytes = Buffer.from((await readRawBody(event, false)) ?? [])
  return apiSession(event, (core, who) => uploadMedia(core, who, param(event, 'id'), getRequestHeader(event, 'x-filename'), bytes))
})
