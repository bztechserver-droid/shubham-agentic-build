// Stable ports (order od91f, 11 Nov 2026). Shubham: "for each PC, we want to have a port stable. So there is chat 1, chat 2, screen and updates."
// Each PC has four fixed ports, one per view of its PC control workspace. Opening one opens the app's own page (the same page, the same sign-in as 5173)
// straight at that PC's Chat 1, Chat 2, Screen or Updates tab, so a bookmark or a saved link keeps working.
//
// The table: block n (1-99) is 51000 + 10 n + 1 (Chat 1), + 2 (Chat 2), + 3 (Screen), + 4 (Updates); + 5 to + 9 are spare. The Server hands the blocks out,
// one per PC in the order the PCs joined (the Server is 1), never the same block twice (a removed PC's block stays its own). A block can be changed by hand
// (Settings › Ports on the Server) to any four free ports from 50000 up: all above the Ports page's Share-all range (1024-49151), so Share all never takes one.
// Pure, for the agent and the page alike.

export const STABLE_SERVICES = ['chat1', 'chat2', 'screen', 'updates'] as const
export type StableService = (typeof STABLE_SERVICES)[number]
export const STABLE_LABELS: Readonly<Record<StableService, string>> = { chat1: 'Chat 1', chat2: 'Chat 2', screen: 'Screen', updates: 'Updates' }

/** One PC's four ports. */
export type StableBlock = Record<StableService, number>

/** Block n's ports are STABLE_BASE + 10 n + 1..4: block 1 (the Server) is 51011-51014. */
export const STABLE_BASE = 51000
export const STABLE_MAX_BLOCKS = 99
/** The lowest and highest port a block may use (hand-picked ones too). */
export const STABLE_MIN = 50000
export const STABLE_MAX = 65535
/** Ports above 50000 the app already uses for something else, never handed out: 50126 is the CRM drive's WebDAV on Linux (F-126). */
export const STABLE_NEVER: readonly number[] = [50126]

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** Block n (1-99). */
export function standardBlock(n: number): StableBlock {
  const b = STABLE_BASE + 10 * n
  return { chat1: b + 1, chat2: b + 2, screen: b + 3, updates: b + 4 }
}

/** The four ports, in the order Chat 1, Chat 2, Screen, Updates. */
export const blockPorts = (b: StableBlock): number[] => STABLE_SERVICES.map(s => b[s])

/** n when the block is exactly block n of the table, else null (changed by hand). */
export function blockNumber(b: StableBlock): number | null {
  const n = (b.chat1 - 1 - STABLE_BASE) / 10
  if (!Number.isInteger(n) || n < 1 || n > STABLE_MAX_BLOCKS) return null
  return sameBlock(b, standardBlock(n)) ? n : null
}

export const sameBlock = (a: StableBlock | null | undefined, b: StableBlock | null | undefined): boolean =>
  !!a && !!b && STABLE_SERVICES.every(s => a[s] === b[s])

/** Four whole port numbers (1-65535), one per service; anything else (extra keys too) is not a block. */
export function isBlock(v: unknown): v is StableBlock {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return Object.keys(o).every(k => (STABLE_SERVICES as readonly string[]).includes(k)) && STABLE_SERVICES.every(s => isInt(o[s]) && o[s] >= 1 && o[s] <= 65535)
}

/**
 * Why a block may not be used, in one sentence, or null when it may. `taken` are the ports the other PCs' blocks hold (a removed PC's too).
 * The rules: four different whole numbers from 50000 to 65535, none another PC's, none the app's own (STABLE_NEVER).
 */
export function blockProblem(b: StableBlock, taken: Iterable<number>): string | null {
  for (const s of STABLE_SERVICES) {
    const p = b[s]
    if (!isInt(p) || p < STABLE_MIN || p > STABLE_MAX) return `${STABLE_LABELS[s]}: a port is a whole number from ${STABLE_MIN} to ${STABLE_MAX}.`
    if (STABLE_NEVER.includes(p)) return `${STABLE_LABELS[s]}: port ${p} is the app's own (the CRM drive on Linux).`
  }
  const ports = blockPorts(b)
  const twice = ports.find((p, i) => ports.indexOf(p) !== i)
  if (twice !== undefined) return `Port ${twice} is used twice: each of the four needs its own port.`
  const others = new Set(taken)
  for (const s of STABLE_SERVICES) if (others.has(b[s])) return `${STABLE_LABELS[s]}: port ${b[s]} is another PC's.`
  return null
}

/** The first block of the table none of whose ports is taken (a removed PC's block counts as taken), or null when all 99 are. */
export function freeBlock(taken: Iterable<number>): StableBlock | null {
  const used = new Set(taken)
  for (let n = 1; n <= STABLE_MAX_BLOCKS; n++) {
    const b = standardBlock(n)
    if (blockPorts(b).every(p => !used.has(p) && !STABLE_NEVER.includes(p))) return b
  }
  return null
}

