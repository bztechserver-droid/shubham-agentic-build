import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { open, readdir, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ChatMessage, ClaudeSession } from '../../shared/agentic.ts'

// F-018: a chat's conversation as claude itself writes it: <config>/projects/<cwd, every
// character but letters, digits and - made a ->/<sessionId>.jsonl. The agent's chats run on
// this Windows account's own Claude config (~/.claude; chats.ts never passes CLAUDE_CONFIG_DIR
// on), so that is where they are. Whether the file exists decides --resume or --session-id.

const MAX_MESSAGES = 400
const MAX_TEXT = 20_000

export const claudeProjectsDir = (home = os.homedir()) => path.join(home, '.claude', 'projects')

/** C:\Users\me\code -> C--Users-me-code, claude's folder name for a working directory. */
export const encodeProjectPath = (cwd: string) => cwd.replace(/[^a-zA-Z0-9-]/g, '-')

export function transcriptPath(cwd: string, sessionId: string, projectsDir = claudeProjectsDir()): string {
  return path.join(projectsDir, encodeProjectPath(cwd), `${sessionId}.jsonl`)
}

export function transcriptInfo(cwd: string, sessionId: string, projectsDir = claudeProjectsDir()): { exists: boolean; bytes: number; path: string } {
  const file = transcriptPath(cwd, sessionId, projectsDir)
  if (!existsSync(file)) return { exists: false, bytes: 0, path: file }
  return { exists: true, bytes: statSync(file).size, path: file }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The folder a conversation was held in, when its transcript is in some other project folder
 * than the one asked about (the floor's folder changed since): claude writes the cwd into its
 * lines, and the folder name alone can't be turned back into a path. Null when there is none.
 */
export function findTranscriptCwd(sessionId: string, projectsDir = claudeProjectsDir()): string | null {
  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir)
  } catch {
    return null
  }
  for (const d of dirs) {
    const file = path.join(projectsDir, d, `${sessionId}.jsonl`)
    if (!existsSync(file)) continue
    let head: string
    try {
      head = readFileSync(file, 'utf8').slice(0, 256 * 1024)
    } catch {
      continue
    }
    for (const line of head.split('\n')) {
      try {
        const row: unknown = JSON.parse(line)
        if (isObject(row) && typeof row.cwd === 'string' && row.cwd) return row.cwd
      } catch {
        // A partial line at the cut; the next file or line will do.
      }
    }
  }
  return null
}

/** The user and assistant turns, oldest first (the last MAX_MESSAGES); tool results and meta lines left out. */
export function readTranscript(cwd: string, sessionId: string, projectsDir = claudeProjectsDir()): ChatMessage[] {
  return readTranscriptFile(transcriptPath(cwd, sessionId, projectsDir))
}

