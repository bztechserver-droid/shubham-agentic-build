import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'
import { MCP_CHATS_LIMIT, MCP_CURATED, MCP_INVENTORY_LIMIT, MCP_NAME_RE, type McpCuratedState, type McpInstallDone, type McpInstallPlan, type McpInventory,
  type McpInventoryChat, type McpInventoryServer, type McpSource, type McpTransport } from '../../shared/mcp-inventory.ts'
import { projectKey } from './claude-config.ts'
import { DEFAULT_RESTRICTED, type McpServerDef } from './mcp-registry.ts'

// What is on this PC, read the way the app itself builds each chat's MCP file (mcp-registry.ts: strictConfigFor): the user scope of
// ~/.claude.json, each folder's local scope, the folder's .mcp.json, this app's list (mcp-servers.json) for the agents that name its
// servers, and the app's own server. Names, kinds and chat names only: no value of any entry is kept or returned. Nothing is spawned.

const MAX_FILE = 64 * 1024 * 1024
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type Read = { state: 'read'; value: unknown } | { state: 'missing' } | { state: 'unreadable' }
/** A bounded read of one JSON file; never creates, repairs or follows anything. */
export function readJsonState(file: string): Read {
  let fd: number | undefined
  try {
    if (!existsSync(file)) return { state: 'missing' }
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_FILE) return { state: 'unreadable' }
    const buffer = Buffer.alloc(stat.size)
    let got = 0
    while (got < buffer.length) { const n = readSync(fd, buffer, got, buffer.length - got, got); if (n <= 0) break; got += n }
    return { state: 'read', value: JSON.parse(buffer.subarray(0, got).toString('utf8')) }
  } catch { return { state: 'unreadable' } } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* nothing to close */ } }
}

export const transportOf = (def: unknown): McpTransport => {
  if (!isObject(def)) return 'other'
  if (def.type === 'http' || def.type === 'sse') return def.type
  if (def.type === 'stdio' || def.type === undefined && typeof def.command === 'string') return 'stdio'
  return 'other'
}

/** The runner on this PC's PATH (uvx / npx), the way a shell would find it. */
export function findRunner(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean).map(e => e.toLowerCase()) : ['']
  for (const dir of dirs) for (const ext of exts) {
    const candidate = path.join(dir, name + ext)
    try { if (existsSync(candidate)) return candidate } catch { /* unreadable PATH entry */ }
  }
  return null
}

export interface InventoryChat { floor: string; agent: string; cwd: string; mcpServers: readonly string[]; running: boolean }
export interface InventoryDeps {
  pc: { id: string; name: string }
  claudeJson: string
  registryFile: string
  appServerNames: readonly string[]
  chats: readonly InventoryChat[]
  chatsWithoutHome: number
  runner: (name: 'uvx' | 'npx') => string | null
  now?: () => Date
}

interface Entry { sources: Set<McpSource>; transports: Set<McpTransport>; chats: Map<string, McpInventoryChat> }