/** Where a stable port lands: the PC control page at that PC and tab (the page's own router; the view names are PC control's tabs). */
export const landingPath = (pcId: string, service: StableService): string => `/pc-control?pc=${encodeURIComponent(pcId)}&view=${service}`

/** The table the Server sends to every PC (its hello and 'stable' messages). Absent from an older Server. */
export interface StableTable {
  v: 1
  pcs: { id: string; name: string; ports: StableBlock; gone?: boolean }[]
}

/** A table as it came over a link, checked: null when it is not one. At most 100 PCs, names cut to 80 characters. */
export function parseStableTable(raw: unknown): StableTable | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1 || !Array.isArray(r.pcs)) return null
  const pcs: StableTable['pcs'] = []
  const ids = new Set<string>()
  for (const p of r.pcs.slice(0, 100) as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[a-z2-7]{16}$/.test(p.id) || ids.has(p.id) || !isBlock(p.ports)) continue
    ids.add(p.id)
    pcs.push({ id: p.id, name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : p.id, ports: { ...p.ports }, ...(p.gone === true ? { gone: true } : {}) })
  }
  return { v: 1, pcs }
}

// ---- the page's view (PortsState.stable) and its two routes

/** How this PC answers on one stable port right now. */
export interface StablePortStatus {
  /**
   * 'listening': this PC answers on it. 'off': the setting is off. 'elsewhere': another PC answers for it (a member sees the others' blocks).
   * 'taken': another program holds it (`program`, `pid`); it is NOT moved, it is tried again every 30 s. 'reserved': the system keeps it (Windows' excluded ranges).
   * 'waiting': not tried yet. 'error': anything else (`text`).
   */
  state: 'listening' | 'off' | 'elsewhere' | 'taken' | 'reserved' | 'waiting' | 'error'
  program: string | null
  pid: number | null
  text: string | null
}

export interface StablePc {
  id: string
  name: string
  /** This PC. */
  self: boolean
  ports: StableBlock
  /** Block n of the table, or null when changed by hand. */
  n: number | null
  /** Removed from the Server: its block stays its own (never handed to another PC), nothing answers on it. */
  gone: boolean
  /** The Server gave it a block while it was away; it says which it had saved when it connects (and keeps that one if it is free). */
  pending: boolean
  status: Record<StableService, StablePortStatus>
}

export interface StablePortsState {
  /** The setting: this PC answers on its stable ports (the Server: on every PC's). Default off. */
  on: boolean
  /** The setting: they are shared on Tailscale too, through the Ports gate (tailnet only, never Funnel). Default off. */
  share: boolean
  /** Why this PC can never answer on them (SAD_STABLE_PORTS=off, test mode), or null. */
  unavailable: string | null
  /** This PC hands out the blocks and may change them (the Server). */
  server: boolean
  /** Every PC's block (a member: as the Server last said), this PC first. */
  pcs: StablePc[]
  /** The last problem in one sentence, or null. */
  error: string | null
  /** A member: when the Server last sent the table; null on the Server or before the first. */
  at: string | null
}

/** A port's state in a few plain words, for the page (the full sentence is `text`). */
export const STABLE_STATE_WORDS: Readonly<Record<StablePortStatus['state'], string>> = {
  listening: 'Answering',
  off: 'Off',
  elsewhere: 'The Server answers',
  taken: 'Held by another program',
  reserved: 'Kept by the system',
  waiting: 'Starting',
  error: 'Would not open',
}

/**
 * The link that opens a stable port from where the page is: its shared link (https by name, else by address) when it is shared on Tailscale (this PC's
 * shares, or the Server's for a PC the Server answers for); else, with the page open on this PC itself and the port answering, the local address.
 * Null when nothing opens from here.
 */
export function stableLink(port: number, shares: readonly { port: number; httpsUrl: string | null; ipUrl: string | null }[], here: { hostname: string } | null, answering: boolean): string | null {
  const s = shares.find(x => x.port === port)
  if (s) return s.httpsUrl ?? s.ipUrl
  if (!here || !answering) return null
  const h = here.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ? `http://${here.hostname}:${port}/` : null
}

/** POST /ports/stable/settings: either or both; answers the new PortsState. */
export interface StableSettingsRequest {
  on?: boolean
  share?: boolean
}

/** POST /ports/stable/change (the Server only): a PC's new four ports. 400 for a block that may not be used (the sentence says why), 409 for a port another program holds now. */
export interface StableChangeRequest {
  pc: string
  ports: StableBlock
}
