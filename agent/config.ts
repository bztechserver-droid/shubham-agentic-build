import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Role, Route } from '../shared/agent-api.ts'
import { parseIPv4 } from './net.ts'

// The agent's state root, config.json and api-token (agent/SPEC.md › State, config and ports).
// Everything lives outside the repo, in %LOCALAPPDATA%\shubham-agentic, or SAD_HOME for tests.

export interface Ports {
  /** TCP, the hub's TLS listener. */
  peer: number
  /** TCP on 127.0.0.1: the local API the app talks to. */
  api: number
  /** UDP: LAN discovery. */
  discovery: number
  /** hbbs's main port P (it also takes P-1 and P+2). */
  hbbs: number
  /** hbbr's main port R (it also takes R+2). */
  hbbr: number
}

/** What config.json holds. */
export interface ConfigFile {
  role: Role
  name: string
  ports: Ports
  /** The hub's public address, handed to hbbs as `-r <publicHost>:<hbbr>`. */
  publicHost: string
  /** Pins this PC's LAN address ("192.168.1.118", or "192.168.1.118/24") when detection picks wrong. */
  lanAddress?: string
  /** How a member reaches its hub (shared/agent-api.ts › Route). */
  route: Route
  /** F-110: false = the Tailscale step dials only the hub's stored address, never its name (the way before 5 Nov 2026). Missing = true. */
  tailnetSearch?: boolean
  /** On mains power, stay out of a sleep that cuts the network, for Control (agent/screen/power.ts). Default true. */
  stayReachable: boolean
}

/** config.json with the SAD_*_PORT overrides applied. The overrides are never written back. */
export interface Config extends ConfigFile {
  /** RustDesk's direct-access port the hub pipes Mode 1 to: SAD_RUSTDESK_DIRECT_PORT or 21118. */
  rustdeskDirectPort: number
  paths: StatePaths
}

export interface StatePaths {
  root: string
  /** <root>/agent */
  agent: string
  configFile: string
  /** device.key, device.crt and uuid */
  identity: string
  apiToken: string
  devices: string
  logs: string
  /** hbbs/hbbr's working folder: hbbs.ini, keys, db and logs/. */
  rustdeskServer: string
  /**
   * Where hbbs.exe and hbbr.exe live: always %LOCALAPPDATA%\shubham-agentic\rustdesk-server,
   * even under SAD_HOME, because every new exe path is a new Windows Firewall prompt and rule.
   */
  rustdeskServerBin: string
  /**
   * Where ffmpeg.exe lives (F-006, npm run setup:screen): %LOCALAPPDATA%\shubham-agentic\ffmpeg,
   * also under SAD_HOME, so test agents share the one 100 MB copy.
   */
  ffmpegBin: string
  /** The app's own screen: this PC's control password, salted and hashed (agent/screen/password.ts). */
  screenPassword: string
  /** F-007: the CRM's session for the person signed in here (its 7-day cookie, never the password). */
  crmSession: string
  /** F-007: which CRM subscription the app put in CLAUDE_CODE_OAUTH_TOKEN (a hash and its last four characters, never the token). */
  claudeSubscription: string
  /** Claude subscription failover: the switch log, whether to switch by itself, and the caps the app has seen (no token, no cookie). */
  claudeSwitch: string
  /** F-008: other PCs' passwords this PC remembers for Control, as SHA256(password ‖ salt) (agent/saved-passwords.ts). */
  savedPasswords: string
  /** "Stay reachable": what each power plan's power button and lid did before the app changed them (agent/screen/power.ts). */
  powerButtons: string
}

export type ConfigPatch = Partial<Omit<ConfigFile, 'ports' | 'lanAddress'>> & {
  ports?: Partial<Ports>
  /** null removes the pin. */
  lanAddress?: string | null
}

type Env = Record<string, string | undefined>

export const DEFAULT_PORTS: Readonly<Ports> = { peer: 21220, api: 21221, discovery: 21222, hbbs: 21216, hbbr: 21217 }
export const DEFAULT_RUSTDESK_DIRECT_PORT = 21118
export const DEFAULT_PUBLIC_HOST = '61.246.245.66'
export const ROUTES: readonly Route[] = ['auto', 'tailscale', 'rustdesk', 'relay']

const PORT_ENV: Record<keyof Ports, string> = {
  peer: 'SAD_PEER_PORT',
  api: 'SAD_API_PORT',
  discovery: 'SAD_DISCOVERY_PORT',
  hbbs: 'SAD_HBBS_PORT',
  hbbr: 'SAD_HBBR_PORT',
}

