/**
 * Order oc0ae (Shubham, 13 Nov 2026: "Can you make a ports button in the pc control next to updates please so i can see all ports also it should show
 * the full tailscale url"): the Ports tab of PC control. One PC's ports as its own agent sees them, READ ONLY: what each one is, whether something listens
 * on it, whether it is shared on Tailscale, and its full Tailscale address (https://<that PC's tailnet name>:<port>) with the link that opens it now.
 *
 * - The page asks its own agent: GET /agent-api/pc-ports/pcs/<id> (owner only, like every core route). The Server answers for itself, and asks a member
 *   over their link (stream 'pc-ports-v1': one request line, one answer line). A PC that is off, or runs a build without this stream, is said so: its ports
 *   are "unknown", and only what the Server knows is shown (that PC's stable ports, and the Server's own links to them).
 * - Nothing is opened, closed, shared or changed from here: that stays on Settings › Ports.
 * - What a member says is checked strictly by the Server (cleanReport) and again by the page: only numbers, short words, and links to a Tailscale
 *   name (*.ts.net) or a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48), so a PC can never hand the page any other link.
 */
import type { ListeningPort, PortShare } from './agent-api.ts'
import { STABLE_LABELS, STABLE_SERVICES, STABLE_STATE_WORDS, type StableBlock, type StablePortStatus, type StableService } from './stable-ports.ts'

export const PC_PORTS_STREAM = 'pc-ports-v1'
export const PC_PORTS_PROTOCOL = 1 as const
/** The page's route on its own agent (under /agent-api). */
export const PC_PORTS_PREFIX = '/pc-ports'
/** The most rows one report may carry (a PC with many programs listening): the rest are left out and said so. */
export const PC_PORTS_MAX_ROWS = 400

/** 'app': the app's own ports. 'stable': this PC's four stable ports (order od91f). 'shared': other Tailscale entries. 'other': any other program. */
export type PcPortGroup = 'app' | 'stable' | 'shared' | 'other'
/** Who shares a port on Tailscale: 'ports' (Settings › Ports, or the stable ports' switch), 'gate' (the phone gate), 'other' (another Tailscale entry). */
export type PcPortSharer = 'ports' | 'gate' | 'other'

export interface PcPortRow {
  port: number
  group: PcPortGroup
  /** What it is, in a few words: "App page", "Agent API", "Chat 1 (stable port)", "Shared by the phone gate", or the program's name. */
  what: string
  /** The program listening on it, e.g. "node"; null when unknown or nothing listens. */
  program: string | null
  /** true: something listens on it on that PC; false: nothing does; null: unknown (the PC did not say). */
  listening: boolean | null
  /** Who shares it on Tailscale now; null = not shared (other devices cannot open it). */
  sharedBy: PcPortSharer | null
  /** Its full Tailscale address, https://<the PC's tailnet name>:<port>; null while the name is unknown. Shown for every port; it opens only when shared. */
  address: string | null
  /** The link that opens it over Tailscale now (by name, or by IP when only that works); null when it does not open from another device. */
  url: string | null
  /** Stable ports only: the link on the Server, which answers every PC's stable ports when they are on; null when the Server does not share it. */
  serverUrl: string | null
  /** One plain sentence, or null: a stable port's state, why a link warns or is missing. */
  note: string | null
}

export interface PcPortsReport {
  protocol: 1
  pcId: string
  /** 'online': the PC answered now. 'offline': it is off or not connected. 'unsupported': its build cannot list its ports (it needs an update). */
  connection: 'online' | 'offline' | 'unsupported'
  /** One plain sentence when something is missing or unknown, or null. */
  reason: string | null
  /** That PC's own name on the tailnet, e.g. "server.tail36192f.ts.net"; null while unknown. */
  tailnetName: string | null
  /** That PC's Tailscale IPv4, e.g. "100.65.101.123"; null while unknown. */
  tailnetAddress: string | null
  /** When that PC last looked at its ports (ISO time), or null. */
  scannedAt: string | null
  rows: PcPortRow[]
}

/** The request line the Server sends a member (one per stream). */
export interface PcPortsRequest {
  protocol: 1
  targetId: string
}