export function buildMcpInventory(d: InventoryDeps): McpInventory {
  const user = readJsonState(d.claudeJson), reg = readJsonState(d.registryFile)
  const cfg = user.state === 'read' && isObject(user.value) ? user.value : null
  const regRaw = reg.state === 'read' && isObject(reg.value) ? reg.value : null
  const registry: Record<string, McpServerDef> = {}
  if (regRaw && isObject(regRaw.servers)) for (const [name, def] of Object.entries(regRaw.servers)) if (MCP_NAME_RE.test(name) && isObject(def)) registry[name] = def as unknown as McpServerDef
  const restricted = new Set<string>([...DEFAULT_RESTRICTED, ...Object.keys(registry)])
  if (regRaw && Array.isArray(regRaw.restricted)) for (const n of regRaw.restricted) if (typeof n === 'string' && MCP_NAME_RE.test(n)) restricted.add(n)
  const addedHere = new Set<string>(regRaw && Array.isArray(regRaw.addedHere) ? regRaw.addedHere.filter((n): n is string => typeof n === 'string' && MCP_NAME_RE.test(n)) : [])

  const entries = new Map<string, Entry>()
  const entry = (name: string): Entry => { let e = entries.get(name); if (!e) { e = { sources: new Set(), transports: new Set(), chats: new Map() }; entries.set(name, e) } return e }
  const note = (from: unknown, source: McpSource): Set<string> => {
    const names = new Set<string>()
    if (!isObject(from)) return names
    for (const [name, def] of Object.entries(from)) {
      if (!MCP_NAME_RE.test(name) || !isObject(def)) continue
      const e = entry(name); e.sources.add(source); e.transports.add(transportOf(def)); names.add(name)
    }
    return names
  }
  for (const name of d.appServerNames) if (MCP_NAME_RE.test(name)) { const e = entry(name); e.sources.add('app'); e.transports.add('stdio') }
  const userNames = note(cfg?.mcpServers, 'user')
  const projects = cfg && isObject(cfg.projects) ? cfg.projects : {}
  let localFolderEntries = 0
  const localByFolder = new Map<string, Set<string>>()
  for (const [folder, value] of Object.entries(projects)) {
    if (!isObject(value) || !isObject(value.mcpServers)) continue
    const names = note(value.mcpServers, 'local')
    localFolderEntries += names.size
    localByFolder.set(folder, names)
  }
  note(regRaw?.servers, 'registry')

  // The names each chat gets, built the way strictConfigFor builds its file; and the project files of the folders those chats run in.
  const folders = new Map<string, Set<string>>()
  let projectFilesRead = 0
  for (const c of d.chats) {
    if (!folders.has(c.cwd)) {
      let names = new Set<string>()
      const dot = readJsonState(path.join(c.cwd, '.mcp.json'))
      if (dot.state === 'read') projectFilesRead++
      if (dot.state === 'read' && isObject(dot.value)) names = note(dot.value.mcpServers, 'project')
      folders.set(c.cwd, names)
    }
  }
  let chatsCounted = 0
  for (const c of d.chats) {
    chatsCounted++
    const got = new Set<string>(d.appServerNames)
    for (const n of userNames) if (!restricted.has(n)) got.add(n)
    for (const n of localByFolder.get(projectKey(c.cwd)) ?? []) if (!restricted.has(n)) got.add(n)
    for (const n of folders.get(c.cwd) ?? []) if (!restricted.has(n)) got.add(n)
    for (const n of new Set(c.mcpServers)) if (Object.prototype.hasOwnProperty.call(registry, n)) got.add(n)
    for (const n of got) entry(n).chats.set(`${c.floor}\u0000${c.agent}`, { floor: c.floor, agent: c.agent, running: c.running })
  }

  const servers = [...entries.entries()].map<McpInventoryServer>(([name, e]) => {
    const chats = [...e.chats.values()].sort((a, b) => a.floor.localeCompare(b.floor) || a.agent.localeCompare(b.agent))
    const kinds = [...e.transports]
    return { name, sources: ([...e.sources] as McpSource[]).sort((a, b) => ['app', 'user', 'local', 'project', 'registry'].indexOf(a) - ['app', 'user', 'local', 'project', 'registry'].indexOf(b)),
      transport: kinds.length === 1 ? kinds[0] : kinds.includes('stdio') ? 'stdio' : 'other', restricted: restricted.has(name) && name !== 'shubham-agentic', addedHere: addedHere.has(name) && Object.prototype.hasOwnProperty.call(registry, name),
      chats: chats.slice(0, MCP_CHATS_LIMIT), chatsShown: chats.length, runningChats: chats.filter(c => c.running).length }
  }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MCP_INVENTORY_LIMIT)

  return {
    version: 1, pc: { id: d.pc.id, name: d.pc.name }, builtAt: (d.now ?? (() => new Date()))().toISOString(),
    read: { userConfig: user.state, registry: reg.state, foldersChecked: folders.size, projectFilesRead, localFolderEntries, chatsCounted, chatsWithoutHome: d.chatsWithoutHome },
    servers, curated: curatedStates(d, registry, addedHere),
    cannotSee: [
      'Whether a server is actually connected right now: the app reads what each chat was given, it does not open a connection to any server. A chat that is running was started with the servers listed for it.',
      "Servers Claude adds by itself from a plugin or from a claude.ai connector, and a .mcp.json above a chat's folder.",
      "A .mcp.json in a folder where no chat of this app runs (for example a folder you open Claude in by hand): project files are read only for the folders the app's chats run in.",
      'How many tools a server offers, and whether it can start: the app does not start any server to ask.',
      'Another PC that is off, not linked to the Server, or on an older build of the app: it is listed as unreachable, not left out silently.',
      "Servers set up inside another program (not Claude's settings and not this app's list).",
    ],
  }
}

function curatedStates(d: InventoryDeps, registry: Record<string, McpServerDef>, addedHere: ReadonlySet<string>): McpCuratedState[] {
  return MCP_CURATED.map(c => ({ id: c.id, name: c.name, label: c.label, about: c.about, runner: c.runner, runnerFound: d.runner(c.runner) !== null,
    registered: Object.prototype.hasOwnProperty.call(registry, c.name), addedHere: addedHere.has(c.name) && Object.prototype.hasOwnProperty.call(registry, c.name), needs: c.needs }))
}

// ---- register-only install, from the short list ---------------------------------------------------------------------------------

export interface InstallDeps { pc: { id: string; name: string }; registryFile: string; runner: (name: 'uvx' | 'npx') => string | null; platform?: NodeJS.Platform }
const refuse = (status: number, code: string, message: string) => Object.assign(apiError(status, message), { code })

