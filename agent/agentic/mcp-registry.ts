import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeAtomic } from '../config.ts'
import { projectKey } from './claude-config.ts'

// Per-agent MCP servers. Every chat gets the app's own tools (shubham-agentic, mcp.json). Other MCP
// servers (Windows-MCP, which drives the whole PC) are kept in a registry, mcp-servers.json, and a
// chat gets ONLY the ones named in its own agent's mcpServers: a chat whose agent names none is started
// exactly as before, with the shared mcp.json. The registry is read each time a chat starts, so
// adding a server is a file change, never a restart; naming one that is not in it gives nothing.
//
// F-078 scope fix: claude also loads the servers of the user's own config (~/.claude.json, user scope),
// so a windows-mcp added there ran in EVERY chat (about 0.7 GB each) and every agent could drive the
// desktop. Chats are now started with --strict-mcp-config and a file of their own (strictConfigFor):
// the app's server, the servers claude would have found anyway (user scope, this folder's local scope,
// this folder's .mcp.json) EXCEPT the restricted names, and the registry servers the agent names.
// SAD_MCP_STRICT=0 (or `strictMcp: false`) brings the old way back.

export interface McpServerDef {
  type: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  /** What it is, for the person reading the file. */
  note?: string
}

export type McpRegistry = Record<string, McpServerDef>

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** Servers that only an agent that names them may have, even when the user's own config carries them. */
export const DEFAULT_RESTRICTED: readonly string[] = ['windows-mcp']

const isDef = (v: unknown): v is McpServerDef => {
  if (!v || typeof v !== 'object') return false
  const d = v as Partial<McpServerDef>
  return d.type === 'stdio' && typeof d.command === 'string' && d.command.length > 0 && Array.isArray(d.args) && d.args.every(a => typeof a === 'string')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const readJson = (file: string): unknown => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  } catch {
    return null
  }
}

/** The registry in `file`: only entries that are well formed, under names that are safe in a file name. */
export function readRegistry(file: string): McpRegistry {
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { servers?: unknown }
    const out: McpRegistry = {}
    if (raw.servers && typeof raw.servers === 'object') {
      for (const [name, def] of Object.entries(raw.servers)) if (NAME.test(name) && isDef(def)) out[name] = def
    }
    return out
  } catch {
    return {}
  }
}

/**
 * The names kept from every chat that does not name them: DEFAULT_RESTRICTED, every server in the registry (it is
 * there so that only named agents get it), and the file's own `"restricted": ["name", …]` list.
 */
export function restrictedNames(file: string, registry: McpRegistry = readRegistry(file)): Set<string> {
  const out = new Set<string>([...DEFAULT_RESTRICTED, ...Object.keys(registry)])
  const raw = readJson(file)
  if (isObject(raw) && Array.isArray(raw.restricted)) for (const n of raw.restricted) if (typeof n === 'string' && NAME.test(n)) out.add(n)
  return out
}

/** The names of the registry's servers that `wanted` (an agent's mcpServers) asks for, in its order, each once. */
export function chosen(registry: McpRegistry, wanted: readonly string[]): string[] {
  return [...new Set(wanted)].filter(n => Object.prototype.hasOwnProperty.call(registry, n))
}

const registryEntry = (d: McpServerDef) => ({ type: 'stdio', command: d.command, args: d.args, ...(d.env ? { env: d.env } : {}) })

/**
 * The --mcp-config file for one chat. Without registry servers to add it is `shared` (the file every
 * chat has had all along); with them, a file of its own: the app's tools and those servers.
 */
export function mcpConfigFor(dir: string, sessionId: string, base: Record<string, unknown>, registry: McpRegistry, wanted: readonly string[], shared: string): string {
  const names = chosen(registry, wanted)
  if (names.length === 0) return shared
  const servers: Record<string, unknown> = { ...base }
  for (const n of names) servers[n] = registryEntry(registry[n])
  const file = path.join(dir, 'mcp', `${sessionId}.json`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
  return file
}

/**
 * The servers claude would start for a chat in `cwd` on its own, apart from the plugin and account ones it adds itself: the user
 * scope of `claudeJson`, that folder's local scope (projects[folder].mcpServers) and the folder's .mcp.json, without the
 * `restricted` names. Later scopes win by name. Entries are passed on exactly as they are (no value is read or logged).
 */
export function inheritedServers(claudeJson: string, cwd: string, restricted: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const take = (from: unknown) => {
    if (!isObject(from)) return
    for (const [name, def] of Object.entries(from)) if (NAME.test(name) && !restricted.has(name) && isObject(def)) out[name] = def
  }
  const cfg = readJson(claudeJson)
  if (isObject(cfg)) {
    take(cfg.mcpServers)
    const project = isObject(cfg.projects) ? cfg.projects[projectKey(cwd)] : null
    if (isObject(project)) take(project.mcpServers)
  }
  const dotMcp = readJson(path.join(cwd, '.mcp.json'))
  if (isObject(dotMcp)) take(dotMcp.mcpServers)
  return out
}

/**
 * The file for a chat started with --strict-mcp-config: always its own (never the shared one). The app's server comes last
 * so nothing can shadow it; the agent's registry servers come after the inherited ones. Written atomically, readable by this
 * account only. Returns the file and the server names in it (names only: never the values).
 */
export function strictConfigFor(
  dir: string,
  sessionId: string,
  base: Record<string, unknown>,
  registryFile: string,
  claudeJson: string,
  cwd: string,
  wanted: readonly string[],
): { file: string; names: string[] } {
  const registry = readRegistry(registryFile)
  const servers: Record<string, unknown> = { ...inheritedServers(claudeJson, cwd, restrictedNames(registryFile, registry)) }
  for (const n of chosen(registry, wanted)) servers[n] = registryEntry(registry[n])
  Object.assign(servers, base)
  const file = path.join(dir, 'mcp', `${sessionId}.json`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 0o600)
  return { file, names: Object.keys(servers) }
}
