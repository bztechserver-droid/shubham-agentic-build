// Persistent-host child: owns a loopback-only gateway and its Claude Code child. Never receives ChatGPT credentials.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { BRIDGE_MODEL, BRIDGE_EFFORT, requireExecutionSnapshot, contractRecord } from '../../shared/chat-execution.ts'
import { assertPrivatePath, writePrivateAtomic } from './storage.ts'

export interface BridgeChildConfig {
  version: 1; runId: string; ownerId: string; leaseId: string; binding: ReturnType<typeof requireExecutionSnapshot>;
  claude: string; claudeSha256: string; controllerPort: number; controllerKey: string; loopbackKey: string;
  settingsFile: string; readyFile: string; memorySettings?: string;
}
export function readChildConfig(file: string): BridgeChildConfig {
  assertPrivatePath(file)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!contractRecord(raw) || raw.version !== 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(String(raw.runId))
    || !/^[A-Za-z0-9_-]{16,128}$/.test(String(raw.leaseId)) || typeof raw.ownerId !== 'string'
    || !Number.isInteger(raw.controllerPort) || (raw.controllerPort as number) < 1 || (raw.controllerPort as number) > 65535
    || !/^[a-f0-9]{64}$/.test(String(raw.controllerKey)) || !/^[a-f0-9]{64}$/.test(String(raw.loopbackKey))
    || typeof raw.claude !== 'string' || !path.isAbsolute(raw.claude) || !/^[a-f0-9]{64}$/.test(String(raw.claudeSha256))
    || typeof raw.settingsFile !== 'string' || path.dirname(raw.settingsFile) !== path.dirname(file)
    || typeof raw.readyFile !== 'string' || path.dirname(raw.readyFile) !== path.dirname(file)) throw new Error('Invalid private child configuration')
  const binding = requireExecutionSnapshot(raw.binding)
  if (binding.execution.profile !== 'codex-in-claude-v1') throw new Error('Invalid child execution identity')
  return { ...raw, binding } as unknown as BridgeChildConfig
}
const equalKey = (value: unknown, expected: string) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(expected)
  && timingSafeEqual(Buffer.from(value), Buffer.from(expected))

/** The abort reason for a request Claude Code itself ended; only a failure that is exactly this cancellation (fetch rejects
 * with the abort reason, before the reply and while reading it) leaves the gateway open. */
const CLAUDE_CODE_ENDED = new Error('Claude Code ended this request')

/** The controller's verdict on a failed request, on every failure it answers: 'paused' = this run is paused (only a reopen
 * ends it); 'open' = the run is not paused (e.g. nothing was sent because the CRM login check went unanswered): this request
 * failed, the next one may go through. A failure without a verdict pauses, as before. */
export const RUN_VERDICT_HEADER = 'x-sad-bridge-run'
/** Sent with the first request after a cut, so the controller records it. */
export const CUT_HEADER = 'x-sad-bridge-cut'

const MESSAGES = {
  paused: 'Codex in Claude Code is paused. Review the execution in the app; no fallback or automatic retry was used.',
  cut: 'Codex in Claude Code: the app restarted while this reply was being written. That request is not sent again (its result is unknown). Send a new message to continue; nothing was retried.',
  restarting: 'Codex in Claude Code: the app is restarting, so nothing was sent. Send your message again in a moment; nothing was retried.',
}
/** The identity of a messages request for "never send a cut request again": its messages, without cache markers (Claude
 * Code's own retry without streaming sends the same messages; a message typed after it adds one). */
export function requestDigest(body: Buffer): string {
  let value: unknown = null
  try { value = JSON.parse(body.toString('utf8')) } catch { /* Not JSON: the bytes themselves. */ }
  const messages = value && typeof value === 'object' && Array.isArray((value as { messages?: unknown }).messages) ? (value as { messages: unknown[] }).messages : null
  return createHash('sha256').update(messages ? JSON.stringify(messages, (key, item) => key === 'cache_control' ? undefined : item) : body).digest('hex')
}

