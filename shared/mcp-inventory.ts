import { contractRecord } from './chat-execution.ts'

// F-168 part 2 (10 Nov 2026, Shubham's order o6f4e): every MCP server a PC has, where it comes from, which chats get it and which of those
// are running now; and a register-only Install from a short curated list. Names, kinds and chat names only: this answer is incapable of
// carrying a command line, an argument, an environment value, a URL or a file path of the user's (the curated entries' own commands are
// ours and are shown on purpose in an install preview).

export const MCP_INVENTORY_PATH = '/mcp-inventory' as const
export const MCP_INVENTORY_LIMIT = 256
export const MCP_CHATS_LIMIT = 200
export const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export type McpSource = 'app' | 'user' | 'local' | 'project' | 'registry'
export const MCP_SOURCES: readonly McpSource[] = ['app', 'user', 'local', 'project', 'registry']
export const MCP_SOURCE_WORDS: Record<McpSource, string> = {
  app: "The app's own server, in every chat",
  user: "Claude's user settings on this PC",
  local: "Claude's settings for a project folder on this PC",
  project: "A .mcp.json file in a chat's folder",
  registry: "This app's own MCP list on this PC",
}

export type McpTransport = 'stdio' | 'http' | 'sse' | 'other'

export interface McpInventoryChat { floor: string; agent: string; running: boolean }
export interface McpInventoryServer {
  name: string
  sources: McpSource[]
  transport: McpTransport
  /** Only a chat whose agent names it gets it (the app keeps it out of every other chat). */
  restricted: boolean
  /** Put in the app's list from this page, so this page may remove it. */
  addedHere: boolean
  /** The chats on this PC that get it when they start, as the app builds each chat's own file. */
  chats: McpInventoryChat[]
  chatsShown: number
  runningChats: number
}

/** A short list the app knows. Registered exactly as written here; the runner (uvx or npx) is never installed by the app. */
export interface McpCuratedDef {
  id: string
  name: string
  label: string
  about: string
  runner: 'uvx' | 'npx'
  /** The exact arguments after the runner, with the version pinned. */
  args: readonly string[]
  /** Said to the person: what it needs and where they set it. The app never stores a value. */
  needs: string
}
export const MCP_CURATED: readonly McpCuratedDef[] = [
  { id: 'windows-mcp', name: 'windows-mcp', label: 'Windows-MCP', about: "Lets an agent see and drive this PC's desktop. Only agents that name it get it.", runner: 'uvx',
    args: ['windows-mcp==0.8.8', 'serve', '--transport', 'stdio'], needs: 'Nothing to set. Needs uv (uvx) on this PC; it installs itself the first time a chat starts it.' },
  { id: 'chrome-devtools', name: 'chrome-devtools', label: 'Chrome DevTools', about: 'Lets an agent open and inspect pages in its own private Chrome.', runner: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.12.0', '--isolated', '--headless', '--no-auto-connect', '--no-usage-statistics'], needs: 'Nothing to set. Needs Node (npx) and Chrome on this PC; it installs itself the first time a chat starts it.' },
]

export interface McpCuratedState {
  id: string
  name: string
  label: string
  about: string
  runner: 'uvx' | 'npx'
  /** Whether the runner was found on this PC's PATH. */
  runnerFound: boolean
  /** A server of that name is already in this app's list. */
  registered: boolean
  addedHere: boolean
  needs: string
}

export interface McpInventory {
  version: 1
  pc: { id: string; name: string }
  builtAt: string
  /** What was read to build the list, so the answer to "is that all of them?" is exact. */
  read: {
    userConfig: 'read' | 'missing' | 'unreadable'
    registry: 'read' | 'missing' | 'unreadable'
    foldersChecked: number
    projectFilesRead: number
    localFolderEntries: number
    chatsCounted: number
    /** Chats with no home PC yet: not counted on any PC (their servers are decided when they first open). */
    chatsWithoutHome: number
  }
  servers: McpInventoryServer[]
  curated: McpCuratedState[]
  /** What this list cannot see, in words. */
  cannotSee: string[]
}

export interface McpInventoryPc { id: string; name: string; here: boolean; inventory: McpInventory | null; error: string | null }
export interface McpInventoryAnswer { version: 1; pcs: McpInventoryPc[] }

/** What an install would write on one PC: shown on the page, and the same fingerprint must come back to write it. */
export interface McpInstallPlan {
  version: 1
  pc: { id: string; name: string }
  id: string
  name: string
  command: string
  args: string[]
  runner: 'uvx' | 'npx'
  runnerFound: boolean
  /** Why nothing can be written now, or null. */
  refusal: string | null
  needs: string
  fingerprint: string
}
export interface McpInstallDone { version: 1; pc: { id: string; name: string }; id: string; name: string; changed: true; action: 'added' | 'removed' }

const only = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => contractRecord(v) && Object.keys(v).every(k => keys.includes(k))
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\0\r\n]/.test(v)
const pcOk = (v: unknown): v is { id: string; name: string } => only(v, ['id', 'name']) && text(v.id, 200) && v.id.length > 0 && text(v.name, 200) && v.name.trim().length > 0

