import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ListeningPort, PortRequest, PortShare, PortsGate, PortsMode, PortsSettingsRequest, PortsState, PortsTlsBy, ServerPorts } from '../../shared/agent-api.ts'
import { apiError } from '../api.ts'
import type { Runner } from '../drive/tailscale.ts'
import { blockOf, programKey, type Block, type BlockContext, type Listen, type Proc } from './block.ts'
import { createCert, type Cert } from './cert.ts'
import { startGate, type Gate, type Shared } from './gate.ts'
import { createIdentity, readSelf, type SelfNode } from './identity.ts'
import { realProbe, type Probe } from './probe.ts'
import { scannersFor, type NetScan, type ProcScan } from './scan.ts'
import { createServe, type ServeEntry, type ServeVia } from './serve.ts'
import { foreignLinks, oursLinks, type Where } from './urls.ts'
import { readTailscaleRights, type TailscaleRights } from './rights.ts'

// F-114 Ports: this PC's agent shares some or all of the ports its programs listen on, on Tailscale, behind its own gate (gate.ts).
//  - Default OFF on every PC. Nothing is shared until the user switches it on.
//  - Only `tailscale serve` entries made by this agent are ever changed (kept in <dir>/state.json). Entries pointing elsewhere (80, 443, 4740, the phone gate's, the Drive's) are never touched.
//  - Never Funnel, never `serve reset`. Nothing runs when Tailscale is not up.

export const DEFAULT_GATE_PORT = 21223
/** What "Share all" covers: the programs the phone gate's ports.json lists (dev servers), not every helper service on the PC. Ports chosen one by one can be any program. */
export const ALL_PROGRAMS: readonly string[] = ['node', 'bun', 'deno', 'python', 'pythonw', 'py', 'uvicorn', 'gunicorn', 'hypercorn', 'daphne', 'uwsgi', 'java', 'javaw', 'dotnet', 'php', 'php-cgi', 'php-fpm', 'ruby', 'go', 'hugo', 'caddy', 'nginx', 'httpd', 'apache2']
const PHONE_GATE_PORT = 4741
const SCAN_EVERY_MS = 5000
const IDLE_SCAN_MS = 15_000
const SERVE_RECHECK_MS = 60_000
const PROCS_RECHECK_MS = 60_000
const SELF_RECHECK_MS = 60_000
const REPROBE_MS = 5 * 60_000
const SHARE_MAX = 49151

export interface PortsLog {
  info(m: string): void
  warn(m: string): void
}

export interface PortsOptions {
  /** <state>/agent/ports: state.json and cert/. */
  dir: string
  run: Runner
  net?: NetScan
  procs?: ProcScan
  probe?: Probe
  selfPid?: number
  /** The app's own ports (agent, API, discovery, hbbs, hbbr, chat host, guard ...). The gate's own port is added. */
  appPorts: () => number[]
  /** '<build folder>/agent/' with forward slashes, lower case: a process whose command line has it is the app's. */
  appMarker?: string | null
  /** The app's own page port (SAD_UI_PORT, 5173): the one app port that may be shared. */
  pagePort: number
  gatePort?: number
  platform?: string
  /** F-116: this PC's user name, for Tailscale's operator check on Linux (default: the account the agent runs as). */
  user?: string
  /** Never scans or shares (test mode). */
  disabled?: boolean
  intervalMs?: number
  now?: () => number
  log?: PortsLog
  onChange?: () => void
  /** Member: the saved hub, for the Server button before its first message. */
  hub?: () => { name: string; tailnetName: string | null; tailnetAddress: string | null } | null
  /** Tests: a fake certificate fetch uses `run`; this swaps the gate (default startGate). */
  startGate?: typeof startGate
  upstreamHost?: string
  /**
   * Stable ports (order od91f, stable.ts): the ports this agent answers on as its own page at one PC's tab (never blocked as the app's), and the ones to share
   * on Tailscale now. These are shared whatever the mode is (Off too), through the same gate, with the same rules; they are never in `chosen`.
   */
  stable?: { listening: () => number[]; shared: () => number[] }
}