const TOKEN = /^[0-9a-f]{64}$/

// %LOCALAPPDATA%\shubham-agentic, whatever SAD_HOME says. Off Windows (F-116, Ubuntu): $XDG_DATA_HOME/shubham-agentic,
// else ~/.local/share/shubham-agentic (start.sh works the folder out the same way).
export function defaultRoot(env: Env, platform: string = process.platform) {
  if (platform !== 'win32') return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'shubham-agentic')
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'shubham-agentic')
}

/** SAD_HOME, else %LOCALAPPDATA%\shubham-agentic (on Linux $XDG_DATA_HOME or ~/.local/share, then shubham-agentic). */
export function stateRoot(env: Env = process.env, platform: string = process.platform): string {
  return env.SAD_HOME ? path.resolve(env.SAD_HOME) : defaultRoot(env, platform)
}

export function statePaths(root: string = stateRoot(), env: Env = process.env): StatePaths {
  const agent = path.join(root, 'agent')
  return {
    root,
    agent,
    configFile: path.join(agent, 'config.json'),
    identity: path.join(agent, 'identity'),
    apiToken: path.join(agent, 'api-token'),
    devices: path.join(agent, 'devices.json'),
    logs: path.join(agent, 'logs'),
    rustdeskServer: path.join(root, 'rustdesk-server'),
    rustdeskServerBin: path.join(defaultRoot(env), 'rustdesk-server'),
    ffmpegBin: path.join(defaultRoot(env), 'ffmpeg'),
    screenPassword: path.join(agent, 'screen-password.json'),
    crmSession: path.join(agent, 'crm-session.json'),
    claudeSubscription: path.join(agent, 'claude-subscription.json'),
    claudeSwitch: path.join(agent, 'claude-switch.json'),
    savedPasswords: path.join(agent, 'saved-passwords.json'),
    powerButtons: path.join(agent, 'power-buttons.json'),
  }
}

export function defaultConfig(): ConfigFile {
  return { role: 'member', name: os.hostname(), ports: { ...DEFAULT_PORTS }, publicHost: DEFAULT_PUBLIC_HOST, route: 'auto', stayReachable: true }
}

function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isLanPin(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const [address, prefix] = v.split('/')
  return parseIPv4(address) !== null && (prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32))
}

// A missing key takes its default; a wrong one is an error, so a typo in a hand-edited file
// is not silently ignored.
function validate(raw: unknown, file: string): ConfigFile {
  const bad = (key: string, what: string) => new Error(`${file}: "${key}" must be ${what}. Fix it, or delete the file to start over.`)
  if (!isObject(raw)) throw new Error(`${file} must hold a JSON object. Fix it, or delete the file to start over.`)
  const out = defaultConfig()
  if (raw.role !== undefined) {
    if (raw.role !== 'hub' && raw.role !== 'member') throw bad('role', '"hub" or "member"')
    out.role = raw.role
  }
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || !raw.name.trim()) throw bad('name', 'a non-empty string')
    out.name = raw.name.trim()
  }
  if (raw.ports !== undefined) {
    if (!isObject(raw.ports)) throw bad('ports', 'an object')
    for (const key of Object.keys(DEFAULT_PORTS) as (keyof Ports)[]) {
      const v = raw.ports[key]
      if (v === undefined) continue
      if (!isPort(v)) throw bad(`ports.${key}`, 'a port number (1-65535)')
      out.ports[key] = v
    }
  }
  if (raw.publicHost !== undefined) {
    if (typeof raw.publicHost !== 'string' || !/^[A-Za-z0-9.-]+$/.test(raw.publicHost)) throw bad('publicHost', 'a host name or IPv4 address')
    out.publicHost = raw.publicHost
  }
  if (raw.lanAddress !== undefined && raw.lanAddress !== null) {
    if (!isLanPin(raw.lanAddress)) throw bad('lanAddress', 'an IPv4 address such as "192.168.1.118" (optionally "/24")')
    out.lanAddress = raw.lanAddress
  }
  if (raw.route !== undefined) {
    if (!ROUTES.includes(raw.route as Route)) throw bad('route', ROUTES.map(r => `"${r}"`).join(', '))
    out.route = raw.route as Route
  } else if (raw.forceRelay === true) {
    // Before "route" there was only a Force relay switch.
    out.route = 'relay'
  }
  if (raw.tailnetSearch !== undefined) {
    if (typeof raw.tailnetSearch !== 'boolean') throw bad('tailnetSearch', 'true or false')
    out.tailnetSearch = raw.tailnetSearch
  }
  if (raw.stayReachable !== undefined) {
    if (typeof raw.stayReachable !== 'boolean') throw bad('stayReachable', 'true or false')
    out.stayReachable = raw.stayReachable
  }
  return out
}

