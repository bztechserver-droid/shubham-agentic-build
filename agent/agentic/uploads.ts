import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import { ATTACH_MAX_BYTES, isStoredName } from '../../shared/attachments.ts'
import { apiError } from '../api.ts'

// F-069: where the files sent to a chat are kept on this PC: one folder, `uploads`, in the agent's state.
// A file is written in pieces (a PC far away is sent it a megabyte at a time, as the link's lines are
// short) under `.partial` and moved into place when its last piece is in, so a half-written file is never
// one claude is told about. Names are the ones shared/attachments.ts makes; nothing else is read or
// written, so a name from outside can't reach another folder.

/** How much of a file goes in one piece over the link (base64 makes it a third more; a link line is 2 MB at most). */
export const PIECE_BYTES = 1024 * 1024
/** A file nobody asked for in this long is deleted at the next start. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

export interface UploadStore {
  dir: string
  /** The whole path of a kept file (what claude is told). */
  pathOf(file: string): string
  has(file: string): boolean
  size(file: string): number | null
  /** One piece (0-based `i` of `n`) of `file`; the last one makes the file whole. True when it did. */
  put(file: string, i: number, n: number, piece: Buffer): boolean
  /** Up to `len` bytes of a kept file from `offset`. */
  read(file: string, offset: number, len: number): Buffer
  /** Deletes what is old (and every unfinished file). */
  prune(now?: number): number
}

export function createUploadStore(dir: string): UploadStore {
  const partial = path.join(dir, '.partial')
  mkdirSync(partial, { recursive: true })
  const named = (file: string) => {
    if (!isStoredName(file)) throw apiError(400, 'That is not a name this PC keeps files under')
    return file
  }
  return {
    dir,
    pathOf: file => path.join(dir, named(file)),
    has: file => isStoredName(file) && existsSync(path.join(dir, file)),
    size(file) {
      try {
        return isStoredName(file) ? statSync(path.join(dir, file)).size : null
      } catch {
        return null
      }
    },
    put(file, i, n, piece) {
      named(file)
      if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 0 || i >= n || n > Math.ceil(ATTACH_MAX_BYTES / PIECE_BYTES) + 1) throw apiError(400, 'Expected piece i of n')
      if (piece.length > PIECE_BYTES) throw apiError(413, 'A piece is too large')
      const tmp = path.join(partial, file)
      // The first piece starts the file over; the rest add to it, in order.
      if (i === 0) rmSync(tmp, { force: true })
      else if (!existsSync(tmp)) throw apiError(409, 'A piece came before the start of the file')
      const fd = openSync(tmp, 'a')
      try {
        writeSync(fd, piece)
      } finally {
        closeSync(fd)
      }
      if (statSync(tmp).size > ATTACH_MAX_BYTES) {
        rmSync(tmp, { force: true })
        throw apiError(413, `A file may be ${Math.round(ATTACH_MAX_BYTES / 1024 / 1024)} MB at most`)
      }
      if (i < n - 1) return false
      renameSync(tmp, path.join(dir, file))
      return true
    },
    read(file, offset, len) {
      named(file)
      const fd = openSync(path.join(dir, file), 'r')
      try {
        const buf = Buffer.alloc(Math.max(0, Math.min(len, PIECE_BYTES)))
        const got = readSync(fd, buf, 0, buf.length, offset)
        return buf.subarray(0, got)
      } finally {
        closeSync(fd)
      }
    },
    prune(now = Date.now()) {
      let n = 0
      for (const [where, all] of [
        [partial, true],
        [dir, false],
      ] as const) {
        let names: string[] = []
        try {
          names = readdirSync(where)
        } catch {
          continue
        }
        for (const f of names) {
          const p = path.join(where, f)
          try {
            const st = statSync(p)
            if (!st.isFile()) continue
            if (all || now - Math.max(st.mtimeMs, st.atimeMs) > KEEP_MS) {
              rmSync(p, { force: true })
              n++
            }
          } catch {
            // Gone already.
          }
        }
      }
      return n
    },
  }
}

/** What an image or file is sent to a page as. Only the pictures a page may show are shown; anything else is a download. */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
}
export function contentTypeOf(file: string): { type: string; inline: boolean } {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  const type = TYPES[ext]
  return type ? { type, inline: true } : { type: 'application/octet-stream', inline: false }
}