/** The loopback gateway Claude Code talks to. It forwards each request once to the controller and never retries.
 * - The controller says the run is paused (or fails without a verdict): paused for good, until the chat is reopened.
 * - The controller says the run stays open: that one request failed (its message is passed on); the next goes through.
 * - A request Claude Code ends itself (Esc, a stopped background task) when that end is what stopped it: nothing changes.
 * - The connection to the controller breaks (hub restart, Update) with the request in flight: its result is unknown. That
 *   exact request is never sent again (Claude Code's automatic "retry without streaming" is refused), the cut is recorded in
 *   this run's failure.json, and a request with new content goes through as soon as a controller answers.
 * - No controller listening at all: nothing reached it, nothing is recorded; the request fails and may be sent again.
 * 10 Nov 2026: a stopped background review paused Lead's chat; a hub restart left Connection paused (invisibly) until stop+open. */
export function bridgeGateway(initial: BridgeChildConfig, configFile: string): http.Server {
  let paused = false
  // Requests whose result is unknown (cut): never sent again, for this child's whole life. `cutAt`: a cut not yet followed by
  // a request a controller took.
  const cutDigests = new Set<string>()
  let cutAt: string | null = null
  // The gateway's own state beside the run's records (never the controller's failure.json, which may hold its own verdict).
  const record = (state: Record<string, unknown>) => {
    try { writePrivateAtomic(path.join(path.dirname(configFile), `${initial.runId}.gateway.json`), JSON.stringify({ version: 1, runId: initial.runId, ...state }) + '\n') }
    catch { /* The cut stays enforced here even when it cannot be recorded. */ }
  }
  return http.createServer((req, res) => {
    const reply = (status: number, message: string) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })) }
    const fail = (status: number) => reply(status, MESSAGES.paused)
    const route = (req.url ?? '').split('?')[0]
    if (req.headers.origin !== undefined || req.method !== 'POST'
      || !['/v1/messages', '/v1/messages/count_tokens'].includes(route)
      || !(equalKey(req.headers.authorization, `Bearer ${initial.loopbackKey}`) || equalKey(req.headers['x-api-key'], initial.loopbackKey))) return fail(403)
    if (paused) return fail(400)
    let size = 0; const chunks: Buffer[] = [], abort = new AbortController()
    const ended = () => abort.abort(CLAUDE_CODE_ENDED)
    req.on('data', data => { size += data.length; if (size > 16 * 1024 * 1024) { fail(413); req.destroy() } else chunks.push(data) })
    req.on('aborted', ended)
    res.on('close', () => { if (!res.writableEnded) ended() })
    req.on('end', () => { void (async () => {
      const body = Buffer.concat(chunks), messages = route === '/v1/messages', digest = messages ? requestDigest(body) : null
      // Never send the cut request again (count_tokens is answered locally by the controller and is never a model request).
      if (digest && cutDigests.has(digest)) return reply(400, MESSAGES.cut)
      let reached = false, config: BridgeChildConfig
      try { config = readChildConfig(configFile) } catch { paused = true; return fail(400) }
      if (config.runId !== initial.runId || config.leaseId !== initial.leaseId || config.loopbackKey !== initial.loopbackKey
        || JSON.stringify(config.binding) !== JSON.stringify(initial.binding)) return fail(409)
      try {
        const response = await fetch(`http://127.0.0.1:${config.controllerPort}/bridge/${config.runId}${route}`, {
          method: 'POST', signal: abort.signal, redirect: 'error', body,
          headers: { authorization: `Bearer ${config.controllerKey}`, 'content-type': 'application/json', ...(cutAt ? { [CUT_HEADER]: cutAt } : {}) },
        })
        reached = true
        if (!response.ok || !response.body) {
          if (response.headers.get(RUN_VERDICT_HEADER) === 'open') {
            const text = (await response.text()).slice(0, 64 * 1024)
            if (!res.headersSent) res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'x-should-retry': 'false' })
            return void res.end(text)
          }
          paused = true; await response.body?.cancel(); return fail(400)
        }
        // A controller took a request with new content: the chat goes on (the cut request itself was never sent again).
        if (messages && cutAt) { record({ state: 'open', at: new Date().toISOString(), recoveredFrom: cutAt }); cutAt = null }
        res.writeHead(200, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
        for await (const data of response.body) {
          if (!res.write(data)) await new Promise<void>(resolve => res.once('drain', resolve))
        }
        res.end()
      } catch (error) {
        if (error === CLAUDE_CODE_ENDED && abort.signal.reason === CLAUDE_CODE_ENDED) return fail(400)
        // Nobody listening: the request never reached a controller, so nothing can have been sent on.
        if (!reached && (error as { cause?: { code?: unknown } } | null)?.cause?.code === 'ECONNREFUSED') return reply(503, MESSAGES.restarting)
        if (!messages) return reply(503, MESSAGES.restarting)
        const at = new Date().toISOString()
        if (cutDigests.size >= 32) cutDigests.delete(cutDigests.values().next().value!)
        cutDigests.add(digest!); cutAt = at
        record({ state: 'cut', at, cause: 'controller-lost', outcome: 'unknown', recovery: 'new-message' })
        reply(400, MESSAGES.cut)
      }
    })() })
  })
}

