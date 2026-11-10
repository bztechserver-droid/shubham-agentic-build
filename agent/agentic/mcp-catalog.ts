import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Auth } from '../auth/index.ts'
import { apiError, type ApiMount } from '../api.ts'
import { contractRecord } from '../../shared/chat-execution.ts'
import { MCP_CATALOG_LIMIT, MCP_CATALOG_PREFIX, MCP_CONFIGURABLE_PROFILES, mcpCatalogError, mcpName, readMcpCatalog,
  type McpCatalog, type McpCatalogEntry } from '../../shared/mcp-catalog.ts'
import { requireCrmHuman } from './human-session.ts'

const MAX_BYTES = 1024 * 1024
const reserved = new Set(['shubham-agentic', 'constructor', 'prototype', '__proto__'])
const cleanString = (v: unknown, limit: number) => typeof v === 'string' && v.length <= limit && !v.includes('\0')
/** Match the currently wired stdio registry, not every transport a future CLI might understand. */
function supported(value: unknown): boolean {
  return contractRecord(value) && value.type === 'stdio' && cleanString(value.command, 4096) && !!(value.command as string).trim()
    && Array.isArray(value.args) && value.args.length <= 256 && value.args.every(arg => cleanString(arg, 8192))
    && (value.env === undefined || contractRecord(value.env) && Object.keys(value.env).length <= 128
      && Object.entries(value.env).every(([key, val]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && cleanString(val, 65536)))
}
/** Pure, redacted projection. Unknown/malformed documents are never converted to an apparently empty registry. */
export function projectMcpCatalog(raw: unknown, revision: string, pc: { id: string; name: string }): McpCatalog {
  if (!contractRecord(raw) || !contractRecord(raw.servers) || Object.keys(raw.servers).length > MCP_CATALOG_LIMIT) throw mcpCatalogError('mcp-catalog-invalid')
  const entries = Object.entries(raw.servers).map<McpCatalogEntry>(([name, definition]) => {
    if (!mcpName(name)) throw mcpCatalogError('mcp-catalog-invalid')
    const valid = !reserved.has(name) && supported(definition)
    return { name, transport: valid ? 'stdio' : 'unsupported', configuration: valid ? 'registered' : 'unsupported',
      configurableProfiles: valid ? MCP_CONFIGURABLE_PROFILES : [], installation: 'not-verified', connection: 'not-tested' }
  }).sort((a, b) => a.name.localeCompare(b.name))
  return readMcpCatalog({ version: 1, pc, revision, scope: 'app-on-this-pc', selection: 'per-agent', activation: 'next-managed-open',
    entries, actions: { register: false, install: false, test: false } })
}
/** Bounded read only. No mkdir, file repair, auth change, spawn, discovery request, package install or token copy. */
export function loadMcpCatalog(file: string, pc: { id: string; name: string }): McpCatalog {
  let fd: number | undefined
  try {
    let stat
    try { stat = lstatSync(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return projectMcpCatalog({ servers: {} }, createHash('sha256').update('').digest('hex'), pc)
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw mcpCatalogError('mcp-catalog-invalid')
    fd = openSync(file, 'r')
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw mcpCatalogError('mcp-catalog-invalid')
    const buffer = Buffer.alloc(Math.min(MAX_BYTES + 1, stat.size + 1))
    let bytes = 0, n: number
    while (bytes < buffer.length && (n = readSync(fd, buffer, bytes, buffer.length - bytes, bytes)) > 0) bytes += n
    const after = lstatSync(file), read = fstatSync(fd)
    if (bytes !== stat.size || after.isSymbolicLink() || after.ino !== stat.ino || after.dev !== stat.dev
      || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || read.size !== stat.size || read.mtimeMs !== stat.mtimeMs) throw mcpCatalogError('mcp-catalog-invalid')
    const data = buffer.subarray(0, bytes)
    return projectMcpCatalog(JSON.parse(data.toString('utf8')), createHash('sha256').update(data).digest('hex'), pc)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'mcp-catalog-invalid') throw mcpCatalogError(code)
    if (error instanceof SyntaxError) throw mcpCatalogError('mcp-catalog-invalid')
    throw mcpCatalogError('mcp-catalog-unavailable')
  } finally { if (fd !== undefined) closeSync(fd) }
}
/** New isolated HTTP slice. Startup/main wiring is intentionally a separately reviewed change. */
export function createMcpCatalogMount(options: { registryFile: string; pc: () => { id: string; name: string }; auth?: Auth }): ApiMount {
  return { prefix: MCP_CATALOG_PREFIX, scoped: true, async http(request) {
    // Reuse current CRM cookie ownership. Machine/page tokens, asserted caller and chat keys are not admin login proof.
    requireCrmHuman(options.auth, request, true)
    if (request.rest !== '/' && request.rest !== '') throw apiError(404, 'No such MCP management route')
    if (request.method !== 'GET') throw Object.assign(mcpCatalogError('mcp-action-unavailable'), { status: 405 })
    if (request.query.size) throw apiError(400, 'The MCP catalog takes no query parameters')
    return loadMcpCatalog(options.registryFile, options.pc())
  } }
}
