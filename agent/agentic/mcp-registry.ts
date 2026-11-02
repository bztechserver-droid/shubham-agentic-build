import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeAtomic } from '../config.ts'

// Per-agent MCP servers. Every chat gets the app's own tools (shubham-agentic, mcp.json). Other MCP
// servers (Windows-MCP, which drives the whole PC) are kept in a registry, mcp-servers.json, and a
// chat gets ONLY the ones named in its own agent's mcpServers: a chat whose agent names none is started
// exactly as before, with the shared mcp.json. The registry is read each time a chat starts, so
// adding a server is a file change, never a restart; naming one that is not in it gives nothing.

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

const isDef = (v: unknown): v is McpServerDef => {
  if (!v || typeof v !== 'object') return false
  const d = v as Partial<McpServerDef>
  return d.type === 'stdio' && typeof d.command === 'string' && d.command.length > 0 && Array.isArray(d.args) && d.args.every(a => typeof a === 'string')
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

/** The names of the registry's servers that `wanted` (an agent's mcpServers) asks for, in its order, each once. */
export function chosen(registry: McpRegistry, wanted: readonly string[]): string[] {
  return [...new Set(wanted)].filter(n => Object.prototype.hasOwnProperty.call(registry, n))
}

/**
 * The --mcp-config file for one chat. Without registry servers to add it is `shared` (the file every
 * chat has had all along); with them, a file of its own: the app's tools and those servers.
 */
export function mcpConfigFor(dir: string, sessionId: string, base: Record<string, unknown>, registry: McpRegistry, wanted: readonly string[], shared: string): string {
  const names = chosen(registry, wanted)
  if (names.length === 0) return shared
  const servers: Record<string, unknown> = { ...base }
  for (const n of names) {
    const d = registry[n]
    servers[n] = { type: 'stdio', command: d.command, args: d.args, ...(d.env ? { env: d.env } : {}) }
  }
  const file = path.join(dir, 'mcp', `${sessionId}.json`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeAtomic(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
  return file
}
