import { createHash, createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { cleanSize, cleanTarget, PC_SSH_PREFIX, sshLine, type SshSessionAnswer, type SshTarget, type SshTargetAnswer, type SshTermServerMessage } from '../shared/pc-ssh-term.ts'
import { cleanTailnetIp } from '../shared/pc-ports.ts'
import { apiError, type ApiMount, type MountRequest, type WsSocket } from './api.ts'
import { describeHuman, requireCrmHuman } from './agentic/human-session.ts'
import type { PtyLike, PtySpawn } from './agentic/chats.ts'
import type { Auth } from './auth/index.ts'
import type { Caller } from './auth/types.ts'

// Orders o1fa0 + o2915 (shared/pc-ssh-term.ts): a live SSH session from PC control's SSH tab. This PC's agent runs its OWN ssh client with its own key
// in a pseudo-terminal (node-pty; ConPTY on Windows) and streams it to the page. The key and any password stay on this PC: the page only sees what ssh
// prints and sends keys. Nothing about SSH itself is changed here (no config, no key written); ssh may add a PC's host key to this PC's known_hosts
// when Shubham answers its question himself.

const TICKET_MS = 30_000
const MAX_SESSIONS = 4
const MAX_IN = 65_536
const ID = /^[a-z0-9]{16}$/

export interface SshTermOptions {
  /** A PC this agent knows (itself and its Server's or its members), with its name and its Tailscale address as its link shows it; null otherwise. */
  pc(id: string): { name: string; tailnetGuess: string | null } | null
  auth: Auth | undefined
  /** node-pty, loaded on the first session (agentic/chats.ts loadNodePty). */
  pty(): { spawn: PtySpawn } | { error: string }
  /** The ssh client, its key (null: ssh's own default), this user's known_hosts, and how it runs. */
  ssh: { exe: string; keyFile: string | null; knownHosts: string; cwd: string; env: Record<string, string> }
  /** <state>/agent/ssh: targets.json (the last target per PC). */
  dir: string
  now?: () => number
  log?: { info(m: string): void; warn(m: string): void }
}

export interface SshTerm {
  mount: ApiMount
  /** Ends every open session (the agent is stopping). */
  closeAll(): void
  /** For tests: how many sessions are open. */
  open(): number
}

interface Ticket {
  pcId: string
  target: SshTarget
  sid: string
  person: string
  who: string
  expires: number
  admitted: boolean
}

/** known_hosts → the fingerprints it holds for `host` on `port` (and for `host` on 22): plain names, [host]:port, or hashed (|1|salt|hash). */
export function knownFingerprints(text: string, host: string, port: number): { forPort: string[]; forHost: string[] } {
  const named = (name: string) => {
    const out: string[] = []
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#') || t.startsWith('@')) continue
      const [hosts, type, b64] = t.split(/\s+/)
      if (!hosts || !type || !b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue
      const hit = hosts.startsWith('|1|')
        ? (() => {
            const [, , salt, hash] = hosts.split('|')
            return !!salt && !!hash && createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash
          })()
        : hosts.split(',').some(h => h.toLowerCase() === name.toLowerCase())
      if (hit) out.push('SHA256:' + createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, ''))
    }
    return [...new Set(out)]
  }
  const forPort = named(port === 22 ? host : `[${host}]:${port}`)
  return { forPort, forHost: port === 22 ? forPort : named(host) }
}

/** The ssh arguments for a target: its own key when it has one (and only that key), a keep-alive, a time limit to connect. Never a shell. */
export function sshArgs(t: SshTarget, keyFile: string | null): string[] {
  return [...(keyFile ? ['-i', keyFile, '-o', 'IdentitiesOnly=yes'] : []), '-o', 'ServerAliveInterval=30', '-o', 'ConnectTimeout=15', '-p', String(t.port), `${t.user}@${t.host}`]
}