/** readTranscript, for the file itself (F-021: wherever this PC keeps it). */
export function readTranscriptFile(file: string): ChatMessage[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: ChatMessage[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(row) || (row.type !== 'user' && row.type !== 'assistant') || row.isMeta === true) continue
    const msg = isObject(row.message) ? row.message : null
    if (!msg) continue
    const parts: string[] = []
    const tools: string[] = []
    if (typeof msg.content === 'string') parts.push(msg.content)
    else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (!isObject(p)) continue
        if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text)
        else if (p.type === 'tool_use' && typeof p.name === 'string') tools.push(p.name)
      }
    }
    const body = parts.join('\n\n').trim()
    if (!body && !tools.length) continue
    out.push({
      id: typeof row.uuid === 'string' ? row.uuid : String(out.length),
      role: row.type,
      text: body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}…` : body,
      timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
      tools,
    })
  }
  return out.slice(-MAX_MESSAGES)
}

// ---------------------------------------------------------------------------------------------
// Bringing in a conversation that isn't a floor's (Bring in a Claude chat): one held in a
// terminal, in Christopher, anywhere this account's claude wrote one. The agent gets a COPY
// under a new id: the original may still be open where it was, and two claudes writing one
// file fork it. The copy is the original's lines with its sessionId swapped, so claude
// resumes it as its own; the copy and the original go their own ways after.

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const HEAD_BYTES = 128 * 1024
const TAIL_BYTES = 256 * 1024
const TITLE_MAX = 140

/** The file of a conversation, in whichever project folder it is; null when there is none. */
export function findTranscript(sessionId: string, projectsDir = claudeProjectsDir()): string | null {
  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir)
  } catch {
    return null
  }
  for (const d of dirs) {
    const file = path.join(projectsDir, d, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

async function readSlice(file: string, start: number, length: number): Promise<string> {
  const h = await open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await h.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await h.close()
  }
}

/** The whole lines of a slice that parse (a cut leaves a partial one at either end). */
function rows(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    try {
      const row: unknown = JSON.parse(line)
      if (isObject(row)) out.push(row)
    } catch {
      // A partial line at a cut, or a blank one.
    }
  }
  return out
}

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

/** What the person typed first: the conversation's name when claude never titled it. */
function firstPrompt(head: Record<string, unknown>[]): string | null {
  for (const row of head) {
    if (row.type !== 'user' || row.isMeta === true || !isObject(row.message)) continue
    const c = row.message.content
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (isObject(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join(' ') : ''
    // Slash commands and reminders are claude's own wrapping, not the person's words.
    if (t.trim() && !t.trimStart().startsWith('<')) return oneLine(t)
  }
  return null
}

/** Its newest title: a rename (custom-title) beats claude's own (ai-title), which beats an old-style summary. */
function titleOf(lines: Record<string, unknown>[]): string | null {
  let custom: string | null = null
  let ai: string | null = null
  let summary: string | null = null
  for (const row of lines) {
    if (row.type === 'custom-title' && typeof row.customTitle === 'string' && row.customTitle.trim()) custom = row.customTitle
    else if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle.trim()) ai = row.aiTitle
    else if (row.type === 'summary' && typeof row.summary === 'string' && row.summary.trim()) summary = row.summary
  }
  const t = custom ?? ai ?? summary
  return t ? oneLine(t) : null
}

/** This account's Claude Code conversations, the most recently written first; the agent field is the caller's to fill. */
export async function listSessions(projectsDir = claudeProjectsDir(), limit = 60): Promise<Omit<ClaudeSession, 'agent'>[]> {
  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch {
    return []
  }
  const found: { file: string; sessionId: string; bytes: number; mtime: number }[] = []
  for (const d of dirs) {
    let names: string[]
    try {
      names = await readdir(path.join(projectsDir, d))
    } catch {
      continue
    }
    for (const n of names) {
      const m = SESSION_FILE_RE.exec(n)
      if (!m) continue
      const file = path.join(projectsDir, d, n)
      try {
        const st = await stat(file)
        if (st.isFile() && st.size > 0) found.push({ file, sessionId: m[1], bytes: st.size, mtime: st.mtimeMs })
      } catch {
        // Gone since the folder was read.
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return Promise.all(
    found.slice(0, limit).map(async f => {
      let head: Record<string, unknown>[] = []
      let tail: Record<string, unknown>[] = []
      try {
        head = rows(await readSlice(f.file, 0, HEAD_BYTES))
        tail = f.bytes > HEAD_BYTES ? rows(await readSlice(f.file, Math.max(HEAD_BYTES, f.bytes - TAIL_BYTES), TAIL_BYTES)) : []
      } catch {
        // Unreadable now: listed by its id alone.
      }
      const cwd = head.find(r => typeof r.cwd === 'string' && r.cwd)?.cwd as string | undefined
      return {
        sessionId: f.sessionId,
        cwd: cwd ?? null,
        title: titleOf([...head, ...tail]) ?? firstPrompt(head),
        bytes: f.bytes,
        updatedAt: new Date(f.mtime).toISOString(),
      }
    }),
  )
}

/**
 * A copy of a conversation under a new id, beside the original (same project folder, so it
 * resumes in the same place). Every line's "sessionId" becomes the new id; nothing else is
 * touched. A last line still being written (the original is open somewhere) is left out. The
 * copy appears whole or not at all.
 */
export async function copyTranscript(sessionId: string, newId: string, projectsDir = claudeProjectsDir()): Promise<{ file: string; bytes: number }> {
  const from = findTranscript(sessionId, projectsDir)
  if (!from) throw new Error(`There is no conversation ${sessionId} on this PC`)
  const to = path.join(path.dirname(from), `${newId}.jsonl`)
  if (existsSync(to)) throw new Error(`There is already a conversation ${newId}`)
  const tmp = `${to}.copying`
  const was = `"sessionId":"${sessionId}"`
  const now = `"sessionId":"${newId}"`
  let rest = ''
  const swap = new Transform({
    decodeStrings: false,
    transform(chunk: string, _enc, done) {
      const text = rest + chunk
      const cut = text.lastIndexOf('\n') + 1
      rest = text.slice(cut)
      done(null, text.slice(0, cut).replaceAll(was, now))
    },
    flush(done) {
      let whole = false
      try {
        JSON.parse(rest)
        whole = true
      } catch {
        // Half written: left out.
      }
      // Ended with its newline, so the line claude appends next starts on its own.
      done(null, whole ? `${rest.replaceAll(was, now)}\n` : '')
    },
  })
  try {
    await pipeline(createReadStream(from, { encoding: 'utf8' }), swap, createWriteStream(tmp))
    await rename(tmp, to)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
  return { file: to, bytes: statSync(to).size }
}