/** One of the app's own ports, by name. `always`: listed even when nothing listens on it (so its absence shows). */
export interface KnownPort {
  port: number
  what: string
  always?: boolean
}

/** The app's own ports on a PC, with their names (the numbers come from that PC's settings). */
export function knownAppPorts(p: {
  page: number
  dev: number
  api: number
  peer: number
  discovery: number
  gate: number
  hbbs: number
  hbbr: number
  rustdeskDirect: number
  guard: number
  chatHost: number
}): KnownPort[] {
  const list: KnownPort[] = [
    { port: p.page, what: 'App page', always: true },
    { port: p.dev, what: 'Dev page (the Dev tree)', always: true },
    { port: p.api, what: 'Agent API', always: true },
    { port: p.chatHost, what: 'Chat host (the chats’ terminals)', always: true },
    { port: p.rustdeskDirect, what: 'RustDesk direct access', always: true },
    { port: p.peer, what: 'PC links (the other PCs connect here)' },
    { port: p.discovery, what: 'LAN discovery' },
    { port: p.gate, what: 'Ports gate (Tailscale shares come in here)' },
    { port: p.hbbs, what: 'RustDesk ID server (hbbs)' },
    { port: p.hbbr, what: 'RustDesk relay (hbbr)' },
    { port: p.guard, what: 'Guard (keeps the agent running)' },
  ]
  // One row per port: a number set twice by hand keeps its first name.
  const out: KnownPort[] = []
  for (const k of list) if (validPort(k.port) && !out.some(o => o.port === k.port)) out.push(k)
  return out
}

/** What a PC knows about its own ports, for its rows. */
export interface PortRowsInput {
  tailnetName: string | null
  /** Every TCP port listening on the PC (PortsState.ports); null when the PC cannot see them (Tailscale not up, test mode). */
  listening: readonly Pick<ListeningPort, 'port' | 'program' | 'sharedBy'>[] | null
  /** Everything shared from the PC on Tailscale (PortsState.shares). */
  shares: readonly Pick<PortShare, 'port' | 'program' | 'sharedBy' | 'httpsUrl' | 'ipUrl' | 'ipUrlWarns' | 'note'>[]
  /** The main page (Tailscale's port 443 entry) when there is one. */
  main: { httpsUrl: string | null; ipUrl: string | null; ipUrlWarns: boolean } | null
  known: readonly KnownPort[]
  /** The PC's own stable ports and how it answers on them (its entry in StablePortsState.pcs); null when it has none. */
  stable: { ports: StableBlock; status: Record<StableService, StablePortStatus> } | null
}

const sharerWords: Record<PcPortSharer, string> = { ports: 'Shared from Settings › Ports', gate: 'Shared by the phone gate', other: 'A Tailscale entry' }

/** https://<name>:<port> (no :443), or null without a name. */
export function tailnetAddressOf(name: string | null, port: number): string | null {
  const host = cleanTailnetName(name)
  return host ? `https://${host}${port === 443 ? '' : `:${port}`}` : null
}