export interface Ports {
  state(): PortsState
  settings(req: PortsSettingsRequest): Promise<PortsState>
  share(req: PortRequest): Promise<PortsState>
  unshare(req: PortRequest): Promise<PortsState>
  refresh(): Promise<PortsState>
  /** The hub's part of its hello: what this PC shares, with ready links. Null when nothing is known (Tailscale not up). */
  hello(): PortsHello | null
  /** A member keeps what its hub says. Anything malformed is ignored. */
  setServer(raw: unknown): boolean
  start(): void
  close(): Promise<void>
}

/** What the hub sends in its hello and in 'ports' messages. An absent field means an older hub. */
export interface PortsHello {
  v: 1
  main: { httpsUrl: string | null; ipUrl: string | null; ipUrlWarns: boolean } | null
  shares: PortShare[]
}

interface Saved {
  mode: PortsMode
  chosen: number[]
  tlsBy: PortsTlsBy
  /** F-117: plain http by name goes to https by name where the agent does the TLS. On by default. */
  redirectHttp: boolean
  entries: { port: number; via: ServeVia; since: string }[]
}

const isPort = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535

function loadSaved(file: string): Saved {
  const empty: Saved = { mode: 'off', chosen: [], tlsBy: 'agent', redirectHttp: true, entries: [] }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Saved>
    return {
      mode: j.mode === 'chosen' || j.mode === 'all' ? j.mode : 'off',
      chosen: Array.isArray(j.chosen) ? [...new Set(j.chosen.filter(isPort))].sort((a, b) => a - b) : [],
      tlsBy: j.tlsBy === 'tailscale' ? 'tailscale' : 'agent',
      redirectHttp: j.redirectHttp !== false,
      entries: Array.isArray(j.entries) ? j.entries.filter(e => e && isPort(e.port) && (e.via === 'raw' || e.via === 'tls')).map(e => ({ port: e.port, via: e.via, since: String(e.since ?? '') })) : [],
    }
  } catch {
    return empty
  }
}

/** This account's name; os.userInfo() throws for an account with no passwd entry (a container, an odd uid). */
function userName(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER ?? ''
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms).unref())

