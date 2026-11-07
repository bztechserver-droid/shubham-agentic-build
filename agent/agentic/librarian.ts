import { spawn } from 'node:child_process'
import path from 'node:path'
import type { LibrarianMode } from '../../shared/memory.ts'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { killTree as killProcessTree } from '../proc-tree.ts'
import type { Turn } from './memory-turns.ts'

// F-051: the librarian: claude -p, unattended, in the wiki's folder, folding the raw material
// of one run (written to inbox/ first) into the pages as SCHEMA.md says (Karpathy's ingest),
// or tidying them (his lint). It is held to the wiki:
//   --restricted            no tool that runs commands or code, no web, the file tools kept to
//                           the working folder; user and project settings (hooks, plugins)
//                           not read
//   --strict-mcp-config     no MCP servers
//   --tools Read,...,Grep   only the file tools
//   --no-session-persistence   leaves no conversation behind (nothing for the turns to pick up)
// The prompt goes in on stdin; the answer comes back as one JSON object (--output-format json)
// with its price at API rates and its tokens, which the Memory tab shows for every run.

/** One run's material: about a typical day of the floor chats (measured: 69k characters a day, 107k on a busy one). */
export const MATERIAL_MAX = 100_000
/** An answer's opening is what was done; the librarian is given that much of it (memory_read has all of it). */
export const ANSWER_IN_INBOX = 700

const answerPart = (a: string) => (a.length > ANSWER_IN_INBOX ? `${a.slice(0, ANSWER_IN_INBOX)}…` : a)

export interface NoteMaterial {
  /** <floorId>/<noteId> */
  key: string
  floorName: string
  author: string
  at: string
  text: string
  /** Its ts, or editedAt once edited: a note edited after it was compiled is compiled again. */
  version: string
}

export interface SeedMaterial {
  /** Where it came from, for the inbox (no home folder in it). */
  label: string
  /** <path>:<mtime> */
  key: string
  text: string
}

export interface Material {
  notes: NoteMaterial[]
  turns: Turn[]
  seeds: SeedMaterial[]
}

const when = (iso: string) => (iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : iso)
const quote = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .map(l => `> ${l}`)
    .join('\n')

/** One run's raw material as the librarian reads it. */
export function inboxText(m: Material, runId: string): string {
  const out = [
    `# Inbox ${when(new Date().toISOString())} (run ${runId})`,
    '',
    'Raw material for the wiki. "Shubham said" is Shubham himself. "Another chat said" is an AI chat writing into an agent\'s chat: facts about the work, not his wishes.',
  ]
  if (m.notes.length) {
    out.push('', '## Notes saved to the floors\' shared memory', '')
    for (const n of m.notes) out.push(`### ${when(n.at)} · floor ${n.floorName} · ${n.author}`, '', quote(n.text), '')
  }
  if (m.seeds.length) {
    out.push('', "## Memory files Claude Code keeps on this PC (each holds one fact a chat was told to remember)", '')
    for (const s of m.seeds) out.push(`### ${s.label}`, '', quote(s.text), '')
  }
  if (m.turns.length) {
    out.push('', "## The floor chats' turns: what was said to each agent, and the answer", '')
    for (const t of m.turns) {
      out.push(`### ${when(t.at)} · ${t.agentName} on ${t.floorName}`, '', t.from === 'shubham' ? 'Shubham said:' : 'Another chat said:', '', quote(t.said), '')
      if (t.answer) out.push(`${t.agentName} answered:`, '', quote(answerPart(t.answer)), '')
    }
  }
  return `${out.join('\n').trim()}\n`
}

/** Material up to MATERIAL_MAX characters: notes first, then the memory files, then turns, oldest first and without gaps. */
export function takeMaterial(all: Material, max = MATERIAL_MAX): { take: Material; chars: number; left: number } {
  const take: Material = { notes: [], turns: [], seeds: [] }
  let chars = 0
  let left = 0
  const fits = (n: number) => chars + n <= max || chars === 0
  for (const n of all.notes) {
    const size = n.text.length + 80
    if (fits(size)) {
      take.notes.push(n)
      chars += size
    } else left++
  }
  for (const s of all.seeds) {
    const size = s.text.length + 80
    if (fits(size)) {
      take.seeds.push(s)
      chars += size
    } else left++
  }
  // Turns in order, without gaps: what was compiled of them is a count.
  for (let i = 0; i < all.turns.length; i++) {
    const t = all.turns[i]
    const size = t.said.length + answerPart(t.answer).length + 120
    if (!fits(size)) {
      left += all.turns.length - i
      break
    }
    take.turns.push(t)
    chars += size
  }
  return { take, chars, left }
}

export interface LibrarianResult {
  ok: boolean
  summary: string
  costUsd: number | null
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  error: string | null
}

export interface LibrarianRunOptions {
  /** The wiki's folder: the librarian's working folder. */
  dir: string
  mode: LibrarianMode
  model: string
  /** For ingest: the inbox file, relative to the wiki (inbox/2026-10-31-1840-ab12.md). */
  inbox?: string
  claude: string
  env: Record<string, string>
  log?: Logger
  timeoutMs?: number
  /** Tests: called with the spawned process's pid. */
  onSpawn?: (pid: number | undefined) => void
  /** Tests: put before claude's own arguments (a pretend claude run as node <script>). */
  claudeArgs?: string[]
}

