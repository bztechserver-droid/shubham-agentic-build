import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatMessage } from '../../shared/agentic.ts'

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
  let text: string
  try {
    text = readFileSync(transcriptPath(cwd, sessionId, projectsDir), 'utf8')
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