export function createPorts(o: PortsOptions): Ports {
  const now = o.now ?? Date.now
  const platform = o.platform ?? process.platform
  // The scanners are Windows' (netstat, the process table); another system passes its own in (`net`, `procs`) or Ports says it is not there yet.
  const real = scannersFor(platform)
  const netscan = o.net ?? real?.net
  const procscan = o.procs ?? real?.procs
  const disabled = o.disabled === true || !netscan || !procscan
  const probe = o.probe ?? realProbe
  const selfPid = o.selfPid ?? process.pid
  const wantedGatePort = o.gatePort ?? DEFAULT_GATE_PORT
  const log = o.log
  const stateFile = path.join(o.dir, 'state.json')
  const saved = loadSaved(stateFile)
  const serve = createServe(o.run)
  const cert: Cert = createCert({ dir: path.join(o.dir, 'cert'), run: o.run, now, onChange: () => o.onChange?.(), warn: m => log?.info(m) })
  const identity = createIdentity({ run: o.run, self: () => self, now })

  let self: SelfNode | null = null
  let rights: TailscaleRights | null = null
  let selfAt = Number.NEGATIVE_INFINITY
  let unavailable: string | null = disabled ? (o.disabled === true ? 'Ports is off in test mode' : `Ports does not have its port scanner for ${platform} yet`) : null
  let listening: Listen[] = []
  let procs = new Map<number, Proc>()
  let procsAt = Number.NEGATIVE_INFINITY
  let entries: ServeEntry[] = []
  let entriesAt = Number.NEGATIVE_INFINITY
  let sig = ''
  const seen = new Map<number, { pid: number; n: number }>()
  const probes = new Map<string, { bad: boolean; at: number }>()
  let gate: Gate | null = null
  let error: string | null = null
  let scannedAt: string | null = null
  let lastScan = Number.NEGATIVE_INFINITY
  let ticking: Promise<void> | null = null
  let rerun = false
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let serverHello: { hello: PortsHello; at: string } | null = null

  const save = () => {
    try {
      fs.mkdirSync(o.dir, { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify(saved, null, 2))
    } catch (e) {
      log?.warn(`could not save the Ports settings: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const ctx = (): BlockContext => ({
    selfPid,
    appPorts: new Set([...o.appPorts(), wantedGatePort, ...(gate ? [gate.port] : [])]),
    appMarker: o.appMarker ?? null,
    pagePort: o.pagePort,
    pagePorts: new Set(o.stable?.listening() ?? []),
    linux: platform === 'linux',
    selfUid: process.getuid?.(),
  })
  /** Stable ports to share now (order od91f): they keep the gate on even with the mode Off. */
  const stableShared = () => new Set(o.stable?.shared() ?? [])
  const sharingOn = () => saved.mode !== 'off' || stableShared().size > 0

  const where = (): Where => ({ name: self?.dnsName ?? null, ip: self?.ips.find(i => /^\d+\./.test(i)) ?? null })
  const ipv4 = () => self?.ips.find(i => /^\d+\./.test(i)) ?? null

  // ---- what Tailscale holds

  type Owner = 'ours' | 'gate' | 'other'
  function ownerOf(e: ServeEntry): Owner {
    if (e.forward === `127.0.0.1:${gate?.port ?? wantedGatePort}`) return 'ours'
    // An entry this agent made earlier that points at an older gate port (the gate came back on another port): still ours, to be repaired.
    if (saved.entries.some(s => s.port === e.port) && (e.kind === 'tcp' || e.kind === 'tls-tcp') && e.forward?.startsWith('127.0.0.1:') && e.forward !== `127.0.0.1:${PHONE_GATE_PORT}`) return 'ours'
    if (e.forward === `127.0.0.1:${PHONE_GATE_PORT}`) return 'gate'
    return 'other'
  }
  const viaOf = (e: ServeEntry): ServeVia => (e.kind === 'tls-tcp' ? 'tls' : 'raw')

  function oursNow(): Map<number, ServeVia> {
    const m = new Map<number, ServeVia>()
    for (const e of entries) if (ownerOf(e) === 'ours') m.set(e.port, viaOf(e))
    return m
  }

  // ---- the view the page gets

  function blockFor(l: Listen): Block | null {
    const key = `${l.port}:${l.pid}`
    const b = blockOf(l, procs, ctx(), probes.get(key)?.bad === true)
    if (b) return b
    const e = entries.find(x => x.port === l.port)
    if (e && ownerOf(e) !== 'ours') return { why: 'other-entry', text: 'Tailscale already shares this port for something else (the phone gate or another entry), so Ports leaves it alone.' }
    return null
  }

  function portsView(): ListeningPort[] {
    const chosen = new Set(saved.chosen)
    const stablePages = new Set(o.stable?.listening() ?? [])
    return listening.map(l => {
      const e = entries.find(x => x.port === l.port)
      const owner = e ? ownerOf(e) : null
      return {
        port: l.port,
        program: procs.get(l.pid)?.name ?? null,
        // F-116: -1 is Linux's "another account's process" (its PID can't be read).
        pid: l.pid < 0 ? null : l.pid,
        sharedBy: owner === 'ours' ? 'ports' : owner,
        chosen: chosen.has(l.port),
        appPage: l.port === o.pagePort || stablePages.has(l.port),
        blocked: blockFor(l),
      }
    })
  }

  function sharesView(): PortShare[] {
    const w = where()
    const certReady = cert.info().state === 'ready'
    const programOf = (port: number) => procs.get(listening.find(l => l.port === port)?.pid ?? -1)?.name ?? null
    const out: PortShare[] = []
    for (const e of entries) {
      // Christopher's own addresses are the "main" page, not shares.
      if ([80, 443, 4740].includes(e.port)) continue
      const owner = ownerOf(e)
      const links = owner === 'ours' ? oursLinks(w, e.port, viaOf(e), certReady) : foreignLinks(w, e, owner === 'gate')
      out.push({ port: e.port, program: programOf(e.port), sharedBy: owner === 'ours' ? 'ports' : owner, ...links })
    }
    return out
  }

  function mainView(): PortsHello['main'] {
    const e = entries.find(x => x.port === 443)
    if (!e) return null
    const w = where()
    const l = foreignLinks(w, { ...e, port: 443 }, ownerOf(e) === 'gate')
    return { httpsUrl: l.httpsUrl, ipUrl: l.ipUrl, ipUrlWarns: l.ipUrlWarns }
  }

  function gateView(): PortsGate {
    const c = cert.info()
    const agentTls = saved.tlsBy === 'agent' && sharingOn()
    return {
      listening: gate !== null,
      port: gate?.port ?? null,
      https: !agentTls ? 'off' : c.state === 'ready' ? 'ready' : c.state === 'getting' ? 'getting' : 'no-cert',
      certExpires: c.expires,
      detail: !agentTls ? null : c.state === 'none' ? (c.detail ?? 'No certificate yet') : null,
    }
  }

  function serverView(): ServerPorts | null {
    const h = o.hub?.() ?? null
    if (!h) return null
    if (serverHello) return { name: h.name, tailnetName: h.tailnetName, tailnetAddress: h.tailnetAddress, main: serverHello.hello.main, shares: serverHello.hello.shares, at: serverHello.at }
    return { name: h.name, tailnetName: h.tailnetName, tailnetAddress: h.tailnetAddress, main: null, shares: [], at: null }
  }

  function state(): PortsState {
    if (!closed && !disabled && now() - lastScan > (sharingOn() ? SCAN_EVERY_MS * 3 : IDLE_SCAN_MS)) void run()
    return {
      available: unavailable === null,
      unavailable,
      mode: saved.mode,
      chosen: [...saved.chosen],
      tlsBy: saved.tlsBy,
      httpRedirect: { on: saved.redirectHttp, active: gate !== null && redirect() !== null },
      allPrograms: [...ALL_PROGRAMS],
      self: { name: self?.dnsName ?? null, address: ipv4(), tailnet: self?.suffix ?? null },
      ports: unavailable === null ? portsView() : [],
      shares: unavailable === null ? sharesView() : [],
      gate: gateView(),
      error,
      scannedAt,
      server: serverView(),
      // F-116: Linux only (absent on Windows): what Tailscale still needs before Ports can share.
      ...(platform === 'linux' ? { tailscaleRights: rights } : {}),
    }
  }

  // ---- the scan and the sharing

  async function ensureSelf(force: boolean) {
    if (!force && self && now() - selfAt < SELF_RECHECK_MS) return
    const before = self?.dnsName
    self = await readSelf(o.run)
    selfAt = now()
    if (self?.dnsName !== before) identity.reset()
    // F-116: on Linux, sharing needs Tailscale's operator rights; read with the rest, at the same pace.
    if (platform === 'linux') rights = await readTailscaleRights(o.run, { platform, user: o.user ?? userName(), uid: process.getuid?.() ?? -1 })
  }

  async function probeNew(): Promise<void> {
    const todo: Listen[] = []
    for (const l of listening) {
      if (!l.reachable || l.port < 1024) continue
      const key = `${l.port}:${l.pid}`
      const had = probes.get(key)
      const mine = oursNow().has(l.port)
      if (!had || (mine && now() - had.at > REPROBE_MS)) {
        // Anything the rules already block needs no probe.
        if (blockOf(l, procs, ctx(), false)) continue
        todo.push(l)
      }
    }
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(
        todo.slice(i, i + 8).map(async l => {
          const bad = await probe(l.port).catch(() => false)
          probes.set(`${l.port}:${l.pid}`, { bad, at: now() })
        }),
      )
    }
    if (probes.size > 4000) probes.clear()
  }

  /** F-117: on only when the setting is on, this gate does the TLS (tlsBy agent) and a certificate is loaded, so the https it points to really opens. */
  const redirect = () =>
    saved.redirectHttp && saved.tlsBy === 'agent' && cert.context() !== null && self ? { name: self.dnsName, hosts: new Set([self.dnsName, self.dnsName.split('.')[0]]) } : null

  async function startTheGate() {
    if (gate || closed) return
    const make = o.startGate ?? startGate
    const options = {
      identity,
      cert: () => cert.context(),
      shared: () => new Map<number, Shared>([...oursNow()].map(([p, v]) => [p, { tlsBy: v === 'tls' ? 'tailscale' : 'agent' }])),
      originHosts: () => new Set<string>(self ? [self.dnsName, self.dnsName.split('.')[0], ...self.ips].map(s => s.toLowerCase()) : []),
      redirect,
      log,
      upstreamHost: o.upstreamHost,
    } as const
    try {
      gate = await make({ ...options, port: wantedGatePort })
    } catch {
      gate = await make({ ...options, port: 0 })
    }
  }

  async function stopTheGate() {
    const g = gate
    gate = null
    await g?.close()
  }

  function wantedVia(): ServeVia {
    return saved.tlsBy === 'agent' && cert.info().state === 'ready' ? 'raw' : 'tls'
  }

  async function reconcile() {
    if (!self) return
    const modeOn = saved.mode !== 'off'
    // Stable ports (order od91f) are shared when their own setting says so, whatever the mode; they are this agent's own pages, so they need no settling or probe.
    const extra = stableShared()
    const wantOn = modeOn || extra.size > 0
    const ours = oursNow()
    if (!wantOn && ours.size === 0) {
      await stopTheGate()
      return
    }
    if (wantOn) {
      await startTheGate()
      if (saved.tlsBy === 'agent' && cert.info().state !== 'ready') await Promise.race([cert.ensure(self.dnsName), sleep(40_000)])
      else if (saved.tlsBy === 'agent') void cert.ensure(self.dnsName)
    }
    const via = wantedVia()
    const chosen = new Set(saved.chosen)
    const desired = new Map<number, ServeVia>()
    if (wantOn) {
      for (const l of listening) {
        if (blockFor(l)) continue
        if (extra.has(l.port)) {
          desired.set(l.port, via)
          continue
        }
        if (!modeOn) continue
        if (saved.mode === 'all' ? l.port > SHARE_MAX || !ALL_PROGRAMS.includes(programKey(procs.get(l.pid)?.name)) : !chosen.has(l.port)) continue
        const settled = (seen.get(l.port)?.n ?? 0) >= 2 && probes.has(`${l.port}:${l.pid}`)
        if (settled || ours.has(l.port)) desired.set(l.port, via)
      }
    }
    const gatePort = gate?.port ?? wantedGatePort
    let changedAny = false
    const offed = new Set<number>()
    // Take away what this agent made and no longer wants (the program stopped, it was switched off, it turned out to be a debugger ...).
    for (const [port, v] of ours) {
      const e = entries.find(x => x.port === port)
      const wantsIt = desired.has(port)
      const stale = e?.forward !== `127.0.0.1:${gatePort}`
      if (wantsIt && v === desired.get(port) && !stale) continue
      try {
        await serve.off(port, v)
        saved.entries = saved.entries.filter(s => s.port !== port)
        offed.add(port)
        changedAny = true
        log?.info(wantsIt ? `port ${port}: switching how it is shared` : `stopped sharing port ${port}`)
      } catch (e2) {
        error = e2 instanceof Error ? e2.message : String(e2)
      }
    }
    // Share what is wanted and has no entry. The list is read again just before: a port that has an entry by now (the phone gate is quick) is left to it.
    const missing = [...desired].filter(([port]) => !ours.has(port) || offed.has(port))
    if (missing.length) {
      const fresh = await serve.status()
      for (const [port, v] of missing) {
        // Has an entry now (someone else's, or ours after a failed switch-off): never written over.
        if (fresh.some(e => e.port === port)) continue
        try {
          await serve.add(port, v, gatePort)
          saved.entries = [...saved.entries.filter(s => s.port !== port), { port, via: v, since: new Date(now()).toISOString() }]
          changedAny = true
          log?.info(`sharing port ${port} on Tailscale (${v === 'raw' ? 'the agent answers http and https' : 'Tailscale does the TLS'})`)
        } catch (e2) {
          error = e2 instanceof Error ? e2.message : String(e2)
        }
      }
    }
    if (changedAny) {
      save()
      entries = await serve.status().catch(() => entries)
      entriesAt = now()
    }
    if (!wantOn && oursNow().size === 0) await stopTheGate()
  }

  async function tick(force: boolean) {
    if (disabled || closed) return
    try {
      await ensureSelf(force)
      if (!self) {
        unavailable = 'Tailscale is not running on this PC, so there is nothing to share on'
        error = null
        listening = []
        return
      }
      unavailable = null
      listening = await (netscan as NetScan)()
      const next = listening.map(l => `${l.port}:${l.pid}`).join(',')
      const portsMoved = next !== sig
      sig = next
      for (const l of listening) {
        const s = seen.get(l.port)
        seen.set(l.port, s && s.pid === l.pid ? { pid: l.pid, n: s.n + 1 } : { pid: l.pid, n: 1 })
      }
      for (const p of [...seen.keys()]) if (!listening.some(l => l.port === p)) seen.delete(p)
      if (portsMoved || now() - procsAt > PROCS_RECHECK_MS) {
        procs = new Map((await (procscan as ProcScan)().catch(() => [] as Proc[])).map(p => [p.pid, p]))
        procsAt = now()
      }
      if (force || portsMoved || now() - entriesAt > SERVE_RECHECK_MS) {
        entries = await serve.status()
        entriesAt = now()
        // The list of what this agent made loses what is gone from Tailscale.
        const had = saved.entries.length
        saved.entries = saved.entries.filter(s => entries.some(e => e.port === s.port))
        if (saved.entries.length !== had) save()
      }
      await probeNew()
      error = null
      await reconcile()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      if (unavailable === null) log?.warn(`Ports: ${error}`)
    } finally {
      scannedAt = new Date(now()).toISOString()
      lastScan = now()
      o.onChange?.()
    }
  }

  function run(force = false): Promise<void> {
    if (ticking) {
      rerun = rerun || force
      return ticking
    }
    ticking = tick(force).finally(() => {
      ticking = null
      if (rerun) {
        rerun = false
        void run(true)
      }
    })
    return ticking
  }

  function schedule() {
    if (timer || closed || disabled) return
    timer = setInterval(() => {
      if (sharingOn() || oursNow().size > 0) void run()
    }, o.intervalMs ?? SCAN_EVERY_MS)
    timer.unref()
  }

  // ---- settings

  function staticBlockOf(port: number): Block | null {
    const l = listening.find(x => x.port === port)
    return blockOf(l ?? { port, pid: -1, reachable: true }, procs, ctx(), false) ?? (l ? blockFor(l) : null)
  }

  async function apply(req: PortsSettingsRequest): Promise<PortsState> {
    if (disabled) throw apiError(409, unavailable ?? 'Ports is not available here')
    if (req.mode !== undefined && req.mode !== 'off' && req.mode !== 'chosen' && req.mode !== 'all') throw apiError(400, "mode must be 'off', 'chosen' or 'all'")
    if (req.tlsBy !== undefined && req.tlsBy !== 'agent' && req.tlsBy !== 'tailscale') throw apiError(400, "tlsBy must be 'agent' or 'tailscale'")
    if (req.redirectHttp !== undefined && typeof req.redirectHttp !== 'boolean') throw apiError(400, 'redirectHttp must be true or false')
    if (req.chosen !== undefined) {
      if (!Array.isArray(req.chosen) || req.chosen.length > 500 || !req.chosen.every(isPort)) throw apiError(400, 'chosen must be a list of port numbers (1-65535)')
      for (const port of req.chosen) {
        const b = staticBlockOf(port)
        if (b && !saved.chosen.includes(port)) throw apiError(409, `Port ${port} cannot be shared: ${b.text}`)
      }
    }
    // Every change is written in the agent log with the old and the new value, so a surprise has a time and a name.
    const was = { mode: saved.mode, tlsBy: saved.tlsBy, redirectHttp: saved.redirectHttp, chosen: saved.chosen.join(',') }
    if (req.mode !== undefined) saved.mode = req.mode
    if (req.tlsBy !== undefined) saved.tlsBy = req.tlsBy
    if (req.redirectHttp !== undefined) saved.redirectHttp = req.redirectHttp
    if (req.chosen !== undefined) saved.chosen = [...new Set(req.chosen)].sort((a, b) => a - b)
    for (const [key, before, after] of [
      ['mode', was.mode, saved.mode],
      ['tlsBy', was.tlsBy, saved.tlsBy],
      ['redirectHttp', String(was.redirectHttp), String(saved.redirectHttp)],
      ['chosen', was.chosen || 'none', saved.chosen.join(',') || 'none'],
    ] as const)
      if (before !== after) log?.info(`setting changed: ${key} ${before} -> ${after}`)
    save()
    schedule()
    await run(true)
    return state()
  }

  return {
    state,
    settings: apply,
    async share({ port }) {
      if (!isPort(port)) throw apiError(400, 'Expected {port}: a port number')
      const b = staticBlockOf(port)
      if (b) throw apiError(409, `Port ${port} cannot be shared: ${b.text}`)
      return apply({ chosen: [...saved.chosen, port], ...(saved.mode === 'off' ? { mode: 'chosen' as const } : {}) })
    },
    async unshare({ port }) {
      if (!isPort(port)) throw apiError(400, 'Expected {port}: a port number')
      return apply({ chosen: saved.chosen.filter(p => p !== port) })
    },
    async refresh() {
      await run(true)
      return state()
    },
    hello() {
      if (disabled || !self) return null
      return { v: 1, main: mainView(), shares: sharesView().slice(0, 60) }
    },
    setServer(raw) {
      const h = parseHello(raw)
      if (!h) return false
      serverHello = { hello: h, at: new Date(now()).toISOString() }
      o.onChange?.()
      return true
    },
    start() {
      if (disabled || closed) return
      schedule()
      void run(true)
    },
    async close() {
      closed = true
      if (timer) clearInterval(timer)
      // The entries stay: they come back to life when the agent does (the gate is on again, on the same port), and they are only ever taken away by this agent.
      await ticking?.catch(() => undefined)
      await stopTheGate()
    },
  }
}

// ---- the hub's message, checked by the member (older hubs send none)

const okUrl = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 200 || !/^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/)?$/.test(v)) return null
  return v
}

export function parseHello(raw: unknown): PortsHello | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Array.isArray(r.shares)) return null
  const shares: PortShare[] = []
  for (const s of r.shares.slice(0, 60) as Record<string, unknown>[]) {
    if (!s || !isPort(s.port) || (s.sharedBy !== 'ports' && s.sharedBy !== 'gate' && s.sharedBy !== 'other')) continue
    shares.push({
      port: s.port,
      program: typeof s.program === 'string' ? s.program.slice(0, 64) : null,
      sharedBy: s.sharedBy,
      httpsUrl: okUrl(s.httpsUrl),
      ipUrl: okUrl(s.ipUrl),
      ipUrlWarns: s.ipUrlWarns === true,
      note: typeof s.note === 'string' ? s.note.slice(0, 240) : null,
    })
  }
  const m = r.main as Record<string, unknown> | null | undefined
  const main = m && typeof m === 'object' ? { httpsUrl: okUrl(m.httpsUrl), ipUrl: okUrl(m.ipUrl), ipUrlWarns: m.ipUrlWarns === true } : null
  return { v: 1, main, shares }
}
