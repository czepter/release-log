import { isCorePath } from '../utils/corePaths.ts'
import { useCore } from '../utils/core.ts'

// Protokoll-Routen gehen an den Node-Handler des Kerns. Er schreibt
// manche Antworten erst auf einem späteren Tick (Webhook liest den Body per
// 'end', MCP streamt) -- deshalb wird auf das Ende der Antwort gewartet,
// nicht nur auf das Promise, sonst schriebe Nuxt danach eine zweite.
export default defineEventHandler(async (event) => {
  const { req, res } = event.node
  if (!isCorePath(req.method ?? 'GET', event.path.split('?')[0])) return
  const { handler } = await useCore()
  const ended = new Promise<void>((resolve) => {
    if (res.writableEnded) return resolve()
    res.once('finish', resolve)
    res.once('close', resolve)
  })
  await handler(req, res)
  await ended
})
