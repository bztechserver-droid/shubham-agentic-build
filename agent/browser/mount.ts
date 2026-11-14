// Order o5dc4: the Browser's routes, under /agent-api/browser. Not person-scoped, so like every such mount they are for the owner of the app only
// (agent/api.ts), the same rule as the PC's own screen.
//   GET  /state            -> BrowserState
//   POST /start {url?}     -> BrowserState   (starts the browser on the Server; opens url when given)
//   POST /stop             -> BrowserState
//   WS   /socket           -> the live view: { t: 'state' | 'frame' | 'notice' } out, clicks / keys / scroll / text / size / navigation / tabs in
// Order o9d97 (the overlay controls the Browser like the app): the Browser page asks these for the Assistant's ui_screen / ui_control.
//   POST /look {all?, tab?}  -> BrowserLook | {none: true}   (the open tab's screen: b-refs, words; private, see shared/browser-look.ts)
//   POST /act  {tab?, do, ...} -> BrowserActDone     (click / type / key / scroll / go; what is his alone is refused, 403)
import { apiError, type ApiMount } from '../api.ts'
import { BROWSER_PREFIX, BROWSER_SOCKET } from '../../shared/browser.ts'
import type { BrowserAct, BrowserHost } from './host.ts'

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined)
const REF = /^b\d{1,5}$/

/** The Assistant's act, checked field by field (anything else: 400). */
export function parseAct(body: unknown): { act: BrowserAct; tab?: string } {
  const b = obj(body)
  const tab = typeof b.tab === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.tab) ? b.tab : undefined
  const ref = typeof b.ref === 'string' && REF.test(b.ref) ? b.ref : undefined
  switch (b.do) {
    case 'click':
      if (!ref) break
      return { act: { do: 'click', ref }, tab }
    case 'type': {
      if (!ref || typeof b.text !== 'string' || b.text.length > 4000) break
      return { act: { do: 'type', ref, text: b.text, clear: b.clear !== false, submit: b.submit === true }, tab }
    }
    case 'key': {
      const key = str(b.key, 32)
      if (!key) break
      return { act: { do: 'key', key, ...(ref ? { ref } : {}) }, tab }
    }
    case 'scroll': {
      const direction = b.direction === 'up' || b.direction === 'down' || b.direction === 'top' || b.direction === 'bottom' ? b.direction : 'down'
      const amount = typeof b.amount === 'number' && Number.isFinite(b.amount) && b.amount > 0 && b.amount <= 20_000 ? b.amount : undefined
      return { act: { do: 'scroll', direction, ...(amount ? { amount } : {}), ...(ref ? { ref } : {}) }, tab }
    }
    case 'go': {
      const url = str(b.url, 2048)
      if (!url) break
      return { act: { do: 'go', url, ...(b.newTab === true ? { newTab: true } : {}) }, tab }
    }
  }
  throw apiError(400, 'Not an action the Browser takes (click, type, key, scroll or go, with a b-ref from ui_screen).')
}

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
      if (req.rest === '/look' && req.method === 'POST') {
        const b = obj(req.body)
        return (await host.look({ all: b.all === true, tab: typeof b.tab === 'string' ? b.tab : undefined })) ?? { none: true }
      }
      if (req.rest === '/act' && req.method === 'POST') {
        const { act, tab } = parseAct(req.body)
        return host.act(act, tab)
      }
      throw apiError(404, 'Not here')
    },
    ws(rest) {
      return rest === BROWSER_SOCKET ? socket => host.attach(socket) : null
    },
  }
}
