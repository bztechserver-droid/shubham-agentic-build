import fs from 'node:fs'
import path from 'node:path'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'
import {
  STABLE_LABELS,
  STABLE_SERVICES,
  blockNumber,
  blockPorts,
  blockProblem,
  freeBlock,
  isBlock,
  landingPath,
  parseStableTable,
  sameBlock,
  type StableBlock,
  type StableChangeRequest,
  type StablePc,
  type StablePortStatus,
  type StablePortsState,
  type StableService,
  type StableSettingsRequest,
  type StableTable,
} from '../../shared/stable-ports.ts'
import type { Listen, Proc } from './block.ts'
import { startStableProxy, type StableProxy, type StableProxyOptions } from './stable-proxy.ts'

// Stable ports (order od91f, 11 Nov 2026): four fixed ports per PC (Chat 1, Chat 2, Screen, Updates), the table in shared/stable-ports.ts.
//  - The Server hands the blocks out and keeps every PC's in <state>/agent/ports/stable.json: itself first, then the PCs in the order they joined, the
//    first free block each, never one block twice (a removed PC keeps its own). Each PC keeps its own four in its own config.json ("stablePorts"); the
//    Server sends the table in its hello and again when it changes, and a member's hello says which block it has saved, so a Server that lost its file
//    gives every PC its old block back.
//  - Off by default on every PC. Switched on (Settings › Ports), a PC answers on its own four ports, and the Server on every PC's (one place that is
//    always on): each port is the app's own page, landing on that PC's tab (stable-proxy.ts). Switched on with "share", Ports shares them on Tailscale.
//  - The clash check: a port another program holds is never moved. The page and the log say which port, which PC and tab, and which program; it is
//    tried again every 30 s, and Change (the Server) gives it other numbers.

export interface StableConfig {
  on: boolean
  share: boolean
  /** This PC's own four, as the Server gave them; null before it has. */
  block: StableBlock | null
}

export interface StableLog {
  info(m: string): void
  warn(m: string): void
}

export interface StableOptions {
  /** <state>/agent/ports: stable.json (the Server only). */
  dir: string
  role: 'hub' | 'member'
  self: { id: string; name: () => string }
  /** The Server: its paired PCs, in the order they joined. */
  members?: () => { id: string; name: string }[]
  /** This PC's settings as saved (config.json's stablePorts), and how to save them. */
  initial: StableConfig
  save: (next: StableConfig) => void
  /** The app's page on this PC (SAD_UI_PORT, 5173), read per request. */
  pagePort: () => number
  /** Why this PC never answers on them (SAD_STABLE_PORTS=off, test mode), or null. */
  unavailable?: string | null
  /** What listens now, and the programs (the Ports scanners), to say who holds a port. Without them a clash is still seen, by the failed listen. */
  net?: () => Promise<Listen[]>
  procs?: () => Promise<Proc[]>
  selfPid?: number
  /** Tests: the loopbacks to listen on (default 127.0.0.1 then ::1) and the page's host (default localhost). */
  hosts?: string[]
  upstreamHost?: string
  /** Tests: how a port is opened (default startStableProxy). */
  listen?: (o: StableProxyOptions) => Promise<StableProxy>
  retryMs?: number
  now?: () => number
  log?: StableLog
  /** Something the page or the other PCs show changed: the table, a setting, a port's state. */
  onChange?: () => void
}

export interface Stable {
  state(): StablePortsState
  settings(req: StableSettingsRequest): Promise<StablePortsState>
  /** The Server only: a PC's new four ports. */
  change(req: StableChangeRequest): Promise<StablePortsState>
  /** The Server's table for its hello and 'stable' messages; null on a member. */
  table(): StableTable | null
  /** A member: the Server's table as it came (checked here). False when it was not one. */
  fromServer(raw: unknown): boolean
  /** The Server: a member's hello said which block it has saved (null/absent: none, or an older member). */
  offer(id: string, raw: unknown): void
  /** For this PC's hello: its own saved block. */
  mine(): StableBlock | null
  /** The ports this PC answers on now (the app's own pages: Ports never blocks them as the app's). */
  listening(): number[]
  /** The ports to share on Tailscale now: the ones it answers on, when "share" is on. */
  shared(): number[]
  /** The Server: its PCs changed (one paired, removed or renamed). */
  sync(): void
  start(): void
  close(): Promise<void>
}

