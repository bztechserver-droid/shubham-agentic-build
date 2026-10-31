import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import type { OpenHandler } from './link/mux.ts'
import type { Logger } from './log.ts'

// The installed RustDesk, used as a separate program (agent/SPEC.md › RustDesk). Mode 1: the
// PC that wants a screen listens on 127.0.0.1, and each connection RustDesk makes there
// becomes a 'rustdesk' stream over the link; the far end pipes it to its own RustDesk's
// direct-access port (21118). RustDesk treats `--connect 127.0.0.1:<port>` as direct access:
// a plain TCP connection, no rendezvous server. Never pass --password.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** C:\Program Files\RustDesk\RustDesk.exe, or the same under Program Files (x86); null when neither is there. */
export function findRustdesk(env: Record<string, string | undefined> = process.env): string | null {
  const roots = [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)']
  for (const root of roots) {
    const exe = path.join(root, 'RustDesk', 'RustDesk.exe')
    if (existsSync(exe)) return exe
  }
  return null
}

/** `RustDesk.exe --get-id` (no admin needed): the ID it prints, or null. */
export function getRustdeskId(exe: string, timeoutMs = 10_000): Promise<string | null> {
  return new Promise(resolve => {
    execFile(exe, ['--get-id'], { timeout: timeoutMs, windowsHide: true }, (_err, stdout) => {
      const lines = String(stdout ?? '').split(/\r?\n/).map(s => s.trim())
      resolve(lines.find(s => /^[A-Za-z0-9_-]{6,32}$/.test(s)) ?? null)
    })
  })
}

/** TCP to host:port within timeoutMs; rejects otherwise. allowHalfOpen, so a tunnel's half-closes pass through. */
function dial(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, allowHalfOpen: true, noDelay: true })
    const fail = (e: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(e)
    }
    const timer = setTimeout(() => fail(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs)
    socket.once('error', fail)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', fail)
      resolve(socket)
    })
  })
}

/**
 * This PC's RustDesk direct-access port: 127.0.0.1 first, then the LAN address (RustDesk
 * listens on [::]:21118, but a copy bound to one address only answers there).
 */
export async function dialDirect(port: number, lan: string | null, timeoutMs = 3000): Promise<net.Socket> {
  let last: unknown
  for (const host of ['127.0.0.1', ...(lan ? [lan] : [])]) {
    try {
      return await dial(host, port, timeoutMs)
    } catch (e) {
      last = e
    }
  }
  throw new Error(`RustDesk's direct access (port ${port}) does not answer on this PC: ${message(last)}`)
}

/** Whether the direct-access port answers: a TCP connect, closed at once. */
export async function directAnswers(port: number, lan: string | null, timeoutMs = 1500): Promise<boolean> {
  try {
    ;(await dialDirect(port, lan, timeoutMs)).destroy()
    return true
  } catch {
    return false
  }
}

/**
 * Pipes two duplexes both ways. Half-closes pass through; the pair is torn down when both
 * have closed, or at once when either fails or is destroyed midway.
 */
export function splice(a: Duplex, b: Duplex, onDone?: () => void): void {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    a.destroy()
    b.destroy()
    onDone?.()
  }
  // A stream destroyed before we got it (the link died meanwhile) emits nothing more.
  if (a.destroyed || b.destroyed) return finish()
  const clean = (s: Duplex) => s.readableEnded && s.writableFinished
  const onClose = (s: Duplex) => () => {
    if (!clean(s) || (a.destroyed && b.destroyed)) finish()
  }
  a.on('error', finish)
  b.on('error', finish)
  a.on('close', onClose(a))
  b.on('close', onClose(b))
  a.pipe(b)
  b.pipe(a)
}

/** The 'rustdesk' stream handler: dial this PC's direct-access port first, so a dead port refuses the stream with the reason. */
export function rustdeskHandler(o: { port: number; lan: () => string | null; log?: Logger }): OpenHandler {
  return async () => {
    const socket = await dialDirect(o.port, o.lan())
    o.log?.info(`a screen stream to ${socket.remoteAddress}:${o.port}`)
    return stream => splice(stream, socket, () => o.log?.debug('screen stream closed'))
  }
}

