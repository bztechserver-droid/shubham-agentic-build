import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { writeAtomic } from '../config.ts'
import { renderToml, type TomlTable, type TomlValue } from './toml.ts'
import { keepRuntimeConfig } from './config-runtime.ts'

// F-134: the one Codex home of this PC (CODEX_HOME), and what is written into it. Everything here is plain file work; nothing talks to the CRM.
//
//   <dir>/home/config.toml        the same for every chat: the login lives in a file, no approvals, no sandbox ("No prompts, full access"), no update banner
//   <dir>/home/AGENTS.md          fixed text only; each chat's own brief goes in its profile below, so nothing is written into the project folder
//   <dir>/home/chat-<id>.config.toml
//                                 one chat's profile (codex -p chat-<id>): its brief as developer_instructions, its model and effort, its MCP servers.
//                                 A profile layers over config.toml (checked on Codex 0.163.0).
//   <dir>/home/auth.json          the person's Codex login, WRITTEN FROM THE CRM'S COPY before the first Codex chat starts and taken out after the last one ends
//                                 (and swept at the agent's start). Owner-only where the system has such a thing (mode 0600; on Windows the state folder's own
//                                 access list, which is the person's profile).
//   <dir>/home/sessions/…         Codex's own conversation files; kept.
//   <dir>/fetched.json            the sidecar: which subscription and revision the auth.json came from, and its hash as fetched. NO SECRET in it.
//
// A login file Codex has CHANGED (a refresh rotates the refresh token) is the only copy of the new login until it reaches the CRM, so it is never deleted
// before that (manager.ts decides; this file only reads and writes).

export interface CodexPaths {
  dir: string
  home: string
  auth: string
  config: string
  agents: string
  sidecar: string
}

export function codexPaths(dir: string): CodexPaths {
  const home = path.join(dir, 'home')
  return { dir, home, auth: path.join(home, 'auth.json'), config: path.join(home, 'config.toml'), agents: path.join(home, 'AGENTS.md'), sidecar: path.join(dir, 'fetched.json') }
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** The same for every chat. The keys were checked against Codex 0.163.0: approval_policy "never" + sandbox_mode "danger-full-access" is its "YOLO mode". */
export function baseConfigToml(): string {
  return `# Written by Shubham Agentic for the chats it starts with Codex. Changes here are put back at the next chat start.\n${renderToml({
    cli_auth_credentials_store: 'file',
    approval_policy: 'never',
    sandbox_mode: 'danger-full-access',
    check_for_update_on_startup: false,
  }, [{ path: ['windows'], body: { sandbox: 'unelevated' } }])}`
}

export const FIXED_AGENTS_MD = `# Shubham Agentic

You are one of several chats that run side by side in Shubham Agentic. What is specific to you (who you are, the floor you work on, the tools of the \`shubham-agentic\` MCP server) is in your developer instructions.\n`

/** Writes config.toml and AGENTS.md when they are not already exactly this. Returns true when it wrote anything. */
export function writeBase(p: CodexPaths): boolean {
  let wrote = false
  for (const [file, text] of [
    [p.config, baseConfigToml()],
    [p.agents, FIXED_AGENTS_MD],
  ] as const) {
    let current: string | null = null
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      // Not there yet.
    }
    const next = file === p.config ? keepRuntimeConfig(current ?? '', text) : text
    if (current !== next) {
      writeAtomic(file, next)
      wrote = true
    }
  }
  return wrote
}

/** A chat's profile name: `codex -p <this>`. Letters and digits of its id only, so it is always a safe file name and a safe argument. */
export function profileName(sessionId: string): string {
  const id = sessionId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 16)
  return `chat-${id || 'x'}`
}
const profileFile = (p: CodexPaths, name: string) => path.join(p.home, `${name}.config.toml`)

/** An MCP server as Codex's config.toml names it. A stdio server has command/args; a streamable HTTP server has a url. */
export interface McpServerToml {
  command?: string
  args?: string[]
  /** Values written into the profile (never for a secret that only the chat's own terminal has). */
  env?: Record<string, string>
  /** Names of variables taken from the chat's own environment (SAD_AGENTIC_KEY, SAD_AGENTIC_URL): how the shim learns whose chat it is without a file holding the key. */
  env_vars?: string[]
  url?: string
  startup_timeout_sec?: number
  tool_timeout_sec?: number
}

export interface ProfileSpec {
  sessionId: string
  /** Approved chat folder: seed trust before the first TUI starts. */
  cwd?: string
  /** The chat's brief (composeAgentBrief), written as developer_instructions behind a marker line naming the chat. */
  brief: string
  /** '' = Codex's own. */
  model?: string
  effort?: string
  mcp: Record<string, McpServerToml>
  /** F-138: the name of the environment variable that holds an OpenAI API key (CODEX_API_KEY). The interactive Codex ignores that variable and asks to sign in (checked on 0.163.0, 7 Nov 2026), so the
   *  profile names a model provider that reads its key from the variable: the key stays in the chat's environment, in no file. Not set for a ChatGPT login (that one is auth.json). */
  keyVar?: string
}

/** The model provider a Codex API key goes through: OpenAI's own API, with its key read from the environment. Not an id Codex reserves (openai, ollama, lmstudio). */
export const KEY_PROVIDER = 'sad-api-key'

/** The first line of a chat's developer instructions: how its conversation file is found among the others (the marker shows up in the file's first lines). */
export const chatMarker = (sessionId: string) => `[sad-chat ${sessionId}]`

