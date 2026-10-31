import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// F-021: a session's JSONL, kept the same on the hub's PCs. claude only appends to it, so a
// copy is the original's first N bytes: what is sent is where the bytes go (`from`) and the
// bytes. A mark (size, and a hash of the last 4 KiB before it) says whether two copies agree
// up to that size; one that doesn't agree is replaced whole, never patched.

/** How much of a copy's end its mark hashes. */
export const MARK_TAIL = 4096
/** The most sent in one piece. */
export const CHUNK = 256 * 1024

export interface FileMark {
  bytes: number
  /** sha1 of the bytes [bytes - 4 KiB, bytes), hex; '' for an empty or missing file. */
  tail: string
}

export const NO_FILE: FileMark = { bytes: 0, tail: '' }

const sizeOf = (file: string) => {
  try {
    return statSync(file).size
  } catch {
    return -1
  }
}

/** The bytes [from, from + max) of `file` (fewer at its end). */
export function readRange(file: string, from: number, max: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(max)
    let got = 0
    while (got < max) {
      const n = readSync(fd, buf, got, max - got, from + got)
      if (n === 0) break
      got += n
    }
    return buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/** The file's mark at `at` bytes (its size when left out); NO_FILE when it is missing or shorter. */
export function markOf(file: string, at?: number): FileMark {
  const size = sizeOf(file)
  if (size <= 0) return NO_FILE
  const bytes = at === undefined ? size : at
  if (bytes <= 0 || bytes > size) return NO_FILE
  const start = Math.max(0, bytes - MARK_TAIL)
  return { bytes, tail: createHash('sha1').update(readRange(file, start, bytes - start)).digest('hex') }
}

export const sameMark = (a: FileMark, b: FileMark) => a.bytes === b.bytes && a.tail === b.tail

export type AppendResult = 'ok' | 'gap' | 'diverged'

/**
 * Puts `data` at `from` in `file`: appended when that is its end; bytes it already has are
 * checked, not written again. 'gap': the file is shorter than `from`. 'diverged': the bytes
 * there differ (the copies forked; the whole file has to come again).
 */
export function appendAt(file: string, from: number, data: Buffer): AppendResult {
  const size = Math.max(0, sizeOf(file))
  if (from > size) return 'gap'
  const overlap = Math.min(size - from, data.length)
  if (overlap > 0 && !readRange(file, from, overlap).equals(data.subarray(0, overlap))) return 'diverged'
  if (overlap < data.length) {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, data.subarray(overlap))
  }
  return 'ok'
}

/** A whole new copy of `file`, written beside it and swapped in at the end (`write` returns the bytes so far). */
export function replacer(file: string): { write(data: Buffer): number; done(): void; abort(): void } {
  const tmp = `${file}.incoming`
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(tmp, '')
  let bytes = 0
  return {
    write(data) {
      appendFileSync(tmp, data)
      bytes += data.length
      return bytes
    },
    done() {
      renameSync(tmp, file)
    },
    abort() {
      rmSync(tmp, { force: true })
    },
  }
}

export interface Tail {
  /** Sends what `file` grows by from `from` on, until untracked. */
  track(sessionId: string, file: string, from: number): void
  untrack(sessionId: string): void
  tracking(sessionId: string): boolean
  /** Sends whatever is there now, at once. */
  flush(sessionId: string): void
  close(): void
}

/**
 * Watches the JSONL of each chat this PC runs and hands on what it grows by, in order, a piece
 * of at most CHUNK at a time (at most 16 pieces a tick, so a burst can't starve the link). A
 * file that shrank was rewritten: `onReset`, and it is sent again from 0.
 */
export function createTail(o: { onData: (sessionId: string, from: number, data: Buffer) => void; onReset?: (sessionId: string) => void; everyMs?: number }): Tail {
  const tracked = new Map<string, { file: string; sent: number }>()

  function pump(sessionId: string, maxPieces: number) {
    const t = tracked.get(sessionId)
    if (!t) return
    const size = sizeOf(t.file)
    if (size < 0) return
    if (size < t.sent) {
      t.sent = 0
      o.onReset?.(sessionId)
    }
    for (let i = 0; i < maxPieces && t.sent < size; i++) {
      const data = readRange(t.file, t.sent, Math.min(CHUNK, size - t.sent))
      if (!data.length) break
      const from = t.sent
      t.sent += data.length
      o.onData(sessionId, from, data)
    }
  }

  const timer = setInterval(() => {
    for (const id of [...tracked.keys()]) pump(id, 16)
  }, o.everyMs ?? 1000)
  timer.unref()

  return {
    track(sessionId, file, from) {
      tracked.set(sessionId, { file, sent: from })
    },
    untrack(sessionId) {
      tracked.delete(sessionId)
    },
    tracking: sessionId => tracked.has(sessionId),
    flush(sessionId) {
      pump(sessionId, Infinity)
    },
    close() {
      clearInterval(timer)
      tracked.clear()
    },
  }
}

/** Resolves once `file` has stopped growing for `quietMs` (a stopped claude's last write is in), or after `maxMs`. */
export async function settled(file: string, quietMs = 600, maxMs = 5000): Promise<void> {
  const until = Date.now() + maxMs
  let last = sizeOf(file)
  let since = Date.now()
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 150))
    const now = sizeOf(file)
    if (now !== last) {
      last = now
      since = Date.now()
    } else if (Date.now() - since >= quietMs) return
  }
}
