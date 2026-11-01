import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ApprovalLogEntry } from '../../shared/approvals.ts'
import type { ChatMenu } from '../../shared/chat.ts'
import { readMenu } from './screen.ts'

// F-076: reading what a waiting chat asks, from its screen text, and the log of what was answered and sent.

const BOX = /[│┃╭╮╰╯┌┐└┘├┤┬┴┼]/g
const RULES = /[─━═]{3,}/g
/** How many lines above the options are kept as what the prompt is about. */
const CONTEXT_LINES = 28

/**
 * What a chat's screen asks: its numbered menu (screen.ts), the lines above it (the command, the file, the
 * tool), and an id made of both. The id is what an answer names: if the prompt has changed by then (the same
 * "Do you want to proceed?" for another command), the id differs and the answer is refused.
 */
export function promptOf(screen: string): { menu: ChatMenu | null; context: string; id: string } {
  const lines = screen.split(/\r?\n/)
  const menu = readMenu(lines)
  const clean = lines
    .map(l => l.replace(BOX, ' ').replace(RULES, ' ').replace(/\s+$/, '').replace(/^\s{0,2}/, ''))
    .filter(l => l.trim() !== '')
  // The context is what comes before the first option (or the end of the screen when there is no menu).
  const first = menu ? clean.findIndex(l => /^\s*(?:❯\s*)?\d{1,2}\.\s+\S/.test(l)) : -1
  const upto = first >= 0 ? first : clean.length
  const context = clean.slice(Math.max(0, upto - CONTEXT_LINES), upto).join('\n').trim()
  const basis = JSON.stringify({ context, q: menu?.question ?? '', o: menu?.options.map(o => [o.n, o.label]) ?? [] })
  return { menu, context, id: createHash('sha1').update(basis).digest('hex').slice(0, 16) }
}

/** An answer's option is one the prompt has, and the prompt is one buttons can answer. */
export const answerable = (menu: ChatMenu | null) => menu !== null && !menu.multi && menu.options.length > 0

export interface ApprovalLog {
  add(e: Omit<ApprovalLogEntry, 'at'>): ApprovalLogEntry
  /** Newest first. */
  list(limit?: number): ApprovalLogEntry[]
}

const TAIL = 512 * 1024

/** The log: one JSON line per answer or send, in one file, kept (never rewritten); a read looks at its end. */
export function createApprovalLog(file: string, now = () => new Date()): ApprovalLog {
  mkdirSync(path.dirname(file), { recursive: true })
  return {
    add(e) {
      const entry: ApprovalLogEntry = { at: now().toISOString(), ...e, detail: e.detail.slice(0, 2000) }
      appendFileSync(file, `${JSON.stringify(entry)}\n`)
      return entry
    },
    list(limit = 100) {
      if (!existsSync(file)) return []
      const size = statSync(file).size
      const from = Math.max(0, size - TAIL)
      const buf = Buffer.alloc(size - from)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buf, 0, buf.length, from)
      } finally {
        closeSync(fd)
      }
      const rows = buf.toString('utf8').split('\n')
      // A read that starts in the middle of a row drops that row.
      if (from > 0) rows.shift()
      const out: ApprovalLogEntry[] = []
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
        if (!rows[i]) continue
        try {
          out.push(JSON.parse(rows[i]) as ApprovalLogEntry)
        } catch {
          // A torn row.
        }
      }
      return out
    },
  }
}