/** The rows of one PC, from what its own agent knows: the app's ports, its stable ports, the other Tailscale entries, then every other listening port. */
export function buildPortRows(i: PortRowsInput): PcPortRow[] {
  const listening = i.listening ? new Map(i.listening.map(l => [l.port, l])) : null
  const shares = new Map(i.shares.map(s => [s.port, s]))
  const rows: PcPortRow[] = []
  const used = new Set<number>()
  const linkOf = (port: number): { url: string | null; note: string | null } => {
    const s = port === 443 && i.main ? { ...i.main, note: null } : shares.get(port)
    if (!s) return { url: null, note: null }
    const url = safeLink(s.httpsUrl) ?? safeLink(s.ipUrl)
    const warns = !safeLink(s.httpsUrl) && !!safeLink(s.ipUrl) && s.ipUrlWarns
    return { url, note: s.note ?? (warns ? 'It opens by its Tailscale IP only, and the browser warns about the certificate.' : url ? null : 'Shared, but it is not a web page: no link opens it.') }
  }
  const sharerOf = (port: number): PcPortSharer | null => (port === 443 && i.main ? 'other' : shares.get(port)?.sharedBy ?? listening?.get(port)?.sharedBy ?? null)
  const row = (port: number, group: PcPortGroup, what: string, extra: Partial<PcPortRow> = {}): PcPortRow => {
    used.add(port)
    const l = listening?.get(port)
    const link = linkOf(port)
    return {
      port,
      group,
      what,
      program: l?.program ?? null,
      listening: listening ? !!l : null,
      sharedBy: sharerOf(port),
      address: tailnetAddressOf(i.tailnetName, port),
      url: link.url,
      serverUrl: null,
      note: link.note,
      ...extra,
    }
  }
  for (const k of [...i.known].sort((a, b) => a.port - b.port)) {
    if (used.has(k.port) || !(k.always || listening?.has(k.port) || shares.has(k.port))) continue
    rows.push(row(k.port, 'app', k.what))
  }
  if (i.stable) for (const s of STABLE_SERVICES) {
    const port = i.stable.ports[s]
    if (used.has(port)) continue
    const st = i.stable.status[s]
    const base = row(port, 'stable', `${STABLE_LABELS[s]} (stable port)`)
    rows.push({ ...base, program: base.program ?? st.program, note: stableNote(st) ?? base.note })
  }
  if (i.main && !used.has(443)) rows.push(row(443, 'shared', 'Main page (Tailscale’s https address)'))
  for (const s of [...i.shares].sort((a, b) => a.port - b.port)) if (!used.has(s.port)) rows.push(row(s.port, 'shared', sharerWords[s.sharedBy], { program: s.program ?? listening?.get(s.port)?.program ?? null }))
  for (const l of [...(i.listening ?? [])].sort((a, b) => a.port - b.port)) if (!used.has(l.port)) rows.push(row(l.port, 'other', l.program ?? 'Unknown program'))
  return rows.slice(0, PC_PORTS_MAX_ROWS)
}

/** A stable port's state in one sentence ("Off", "Answering", "Held by another program: node (pid 8120)"). */
export function stableNote(st: StablePortStatus | null | undefined): string | null {
  if (!st) return null
  const words = STABLE_STATE_WORDS[st.state]
  if (st.state === 'taken' && st.program) return `${words}: ${st.program}${st.pid ? ` (pid ${st.pid})` : ''}.`
  return `${words}.`
}

/**
 * The rows the Server shows for a PC that did not answer: that PC's stable ports from the Server's table, with the Server's own state and links for
 * them (the Server answers every PC's stable ports when they are on). Everything about the PC itself is unknown.
 */
export function stableFallbackRows(block: StableBlock, onServer: Record<StableService, StablePortStatus> | null, serverLink: (port: number) => string | null, tailnetName: string | null): PcPortRow[] {
  return STABLE_SERVICES.map(s => {
    const port = block[s]
    const st = onServer?.[s] ?? null
    return {
      port,
      group: 'stable',
      what: `${STABLE_LABELS[s]} (stable port)`,
      program: null,
      listening: null,
      sharedBy: null,
      address: tailnetAddressOf(tailnetName, port),
      url: null,
      serverUrl: serverLink(port),
      note: st ? `On the Server: ${stableNote(st)}` : null,
    } satisfies PcPortRow
  })
}

// ---- strict checks: what a member says, before the Server passes it on, and what the page reads ----

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const validPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535
const words = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && ![...v].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
const wordsOrNull = (v: unknown, max: number): v is string | null => v === null || words(v, max)
const PC_ID = /^[a-z0-9]{16}$/

/** A tailnet DNS name ("server.tail36192f.ts.net"), lower case, no trailing dot; null for anything else. */
export function cleanTailnetName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const host = v.trim().replace(/\.$/, '').toLowerCase()
  return host.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(host) && host.split('.').every(l => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-')) ? host : null
}

/** A Tailscale IPv4 (100.64.0.0/10), or null. */
export function cleanTailnetIp(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v.trim())
  if (!m) return null
  const [a, b, c] = m.slice(1).map(Number)
  return a >= 64 && a <= 127 && b <= 255 && c <= 255 ? v.trim() : null
}

