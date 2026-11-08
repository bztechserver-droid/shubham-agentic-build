import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { BRIDGE_MODEL, BRIDGE_EFFORT, normalizeExecution } from '../../shared/chat-execution.ts'
import { killTree } from '../proc-tree.ts'
import { protectPath, assertPrivatePath, writePrivateAtomic } from './storage.ts'
import type { BridgeChildConfig } from './child.ts'

/** Real, isolated setup proof. Its marker is absent from both prompts; no app agent/profile is fabricated. */
export async function probeClaudeHarness(o: { directory: string; claude: string; claudeSha256: string; controllerPort: number;
  ownerId: string; consumerId: string; register(id: string, key: string): () => void; sawRead(): boolean }) {
  const directory = path.join(o.directory, `probe-${randomUUID()}`)
  if (path.dirname(directory) !== path.resolve(o.directory) || !path.basename(directory).startsWith('probe-')) throw new Error('Probe cleanup boundary changed')
  fs.mkdirSync(directory, { mode: 0o700 }); protectPath(directory)
  const home = path.join(directory, 'claude-home'); fs.mkdirSync(home, { mode: 0o700 }); protectPath(home)
  const runId = randomUUID(), sid = randomUUID(), key = randomBytes(32).toString('hex'), marker = `f159_${randomBytes(24).toString('hex')}`
  const markerFile = path.join(directory, 'marker.txt'), configFile = path.join(directory, 'child.json')
  writePrivateAtomic(markerFile, marker)
  const config: BridgeChildConfig = { version: 1, runId, ownerId: o.ownerId, leaseId: o.consumerId,
    binding: { agentId: `setup_${randomUUID()}`, sessionId: sid, codexThread: null, opencodeSession: null, homePc: 'setup_probe', executionRevision: 0,
      execution: normalizeExecution({ engine: 'claude', executionProfile: 'codex-in-claude-v1' }) },
    claude: o.claude, claudeSha256: o.claudeSha256, controllerPort: o.controllerPort, controllerKey: key, loopbackKey: randomBytes(32).toString('hex'),
    readyFile: path.join(directory, 'ready.json'), settingsFile: path.join(directory, 'settings.json') }
  writePrivateAtomic(configFile, JSON.stringify(config) + '\n')
  const unregister = o.register(runId, key)
  const active = new Map<number, number>()
  const run = (resume: boolean, prompt: string): Promise<string> => new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'child.ts'), configFile, '--print', '--output-format', 'json',
      resume ? '--resume' : '--session-id', sid, '--model', BRIDGE_MODEL, '--effort', BRIDGE_EFFORT, '--permission-mode', 'bypassPermissions',
      '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--', prompt], {
      cwd: directory, windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_MAX_RETRIES: '0', ANTHROPIC_MAX_RETRIES: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.pid) active.set(child.pid, started)
    let stdout = '', stderr = '', size = 0
    const timer = setTimeout(() => { reject(new Error('Claude Code setup proof timed out')); if (child.pid) void killTree(child.pid, { since: started }) }, 180_000)
    child.stdout.on('data', data => { size += data.length; if (size > 8 * 1024 * 1024) { reject(new Error('Claude Code setup output exceeded its bound')); if (child.pid) void killTree(child.pid, { since: started }) } else stdout += data })
    child.stderr.on('data', data => { if (stderr.length < 4096) stderr += data })
    child.once('error', () => { clearTimeout(timer); reject(new Error('Claude Code setup process could not start')) })
    child.once('close', code => {
      clearTimeout(timer); if (child.pid) active.delete(child.pid)
      if (code !== 0) {
        const detail = stdout + stderr
        const category = /effort.*max|max.*effort/i.test(detail) ? 'cli-effort-refused' : /unknown option|invalid.*option/i.test(detail) ? 'cli-option-refused' : 'cli-or-gateway-refused'
        writePrivateAtomic(path.join(o.directory, 'last-harness-failure.json'), JSON.stringify({ at: new Date().toISOString(), exitCode: code, category, resumed: resume }) + '\n')
        return reject(new Error('Claude Code setup process refused the gateway or model policy'))
      }
      try {
        const result = stdout.trim().split(/\r?\n/).map(line => { try { return JSON.parse(line) } catch { return null } }).find(row => row?.type === 'result')
        if (result?.is_error || typeof result?.result !== 'string') return reject(new Error('Claude Code setup result was not confirmed'))
        resolve(result.result)
      } catch { reject(new Error('Claude Code setup result was unreadable')) }
    })
  })
  try {
    const first = await run(false, `Use the Read tool to read this local file: ${markerFile}. Reply with only its exact contents.`)
    if (!first.includes(marker) || !o.sawRead()) throw new Error('The adapter did not prove an actual Read tool round trip')
    const resumed = await run(true, 'What were the exact contents of the file you read in the previous turn? Reply with only those contents; do not read any file again.')
    if (!resumed.includes(marker)) throw new Error('Claude JSONL resume did not retain the previous Read result')
    return { version: 1, readVerified: true, resumeVerified: true, model: BRIDGE_MODEL, effort: BRIDGE_EFFORT, verifiedAt: new Date().toISOString() }
  } finally {
    for (const [pid, since] of active) await killTree(pid, { since })
    unregister()
    // Only the exact generated probe directory can be removed; never a native config or auth directory.
    assertPrivatePath(directory); fs.rmSync(directory, { recursive: true, force: true })
  }
}
