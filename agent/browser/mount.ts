// Order o5dc4: the Browser's routes, under /agent-api/browser. Not person-scoped, so like every such mount they are for the owner of the app only
// (agent/api.ts), the same rule as the PC's own screen.
//   GET  /state            -> BrowserState
//   POST /start {url?}     -> BrowserState   (starts the browser on the Server; opens url when given)
//   POST /stop             -> BrowserState
//   WS   /socket           -> the live view: { t: 'state' | 'frame' | 'notice' } out, clicks / keys / scroll / text / size / navigation in
import { apiError, type ApiMount } from '../api.ts'
import { BROWSER_PREFIX, BROWSER_SOCKET } from '../../shared/browser.ts'
import type { BrowserHost } from './host.ts'

export function browserMount(host: BrowserHost): ApiMount {
  return {
    prefix: BROWSER_PREFIX,
    async http(req) {
      if (req.rest === '/state' && req.method === 'GET') return host.state()
      if (req.rest === '/start' && req.method === 'POST') {
        const url = typeof req.body === 'object' && req.body !== null && typeof (req.body as { url?: unknown }).url === 'string' ? (req.body as { url: string }).url : undefined
        return host.start(url)
      }
      if (req.rest === '/stop' && req.method === 'POST') {
        await host.stop()
        return host.state()
      }
      throw apiError(404, 'Not here')
    },
    ws(rest) {
      return rest === BROWSER_SOCKET ? socket => host.attach(socket) : null
    },
  }
}