interface Entry {
  id: string
  name: string
  ports: StableBlock
  since: string
  /** Given while the PC was away: its hello may bring the block it had saved. */
  pending?: boolean
  gone?: boolean
}

interface Slot {
  port: number
  pc: string
  service: StableService
  proxies: StableProxy[]
  status: StablePortStatus
}

const ID = /^[a-z2-7]{16}$/
const RETRY_MS = 30_000
const status = (state: StablePortStatus['state'], text: string | null = null, program: string | null = null, pid: number | null = null): StablePortStatus => ({ state, program, pid, text })
const say = (e: unknown) => (e instanceof Error ? e.message : String(e))
const range = (b: StableBlock) => {
  const n = blockNumber(b)
  return n === null ? blockPorts(b).join(', ') : `${b.chat1}-${b.updates}`
}

/** stable.json, checked: a PC whose block clashes with one before it (a hand-edited file) is left out, and gets a free block at the next sync. */
function loadEntries(file: string, log?: StableLog): Entry[] {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log?.warn(`stable ports: ${file} could not be read (${say(e)}); the blocks are handed out again in the order the PCs joined`)
    return []
  }
  const r = raw as { v?: unknown; pcs?: unknown }
  if (!r || r.v !== 1 || !Array.isArray(r.pcs)) return []
  const out: Entry[] = []
  const used = new Set<number>()
  for (const p of r.pcs as Record<string, unknown>[]) {
    if (!p || typeof p.id !== 'string' || !ID.test(p.id) || out.some(e => e.id === p.id) || !isBlock(p.ports)) continue
    if (blockPorts(p.ports).some(x => used.has(x))) {
      log?.warn(`stable ports: ${p.id}'s ports in ${file} are another PC's; it gets a free block`)
      continue
    }
    for (const x of blockPorts(p.ports)) used.add(x)
    out.push({
      id: p.id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : p.id,
      ports: { ...p.ports },
      since: typeof p.since === 'string' ? p.since : '',
      ...(p.pending === true ? { pending: true } : {}),
      ...(p.gone === true ? { gone: true } : {}),
    })
  }
  return out
}