/**
 * A link the page may show and open: http or https, to a tailnet name (*.ts.net), a Tailscale IPv4 or a Tailscale IPv6 ([fd7a:115c:a1e0:…]), with at most
 * a port; no user, path, query or fragment. Anything else is null (never shown as a link).
 */
export function safeLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300 || /\s/.test(v)) return null
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return null
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
  const host = u.hostname.toLowerCase()
  const v6 = /^\[fd7a:115c:a1e0:[0-9a-f:]*\]$/.test(host)
  if (!cleanTailnetName(host) && !cleanTailnetIp(host) && !v6) return null
  return v.replace(/\/$/, '')
}

function cleanRow(raw: unknown): PcPortRow | null {
  if (!obj(raw)) return null
  const { port, group, what, program, listening, sharedBy, address, url, serverUrl, note } = raw
  if (!validPort(port) || !['app', 'stable', 'shared', 'other'].includes(String(group)) || !words(what, 120) || !wordsOrNull(program ?? null, 80)) return null
  if (!(listening === null || typeof listening === 'boolean') || !(sharedBy === null || ['ports', 'gate', 'other'].includes(String(sharedBy))) || !wordsOrNull(note ?? null, 300)) return null
  return {
    port,
    group: group as PcPortGroup,
    what,
    program: (program as string | null | undefined) ?? null,
    listening,
    sharedBy: sharedBy as PcPortSharer | null,
    // A link that is not to a Tailscale name or address is dropped, never passed on.
    address: safeLink(address),
    url: safeLink(url),
    serverUrl: safeLink(serverUrl ?? null),
    note: (note as string | null | undefined) ?? null,
  }
}

/**
 * The report as a PC said it, checked: the right PC, known words, bounded sizes, safe links. Throws on a report that is not one (the Server then says
 * the PC's ports are unknown); a single bad row is left out.
 */
export function cleanReport(raw: unknown, pcId: string): PcPortsReport {
  if (!obj(raw) || raw.protocol !== PC_PORTS_PROTOCOL || raw.pcId !== pcId || !PC_ID.test(pcId)) throw new Error('This is not that PC’s ports report.')
  if (!['online', 'offline', 'unsupported'].includes(String(raw.connection)) || !Array.isArray(raw.rows) || raw.rows.length > PC_PORTS_MAX_ROWS) throw new Error('The ports report is incomplete.')
  if (!wordsOrNull(raw.reason ?? null, 300) || !(raw.scannedAt === null || raw.scannedAt === undefined || (typeof raw.scannedAt === 'string' && Number.isFinite(Date.parse(raw.scannedAt))))) throw new Error('The ports report is incomplete.')
  const rows = raw.rows.map(cleanRow).filter((r): r is PcPortRow => r !== null)
  return {
    protocol: PC_PORTS_PROTOCOL,
    pcId,
    connection: raw.connection as PcPortsReport['connection'],
    reason: (raw.reason as string | null | undefined) ?? null,
    tailnetName: cleanTailnetName(raw.tailnetName),
    tailnetAddress: cleanTailnetIp(raw.tailnetAddress),
    scannedAt: typeof raw.scannedAt === 'string' ? raw.scannedAt : null,
    rows,
  }
}

/** The report for a PC whose own answer is missing: why, and only what the Server knows. */
export function unknownReport(pcId: string, connection: 'offline' | 'unsupported', reason: string, rows: PcPortRow[], last: { tailnetName: string | null; tailnetAddress: string | null } | null): PcPortsReport {
  return { protocol: PC_PORTS_PROTOCOL, pcId, connection, reason, tailnetName: last?.tailnetName ?? null, tailnetAddress: last?.tailnetAddress ?? null, scannedAt: null, rows }
}

/** The page's sections, in order, with their titles. */
export const PC_PORT_GROUPS: readonly { group: PcPortGroup; title: string }[] = [
  { group: 'app', title: 'The app’s ports' },
  { group: 'stable', title: 'Stable ports' },
  { group: 'shared', title: 'Other Tailscale shares' },
  { group: 'other', title: 'Other programs' },
]
