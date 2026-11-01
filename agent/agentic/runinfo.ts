import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DefaultModel } from '../../shared/agentic.ts'

// F-062: what a chat really runs on, read from its conversation file (the JSONL claude writes):
//   - the model: every answer row records it (message.model, "claude-sonnet-5-5"); the newest
//     one that is not claude's own placeholder ("<synthetic>") is what it runs on now
//   - the effort: a /effort in the chat leaves a local-command row, "Set effort level to max (...)";
//     the newest one is what it was set to
//   - ultracode (F-067): `/effort ultracode` leaves "Ultracode on ...", `/effort ultracode off` "Ultracode off ...";
//     a `/effort <level>` turns it off too. The newest of these three says whether it is on
// Only the end of the file is read (a conversation can be hundreds of MB), and what was read is
// kept until the file grows.

/** How much of the end of a conversation is looked at. */
const TAIL_BYTES = 2 * 1024 * 1024
const EFFORT_RE = /Set effort level to (low|medium|high|xhigh|max)\b/i
const ULTRA_RE = /\bUltracode (on|off)\b/i

export interface FileRun {
  model: string | null
  effort: string | null
  effortAt: string | null
  /** F-067: whether ultracode is on, as its newest command said; null when none did. */
  ultracode: boolean | null
  ultracodeAt: string | null
  /** When the file last changed (ms), to tell which conversation is the newest. */
  mtimeMs: number
}

const cache = new Map<string, { size: number; mtimeMs: number; value: FileRun }>()

/** An effort set long ago, in a long conversation, is looked for this far back, once. */
const FAR_BYTES = 16 * 1024 * 1024

/** Reads bytes [from, to) of a file as text. */
function readRange(file: string, from: number, to: number): string {
  const len = to - from
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, from)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The text of a range with the row it starts in the middle of dropped (when it does not start the file). */
const wholeRows = (text: string, from: number) => (from > 0 ? text.slice(text.indexOf('\n') + 1) : text)

/**
 * What the end of one conversation file says; null when it can't be read. What was found is kept:
 * when the file grows only the new bytes are read, and what they don't say stays as it was. A first
 * look that finds no /effort in the end of a long file looks further back, once.
 */
export function readFileRun(file: string): FileRun | null {
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  const hit = cache.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value
  try {
    let value: FileRun
    if (hit && st.size > hit.size && st.size - hit.size <= TAIL_BYTES) {
      // What was added starts at a row's start (it is where the last read ended); a torn one fails to parse and is skipped.
      const fresh = scanRun(readRange(file, hit.size, st.size), st.mtimeMs)
      value = {
        model: fresh.model ?? hit.value.model,
        effort: fresh.effort ?? hit.value.effort,
        effortAt: fresh.effort ? fresh.effortAt : hit.value.effortAt,
        ultracode: fresh.ultracode ?? hit.value.ultracode,
        ultracodeAt: fresh.ultracode !== null ? fresh.ultracodeAt : hit.value.ultracodeAt,
        mtimeMs: st.mtimeMs,
      }
    } else {
      const from = Math.max(0, st.size - TAIL_BYTES)
      value = scanRun(wholeRows(readRange(file, from, st.size), from), st.mtimeMs)
      if (value.effort === null && from > 0) {
        const far = Math.max(0, st.size - FAR_BYTES)
        const older = scanRun(wholeRows(readRange(file, far, from), far), st.mtimeMs)
        value = {
          ...value,
          model: value.model ?? older.model,
          effort: older.effort,
          effortAt: older.effortAt,
          ultracode: value.ultracode ?? older.ultracode,
          ultracodeAt: value.ultracode !== null ? value.ultracodeAt : older.ultracodeAt,
        }
      }
    }
    cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value })
    return value
  } catch {
    return null
  }
}

/** The newest model and effort in conversation rows (newline separated JSON). */
export function scanRun(text: string, mtimeMs = 0): FileRun {
  const lines = text.split('\n')
  let model: string | null = null
  let effort: string | null = null
  let effortAt: string | null = null
  let ultracode: boolean | null = null
  let ultracodeAt: string | null = null
  for (let i = lines.length - 1; i >= 0 && (model === null || effort === null || ultracode === null); i--) {
    const line = lines[i]
    if (!line) continue
    // A cheap test first: most rows are neither.
    const isAnswer = model === null && line.includes('"model"')
    const isEffort = (effort === null || ultracode === null) && line.includes('Set effort level')
    const isUltra = ultracode === null && line.includes('ltracode')
    if (!isAnswer && !isEffort && !isUltra) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null) continue
    const r = row as { type?: unknown; subtype?: unknown; content?: unknown; timestamp?: unknown; message?: { model?: unknown } }
    if (isAnswer && r.type === 'assistant' && typeof r.message?.model === 'string' && r.message.model && r.message.model !== '<synthetic>') model = r.message.model
    if ((isEffort || isUltra) && r.type === 'system' && r.subtype === 'local_command' && typeof r.content === 'string') {
      const at = typeof r.timestamp === 'string' ? r.timestamp : null
      const m = EFFORT_RE.exec(r.content)
      if (m && effort === null) {
        effort = m[1].toLowerCase()
        effortAt = at
      }
      // The newest of "Ultracode on/off" and "Set effort level to" says: a level turns ultracode off.
      if (ultracode === null) {
        const u = ULTRA_RE.exec(r.content)
        if (u) {
          ultracode = u[1].toLowerCase() === 'on'
          ultracodeAt = at
        } else if (m) {
          ultracode = false
          ultracodeAt = at
        }
      }
    }
  }
  return { model, effort, effortAt, ultracode, ultracodeAt, mtimeMs }
}

/**
 * The model chats without a pinned one run on, when it is configured: ANTHROPIC_MODEL, else the
 * "model" in claude's own settings.json. Usually neither says (the CLI chooses); the caller then
 * falls back to what its newest inheriting chat ran on.
 */
export function configuredModel(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): DefaultModel | null {
  const fromEnv = env.ANTHROPIC_MODEL?.trim()
  if (fromEnv) return { model: fromEnv, from: 'environment' }
  try {
    const settings: unknown = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
    const m = typeof settings === 'object' && settings !== null ? (settings as { model?: unknown }).model : undefined
    if (typeof m === 'string' && m.trim()) return { model: m.trim(), from: 'settings' }
  } catch {
    // No settings file, or not JSON: the CLI's own choice then.
  }
  return null
}