export function createStable(o: StableOptions): Stable {
  const now = o.now ?? Date.now
  const log = o.log
  const file = path.join(o.dir, 'stable.json')
  const hosts = o.hosts ?? ['127.0.0.1', '::1']
  const listen = o.listen ?? startStableProxy
  const selfPid = o.selfPid ?? process.pid
  const unavailable = o.unavailable ?? null
  let cfg: StableConfig = { on: o.initial.on, share: o.initial.share, block: o.initial.block ? { ...o.initial.block } : null }
  // The Server's table of every PC; a member's copy of what the Server last said.
  let entries: Entry[] = o.role === 'hub' ? loadEntries(file, log) : []
  let told: { table: StableTable; at: string } | null = null
  const slots = new Map<number, Slot>()
  let error: string | null = null
  let chain: Promise<void> = Promise.resolve()
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const changed = () => o.onChange?.()
  const nameOf = (pc: string) => (pc === o.self.id ? o.self.name() : (entries.find(e => e.id === pc)?.name ?? told?.table.pcs.find(p => p.id === pc)?.name ?? pc))
  const what = (s: Pick<Slot, 'port' | 'pc' | 'service'>) => `port ${s.port} (${nameOf(s.pc)} · ${STABLE_LABELS[s.service]})`

  function saveEntries() {
    try {
      writeAtomic(file, JSON.stringify({ v: 1, pcs: entries }, null, 2) + '\n')
    } catch (e) {
      error = `Could not save the stable ports: ${say(e)}`
      log?.warn(error)
    }
  }

  function saveCfg(next: StableConfig) {
    cfg = next
    try {
      o.save(next)
    } catch (e) {
      error = `Could not save this PC's stable ports: ${say(e)}`
      log?.warn(error)
    }
  }

  const takenBy = (except: string) => entries.filter(e => e.id !== except).flatMap(e => blockPorts(e.ports))

  // ---- the Server's table

  function sync() {
    if (o.role !== 'hub' || closed) return
    let dirty = false
    const stamp = new Date(now()).toISOString()
    const give = (id: string): StableBlock | null => {
      const b = freeBlock(takenBy(id))
      if (!b) log?.warn('stable ports: all 99 blocks are taken; a PC got none')
      return b
    }
    // This PC first: the block it saved, when no other PC holds it; else the first free one.
    let me = entries.find(e => e.id === o.self.id)
    if (!me) {
      const own = cfg.block && !blockProblem(cfg.block, takenBy(o.self.id)) ? cfg.block : give(o.self.id)
      if (own) {
        me = { id: o.self.id, name: o.self.name(), ports: { ...own }, since: stamp }
        entries.unshift(me)
        dirty = true
        log?.info(`stable ports: this PC (the Server) has ${range(own)}`)
      }
    } else if (me.name !== o.self.name()) {
      me.name = o.self.name()
      dirty = true
    }
    const members = o.members?.() ?? []
    for (const m of members) {
      const e = entries.find(x => x.id === m.id)
      if (e) {
        if (e.name !== m.name || e.gone) {
          e.name = m.name
          delete e.gone
          dirty = true
        }
        continue
      }
      const b = give(m.id)
      if (!b) continue
      entries.push({ id: m.id, name: m.name, ports: b, since: stamp, pending: true })
      dirty = true
      log?.info(`stable ports: ${m.name} has ${range(b)}`)
    }
    // A removed PC keeps its block, so a saved link never opens another PC; nothing answers on it.
    for (const e of entries) {
      if (e.id !== o.self.id && !e.gone && !members.some(m => m.id === e.id)) {
        e.gone = true
        dirty = true
        log?.info(`stable ports: ${e.name} was removed; ${range(e.ports)} stay its own`)
      }
    }
    if (dirty) saveEntries()
    if (me && !sameBlock(cfg.block, me.ports)) saveCfg({ ...cfg, block: { ...me.ports } })
    if (dirty) {
      apply()
      changed()
    }
  }

  // ---- listening

  function wanted(): Pick<Slot, 'port' | 'pc' | 'service'>[] {
    if (!cfg.on || unavailable !== null || closed) return []
    if (o.role === 'hub') return entries.filter(e => !e.gone).flatMap(e => STABLE_SERVICES.map(service => ({ port: e.ports[service], pc: e.id, service })))
    const own = cfg.block
    return own ? STABLE_SERVICES.map(service => ({ port: own[service], pc: o.self.id, service })) : []
  }

  function setStatus(slot: Slot, next: StablePortStatus) {
    const before = slot.status
    slot.status = next
    if (before.state === next.state && before.pid === next.pid && before.text === next.text) return
    if (next.state === 'listening') log?.info(`stable ${what(slot)}: answering (lands on ${landingPath(slot.pc, slot.service)})`)
    else if (next.state === 'taken') log?.warn(`stable ${what(slot)}: ${next.text}`)
    else if (next.state === 'reserved' || next.state === 'error') log?.warn(`stable ${what(slot)}: ${next.text}`)
    changed()
  }

  async function closeSlot(slot: Slot) {
    const ps = slot.proxies
    slot.proxies = []
    await Promise.all(ps.map(p => p.close().catch(() => undefined)))
  }

  /** Who holds a port (another program), from what listens now; null when nothing is seen there or it is this agent. */
  async function holder(port: number, scan: Listen[] | null): Promise<{ pid: number | null; program: string | null } | null> {
    const l = scan?.find(x => x.port === port)
    if (!l || l.pid === selfPid) return null
    let program: string | null = null
    if (l.pid > 0 && o.procs) {
      try {
        program = (await o.procs()).find(p => p.pid === l.pid)?.name ?? null
      } catch {
        // the program stays unnamed
      }
    }
    return { pid: l.pid > 0 ? l.pid : null, program }
  }

  const takenText = (h: { pid: number | null; program: string | null } | null) =>
    `${h?.program ? `${h.program}${h.pid ? ` (pid ${h.pid})` : ''}` : h?.pid ? `another program (pid ${h.pid})` : 'another program'} holds it. It is not moved: close that program, or give this PC other ports with Change on the Server's Settings › Ports. Tried again every 30 s.`

  async function open(slot: Slot, scan: Listen[] | null) {
    // Seen held by someone else first: no listen is tried, so nothing of ours sits next to it on another address.
    const pre = await holder(slot.port, scan)
    if (pre) return setStatus(slot, status('taken', takenText(pre), pre.program, pre.pid))
    const options = (host: string): StableProxyOptions => ({ port: slot.port, host, landing: landingPath(slot.pc, slot.service), pagePort: o.pagePort, upstreamHost: o.upstreamHost })
    try {
      slot.proxies = [await listen(options(hosts[0]))]
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') {
        const h = await holder(slot.port, o.net ? await o.net().catch(() => null) : null)
        return setStatus(slot, status('taken', takenText(h), h?.program ?? null, h?.pid ?? null))
      }
      if (code === 'EACCES') return setStatus(slot, status('reserved', 'The system keeps this port for itself (on Windows, an excluded port range, often Hyper-V or WSL). Give this PC other ports with Change.'))
      return setStatus(slot, status('error', `It would not open: ${say(e)}`))
    }
    for (const host of hosts.slice(1)) {
      try {
        slot.proxies.push(await listen(options(host)))
      } catch (e) {
        // No IPv6 here: 127.0.0.1 alone serves it. Another program on the other loopback: a visitor could reach it instead (the gate dials both), so it counts as held.
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          await closeSlot(slot)
          const h = await holder(slot.port, o.net ? await o.net().catch(() => null) : null)
          return setStatus(slot, status('taken', takenText(h), h?.program ?? null, h?.pid ?? null))
        }
      }
    }
    setStatus(slot, status('listening'))
  }

  async function applyNow() {
    const want = wanted()
    for (const [port, slot] of slots) {
      if (want.some(w => w.port === port && w.pc === slot.pc && w.service === slot.service)) continue
      await closeSlot(slot)
      slots.delete(port)
      changed()
    }
    const todo = want.filter(w => !slots.get(w.port)?.proxies.length)
    if (!todo.length) return
    const scan = o.net ? await o.net().catch(() => null) : null
    for (const w of todo) {
      let slot = slots.get(w.port)
      if (!slot) {
        slot = { ...w, proxies: [], status: status('waiting') }
        slots.set(w.port, slot)
      }
      if (closed) return
      await open(slot, scan)
    }
  }

  function apply(): Promise<void> {
    chain = chain.then(applyNow).catch(e => {
      error = say(e)
      log?.warn(`stable ports: ${error}`)
    })
    return chain
  }

  function schedule() {
    if (timer || closed) return
    // Only what is wanted and not answering is tried again; nothing else is touched.
    timer = setInterval(() => {
      if (wanted().some(w => !slots.get(w.port)?.proxies.length)) void apply()
    }, o.retryMs ?? RETRY_MS)
    timer.unref()
  }

  // ---- the page's view

  function statusOf(pc: string, service: StableService, port: number, gone: boolean): StablePortStatus {
    if (gone) return status('off', 'This PC was removed from the Server: its ports stay its own, and nothing answers on them.')
    if (unavailable !== null) return status('off', unavailable)
    const here = o.role === 'hub' || pc === o.self.id
    if (!here) return status('elsewhere', 'The Server answers on this one.')
    if (!cfg.on) return status('off')
    const slot = slots.get(port)
    return slot && slot.pc === pc && slot.service === service ? slot.status : status('waiting')
  }

  function pcView(p: { id: string; name: string; ports: StableBlock; gone?: boolean; pending?: boolean }): StablePc {
    const gone = p.gone === true
    return {
      id: p.id,
      name: p.name,
      self: p.id === o.self.id,
      ports: { ...p.ports },
      n: blockNumber(p.ports),
      gone,
      pending: p.pending === true,
      status: Object.fromEntries(STABLE_SERVICES.map(s => [s, statusOf(p.id, s, p.ports[s], gone)])) as Record<StableService, StablePortStatus>,
    }
  }

  function state(): StablePortsState {
    let list: { id: string; name: string; ports: StableBlock; gone?: boolean; pending?: boolean }[]
    if (o.role === 'hub') list = entries
    else {
      list = told ? told.table.pcs : []
      // Before the Server's first word this run, what this PC saved.
      if (cfg.block && !list.some(p => p.id === o.self.id)) list = [{ id: o.self.id, name: o.self.name(), ports: cfg.block }, ...list]
    }
    const pcs = list.map(pcView).sort((a, b) => Number(b.self) - Number(a.self))
    return { on: cfg.on, share: cfg.share, unavailable, server: o.role === 'hub', pcs, error, at: told?.at ?? null }
  }

  // ---- the routes

  async function settings(req: StableSettingsRequest): Promise<StablePortsState> {
    if (req.on !== undefined && typeof req.on !== 'boolean') throw apiError(400, 'on must be true or false')
    if (req.share !== undefined && typeof req.share !== 'boolean') throw apiError(400, 'share must be true or false')
    if (unavailable !== null && req.on === true) throw apiError(409, unavailable)
    const next = { ...cfg, ...(req.on !== undefined ? { on: req.on } : {}), ...(req.share !== undefined ? { share: req.share } : {}) }
    for (const key of ['on', 'share'] as const) if (next[key] !== cfg[key]) log?.info(`stable ports: setting changed: ${key} ${cfg[key]} -> ${next[key]}`)
    error = null
    saveCfg(next)
    await apply()
    schedule()
    changed()
    return state()
  }

  async function change(req: StableChangeRequest): Promise<StablePortsState> {
    if (o.role !== 'hub') throw apiError(409, "Only the Server changes the stable ports, so two PCs never get the same ones: open Settings › Ports on the Server.")
    if (!req || typeof req.pc !== 'string' || !isBlock(req.ports)) throw apiError(400, 'Expected {pc, ports: {chat1, chat2, screen, updates}}')
    const e = entries.find(x => x.id === req.pc)
    if (!e) throw apiError(404, 'No PC with that ID has stable ports')
    if (e.gone) throw apiError(409, `${e.name} was removed from the Server; its ports are kept as they are`)
    const problem = blockProblem(req.ports, takenBy(e.id))
    if (problem) throw apiError(400, problem)
    if (sameBlock(req.ports, e.ports)) return state()
    // Held by another program on this PC right now: said before anything moves.
    if (o.net && cfg.on && unavailable === null) {
      const scan = await o.net().catch(() => null)
      for (const s of STABLE_SERVICES) {
        const p = req.ports[s]
        if (slots.get(p)?.proxies.length) continue
        const h = await holder(p, scan)
        if (h) throw apiError(409, `${STABLE_LABELS[s]}: port ${p} is in use on this PC right now by ${h.program ?? 'another program'}${h.pid ? ` (pid ${h.pid})` : ''}. Choose another.`)
      }
    }
    log?.info(`stable ports: ${e.name} changed from ${range(e.ports)} to ${range(req.ports)}`)
    e.ports = { ...req.ports }
    delete e.pending
    saveEntries()
    if (e.id === o.self.id) saveCfg({ ...cfg, block: { ...e.ports } })
    error = null
    await apply()
    changed()
    return state()
  }

  return {
    state,
    settings,
    change,
    table() {
      if (o.role !== 'hub') return null
      return { v: 1, pcs: entries.map(e => ({ id: e.id, name: e.name, ports: { ...e.ports }, ...(e.gone ? { gone: true } : {}) })) }
    },
    fromServer(raw) {
      if (o.role === 'hub') return false
      const t = parseStableTable(raw)
      if (!t) return false
      told = { table: t, at: new Date(now()).toISOString() }
      const me = t.pcs.find(p => p.id === o.self.id)
      if (me && !sameBlock(cfg.block, me.ports)) {
        log?.info(cfg.block ? `stable ports: the Server moved this PC from ${range(cfg.block)} to ${range(me.ports)}` : `stable ports: the Server gave this PC ${range(me.ports)}`)
        saveCfg({ ...cfg, block: { ...me.ports } })
      }
      void apply()
      changed()
      return true
    },
    offer(id, raw) {
      if (o.role !== 'hub') return
      let e = entries.find(x => x.id === id)
      if (!e) {
        sync()
        e = entries.find(x => x.id === id)
      }
      if (!e || !e.pending) return
      const saved = isBlock(raw) ? raw : null
      if (saved && !sameBlock(saved, e.ports) && !blockProblem(saved, takenBy(id))) {
        log?.info(`stable ports: ${e.name} keeps the ports it had saved, ${range(saved)} (not ${range(e.ports)})`)
        e.ports = { ...saved }
      }
      delete e.pending
      saveEntries()
      void apply()
      changed()
    },
    mine: () => (cfg.block ? { ...cfg.block } : null),
    listening: () => [...slots.values()].filter(s => s.status.state === 'listening').map(s => s.port).sort((a, b) => a - b),
    shared() {
      if (!cfg.on || !cfg.share || unavailable !== null) return []
      return [...slots.values()].filter(s => s.status.state === 'listening').map(s => s.port).sort((a, b) => a - b)
    },
    sync,
    start() {
      if (closed) return
      sync()
      void apply()
      schedule()
    },
    async close() {
      closed = true
      if (timer) clearInterval(timer)
      timer = null
      await chain.catch(() => undefined)
      await Promise.all([...slots.values()].map(closeSlot))
      slots.clear()
    },
  }
}