export interface Tunnels {
  /**
   * The loopback port for `key` (a device ID), opening its listener if needed. Each connection
   * there gets a stream from `openStream`, asked at connection time so a new link is used.
   */
  open(key: string, openStream: () => Promise<Duplex>): Promise<number>
  closeAll(): void
  /** Listening ports by key (tests, diagnostics). */
  ports(): Record<string, number>
}

interface Tunnel {
  server: net.Server
  port: number
  active: number
  idle: NodeJS.Timeout | null
  openStream: () => Promise<Duplex>
}

/** Mode 1 listeners on 127.0.0.1:0, one per device, each closed 10 minutes after its last stream. */
export function createTunnels(o: { idleMs?: number; log?: Logger } = {}): Tunnels {
  const idleMs = o.idleMs ?? 10 * 60_000
  const tunnels = new Map<string, Tunnel>()
  // Listeners still binding, by key: a second open() meanwhile (a double-click on Open screen)
  // waits for the same one rather than binding its own, which nothing would ever close.
  const binding = new Map<string, Promise<Tunnel>>()
  // Bumped by closeAll(), so a listener that finishes binding afterwards closes at once.
  let generation = 0

  function close(key: string, t: Tunnel) {
    if (tunnels.get(key) !== t) return
    tunnels.delete(key)
    if (t.idle) clearTimeout(t.idle)
    t.server.close()
    o.log?.info(`closed the screen tunnel for ${key} on 127.0.0.1:${t.port}`)
  }

  function armIdle(key: string, t: Tunnel) {
    if (t.idle) clearTimeout(t.idle)
    t.idle = t.active > 0 ? null : setTimeout(() => close(key, t), idleMs)
    t.idle?.unref()
  }

  async function listen(key: string, openStream: () => Promise<Duplex>): Promise<Tunnel> {
    const started = generation
    const server = net.createServer({ allowHalfOpen: true, noDelay: true }, conn => {
      t.active++
      armIdle(key, t)
      conn.on('error', () => {}) // splice tears it down; this only keeps an early error from crashing
      let counted = true
      const release = () => {
        if (!counted) return
        counted = false
        t.active--
        armIdle(key, t)
      }
      t.openStream().then(
        stream => splice(conn, stream, release),
        e => {
          o.log?.warn(`no stream for ${key}: ${message(e)}`)
          conn.destroy()
          release()
        },
      )
    })
    const t: Tunnel = { server, port: 0, active: 0, idle: null, openStream }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', e => o.log?.warn(`tunnel listener: ${e.message}`))
    if (generation !== started) {
      server.close()
      throw new Error('the screen tunnels were closed meanwhile')
    }
    t.port = (server.address() as net.AddressInfo).port
    tunnels.set(key, t)
    o.log?.info(`screen tunnel for ${key} on 127.0.0.1:${t.port}`)
    return t
  }

  return {
    async open(key, openStream) {
      let t = tunnels.get(key)
      if (!t) {
        let pending = binding.get(key)
        if (!pending) {
          pending = listen(key, openStream).finally(() => binding.delete(key))
          binding.set(key, pending)
        }
        t = await pending
      }
      // The latest caller's stream source: a new link is used from now on.
      t.openStream = openStream
      armIdle(key, t)
      return t.port
    },
    closeAll() {
      generation++
      for (const [key, t] of [...tunnels]) close(key, t)
    },
    ports: () => Object.fromEntries([...tunnels].map(([key, t]) => [key, t.port])),
  }
}

/** `RustDesk.exe --connect 127.0.0.1:<port>`, detached and visible: RustDesk opens the screen in its own window. */
export function launchRustdesk(exe: string, port: number, log?: Logger): void {
  const child = spawn(exe, ['--connect', `127.0.0.1:${port}`], { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', e => log?.error(`could not start ${exe}: ${e.message}`))
  child.unref()
  log?.info(`started RustDesk --connect 127.0.0.1:${port}`)
}
