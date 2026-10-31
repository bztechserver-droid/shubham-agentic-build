import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { MemoryEntry } from '../../shared/agentic.ts'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

// F-018: a floor's shared memory (agentic-claude-manager server/lib/memory.js): notes its chats
// save with memory_save and the human adds on the Memory tab, one JSON line each in
// <state>/agent/agentic/memory/<scope>.jsonl. Appends only; an edit or delete rewrites the file.

export const MEMORY_TEXT_MAX = 4000
const TAGS_MAX = 8

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SCOPE_RE = /^[0-9a-zA-Z-]{1,64}$/

export interface NewNote {
  text: string
  tags?: string[]
  sessionId?: string | null
  authorName?: string | null
}

export interface MemoryStore {
  /** Newest first. */
  recent(scope: string, limit?: number): MemoryEntry[]
  /** Best matches first; an empty query is recent(). */
  search(scope: string, query: string, limit?: number): MemoryEntry[]
  save(scope: string, note: NewNote): MemoryEntry
  edit(scope: string, id: string, text: string): MemoryEntry
  remove(scope: string, id: string): boolean
  /** The scope's file goes (its floor was deleted). */
  drop(scope: string): void
  /** F-051: every note, oldest first (the memory layer indexes them all). */
  all(scope: string): MemoryEntry[]
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((t): t is string => typeof t === 'string').map(t => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, TAGS_MAX)
}

function hydrate(raw: unknown): MemoryEntry | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null
  return {
    id: raw.id,
    ts: typeof raw.ts === 'string' ? raw.ts : new Date(0).toISOString(),
    text: raw.text.slice(0, MEMORY_TEXT_MAX),
    tags: cleanTags(raw.tags),
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    author: raw.author === 'agent' ? 'agent' : 'human',
    authorName: typeof raw.authorName === 'string' ? raw.authorName : null,
    editedAt: typeof raw.editedAt === 'string' ? raw.editedAt : null,
  }
}

/** Words of three letters or more, lowercased. */
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []

export function createMemoryStore(dir: string): MemoryStore {
  const fileOf = (scope: string) => {
    if (!SCOPE_RE.test(scope)) throw apiError(400, 'Not a memory scope')
    return path.join(dir, `${scope}.jsonl`)
  }

  function read(scope: string): MemoryEntry[] {
    let text: string
    try {
      text = readFileSync(fileOf(scope), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    const out: MemoryEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = hydrate(JSON.parse(line))
        if (e) out.push(e)
      } catch {
        // A torn last line (a crash mid-append) is skipped, not fatal.
      }
    }
    return out
  }

  function rewrite(scope: string, entries: MemoryEntry[]) {
    writeAtomic(fileOf(scope), entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''))
  }

  const cap = (n: number | undefined, d: number) => Math.max(1, Math.min(typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : d, 100))

  return {
    recent(scope, limit) {
      return read(scope).reverse().slice(0, cap(limit, 10))
    },

    search(scope, query, limit) {
      const terms = [...new Set(words(query))]
      if (!terms.length) return this.recent(scope, limit)
      const scored = read(scope)
        .map((e, i) => {
          const hay = `${e.text} ${e.tags.join(' ')}`.toLowerCase()
          let score = 0
          for (const t of terms) {
            if (e.tags.includes(t)) score += 3
            if (hay.includes(t)) score += 2
          }
          return { e, score, i }
        })
        .filter(x => x.score > 0)
      scored.sort((a, b) => b.score - a.score || b.i - a.i)
      return scored.slice(0, cap(limit, 10)).map(x => x.e)
    },

    save(scope, note) {
      const text = typeof note.text === 'string' ? note.text.trim() : ''
      if (!text) throw apiError(400, 'A note needs some text')
      if (text.length > MEMORY_TEXT_MAX) throw apiError(400, `A note is at most ${MEMORY_TEXT_MAX} characters`)
      const entry: MemoryEntry = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        text,
        tags: cleanTags(note.tags),
        sessionId: note.sessionId ?? null,
        author: note.sessionId ? 'agent' : 'human',
        authorName: note.authorName ?? null,
        editedAt: null,
      }
      const file = fileOf(scope)
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(entry)}\n`)
      return entry
    },

    edit(scope, id, text) {
      const t = typeof text === 'string' ? text.trim() : ''
      if (!t) throw apiError(400, 'A note needs some text')
      if (t.length > MEMORY_TEXT_MAX) throw apiError(400, `A note is at most ${MEMORY_TEXT_MAX} characters`)
      const entries = read(scope)
      const e = entries.find(x => x.id === id)
      if (!e) throw apiError(404, 'No such note')
      e.text = t
      e.editedAt = new Date().toISOString()
      rewrite(scope, entries)
      return e
    },

    remove(scope, id) {
      const entries = read(scope)
      const next = entries.filter(x => x.id !== id)
      if (next.length === entries.length) return false
      rewrite(scope, next)
      return true
    },

    drop(scope) {
      rmSync(fileOf(scope), { force: true })
    },

    all(scope) {
      return read(scope)
    },
  }
}