// Written whole to a temp name, then renamed, so a reader never sees half a file.
export function writeAtomic(file: string, text: string, mode?: number) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
  renameSync(tmp, file)
}

/** config.json as stored; created with the defaults when missing. */
export function readConfigFile(paths: StatePaths = statePaths()): ConfigFile {
  let text: string
  try {
    text = readFileSync(paths.configFile, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return writeConfigFile(paths, defaultConfig())
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`${paths.configFile} is not valid JSON. Fix it, or delete the file to start over.`)
  }
  return validate(raw, paths.configFile)
}

export function writeConfigFile(paths: StatePaths, config: ConfigFile): ConfigFile {
  const clean = validate(config, paths.configFile)
  writeAtomic(paths.configFile, JSON.stringify(clean, null, 2) + '\n')
  return clean
}

function envPort(env: Env, name: string, fallback: number) {
  const v = env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!isPort(n)) throw new Error(`${name} must be a port number (1-65535), not "${v}"`)
  return n
}

function withOverrides(file: ConfigFile, paths: StatePaths, env: Env): Config {
  const ports = { ...file.ports }
  for (const key of Object.keys(PORT_ENV) as (keyof Ports)[]) ports[key] = envPort(env, PORT_ENV[key], ports[key])
  return { ...file, ports, rustdeskDirectPort: envPort(env, 'SAD_RUSTDESK_DIRECT_PORT', DEFAULT_RUSTDESK_DIRECT_PORT), paths }
}

/** `--role hub`, `--role=member`; null when absent. Throws on any other value. */
export function roleFromArgs(argv: readonly string[]): Role | null {
  for (let i = 0; i < argv.length; i++) {
    let v: string | undefined
    if (argv[i] === '--role') v = argv[i + 1]
    else if (argv[i].startsWith('--role=')) v = argv[i].slice('--role='.length)
    else continue
    if (v === 'hub' || v === 'member') return v
    throw new Error(`--role must be "hub" or "member", not ${v === undefined ? 'nothing' : `"${v}"`}`)
  }
  return null
}

export interface LoadOptions {
  /** The state root; default SAD_HOME or %LOCALAPPDATA%\shubham-agentic. */
  root?: string
  env?: Env
  /** Command-line flags: a `--role` here is saved to config.json, so it sticks. */
  argv?: readonly string[]
}

/** Reads config.json (creating it), saves a `--role` flag, and applies the env overrides. */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env
  const paths = statePaths(opts.root ?? stateRoot(env), env)
  let file = readConfigFile(paths)
  const role = opts.argv ? roleFromArgs(opts.argv) : null
  if (role && role !== file.role) file = writeConfigFile(paths, { ...file, role })
  return withOverrides(file, paths, env)
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Changes config.json (re-read first, so the env overrides never land in it) and returns the new Config. */
export function updateConfig(patch: ConfigPatch, opts: Omit<LoadOptions, 'argv'> = {}): Config {
  const env = opts.env ?? process.env
  const paths = statePaths(opts.root ?? stateRoot(env), env)
  const current = readConfigFile(paths)
  const { lanAddress, ports, ...rest } = patch
  // `{ role: undefined }` means "leave it", not "back to the default".
  const next: ConfigFile = { ...current, ...defined(rest), ports: { ...current.ports, ...defined(ports ?? {}) } }
  if (lanAddress === null) delete next.lanAddress
  else if (lanAddress !== undefined) next.lanAddress = lanAddress
  return withOverrides(writeConfigFile(paths, next), paths, env)
}

/** The local API's token (64 hex characters), or null before the agent's first start. Vite's proxy reads it per request. */
export function readApiToken(root: string = stateRoot()): string | null {
  try {
    const token = readFileSync(statePaths(root).apiToken, 'utf8').trim()
    return TOKEN.test(token) ? token : null
  } catch {
    return null
  }
}

/** Reads the API token, or creates it (32 random bytes, hex). A malformed file is replaced. */
export function loadOrCreateApiToken(root: string = stateRoot()): string {
  const existing = readApiToken(root)
  if (existing) return existing
  const token = randomBytes(32).toString('hex')
  writeAtomic(statePaths(root).apiToken, token, 0o600)
  return token
}