function readServer(v: unknown): McpInventoryServer | null {
  if (!only(v, ['name', 'sources', 'transport', 'restricted', 'addedHere', 'chats', 'chatsShown', 'runningChats']) || typeof v.name !== 'string' || !MCP_NAME_RE.test(v.name)
    || !Array.isArray(v.sources) || !v.sources.length || !v.sources.every(s => MCP_SOURCES.includes(s as McpSource)) || new Set(v.sources).size !== v.sources.length
    || !['stdio', 'http', 'sse', 'other'].includes(String(v.transport)) || typeof v.restricted !== 'boolean' || typeof v.addedHere !== 'boolean'
    || !Array.isArray(v.chats) || v.chats.length > MCP_CHATS_LIMIT
    || !Number.isInteger(v.chatsShown) || !Number.isInteger(v.runningChats) || (v.runningChats as number) < 0 || (v.chatsShown as number) < v.chats.length) return null
  const chats: McpInventoryChat[] = []
  for (const c of v.chats) {
    if (!only(c, ['floor', 'agent', 'running']) || !text(c.floor, 200) || !text(c.agent, 200) || typeof c.running !== 'boolean') return null
    chats.push({ floor: c.floor, agent: c.agent, running: c.running })
  }
  return { name: v.name, sources: v.sources as McpSource[], transport: v.transport as McpTransport, restricted: v.restricted, addedHere: v.addedHere, chats, chatsShown: v.chatsShown as number, runningChats: v.runningChats as number }
}
function readCurated(v: unknown): McpCuratedState | null {
  if (!only(v, ['id', 'name', 'label', 'about', 'runner', 'runnerFound', 'registered', 'addedHere', 'needs']) || !MCP_CURATED.some(c => c.id === v.id)
    || !text(v.name, 64) || !text(v.label, 100) || !text(v.about, 400) || (v.runner !== 'uvx' && v.runner !== 'npx') || typeof v.runnerFound !== 'boolean'
    || typeof v.registered !== 'boolean' || typeof v.addedHere !== 'boolean' || !text(v.needs, 400)) return null
  return { id: v.id as string, name: v.name, label: v.label, about: v.about, runner: v.runner, runnerFound: v.runnerFound, registered: v.registered, addedHere: v.addedHere, needs: v.needs }
}
/** The strict reader: anything unknown or oversized makes the whole answer unreadable, never a quietly shorter list. */
export function readMcpInventory(value: unknown): McpInventory | null {
  if (!only(value, ['version', 'pc', 'builtAt', 'read', 'servers', 'curated', 'cannotSee']) || value.version !== 1 || !pcOk(value.pc) || !text(value.builtAt, 40) || !Number.isFinite(Date.parse(value.builtAt))
    || !only(value.read, ['userConfig', 'registry', 'foldersChecked', 'projectFilesRead', 'localFolderEntries', 'chatsCounted', 'chatsWithoutHome'])
    || !['read', 'missing', 'unreadable'].includes(String(value.read.userConfig)) || !['read', 'missing', 'unreadable'].includes(String(value.read.registry))
    || !['foldersChecked', 'projectFilesRead', 'localFolderEntries', 'chatsCounted', 'chatsWithoutHome'].every(k => Number.isInteger((value.read as Record<string, unknown>)[k]) && ((value.read as Record<string, unknown>)[k] as number) >= 0)
    || !Array.isArray(value.servers) || value.servers.length > MCP_INVENTORY_LIMIT || !Array.isArray(value.curated) || value.curated.length > MCP_CURATED.length
    || !Array.isArray(value.cannotSee) || value.cannotSee.length > 20 || !value.cannotSee.every(s => text(s, 400))) return null
  const servers = value.servers.map(readServer)
  const curated = value.curated.map(readCurated)
  if (servers.some(s => s === null) || curated.some(c => c === null) || new Set(servers.map(s => s!.name)).size !== servers.length) return null
  return { version: 1, pc: { id: value.pc.id, name: value.pc.name }, builtAt: value.builtAt, read: value.read as unknown as McpInventory['read'], servers: servers as McpInventoryServer[], curated: curated as McpCuratedState[], cannotSee: value.cannotSee as string[] }
}
/** The whole answer of GET /mcp-inventory: one entry per PC within reach, each with its list or the plain reason it has none. */
export function readMcpInventoryAnswer(value: unknown): McpInventoryAnswer | null {
  if (!only(value, ['version', 'pcs']) || value.version !== 1 || !Array.isArray(value.pcs) || value.pcs.length < 1 || value.pcs.length > 64) return null
  const pcs: McpInventoryPc[] = []
  for (const p of value.pcs) {
    if (!only(p, ['id', 'name', 'here', 'inventory', 'error']) || !text(p.id, 200) || !text(p.name, 200) || typeof p.here !== 'boolean' || (p.error !== null && !text(p.error, 600))) return null
    const inventory = p.inventory === null ? null : readMcpInventory(p.inventory)
    if ((p.inventory === null) === (p.error === null) || p.inventory !== null && !inventory || inventory && inventory.pc.id !== p.id) return null
    pcs.push({ id: p.id, name: p.name, here: p.here, inventory, error: p.error as string | null })
  }
  return new Set(pcs.map(p => p.id)).size === pcs.length ? { version: 1, pcs } : null
}
export function readMcpInstallPlan(value: unknown): McpInstallPlan | null {
  if (!only(value, ['version', 'pc', 'id', 'name', 'command', 'args', 'runner', 'runnerFound', 'refusal', 'needs', 'fingerprint']) || value.version !== 1 || !pcOk(value.pc)
    || !MCP_CURATED.some(c => c.id === value.id) || !text(value.name, 64) || !text(value.command, 4096) || !Array.isArray(value.args) || value.args.length > 32 || !value.args.every(a => text(a, 512))
    || (value.runner !== 'uvx' && value.runner !== 'npx') || typeof value.runnerFound !== 'boolean' || (value.refusal !== null && !text(value.refusal, 600)) || !text(value.needs, 400)
    || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)) return null
  return { version: 1, pc: { id: value.pc.id, name: value.pc.name }, id: value.id as string, name: value.name, command: value.command, args: value.args as string[], runner: value.runner, runnerFound: value.runnerFound, refusal: value.refusal as string | null, needs: value.needs, fingerprint: value.fingerprint }
}
export function readMcpInstallDone(value: unknown): McpInstallDone | null {
  if (!only(value, ['version', 'pc', 'id', 'name', 'changed', 'action']) || value.version !== 1 || !pcOk(value.pc) || !MCP_CURATED.some(c => c.id === value.id) || !text(value.name, 64)
    || value.changed !== true || (value.action !== 'added' && value.action !== 'removed')) return null
  return { version: 1, pc: { id: value.pc.id, name: value.pc.name }, id: value.id as string, name: value.name, changed: true, action: value.action }
}