/** The command that would be written on THIS PC for one curated entry. Writes nothing. */
export function planInstall(d: InstallDeps, id: string): McpInstallPlan {
  const c = MCP_CURATED.find(x => x.id === id)
  if (!c) throw refuse(404, 'mcp-not-curated', 'That MCP is not in the app\'s list of installable servers.')
  const found = d.runner(c.runner)
  const win = (d.platform ?? process.platform) === 'win32'
  const command = c.runner === 'npx' && win ? 'cmd' : (c.runner === 'uvx' && found ? found : c.runner)
  const args = c.runner === 'npx' && win ? ['/c', 'npx', ...c.args] : [...c.args]
  const reg = readJsonState(d.registryFile)
  const raw = reg.state === 'read' && isObject(reg.value) ? reg.value : null
  let refusal: string | null = null
  if (reg.state === 'unreadable' || reg.state === 'read' && !raw || raw && raw.servers !== undefined && !isObject(raw.servers)) refusal = "This PC's MCP list file could not be read as it is, so nothing is written to it."
  else if (raw && isObject(raw.servers) && Object.prototype.hasOwnProperty.call(raw.servers, c.name)) refusal = `${c.label} is already in this PC's MCP list.`
  else if (!found) refusal = c.runner === 'uvx' ? 'uv (uvx) was not found on this PC. The app does not install it: install uv first, then come back.' : 'Node (npx) was not found on this PC. The app does not install it: install Node first, then come back.'
  else if (raw && isObject(raw.servers) && Object.keys(raw.servers).length >= 128) refusal = "This PC's MCP list is full."
  const fingerprint = createHash('sha256').update(JSON.stringify([d.pc.id, c.id, command, args])).digest('hex')
  return { version: 1, pc: { id: d.pc.id, name: d.pc.name }, id: c.id, name: c.name, command, args, runner: c.runner, runnerFound: found !== null, refusal, needs: c.needs, fingerprint }
}

/** Writes ONE entry into this PC's mcp-servers.json, atomically, only if what the person confirmed is exactly what would be written now. */
export function registerCurated(d: InstallDeps, id: string, fingerprint: unknown): McpInstallDone {
  const plan = planInstall(d, id)
  if (plan.refusal) throw refuse(409, 'mcp-install-refused', plan.refusal)
  if (typeof fingerprint !== 'string' || fingerprint !== plan.fingerprint) throw refuse(409, 'mcp-install-changed', 'What would be written changed since you looked at it. Look again and confirm again. Nothing was written.')
  const reg = readJsonState(d.registryFile)
  const raw: Record<string, unknown> = reg.state === 'read' && isObject(reg.value) ? { ...reg.value } : {}
  const servers: Record<string, unknown> = isObject(raw.servers) ? { ...raw.servers } : {}
  servers[plan.name] = { type: 'stdio', command: plan.command, args: plan.args, note: 'Added from the MCP page' }
  const added = new Set<string>(Array.isArray(raw.addedHere) ? raw.addedHere.filter((n): n is string => typeof n === 'string') : [])
  added.add(plan.name)
  mkdirSync(path.dirname(d.registryFile), { recursive: true })
  writeAtomic(d.registryFile, `${JSON.stringify({ ...raw, servers, addedHere: [...added].sort() }, null, 2)}\n`)
  return { version: 1, pc: plan.pc, id: plan.id, name: plan.name, changed: true, action: 'added' }
}

/** Removes ONLY an entry this page added (named in the file's own addedHere list); nothing else in the file is touched. */
export function removeCurated(d: InstallDeps, id: string): McpInstallDone {
  const c = MCP_CURATED.find(x => x.id === id)
  if (!c) throw refuse(404, 'mcp-not-curated', 'That MCP is not in the app\'s list of installable servers.')
  const reg = readJsonState(d.registryFile)
  const raw = reg.state === 'read' && isObject(reg.value) ? reg.value : null
  if (!raw) throw refuse(409, 'mcp-remove-refused', "This PC's MCP list file could not be read as it is, so nothing was changed.")
  const added = Array.isArray(raw.addedHere) ? raw.addedHere.filter((n): n is string => typeof n === 'string') : []
  if (!added.includes(c.name) || !isObject(raw.servers) || !Object.prototype.hasOwnProperty.call(raw.servers, c.name)) throw refuse(409, 'mcp-remove-refused', `${c.label} was not added from this page, so this page does not remove it. Nothing was changed.`)
  const servers = { ...raw.servers }
  delete servers[c.name]
  writeAtomic(d.registryFile, `${JSON.stringify({ ...raw, servers, addedHere: added.filter(n => n !== c.name) }, null, 2)}\n`)
  return { version: 1, pc: { id: d.pc.id, name: d.pc.name }, id: c.id, name: c.name, changed: true, action: 'removed' }
}
