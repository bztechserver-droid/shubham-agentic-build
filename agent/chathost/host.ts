import { timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import { killTree } from '../proc-tree.ts'
import type { Logger } from '../log.ts'
import {
  EXITED_KEEP_MS,
  HOST_PROTOCOL,
  HOST_VERSION,
  RING_BYTES,
  encode,
  lineReader,
  parse,
  type ChatMeta,
  type ClientMsg,
  type HostChat,
  type HostMsg,
} from './protocol.ts'

// F-075: the chat host. It owns every chat's terminal (node-pty, ConPTY) and the claude process in it, so that
// the agent can stop, update and start again without a chat noticing: a ConPTY child dies with the process that
// created it (measured on 1 Nov 2026: killed within a second, detached or not), so the owner must be something
// that is not the agent. The agent is the host's one controller (a TCP connection on 127.0.0.1, protocol.ts):
// it spawns, types, resizes and kills through it, and on every start it lists the chats and attaches to the
// ones running, getting each one's recent output back so that nothing is missed or shown twice.
// The host knows nothing of claude, floors or keys: what the agent wants kept with a chat (`meta`) is stored and
// returned whole. It never parses output. It is kept small on purpose: everything that runs in it is a risk to
// every chat at once.

export interface HostPty {
  readonly pid: number
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export type HostSpawn = (file: string, args: string[], o: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => HostPty

export interface ChatHostOptions {
  /** 0: any free port (tests). */
  port: number
  token: string
  spawn: HostSpawn
  log: Logger
  /** Ends a process's real descendants by exact PID; default agent/proc-tree.ts. Tests with a fake pty pass a no-op. */
  treeKill?: (pid: number, startedAt: number) => Promise<void> | void
  exitedKeepMs?: number
  /** After a kill, this long without the terminal reporting its end, and the chat is counted as ended. */
  killGraceMs?: number
}

export interface ChatHost {
  readonly port: number
  /** Stops listening and drops the controller; chats are NOT ended (use `shutdown`). */
  close(): Promise<void>
  /** The chats (running and ended-not-yet-forgotten). */
  chats(): HostChat[]
  controller(): boolean
  /** Resolves when a controller's `shutdown` was carried out. */
  readonly stopped: Promise<void>
}

interface Entry {
  chat: HostChat
  pty: HostPty
  ring: string[]
  bytes: number
  subscribed: boolean
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
/** A controller that does not read (the agent wedged): after this much unsent output it is dropped, it reconnects and replays. */
const MAX_UNSENT_BYTES = 32 * 1024 * 1024

export function startChatHost(o: ChatHostOptions): Promise<ChatHost> {
  const log = o.log
  const startedAt = Date.now()
  const entries = new Map<string, Entry>()
  const treeKill = o.treeKill ?? ((pid: number, since: number) => void killTree(pid, { since }).catch(() => {}))
  let ctl: net.Socket | null = null
  let stopping = false
  let resolveStopped!: () => void
  const stopped = new Promise<void>(r => (resolveStopped = r))

  const send = (s: net.Socket | null, m: HostMsg) => {
    if (!s || s.destroyed) return
    s.write(encode(m))
    if (s.writableLength > MAX_UNSENT_BYTES) {
      log.warn('the controller is not reading: dropping it (it reconnects and replays)')
      s.destroy()
    }
  }
  const toCtl = (m: HostMsg) => send(ctl, m)

  function finish(e: Entry, code: number | null) {
    if (e.chat.exited) return
    e.chat.exited = { code, at: Date.now() }
    log.info(`chat ${e.chat.id.slice(0, 8)}: ended${code === null ? '' : ` (${code})`}`)
    toCtl({ t: 'exit', id: e.chat.id, code })
  }

  function spawnChat(m: Extract<ClientMsg, { t: 'spawn' }>) {
    const old = entries.get(m.id)
    if (old && !old.chat.exited) return toCtl({ t: 'spawned', id: m.id, pid: old.chat.pid })
    let pty: HostPty
    try {
      pty = o.spawn(m.file, m.args, { cwd: m.cwd, env: m.env, cols: m.cols, rows: m.rows })
    } catch (e) {
      return toCtl({ t: 'spawn-failed', id: m.id, error: e instanceof Error ? e.message : String(e) })
    }
    const e: Entry = {
      chat: { id: m.id, pid: pty.pid, meta: m.meta, cols: m.cols, rows: m.rows, startedAt: Date.now(), exited: null },
      pty,
      ring: [],
      bytes: 0,
      subscribed: true,
    }
    entries.set(m.id, e)
    pty.onData(data => {
      e.ring.push(data)
      e.bytes += data.length
      while (e.bytes > RING_BYTES && e.ring.length > 1) e.bytes -= e.ring.shift()!.length
      if (e.subscribed) toCtl({ t: 'data', id: m.id, d: data })
    })
    pty.onExit(x => finish(e, typeof x?.exitCode === 'number' ? x.exitCode : null))
    log.info(`chat ${m.id.slice(0, 8)}: started (pid ${pty.pid}, ${m.cols}x${m.rows})`)
    toCtl({ t: 'spawned', id: m.id, pid: pty.pid })
  }

  function killChat(e: Entry) {
    if (e.chat.exited) return
    try {
      e.pty.kill()
    } catch {
      // Gone already; its processes may not be.
    }
    if (e.chat.pid) void Promise.resolve(treeKill(e.chat.pid, e.chat.startedAt)).catch(() => {})
    // The terminal normally reports its end by itself; if it does not, the chat is counted as ended.
    setTimeout(() => finish(e, null), o.killGraceMs ?? 3000).unref()
  }

  function handle(s: net.Socket, m: ClientMsg) {
    switch (m.t) {
      case 'spawn':
        return spawnChat(m)
      case 'write': {
        const e = entries.get(m.id)
        if (e && !e.chat.exited && typeof m.d === 'string') {
          try {
            e.pty.write(m.d)
          } catch {
            // Ended meanwhile.
          }
        }
        return
      }
      case 'resize': {
        const e = entries.get(m.id)
        if (e && !e.chat.exited) {
          try {
            e.pty.resize(m.cols, m.rows)
            e.chat.cols = m.cols
            e.chat.rows = m.rows
          } catch {
            // Ended meanwhile.
          }
        }
        return
      }
      case 'kill': {
        const e = entries.get(m.id)
        if (e) killChat(e)
        return
      }
      case 'list':
        return send(s, { t: 'chats', chats: [...entries.values()].map(e => e.chat) })
      case 'attach': {
        const e = entries.get(m.id)
        if (!e) return send(s, { t: 'error', error: 'no such chat', id: m.id })
        e.subscribed = true
        return send(s, { t: 'replay', id: m.id, d: e.ring.join('') })
      }
      case 'forget': {
        const e = entries.get(m.id)
        if (e?.chat.exited) entries.delete(m.id)
        return
      }
      case 'ping':
        return send(s, { t: 'pong' })
      case 'shutdown': {
        const running = [...entries.values()].filter(e => !e.chat.exited)
        if (running.length && !m.killChats) return send(s, { t: 'error', error: `${running.length} chat${running.length === 1 ? ' is' : 's are'} running` })
        log.info(`shutdown asked${running.length ? `: ending ${running.length} chat${running.length === 1 ? '' : 's'}` : ''}`)
        for (const e of running) killChat(e)
        send(s, { t: 'bye', why: 'shutdown' })
        stopping = true
        setTimeout(() => {
          for (const c of sockets) c.destroy()
          server.close(() => resolveStopped())
        }, 300).unref()
        setTimeout(() => resolveStopped(), 4000).unref()
        return
      }
      default:
        return send(s, { t: 'error', error: 'unknown message' })
    }
  }

  const sockets = new Set<net.Socket>()
  const server = net.createServer(s => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
    s.setNoDelay(true)
    s.setEncoding('utf8')
    let authed = false
    const hello = setTimeout(() => s.destroy(), 5000)
    hello.unref()
    const feed = lineReader(
      line => {
        const m = parse<ClientMsg>(line)
        if (!m) return
        if (!authed) {
          if (m.t !== 'hello' || typeof m.token !== 'string' || !same(m.token, o.token)) return void s.destroy()
          authed = true
          clearTimeout(hello)
          if (ctl && ctl !== s) {
            send(ctl, { t: 'bye', why: 'another controller took over' })
            ctl.destroy()
          }
          ctl = s
          // A new controller has seen nothing yet: nothing is streamed to it until it attaches.
          for (const e of entries.values()) e.subscribed = false
          send(s, { t: 'hello-ok', protocol: HOST_PROTOCOL, version: HOST_VERSION, pid: process.pid, startedAt })
          return
        }
        if (s === ctl) handle(s, m)
      },
      () => s.destroy(),
    )
    s.on('data', feed)
    s.on('error', () => {})
    s.on('close', () => {
      clearTimeout(hello)
      if (ctl === s) {
        ctl = null
        for (const e of entries.values()) e.subscribed = false
        if (!stopping) log.info('the controller went away; the chats go on')
      }
    })
  })

  const sweep = setInterval(() => {
    const t = Date.now()
    for (const [id, e] of entries) if (e.chat.exited && t - e.chat.exited.at > (o.exitedKeepMs ?? EXITED_KEEP_MS)) entries.delete(id)
  }, 60_000)
  sweep.unref()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port: o.port, host: '127.0.0.1', exclusive: true }, () => {
      server.off('error', reject)
      server.on('error', e => log.error(`host server: ${e.message}`))
      const port = (server.address() as net.AddressInfo).port
      log.info(`the chat host runs (pid ${process.pid}, protocol ${HOST_PROTOCOL}, version ${HOST_VERSION}) on port ${port}`)
      resolve({
        port,
        chats: () => [...entries.values()].map(e => e.chat),
        controller: () => ctl !== null,
        stopped,
        async close() {
          clearInterval(sweep)
          for (const s of sockets) s.destroy()
          await new Promise<void>(r => server.close(() => r()))
        },
      })
    })
  })
}

export type { ChatMeta }
