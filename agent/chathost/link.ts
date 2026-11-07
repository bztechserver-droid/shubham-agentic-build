import type { Logger } from '../log.ts'
import type { ChatPool, PtySpawn } from '../agentic/chats.ts'
import { connectChatHost, type HostClient, type HostInfo } from './client.ts'
import type { HostChat } from './protocol.ts'

// F-075: what the chat pool sees of the chat host: where its terminals come from (`spawn`), and, once, at the
// start of this agent, the chats the agent before it left running (`adopt`).

export interface ChatHostLink {
  readonly info: HostInfo
  /** For the chat pool: a terminal that lives in the host. */
  spawn: PtySpawn
  /** Takes hold of every chat running in the host, and notes the ones that ended while no agent was there. */
  adopt(pool: ChatPool): Promise<{ adopted: string[]; ended: string[]; skipped: string[] }>
  /** The host went away or another controller took over: the pool's chats have ended (-1) and nothing else works. */
  onLost(cb: (why: string) => void): void
  /** The link is back (a host was found or started again) and its chats, if any, are taken over. */
  onBack(cb: () => void): void
  /** Lets go of the host. The chats go on. */
  close(): void
  /** For the Build page and the update: how many chats the host runs. */
  count(): Promise<number>
  /** The host's stop (an update of the host itself): only with `killChats` while chats run. */
  shutdown(killChats: boolean): Promise<{ ok: boolean; error?: string }>
}

export interface LinkOptions {
  port: number
  token: string
  log: Logger
  /**
   * Called when the connection to the host is lost (the host died or was restarted): makes sure a host is there
   * (starting one if need be) and says where. The link then reconnects by itself and takes over the chats that run in
   * it. Not asked when another controller took over (two agents must not fight over the host).
   */
  again?: () => Promise<{ port: number; token: string } | null>
  /** Tests: how long to wait between tries to get the host back. */
  retryMs?: number
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** What the pool needs of a listed chat, or null when its meta is not ours (a chat started by something else). */
export function adoptable(c: HostChat) {
  const key = str(c.meta.key)
  const floorId = str(c.meta.floorId)
  const agentId = str(c.meta.agentId)
  const cwd = str(c.meta.cwd)
  const startedAt = str(c.meta.startedAt)
  if (!key || !floorId || !agentId || !cwd || !startedAt) return null
  return { sessionId: c.id, floorId, agentId, cwd, startedAt, key, cols: c.cols, rows: c.rows, engine: c.meta.engine === 'codex' ? ('codex' as const) : ('claude' as const) }
}

export async function connectLink(o: LinkOptions): Promise<ChatHostLink> {
  let client: HostClient = await connectChatHost({ port: o.port, token: o.token })
  let pool: ChatPool | null = null
  let closed = false
  const lostCbs: Array<(why: string) => void> = []
  const backCbs: Array<() => void> = []
  const watch = (c: HostClient) =>
    c.onLost(why => {
      if (closed || c !== client) return
      for (const cb of lostCbs) cb(why)
      if (!o.again || /another controller|shutdown/.test(why)) return
      void (async () => {
        // The chats that ran in it have ended for the pool (-1). A host that is back (or a new one) is joined again.
        while (!closed) {
          await new Promise(r => setTimeout(r, o.retryMs ?? 2000).unref())
          try {
            const where = await o.again!()
            if (!where) continue
            const next = await connectChatHost({ port: where.port, token: where.token })
            if (closed) return void next.close()
            client = next
            watch(next)
            o.log.info('chat host: connected again')
            if (pool) await takeOver(next, pool)
            for (const cb of backCbs) cb()
            return
          } catch (e) {
            o.log.warn(`chat host: not back yet (${e instanceof Error ? e.message : String(e)})`)
          }
        }
      })()
    })
  watch(client)
  async function takeOver(c: HostClient, p: ChatPool) {
    const out = { adopted: [] as string[], ended: [] as string[], skipped: [] as string[] }
    for (const ch of await c.list()) {
      const a = adoptable(ch)
      if (ch.exited) {
        // It ended while no agent was there: say so to the host, and let the open-chats list (F-058) bring it back.
        out.ended.push(ch.id)
        c.forget(ch.id)
        continue
      }
      if (!a) {
        o.log.warn(`chat host: ${ch.id.slice(0, 8)} was not started by this app; leaving it alone`)
        out.skipped.push(ch.id)
        continue
      }
      try {
        const { pty, replay } = await c.attach(ch.id)
        p.adopt(a, pty, replay)
        out.adopted.push(ch.id)
      } catch (e) {
        o.log.warn(`chat host: could not take over ${ch.id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`)
        out.skipped.push(ch.id)
      }
    }
    return out
  }
  return {
    get info() {
      return client.info
    },
    spawn: (file, args, so) => {
      if (!so.id) throw new Error('a chat in the host needs its id')
      return client.spawn(file, args, { cwd: so.cwd, env: so.env, cols: so.cols, rows: so.rows, id: so.id, meta: so.meta ?? {} })
    },
    async adopt(p) {
      pool = p
      return takeOver(client, p)
    },
    onLost: cb => void lostCbs.push(cb),
    onBack: cb => void backCbs.push(cb),
    close: () => {
      closed = true
      client.close()
    },
    async count() {
      return (await client.list()).filter(c => !c.exited).length
    },
    shutdown: killChats => client.shutdown(killChats),
  }
}
