import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { OpenCodeClient } from './client.ts'
import { isolatedEnvironment, providerEnvironment } from './home.ts'
import type { ApiCredential } from './crm.ts'
import type { OpenCodeInstall } from './install.ts'
import { killTree } from '../proc-tree.ts'

export interface BackendOptions {
  install: OpenCodeInstall
  root: string
  cwd: string
  credential: ApiCredential
  model: string
  native: string | null
  brief: string
  toolsUrl: string
  chatKey: string
  shim: string
  mcp?: Record<string, { command: string[]; environment?: Record<string, string> }>
  event: (event: any) => void
  exited: () => void
  /** Synthetic protocol proof only; not accepted from settings or API requests. */
  mockBaseUrl?: string
  spawned?: (pid: number) => void
}
export interface Backend {
  pid?: number
  native: string
  model: string
  client: Pick<OpenCodeClient, 'request'>
  terminal: { executable: string; args: string[]; env: Record<string, string> }
  snapshot(): Promise<unknown>
  send(text: string): Promise<void>
  abort(): Promise<void>
  close(): Promise<void>
}
async function port(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const p = (server.address() as net.AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return p
}
/** One process, one isolated database, one provider credential, no credential files. */
export async function startBackend(o: BackendOptions): Promise<Backend> {
  const p = await port(), password = randomBytes(32).toString('hex')
  const env = isolatedEnvironment(o.root)
  env.OPENCODE_SERVER_PASSWORD = password
  env.SAD_AGENTIC_URL = o.toolsUrl; env.SAD_AGENTIC_KEY = o.chatKey
  const strip = { OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENCODE_SERVER_PASSWORD: '' }
  const mcp = Object.fromEntries(Object.entries(o.mcp ?? {}).map(([name, value]) => [name, { type: 'local', command: value.command, environment: { ...value.environment, ...strip } }]))
  mcp['shubham-agentic'] = { type: 'local', command: [process.execPath, o.shim], environment: strip }
  if (o.mockBaseUrl && new URL(o.mockBaseUrl).hostname !== '127.0.0.1') throw new Error('Synthetic provider must be loopback')
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    permission: 'allow', autoupdate: false, share: 'disabled', enabled_providers: [o.credential.provider],
    // Native TUI turns must receive the same agent brief as HTTP turns.
    default_agent: 'build', agent: { build: { prompt: o.brief } },
    ...(o.model ? { model: `${o.credential.provider}/${o.model}`, small_model: `${o.credential.provider}/${o.model}` } : {}),
    ...(o.mockBaseUrl ? { provider: { [o.credential.provider]: {
      options: { baseURL: o.mockBaseUrl },
      models: { [o.model]: { name: 'Synthetic mock', limit: { context: 32000, output: 4000 } } },
    } } } : {}),
    mcp,
  })
  const started = Date.now()
  const child: ChildProcess = spawn(o.install.executable, ['serve', '--hostname', '127.0.0.1', '--port', String(p)], { cwd: o.cwd, env: providerEnvironment(env, o.credential), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
  if (child.pid) o.spawned?.(child.pid)
  // No child output is logged: a provider's diagnostics may contain credentials.
  let dead = false, closed = false
  child.once('exit', () => { dead = true; if (!closed) o.exited() })
  child.once('error', () => { dead = true; if (!closed) o.exited() })
  const client = new OpenCodeClient(p, password, o.cwd), controller = new AbortController()
  const close = async () => {
    if (closed) return
    closed = true; controller.abort()
    if (child.pid && !dead) {
      const descendants = killTree(child.pid, { since: started }).catch(() => {})
      // End the exact child handle synchronously as well: an agent hard-exit
      // must not leave its HTTP backend alive while tree discovery is pending.
      child.kill()
      await descendants
    }
  }
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (dead) throw new Error('OpenCode backend exited before becoming ready.')
      try { const health = await client.request('/global/health', 'GET', undefined, 500); if (health.version !== o.install.version) throw new Error('version'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    if (!ready) throw new Error('OpenCode did not become ready.')
    const providers = await client.request('/provider')
    const model = o.model || providers.default?.[o.credential.provider]
    if (typeof model !== 'string' || !providers.all?.find((x: any) => x.id === o.credential.provider)?.models?.[model]) throw new Error('Choose a model supported by the installed OpenCode provider.')
    // Config is supplied through environment only. PATCH /config writes in the
    // project directory and must never be used to set app-managed defaults.
    const info = o.native ? await client.request(`/session/${o.native}`) : await client.request('/session', 'POST', { title: 'Agent conversation' })
    const native = info.id as string
    void client.events(controller.signal, o.event)
    return {
      pid: child.pid, native, model, client,
      // Attach needs only loopback auth. No provider key goes to the TUI.
      terminal: { executable: o.install.executable, args: ['attach', client.url, '--dir', o.cwd, '--session', native], env },
      snapshot: async () => ({ info: await client.request(`/session/${native}`), messages: await client.request(`/session/${native}/message`) }),
      async send(text) { await client.request(`/session/${native}/prompt_async`, 'POST', { model: { providerID: o.credential.provider, modelID: model }, system: o.brief, parts: [{ type: 'text', text }] }) },
      async abort() { await client.request(`/session/${native}/abort`, 'POST') },
      close,
    }
  } catch (error) { await close(); throw error }
}

/** No auth store is read. Interchange is a separate CLI process in the isolated chat home. */
export async function interchange(install: OpenCodeInstall, root: string, cwd: string, args: string[]): Promise<string> {
  const env = isolatedEnvironment(root)
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: 'allow', share: 'disabled', autoupdate: false, enabled_providers: [] })
  const child = spawn(install.executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const timeout = setTimeout(() => child.kill(), 30000)
  timeout.unref()
  let data = ''
  child.stdout.on('data', chunk => { data += chunk; if (data.length > 64 * 1024 * 1024) child.kill() })
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => clearTimeout(timeout))
  if (code !== 0 || data.length > 64 * 1024 * 1024) throw new Error('OpenCode interchange failed.')
  return data
}
export function readInterchange(file: string): unknown { return JSON.parse(readFileSync(file, 'utf8')) }
