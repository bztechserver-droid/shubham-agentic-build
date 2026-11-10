import { contractRecord, type ExecutionProfile } from './chat-execution.ts'

export const MCP_CATALOG_VERSION = 1 as const
export const MCP_CATALOG_PREFIX = '/mcps' as const
export const MCP_CATALOG_LIMIT = 128
export const MCP_CONFIGURABLE_PROFILES = ['claude-native-v1', 'codex-native-v1', 'codex-in-claude-v1'] as const satisfies readonly ExecutionProfile[]
export type McpConfigurableProfile = typeof MCP_CONFIGURABLE_PROFILES[number]
export const mcpName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v)
const only = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => contractRecord(v) && Object.keys(v).every(k => keys.includes(k))
export interface McpCatalogEntry {
  readonly name: string
  readonly transport: 'stdio' | 'unsupported'
  readonly configuration: 'registered' | 'unsupported'
  /** Serializer support only: NOT installation, authorization, tool discovery or live runtime proof. */
  readonly configurableProfiles: readonly McpConfigurableProfile[]
  readonly installation: 'not-verified'
  readonly connection: 'not-tested'
}
/** Public response is deliberately incapable of carrying commands, arguments, environment or file paths. */
export interface McpCatalog {
  readonly version: 1
  readonly pc: { readonly id: string; readonly name: string }
  readonly revision: string
  readonly scope: 'app-on-this-pc'
  readonly selection: 'per-agent'
  readonly activation: 'next-managed-open'
  readonly entries: readonly McpCatalogEntry[]
  readonly actions: { readonly register: false; readonly install: false; readonly test: false }
}
export function mcpCatalogError(code: 'mcp-catalog-invalid' | 'mcp-catalog-unavailable' | 'mcp-action-unavailable') {
  const message = code === 'mcp-catalog-invalid' ? 'The MCP catalog is unsupported or changed while being read. Nothing was installed or changed.'
    : code === 'mcp-action-unavailable' ? 'This MCP management action is not available in this version. Nothing was installed or changed.'
      : 'The MCP catalog is unavailable. Nothing was installed or changed.'
  return Object.assign(new Error(message), { status: code === 'mcp-catalog-unavailable' ? 503 : 409, code })
}
const invalid = (): never => { throw mcpCatalogError('mcp-catalog-invalid') }
export function readMcpCatalog(value: unknown): McpCatalog {
  if (!only(value, ['version', 'pc', 'revision', 'scope', 'selection', 'activation', 'entries', 'actions']) || value.version !== MCP_CATALOG_VERSION
    || !only(value.pc, ['id', 'name']) || !mcpName(value.pc.id) || typeof value.pc.name !== 'string' || !value.pc.name.trim()
    || value.pc.name.length > 200 || /[\r\n\0]/.test(value.pc.name)
    || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || value.scope !== 'app-on-this-pc' || value.selection !== 'per-agent' || value.activation !== 'next-managed-open'
    || !only(value.actions, ['register', 'install', 'test']) || value.actions.register !== false || value.actions.install !== false || value.actions.test !== false
    || !Array.isArray(value.entries) || value.entries.length > MCP_CATALOG_LIMIT) return invalid()
  const names = new Set<string>()
  const entries: McpCatalogEntry[] = value.entries.map(entry => {
    if (!only(entry, ['name', 'transport', 'configuration', 'configurableProfiles', 'installation', 'connection']) || !mcpName(entry.name)
      || names.has(entry.name) || entry.configuration !== 'registered' && entry.configuration !== 'unsupported'
      || entry.transport !== (entry.configuration === 'registered' ? 'stdio' : 'unsupported')
      || entry.installation !== 'not-verified' || entry.connection !== 'not-tested' || !Array.isArray(entry.configurableProfiles)) return invalid()
    const expected = entry.configuration === 'registered' ? MCP_CONFIGURABLE_PROFILES : []
    if (JSON.stringify(entry.configurableProfiles) !== JSON.stringify(expected)) return invalid()
    names.add(entry.name)
    return Object.freeze({ name: entry.name, transport: entry.configuration === 'registered' ? 'stdio' : 'unsupported', configuration: entry.configuration,
      configurableProfiles: Object.freeze([...expected]), installation: 'not-verified', connection: 'not-tested' })
  })
  return Object.freeze({ version: MCP_CATALOG_VERSION, pc: Object.freeze({ id: value.pc.id, name: value.pc.name }), revision: value.revision,
    scope: 'app-on-this-pc', selection: 'per-agent', activation: 'next-managed-open', entries: Object.freeze(entries),
    actions: Object.freeze({ register: false, install: false, test: false }) })
}
