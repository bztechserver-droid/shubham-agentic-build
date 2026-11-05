import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
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

/**
 * F-116: where RustDesk may be on Linux, in this order: the .deb's /usr/bin (a link to /usr/share/rustdesk), a hand
 * install, /opt, the snap, the user's own bin; then PATH; then a Flatpak's launcher (system-wide, then the user's),
 * which passes --get-id and --connect on to RustDesk as they are.
 */
export function linuxRustdeskFiles(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME || os.homedir()
  const onPath = (env.PATH || '').split(':').filter(d => d.startsWith('/')).map(d => path.posix.join(d, 'rustdesk'))
  const flatpak = 'exports/bin/com.rustdesk.RustDesk'
  return [
    ...new Set([
      '/usr/bin/rustdesk',
      '/usr/local/bin/rustdesk',
      '/opt/rustdesk/rustdesk',
      '/snap/bin/rustdesk',
      path.posix.join(home, '.local/bin/rustdesk'),
      ...onPath,
      path.posix.join('/var/lib/flatpak', flatpak),
      path.posix.join(home, '.local/share/flatpak', flatpak),
    ]),
  ]
}

/**
 * C:\Program Files\RustDesk\RustDesk.exe, or the same under Program Files (x86); null when neither is there.
 * On Linux (F-116), the first of linuxRustdeskFiles() that is there (`exists`: tests). Elsewhere, null.
 */
export function findRustdesk(env: Record<string, string | undefined> = process.env, platform: string = process.platform, exists: (file: string) => boolean = existsSync): string | null {
  if (platform === 'linux') return linuxRustdeskFiles(env).find(f => exists(f)) ?? null
  if (platform !== 'win32') return null
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
export async function dialDirect(port: number, lan: string | null, timeoutMs = 3000, hosts?: string[]): Promise<net.Socket> {
  let last: unknown
  for (const host of hosts ?? ['127.0.0.1', ...(lan ? [lan] : [])]) {
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
export function rustdeskHandler(o: {
  port: number
  lan: () => string | null
  /** F-116: this PC's Tailscale address, for a RustDesk whose IP whitelist leaves out 127.0.0.1. */
  tailnet?: () => string | null
  /** F-116: this PC's RustDesk's IP whitelist (readRustdeskWhitelist); default: not known, today's order. */
  whitelist?: () => string[] | null | undefined
  log?: Logger
}): OpenHandler {
  return async () => {
    const lan = o.lan()
    const list = o.whitelist?.()
    const plan = directHosts(lan, o.tailnet?.() ?? null, list)
    const socket = await dialDirect(o.port, lan, undefined, plan.hosts)
    o.log?.info(`a screen stream to ${socket.remoteAddress}:${o.port}${plan.why ? ` (${plan.why})` : ''}`)
    return stream => splice(stream, socket, () => o.log?.debug('screen stream closed'))
  }
}

// ---------------------------------------------------------------------------------------------
// F-116: RustDesk's IP whitelist (Settings › Security › Use IP Whitelisting). A connection the app pipes in comes from the
// address it dials, and RustDesk turns away one from outside its whitelist ("Your ip is blocked by the peer"); the TCP connect
// itself succeeds, so the dial can't tell. So the whitelist is read from RustDesk's own settings file (never changed), and
// the app dials an address on it: this PC's Tailscale address (a local connection to it comes from it), then the LAN
// address, then 127.0.0.1. With no whitelist, or none that can be read, the order stays as it always was.

/** Where RustDesk keeps its settings for this user: Linux ~/.config/rustdesk; Windows %APPDATA%\RustDesk\config, then the service's copy. */
export function rustdeskConfigFiles(platform: string = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  if (platform === 'linux') return [path.posix.join(env.HOME || os.homedir(), '.config/rustdesk/RustDesk2.toml')]
  if (platform !== 'win32') return []
  const appData = env.APPDATA || path.win32.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming')
  const sys = env.SystemRoot || 'C:\\Windows'
  return [
    path.win32.join(appData, 'RustDesk', 'config', 'RustDesk2.toml'),
    path.win32.join(sys, 'ServiceProfiles', 'LocalService', 'AppData', 'Roaming', 'RustDesk', 'config', 'RustDesk2.toml'),
  ]
}

/** The `whitelist` option of a RustDesk2.toml: its addresses and ranges; null when it is not set or empty (RustDesk then lets every address in). */
export function parseWhitelist(toml: string): string[] | null {
  const m = /^\s*whitelist\s*=\s*(?:'([^']*)'|"([^"]*)")\s*$/m.exec(toml)
  if (!m) return null
  const list = (m[1] ?? m[2] ?? '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
  return list.length ? list : null
}

/**
 * This PC's RustDesk whitelist: the first settings file that can be read says. null: there is none (every address may come in).
 * undefined: no settings file could be read (another account's, or none), so nothing is known.
 */
export function readRustdeskWhitelist(platform: string = process.platform, env: Record<string, string | undefined> = process.env, read: (file: string) => string = f => readFileSync(f, 'utf8')): string[] | null | undefined {
  for (const file of rustdeskConfigFiles(platform, env)) {
    let text: string
    try {
      text = read(file)
    } catch {
      continue
    }
    return parseWhitelist(text)
  }
  return undefined
}

/** Whether a whitelist (addresses and CIDR ranges, IPv4 or IPv6) lets `ip` in. */
export function whitelistCovers(list: readonly string[], ip: string): boolean {
  const kind = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null
  if (!kind) return false
  const allow = new net.BlockList()
  for (const entry of list) {
    const [addr, bits] = entry.split('/')
    const k = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null
    if (!k) continue
    try {
      if (bits === undefined) allow.addAddress(addr, k)
      else allow.addSubnet(addr, Number(bits), k)
    } catch {
      // A range RustDesk would not take either.
    }
  }
  return allow.check(ip, kind)
}

/** The addresses to dial this PC's RustDesk at, in order, and why when the whitelist changed the order. */
export function directHosts(lan: string | null, tailnet: string | null, whitelist: readonly string[] | null | undefined): { hosts: string[]; why: string | null } {
  const today = ['127.0.0.1', ...(lan ? [lan] : [])]
  if (!whitelist || whitelistCovers(whitelist, '127.0.0.1')) return { hosts: today, why: null }
  const all = [...new Set([tailnet, lan, '127.0.0.1'].filter((h): h is string => Boolean(h)))]
  const allowed = all.filter(h => whitelistCovers(whitelist, h))
  const hosts = [...allowed, ...all.filter(h => !allowed.includes(h))]
  const why = allowed.length
    ? `RustDesk's IP whitelist leaves out 127.0.0.1, so dialled at ${allowed[0]}`
    : "RustDesk's IP whitelist covers none of this PC's own addresses: it will turn this connection away"
  return { hosts, why }
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
