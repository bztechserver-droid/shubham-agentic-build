// Persistent-host child: owns a loopback-only gateway and its Claude Code child. Never receives ChatGPT credentials.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
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

export async function runBridgeChild(configFile: string, args: string[]): Promise<void> {
  const initial = readChildConfig(configFile)
  const { createHash } = await import('node:crypto')
  if (createHash('sha256').update(fs.readFileSync(initial.claude)).digest('hex') !== initial.claudeSha256) throw new Error('The pinned Claude Code executable changed')
  let paused = false
  const server = http.createServer((req, res) => {
    const fail = (status: number) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Codex in Claude Code is paused. Review the execution in the app; no fallback or automatic retry was used.' } })) }
    if (req.headers.origin !== undefined || req.method !== 'POST'
      || !['/v1/messages', '/v1/messages/count_tokens'].includes((req.url ?? '').split('?')[0])
      || !(equalKey(req.headers.authorization, `Bearer ${initial.loopbackKey}`) || equalKey(req.headers['x-api-key'], initial.loopbackKey))) return fail(403)
    if (paused) return fail(400)
    let size = 0; const chunks: Buffer[] = [], abort = new AbortController()
    req.on('data', data => { size += data.length; if (size > 16 * 1024 * 1024) { fail(413); req.destroy() } else chunks.push(data) })
    req.on('aborted', () => abort.abort())
    res.on('close', () => { if (!res.writableEnded) abort.abort() })
    req.on('end', () => { void (async () => {
      try {
        const config = readChildConfig(configFile)
        if (config.runId !== initial.runId || config.leaseId !== initial.leaseId || config.loopbackKey !== initial.loopbackKey
          || JSON.stringify(config.binding) !== JSON.stringify(initial.binding)) return fail(409)
        const response = await fetch(`http://127.0.0.1:${config.controllerPort}/bridge/${config.runId}${req.url!.split('?')[0]}`, {
          method: 'POST', signal: abort.signal, redirect: 'error', headers: { authorization: `Bearer ${config.controllerKey}`, 'content-type': 'application/json' }, body: Buffer.concat(chunks),
        })
        if (!response.ok || !response.body) { paused = true; await response.body?.cancel(); return fail(400) }
        res.writeHead(200, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
        for await (const data of response.body) {
          if (!res.write(data)) await new Promise<void>(resolve => res.once('drain', resolve))
        }
        res.end()
      } catch { paused = true; fail(400) }
    })() })
  })
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
    permissions: { defaultMode: 'bypassPermissions' } }) + '\n')
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