export function createSshTerm(o: SshTermOptions): SshTerm {
  const now = o.now ?? Date.now
  const tickets = new Map<string, Ticket>()
  const sessions = new Set<{ term: PtyLike | null; socket: WsSocket }>()
  const targetsFile = path.join(o.dir, 'targets.json')

  const readTargets = (): Record<string, SshTarget & { at: string }> => {
    try {
      const v = JSON.parse(fs.readFileSync(targetsFile, 'utf8')) as { v?: number; targets?: Record<string, unknown> }
      const out: Record<string, SshTarget & { at: string }> = {}
      for (const [id, raw] of Object.entries(v.targets ?? {})) {
        const t = ID.test(id) ? cleanTarget(raw) : null
        if (t) out[id] = { ...t, at: String((raw as { at?: unknown }).at ?? '') }
      }
      return out
    } catch {
      return {}
    }
  }
  const saveTarget = (id: string, t: SshTarget) => {
    try {
      const all = { ...readTargets(), [id]: { ...t, at: new Date(now()).toISOString() } }
      fs.mkdirSync(o.dir, { recursive: true })
      const tmp = `${targetsFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, targets: all }, null, 2) + '\n')
      fs.renameSync(tmp, targetsFile)
    } catch (e) {
      o.log?.warn(`ssh: the last target for ${id} could not be saved (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  const prune = () => {
    for (const [k, t] of tickets) if (t.expires <= now()) tickets.delete(k)
  }

  function target(id: string): SshTargetAnswer {
    const pc = o.pc(id)
    if (!ID.test(id) || !pc) throw apiError(404, 'That is not one of this app’s PCs.')
    const saved = readTargets()[id]
    if (saved) return { pcId: id, user: saved.user, host: saved.host, port: saved.port, from: 'saved' }
    const guess = cleanTailnetIp(pc.tailnetGuess)
    return { pcId: id, user: null, host: guess, port: guess ? 22 : null, from: guess ? 'guess' : null }
  }

  function session(id: string, r: MountRequest): SshSessionAnswer {
    // The same rule as the PC screen and phone control: the signed-in CRM administrator's own session, never a chat tool or a program.
    const caller = requireCrmHuman(o.auth, r, true)
    const pc = o.pc(id)
    if (!ID.test(id) || !pc) throw apiError(404, 'That is not one of this app’s PCs.')
    const t = cleanTarget(r.body)
    if (!t) throw apiError(400, 'Give a user (letters, digits, . _ -), a Tailscale address (100.x.y.z or a name ending in .ts.net) and a port.')
    prune()
    if (sessions.size >= MAX_SESSIONS) throw apiError(429, `${MAX_SESSIONS} SSH sessions are open already. Close one first.`)
    if (tickets.size >= 16) throw apiError(429, 'Too many sessions are starting at once. Wait a moment.')
    const ticket = randomBytes(32).toString('hex')
    const expires = now() + TICKET_MS
    tickets.set(ticket, { pcId: id, target: t, sid: caller.sid!, person: caller.person!.id, who: describeHuman(caller), expires, admitted: false })
    saveTarget(id, t)
    let known = { forPort: [] as string[], forHost: [] as string[] }
    try {
      known = knownFingerprints(fs.readFileSync(o.ssh.knownHosts, 'utf8'), t.host, t.port)
    } catch {
      // No known_hosts yet: ssh asks.
    }
    return { ticket, expiresAt: new Date(expires).toISOString(), target: t, knownForPort: known.forPort, knownForHost: known.forHost }
  }

  function allow(query: URLSearchParams, caller: Caller) {
    prune()
    const t = tickets.get(query.get('ticket') ?? '')
    if (!t || t.admitted) throw Object.assign(apiError(403, 'This terminal link is used up or too old. Press Open terminal again.'), { code: 'ticket' })
    // Only the session that asked for it may open it.
    if (!caller.person || caller.sid !== t.sid || caller.person.id !== t.person) throw Object.assign(apiError(403, 'This terminal was opened by another sign-in.'), { code: 'ticket' })
    t.admitted = true
  }

  function attach(ticketId: string, socket: WsSocket, caller: Caller) {
    const t = tickets.get(ticketId)
    tickets.delete(ticketId)
    const send = (m: SshTermServerMessage) => {
      try {
        socket.sendText(JSON.stringify(m))
      } catch {
        // The page has gone; onClose ends the session.
      }
    }
    if (!t || !t.admitted || t.expires <= now()) {
      send({ t: 'exit', code: null, reason: 'This terminal link is used up or too old. Press Open terminal again.' })
      socket.close(4003, 'ticket')
      return
    }
    const p = o.pty()
    if ('error' in p) {
      send({ t: 'exit', code: null, reason: `This PC cannot run a terminal: ${p.error}` })
      socket.close(1011, 'no pty')
      return
    }
    const s: { term: PtyLike | null; socket: WsSocket } = { term: null, socket }
    sessions.add(s)
    let ended = false
    const untrack = o.auth?.track(caller, () => socket.close(4001, 'The sign-in ended.'))
    const end = () => {
      if (ended) return
      ended = true
      sessions.delete(s)
      if (typeof untrack === 'function') untrack()
      // Its own handle only (node-pty ends exactly this process): never by name or a tree.
      try {
        s.term?.kill()
      } catch {
        // Already gone.
      }
    }
    try {
      s.term = p.spawn(o.ssh.exe, sshArgs(t.target, o.ssh.keyFile), { cwd: o.ssh.cwd, env: { ...o.ssh.env, TERM: 'xterm-256color' }, cols: 100, rows: 30 })
    } catch (e) {
      sessions.delete(s)
      if (typeof untrack === 'function') untrack()
      send({ t: 'exit', code: null, reason: `ssh did not start: ${e instanceof Error ? e.message : String(e)}` })
      socket.close(1011, 'ssh did not start')
      return
    }
    o.log?.info(`ssh session opened to ${sshLine(t.target)} (${t.pcId}) by ${t.who}`)
    s.term.onData(d => send({ t: 'out', d }))
    s.term.onExit(e => {
      if (ended) return
      send({ t: 'exit', code: e.exitCode, reason: e.exitCode === 0 ? 'The session ended.' : `ssh ended (code ${e.exitCode}).` })
      o.log?.info(`ssh session to ${sshLine(t.target)} ended (code ${e.exitCode})`)
      end()
      socket.close(1000, 'ended')
    })
    socket.onText(text => {
      if (ended || text.length > MAX_IN + 64) return
      let m: unknown
      try {
        m = JSON.parse(text)
      } catch {
        return
      }
      const msg = m as { t?: unknown; d?: unknown; cols?: unknown; rows?: unknown }
      if (msg.t === 'in' && typeof msg.d === 'string' && msg.d.length <= MAX_IN) s.term?.write(msg.d)
      else if (msg.t === 'size') {
        const size = cleanSize(msg.cols, msg.rows)
        if (size) s.term?.resize(size.cols, size.rows)
      }
    })
    socket.onClose(() => {
      if (!ended) o.log?.info(`ssh session to ${sshLine(t.target)} closed by the page`)
      end()
    })
  }

  const mount: ApiMount = {
    prefix: PC_SSH_PREFIX,
    async http(r: MountRequest) {
      const m = /^\/pcs\/([^/]+)\/(target|session)$/.exec(r.rest)
      if (!m) throw apiError(404, 'Nothing here.')
      if (r.query.toString()) throw apiError(400, 'Nothing after the path, please.')
      if (m[2] === 'target') {
        if (r.method !== 'GET') throw apiError(405, 'Only GET.')
        return target(m[1])
      }
      if (r.method !== 'POST') throw apiError(405, 'Only POST.')
      return session(m[1], r)
    },
    ws(rest, query) {
      if (rest !== '/terminal') return null
      const ticket = query.get('ticket') ?? ''
      return (socket, caller) => attach(ticket, socket, caller ?? { person: null, via: 'local', sid: null })
    },
    wsAllow(rest, query, caller) {
      if (rest === '/terminal') allow(query, caller)
    },
  }

  return {
    mount,
    closeAll() {
      for (const s of [...sessions]) {
        try {
          s.socket.close(1001, 'The agent is stopping.')
        } catch {
          // already closed
        }
        try {
          s.term?.kill()
        } catch {
          // already gone
        }
      }
      sessions.clear()
    },
    open: () => sessions.size,
  }
}

