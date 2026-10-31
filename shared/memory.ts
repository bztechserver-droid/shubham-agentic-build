// F-051: the memory layer, as the agent's API and the page both see it (agent/SPEC.md › F-051).
//   raw        the floors' notes (memory_save, the Memory tab) and the floor chats' turns (what
//              Shubham said, and the answer), kept as they were
//   the wiki   markdown pages a librarian (claude -p) compiles from the raw material, on the hub
//   search     words (BM25) and meaning (a local embedding model), over all of it
//   recall     core.md and the wiki's index in every chat's brief; each prompt's best matches

/** Under the agentic mount: /agentic/memory/... */
export const MEMORY_PREFIX = '/memory'

export type MemoryKind = 'wiki' | 'note' | 'turn'

/** One search result: a section of a wiki page, a note, or a turn of a floor chat. */
export interface MemoryHit {
  /** wiki:<path>#<n> · note:<floorId>/<noteId> · turn:<sessionId>/<n> */
  id: string
  kind: MemoryKind
  /** The page's title, the note's author, or who said it to whom. */
  title: string
  /** The page section's heading. */
  heading: string | null
  /** The text found (a section, a note, or what was said and answered), cut to a snippet. */
  text: string
  /** A wiki page's path in the wiki folder (projects/build.md). */
  path: string | null
  floorId: string | null
  sessionId: string | null
  /** When it was said, saved or last updated. */
  at: string | null
  /** The fused score, 0..1. */
  score: number
  /** Meaning: the cosine similarity to the query, when the model was ready. */
  meaning: number | null
  /** Words: how much of the query (by rarity) this hit holds, 0..1. */
  words: number
}

export interface WikiPageMeta {
  /** Relative to the wiki folder, with forward slashes. */
  path: string
  title: string
  summary: string
  tags: string[]
  updated: string | null
  bytes: number
}

export interface WikiPage extends WikiPageMeta {
  /** The page without its front matter. */
  body: string
}

export type LibrarianMode = 'ingest' | 'tidy'

export interface LibrarianRun {
  id: string
  mode: LibrarianMode
  /** now: a person pressed Compile; auto: the schedule. */
  trigger: 'now' | 'auto'
  startedAt: string
  endedAt: string | null
  state: 'running' | 'done' | 'failed'
  model: string
  material: { notes: number; turns: number; seeds: number; chars: number }
  /** Wiki pages added or changed. */
  changed: string[]
  /** The librarian's own account of what it did. */
  summary: string
  /** What claude -p reported: the run's price at API rates (a subscription is not charged it), and its tokens. */
  costUsd: number | null
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  error: string | null
}

export const LIBRARIAN_MODELS = ['sonnet', 'haiku', 'opus'] as const
export type LibrarianModel = (typeof LIBRARIAN_MODELS)[number]

export interface MemorySettings {
  /** The librarian compiles by itself (at most every `everyHours`, only with new material). Off by default: it uses the weekly limit. */
  auto: boolean
  everyHours: number
  model: LibrarianModel
  /** Each prompt brings its best matches (the UserPromptSubmit hook). */
  recall: boolean
  /** The floor chats' turns are kept and searched (no model is run for that). */
  fromChats: boolean
  /**
   * The turns from before the memory was first started (the past) are compiled too, oldest
   * first, a run at a time. Off by default: they are searched and recalled as they are, and
   * compiling them all is many runs (measured: 2,925 turns, 27 runs).
   */
  pastChats: boolean
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { auto: false, everyHours: 24, model: 'sonnet', recall: true, fromChats: true, pastChats: false }

export type MeaningState = 'off' | 'waiting' | 'downloading' | 'loading' | 'ready' | 'failed'

export interface MemoryStatus {
  /** False on a PC that isn't the hub: its memory is the hub's. */
  here: boolean
  /** The chats get it: recall with every prompt and the section in their brief (main.ts turns the layer on). */
  live: boolean
  meaning: { state: MeaningState; model: string; progress: number | null; error: string | null }
  index: { chunks: number; wiki: number; notes: number; turns: number; embedded: number }
  wiki: { dir: string; pages: number; git: boolean }
  settings: MemorySettings
  /** Not yet compiled into the wiki (the past's turns only when pastChats is on). */
  pending: { notes: number; turns: number; seeds: number; chars: number }
  /** The turns from before the memory started: how many, how many still to compile, and their size. */
  past: { total: number; left: number; chars: number }
  running: LibrarianRun | null
  runs: LibrarianRun[]
  nextAutoAt: string | null
}