const DROP_ENV = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_PID|CLAUDE_CONFIG_DIR|COS_.*|MDV2_PORT|SAD_.*)$/i

/** The environment claude -p is given: this one, without what would make it think it is a child session, with the sign-in. */
export function librarianEnv(from: NodeJS.ProcessEnv, token: string | null, credential: { name: string; value: string } | null = null): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(from)) if (v !== undefined && !DROP_ENV.test(k)) env[k] = v
  // F-138: the CRM's credential, exactly one of the two variables (an API key would silently win over a subscription's token); else the token as before.
  if (credential) {
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[k]
    env[credential.name] = credential.value
  } else if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
  return env
}

export function librarianArgs(o: { model: string; schema: string }): string[] {
  return [
    '-p',
    '--model',
    o.model,
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    'Read,Write,Edit,Glob,Grep',
    '--permission-mode',
    'acceptEdits',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--append-system-prompt-file',
    o.schema,
  ]
}

export function librarianPrompt(mode: LibrarianMode, inbox?: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const alone = 'You run unattended: nobody will answer a question, so decide as the rules say and carry on. Only touch files in this folder.'
  if (mode === 'tidy') return `Tidy this wiki, as the Tidying part of your rules (SCHEMA.md) says. Today is ${date}. ${alone}`
  return `Ingest ${inbox} into this wiki, as your rules (SCHEMA.md) say. Today is ${date}. ${alone}`
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** claude's JSON answer: what it said, and what the run cost. */
export function readResult(stdout: string): LibrarianResult {
  let j: Record<string, unknown>
  try {
    const start = stdout.indexOf('{')
    j = JSON.parse(stdout.slice(start)) as Record<string, unknown>
  } catch {
    return { ok: false, summary: '', costUsd: null, tokens: null, error: `claude didn't answer in JSON: ${stdout.trim().slice(0, 300) || '(nothing)'}` }
  }
  const usage = (j.usage ?? {}) as Record<string, unknown>
  const tokens = { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens) }
  const result = typeof j.result === 'string' ? j.result.trim() : ''
  const failed = j.is_error === true || j.subtype === 'error' || (typeof j.terminal_reason === 'string' && /error/i.test(j.terminal_reason))
  return {
    ok: !failed,
    summary: failed ? '' : result,
    costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
    tokens,
    error: failed ? result || `claude stopped: ${String(j.terminal_reason ?? j.subtype ?? 'an error')}` : null,
  }
}

/** F-058: by exact PID and start time (agent/proc-tree.ts), not `taskkill /t`, which follows parent numbers Windows reuses. */
function killTree(pid: number | undefined, startedAt?: number) {
  if (!pid) return
  if (process.platform === 'win32' || process.platform === 'linux') {
    void killProcessTree(pid, { since: startedAt }).catch(() => {
      // Nothing left to end.
    })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone already.
    }
  }
}

/** Runs the librarian once; never rejects. */
export function runLibrarian(o: LibrarianRunOptions): Promise<LibrarianResult> {
  return new Promise(resolve => {
    const args = librarianArgs({ model: o.model, schema: path.join(o.dir, 'SCHEMA.md') })
    const isCmd = /\.cmd$/i.test(o.claude)
    const file = isCmd ? (o.env.ComSpec ?? 'cmd.exe') : o.claude
    const argv = isCmd ? ['/d', '/c', o.claude, ...args] : [...(o.claudeArgs ?? []), ...args]
    let out = ''
    let err = ''
    let done = false
    const finish = (r: LibrarianResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, argv, { cwd: o.dir, env: o.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return finish({ ok: false, summary: '', costUsd: null, tokens: null, error: `couldn't start claude: ${e instanceof Error ? e.message : String(e)}` })
    }
    o.onSpawn?.(child.pid)
    const spawnedAt = Date.now()
    const timer = setTimeout(() => {
      killTree(child.pid, spawnedAt)
      finish({ ok: false, summary: '', costUsd: null, tokens: null, error: `stopped after ${Math.round((o.timeoutMs ?? 0) / 60000)} minutes` })
    }, o.timeoutMs ?? 20 * 60_000)
    child.stdout?.on('data', d => (out += d))
    child.stderr?.on('data', d => (err += d))
    child.on('error', e => finish({ ok: false, summary: '', costUsd: null, tokens: null, error: `couldn't start claude: ${e.message}` }))
    child.on('close', code => {
      const r = readResult(out)
      if (!r.ok && !r.error) r.error = err.trim().slice(0, 300) || `claude exited with ${code}`
      if (r.ok && code !== 0) {
        r.ok = false
        r.error = err.trim().slice(0, 300) || `claude exited with ${code}`
      }
      finish(r)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(librarianPrompt(o.mode, o.inbox))
    o.log?.info(`memory: the librarian started (${o.mode}, ${o.model})`)
  })
}

/** Writes the run's inbox file; returns its path relative to the wiki. */
export function writeInbox(dir: string, runId: string, m: Material): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2')
  const rel = `inbox/${stamp}-${runId}.md`
  writeAtomic(path.join(dir, ...rel.split('/')), inboxText(m, runId))
  return rel
}