export async function runBridgeChild(configFile: string, args: string[]): Promise<void> {
  const initial = readChildConfig(configFile)
  const { createHash } = await import('node:crypto')
  if (createHash('sha256').update(fs.readFileSync(initial.claude)).digest('hex') !== initial.claudeSha256) throw new Error('The pinned Claude Code executable changed')
  const server = bridgeGateway(initial, configFile)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The child loopback listener is unavailable')
  let memory: Record<string, unknown> = {}
  if (initial.memorySettings) { try { const value = JSON.parse(fs.readFileSync(initial.memorySettings, 'utf8')); if (contractRecord(value)) memory = value } catch { /* The optional native memory hooks are absent. */ } }
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_)/.test(key)) delete env[key]
  Object.assign(env, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_AUTH_TOKEN: initial.loopbackKey,
    ANTHROPIC_MODEL: BRIDGE_MODEL, ANTHROPIC_SMALL_FAST_MODEL: BRIDGE_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL: BRIDGE_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: BRIDGE_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: BRIDGE_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: BRIDGE_MODEL, CLAUDE_CODE_EFFORT_LEVEL: BRIDGE_EFFORT,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1', CLAUDE_CODE_DISABLE_MOUSE: '1',
    CLAUDE_CODE_MAX_RETRIES: '0', ANTHROPIC_MAX_RETRIES: '0' })
  writePrivateAtomic(initial.settingsFile, JSON.stringify({ ...memory, env: { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: initial.loopbackKey, ANTHROPIC_MODEL: BRIDGE_MODEL, ANTHROPIC_SMALL_FAST_MODEL: BRIDGE_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: BRIDGE_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: BRIDGE_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: BRIDGE_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: BRIDGE_MODEL, CLAUDE_CODE_EFFORT_LEVEL: BRIDGE_EFFORT },
    permissions: { defaultMode: 'default' } }) + '\n')
  const child = spawn(initial.claude, ['--settings', initial.settingsFile, ...args], { cwd: process.cwd(), env, windowsHide: true, stdio: 'inherit' })
  try {
    if (!child.pid) throw new Error('Claude Code did not start')
    writePrivateAtomic(initial.readyFile, JSON.stringify({ version: 1, runId: initial.runId, leaseId: initial.leaseId,
      proxyPid: process.pid, claudePid: child.pid, port: address.port, nonce: randomBytes(16).toString('hex') }) + '\n')
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; resolve() }) })
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    if (child.exitCode === null) child.kill()
    for (const file of [initial.settingsFile, initial.readyFile]) { try { fs.unlinkSync(file) } catch { /* Already removed. */ } }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBridgeChild(path.resolve(process.argv[2] ?? ''), process.argv.slice(3)).catch(() => { console.error('Codex in Claude Code could not start safely. Review its execution in the app.'); process.exitCode = 1 })
}
