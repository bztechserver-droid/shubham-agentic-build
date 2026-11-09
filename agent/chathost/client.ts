import net from 'node:net'
import type { Logger } from '../log.ts'
import { HOST_PROTOCOL, encode, lineReader, parse, type ChatMeta, type ClientMsg, type HostChat, type HostMsg } from './protocol.ts'

// F-075: the agent's side of the chat host (host.ts). `connectChatHost` opens the one controller connection;
// its `spawn` hands the chat pool a terminal that is really the host's (a drop-in for node-pty: the same
// pid / onData / onExit / write / resize / kill), and `attach` takes hold of a chat that is already running in
// the host, which is how a freshly started agent finds the chats of the one before it.

export interface RemotePty {
  readonly pid: number
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SpawnOptions {
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  /** The chat's id (its claude session id): the host's key for it. */
  id: string
  /** Kept by the host with the chat and returned by `list`: the chat's key, who it is. */
  meta: ChatMeta
}

export interface HostInfo {
  protocol: number
  version: number
  pid: number
  startedAt: number
}

export interface HostClient {
  readonly info: HostInfo
  readonly connected: boolean
  /** A terminal in the host; its pid is 0 until the host has started it. A start that fails ends it at once with exit code -1. */
  spawn(file: string, args: string[], o: SpawnOptions): RemotePty
  list(): Promise<HostChat[]>
  /** Takes hold of a chat that runs in the host: its terminal, and everything the host has kept of its output. */
  attach(id: string): Promise<{ pty: RemotePty; replay: string }>
  /** An ended chat has been noted: the host forgets it. */
  forget(id: string): void
  /** Backend cancellation through this existing authenticated controller. */
  kill(id: string): void
  /** Stops the host (refused while chats run unless `killChats`). Resolves with the host's answer. */
  shutdown(killChats: boolean): Promise<{ ok: boolean; error?: string }>
  /** Calls back once if the connection goes away without close() (the host died or restarted, or another controller took over). */
  onLost(cb: (why: string) => void): void
  /** Drops the connection. The chats go on. */
  close(): void
}

export interface ConnectOptions {
  port: number
  token: string
  log?: Logger
  /** Per request, ms. */
  timeoutMs?: number
}

class Remote implements RemotePty {
  pid = 0
  private data: Array<(d: string) => void> = []
  private exit: Array<(e: { exitCode: number }) => void> = []
  private ended = false
  /** Output and the end that came before anyone listened (an attach: the lines after the replay arrive in the same breath). */
  private early: string[] = []
  private earlyExit: number | null = null
  readonly id: string
  private readonly out: (m: ClientMsg) => void
  constructor(id: string, out: (m: ClientMsg) => void) {
    this.id = id
    this.out = out
  }
  onData(cb: (d: string) => void) {
    this.data.push(cb)
    if (this.early.length) for (const d of this.early.splice(0)) cb(d)
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit.push(cb)
    if (this.earlyExit !== null) cb({ exitCode: this.earlyExit })
  }
  write(d: string) {
    if (!this.ended) this.out({ t: 'write', id: this.id, d })
  }
  resize(cols: number, rows: number) {
    if (!this.ended) this.out({ t: 'resize', id: this.id, cols, rows })
  }
  kill() {
    if (!this.ended) this.out({ t: 'kill', id: this.id })
  }
  /** From the connection. */
  push(d: string) {
    if (this.ended) return
    if (!this.data.length) this.early.push(d)
    else for (const cb of this.data) cb(d)
  }
  end(code: number) {
    if (this.ended) return
    this.ended = true
    if (!this.exit.length) this.earlyExit = code
    else for (const cb of this.exit) cb({ exitCode: code })
  }
}

/** Opens the controller connection, says hello and waits for the host's answer. Rejects when nothing answers or the token is wrong. */
export function connectChatHost(o: ConnectOptions): Promise<HostClient> {
  const timeoutMs = o.timeoutMs ?? 8000
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: o.port, host: '127.0.0.1' })
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    const ptys = new Map<string, Remote>()
    const waiting = new Map<string, (m: HostMsg) => void>()
    const lost: Array<(why: string) => void> = []
    let info: HostInfo | null = null
    let closing = false
    let gone = false

    const out = (m: ClientMsg) => {
      if (!socket.destroyed) socket.write(encode(m))
    }
    /** Waits for the next message with this key. */
    const expect = (key: string, send: ClientMsg) =>
      new Promise<HostMsg>((res, rej) => {
        const t = setTimeout(() => {
          waiting.delete(key)
          rej(new Error(`the chat host did not answer (${send.t})`))
        }, timeoutMs)
        waiting.set(key, m => {
          clearTimeout(t)
          waiting.delete(key)
          res(m)
        })
        out(send)
      })

    const fail = (why: string) => {
      if (gone) return
      gone = true
      // Said first: the agent notes what was open before the terminals end.
      if (info && !closing) for (const cb of lost) cb(why)
      for (const p of ptys.values()) p.end(-1)
      ptys.clear()
      for (const w of [...waiting.values()]) w({ t: 'error', error: why })
      if (!info) reject(new Error(why))
    }

    const feed = lineReader(
      line => {
        const m = parse<HostMsg>(line)
        if (!m) return
        switch (m.t) {
          case 'hello-ok':
            info = { protocol: m.protocol, version: m.version, pid: m.pid, startedAt: m.startedAt }
            return resolve(client)
          case 'data':
            return void ptys.get(m.id)?.push(m.d)
          case 'exit': {
            const p = ptys.get(m.id)
            ptys.delete(m.id)
            return p?.end(m.code ?? -1)
          }
          case 'spawned': {
            const p = ptys.get(m.id)
            if (p) p.pid = m.pid
            return
          }
          case 'spawn-failed': {
            o.log?.warn(`the chat host could not start chat ${m.id.slice(0, 8)}: ${m.error}`)
            const p = ptys.get(m.id)
            ptys.delete(m.id)
            return p?.end(-1)
          }
          case 'chats':
            return waiting.get('list')?.(m)
          case 'replay':
            return waiting.get(`attach:${m.id}`)?.(m)
          case 'pong':
            return waiting.get('ping')?.(m)
          case 'bye':
            waiting.get('shutdown')?.(m)
            return fail(m.why)
          case 'error':
            if (m.id && waiting.has(`attach:${m.id}`)) return waiting.get(`attach:${m.id}`)?.(m)
            if (waiting.has('shutdown')) return waiting.get('shutdown')?.(m)
            o.log?.warn(`the chat host says: ${m.error}`)
            return
        }
      },
      () => socket.destroy(),
    )
    socket.on('data', feed)
    socket.on('error', e => fail(`the chat host connection: ${e.message}`))
    socket.on('close', () => fail('the chat host connection closed'))

    const client: HostClient = {
      get info() {
        return info!
      },
      get connected() {
        return !gone && !socket.destroyed
      },
      spawn(file, args, so) {
        const p = new Remote(so.id, out)
        if (gone) {
          queueMicrotask(() => p.end(-1))
          return p
        }
        ptys.set(so.id, p)
        out({ t: 'spawn', id: so.id, file, args, cwd: so.cwd, env: so.env, cols: so.cols, rows: so.rows, meta: so.meta })
        return p
      },
      async list() {
        const m = await expect('list', { t: 'list' })
        if (m.t !== 'chats') throw new Error(m.t === 'error' ? m.error : 'unexpected answer to list')
        return m.chats
      },
      async attach(id) {
        const p = new Remote(id, out)
        // Registered first: output that follows the replay must not slip past.
        ptys.set(id, p)
        const m = await expect(`attach:${id}`, { t: 'attach', id }).catch(e => {
          ptys.delete(id)
          throw e
        })
        if (m.t !== 'replay') {
          ptys.delete(id)
          throw new Error(m.t === 'error' ? m.error : 'unexpected answer to attach')
        }
        return { pty: p, replay: m.d }
      },
      forget(id) {
        out({ t: 'forget', id })
      },
      kill(id) { out({t:'kill',id}) },
      async shutdown(killChats) {
        const m = await expect('shutdown', { t: 'shutdown', killChats }).catch(() => ({ t: 'bye', why: 'no answer' }) as HostMsg)
        return m.t === 'bye' ? { ok: true } : { ok: false, error: m.t === 'error' ? m.error : 'unexpected answer' }
      },
      onLost(cb) {
        lost.push(cb)
      },
      close() {
        closing = true
        socket.destroy()
      },
    }

    out({ t: 'hello', token: o.token, protocol: HOST_PROTOCOL })
    setTimeout(() => {
      if (!info) {
        socket.destroy()
        reject(new Error('the chat host did not answer hello'))
      }
    }, timeoutMs).unref()
  })
}