export function profileToml(spec: ProfileSpec): string {
  const top: Record<string, TomlValue> = { developer_instructions: `${chatMarker(spec.sessionId)}\n\n${spec.brief}` }
  if (spec.model) top.model = spec.model
  if (spec.effort) top.model_reasoning_effort = spec.effort
  const tables: TomlTable[] = []
  if (spec.cwd) {
    const cwd = path.resolve(spec.cwd)
    const trusted = new Set([cwd])
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, '.git'))) { trusted.add(dir); break }
      if (path.dirname(dir) === dir) break
    }
    for (const dir of trusted) tables.push({ path: ['projects', process.platform === 'win32' ? dir.toLowerCase() : dir], body: { trust_level: 'trusted' } })
  }
  if (spec.keyVar) {
    top.model_provider = KEY_PROVIDER
    tables.push({ path: ['model_providers', KEY_PROVIDER], body: { name: 'OpenAI', base_url: 'https://api.openai.com/v1', env_key: spec.keyVar, wire_api: 'responses' } })
  }
  for (const [name, s] of Object.entries(spec.mcp)) {
    const body: Record<string, TomlValue> = {}
    if (s.command !== undefined) body.command = s.command
    if (s.args) body.args = s.args
    if (s.env && Object.keys(s.env).length) body.env = s.env
    if (s.env_vars?.length) body.env_vars = s.env_vars
    if (s.url !== undefined) body.url = s.url
    if (s.startup_timeout_sec !== undefined) body.startup_timeout_sec = s.startup_timeout_sec
    if (s.tool_timeout_sec !== undefined) body.tool_timeout_sec = s.tool_timeout_sec
    // Execution approvals and MCP approvals are independent in Codex 0.163.0.
    if (name === 'shubham-agentic') body.default_tools_approval_mode = 'approve'
    tables.push({ path: ['mcp_servers', name], body })
  }
  return renderToml(top, tables)
}

/** Writes (or rewrites) a chat's profile and returns its name. */
export function writeProfile(p: CodexPaths, spec: ProfileSpec): string {
  const name = profileName(spec.sessionId)
  const file = profileFile(p, name)
  let current = ''
  try { current = readFileSync(file, 'utf8') } catch { /* New profile. */ }
  const next = keepRuntimeConfig(current, profileToml(spec))
  if (current !== next) writeAtomic(file, next)
  return name
}

export function removeProfile(p: CodexPaths, sessionId: string): void {
  rmSync(profileFile(p, profileName(sessionId)), { force: true })
}

/** Profiles of chats that are no longer running (left by a crash). */
export function sweepProfiles(p: CodexPaths, keep: ReadonlySet<string>): number {
  let n = 0
  let names: string[] = []
  try {
    names = readdirSync(p.home)
  } catch {
    return 0
  }
  for (const f of names) {
    const m = /^(chat-[0-9a-zA-Z]+)\.config\.toml$/.exec(f)
    if (m && !keep.has(m[1])) {
      rmSync(path.join(p.home, f), { force: true })
      n++
    }
  }
  return n
}

// ── the login file and its sidecar ────────────────────────────────────────────────────────────

export interface Sidecar {
  subscriptionId: string
  /** The CRM person it was fetched for. */
  userId: string
  /** The revision the CRM had when the file was fetched (what a write-back is compared against). */
  baseRevision: number
  /** SHA-256 of the file exactly as fetched. A different hash on disk means Codex has rewritten it. */
  sha256: string
  fetchedAt: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function readSidecar(p: CodexPaths): Sidecar | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(p.sidecar, 'utf8'))
    if (!isObject(raw)) return null
    const { subscriptionId, userId, baseRevision, sha256: h, fetchedAt } = raw
    if (typeof subscriptionId !== 'string' || typeof userId !== 'string' || !Number.isInteger(baseRevision) || typeof h !== 'string' || typeof fetchedAt !== 'string') return null
    return { subscriptionId, userId, baseRevision: baseRevision as number, sha256: h, fetchedAt }
  } catch {
    return null
  }
}

export function writeSidecar(p: CodexPaths, s: Sidecar): void {
  writeAtomic(p.sidecar, `${JSON.stringify(s, null, 2)}\n`, 0o600)
}

/** Writes the login the CRM handed out, byte for byte, owner-only, with its sidecar. The text is not kept anywhere else. */
export function placeLogin(p: CodexPaths, authJson: string, from: { subscriptionId: string; userId: string; revision: number }, at = new Date()): Sidecar {
  mkdirSync(p.home, { recursive: true })
  const side: Sidecar = { subscriptionId: from.subscriptionId, userId: from.userId, baseRevision: from.revision, sha256: sha256(authJson), fetchedAt: at.toISOString() }
  // The sidecar first: a crash between the two leaves a hash that matches no file on disk, which reads as "changed", and a changed file is only ever put back where the
  // CRM can refuse it (it is not a refresh); the other order could leave a file nobody knows the origin of.
  writeSidecar(p, side)
  writeAtomic(p.auth, authJson, 0o600)
  return side
}

export interface LoginOnDisk {
  /** Its text, for the one caller that writes it back. Never log it. */
  text: string
  sha256: string
}

export function readLogin(p: CodexPaths): LoginOnDisk | null {
  try {
    const text = readFileSync(p.auth, 'utf8')
    return { text, sha256: sha256(text) }
  } catch {
    return null
  }
}

export const hasLogin = (p: CodexPaths) => existsSync(p.auth)

/** Takes the login file and its sidecar out. Callers have made sure nothing in it is waiting to reach the CRM. */
export function removeLogin(p: CodexPaths): void {
  rmSync(p.auth, { force: true })
  rmSync(p.sidecar, { force: true })
}
