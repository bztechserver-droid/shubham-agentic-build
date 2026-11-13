// Order o16d2: the pictures and videos agents show in their chats (the show_media tool), and the one route that serves them.
// Safety (his spec): only a file an agent explicitly shared through the tool is ever served, by an unguessable id (18 random bytes), to
// the owner of the app only (the route checks that), read only, pictures and videos only (the name's ending AND the file's first bytes
// must agree, checked again each time it is served), at most MEDIA_MAX_BYTES, with Range so a video can be sought. A path is never
// taken from the request: the id picks a row of this list. The list is kept in <agentic dir>/media.json (the newest 5000 shares).
//
// Order o528e (Shubham: "if I ask you for any drive in the CRM, you should be able to give it to me here in the overlay chat"): a CRM file shared by
// show_crm_file is a row of the same list, with the CRM file's id instead of a path. Its bytes come from the CRM signed in on this PC (the agent's own
// CRM files service, the one the CRM files page and the drive use; nothing here writes to the CRM), through a copy this PC keeps for a day in
// <agentic dir>/media-cache: the copy is served AS IT ARRIVES (a video plays, and is sought within what has come, before the whole file is here); a range
// far ahead of it (a video's index at its end) is one ranged read of the CRM. A picture or a video (its ending AND its first bytes agree) is shown; a PDF's
// pages are drawn as pictures by Windows (pdf-pages.ts) and the PDF itself is only downloaded; any other file is only downloaded, as bytes.

import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import { apiError } from '../api.ts'
import { parseRange } from './app-update.ts'
import { createPdfPages, PdfUnreadable, type PdfPages } from './pdf-pages.ts'
import type { CrmNode } from '../../shared/crm-files.ts'
import { endingOf, MEDIA_ID, MEDIA_MAX_BYTES, kindOfSrc, mediaPath, nameOfSrc, pdfWidth, safeMediaSrc, sizeWords, type MediaKind, type MediaShown } from '../../shared/media.ts'

interface Sniff {
  ext: readonly string[]
  type: string
  kind: MediaKind
  /** The file's first bytes say it is this. */
  is: (head: Buffer) => boolean
}
const latin = (b: Buffer, from: number, to: number) => b.toString('latin1', from, to)

/** What the app shows. No SVG (it can carry script), nothing a phone's browser cannot draw or play. */
export const MEDIA_TYPES: readonly Sniff[] = [
  { ext: ['.png'], type: 'image/png', kind: 'image', is: b => b[0] === 0x89 && latin(b, 1, 4) === 'PNG' },
  { ext: ['.jpg', '.jpeg'], type: 'image/jpeg', kind: 'image', is: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ['.gif'], type: 'image/gif', kind: 'image', is: b => latin(b, 0, 4) === 'GIF8' },
  { ext: ['.webp'], type: 'image/webp', kind: 'image', is: b => latin(b, 0, 4) === 'RIFF' && latin(b, 8, 12) === 'WEBP' },
  { ext: ['.avif'], type: 'image/avif', kind: 'image', is: b => latin(b, 4, 8) === 'ftyp' && /^avi[fs]$/.test(latin(b, 8, 12)) },
  { ext: ['.bmp'], type: 'image/bmp', kind: 'image', is: b => latin(b, 0, 2) === 'BM' },
  // .mov is served as mp4: the same ISO family; a phone's Chrome plays an H.264 .mov that way.
  { ext: ['.mp4', '.m4v', '.mov'], type: 'video/mp4', kind: 'video', is: b => latin(b, 4, 8) === 'ftyp' },
  { ext: ['.webm'], type: 'video/webm', kind: 'video', is: b => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { ext: ['.ogv'], type: 'video/ogg', kind: 'video', is: b => latin(b, 0, 4) === 'OggS' },
]
const ENDINGS = MEDIA_TYPES.flatMap(t => t.ext).join(', ')

/** o528e: a CRM file's id as crm_files gives it (file:<the CRM's id>). */
export const CRM_FILE_ID = /^file:[^\s/\\]{1,200}$/

/** o528e: what the shelf needs of the CRM files: the agent's own CRM files service (agent/crm-files/service.ts), reading only. */
export interface CrmFileSource {
  node(id: string): Promise<CrmNode>
  children(id: string): Promise<{ children: CrmNode[]; path: { id: string; name: string }[] }>
  file(id: string): Promise<{ stream: Readable; size: number | null; type: string; name: string }>
  fileBytes(id: string, start: number, length: number): Promise<Buffer>
}

export interface MediaRecord {
  id: string
  /** The real path (links resolved) when it was shared; '' for a CRM file. */
  file: string
  type: string
  kind: MediaKind
  name: string
  /** Bytes (null: a CRM file whose size the CRM has not said yet). */
  size: number | null
  caption: string | null
  at: string
  sessionId: string
  agent: string
  /** o528e: a CRM file: its id (file:<CRM id>); its bytes come from the CRM through this PC, never from a path. */
  crm?: string
  /** o528e: where it is in the CRM (projects / <project> / <folders>). */
  where?: string
}

export interface MediaShelf {
  /** The show_media tool: `path` (a file on this PC) or `url` (https), `caption`, `kind` (for an address with no file ending). */
  share(input: Record<string, unknown>, who: { sessionId: string; agent: string }): Promise<MediaShown>
  /** o528e: the show_crm_file tool: `id` (a file's id from crm_files), `caption`. */
  shareCrm(input: Record<string, unknown>, who: { sessionId: string; agent: string }): Promise<MediaShown>
  /** GET/HEAD /agentic/media/<id> (the caller is checked by the route: the owner only). */
  serve(id: string, req: IncomingMessage, res: ServerResponse, download: boolean): Promise<void>
  /** o528e: GET /agentic/media/<id>/pdf (page null: { pages }) and /pdf/<n>?w=<width> (that page as a JPEG). The owner only, as serve. */
  pdf(id: string, page: number | null, width: number, req: IncomingMessage, res: ServerResponse): Promise<void>
  get(id: string): Promise<MediaRecord | null>
}

const KEEP = 5000
const CAPTION_MAX = 500
/** o528e: the CRM copies: kept and used for a day, at most this much in all (the oldest go first), each at most CACHE_ONE (larger ones are read from the CRM as asked). */
const CACHE_KEEP_MS = 24 * 60 * 60 * 1000
const CACHE_ALL = 2 * 1024 * 1024 * 1024
const CACHE_ONE = 500 * 1024 * 1024
/** A range this far past what has come is read from the CRM by itself, at most CHUNK of it. */
const FAR = 16 * 1024 * 1024
const CHUNK = 8 * 1024 * 1024
/** How long a reader waits for the next bytes of a copy before giving up. */
const STALL_MS = 60_000

async function headOf(file: string): Promise<Buffer> {
  const h = await open(file, 'r')
  try {
    const b = Buffer.alloc(64)
    const { bytesRead } = await h.read(b, 0, 64, 0)
    return b.subarray(0, bytesRead)
  } finally {
    await h.close()
  }
}

const CRM_KINDS: readonly unknown[] = ['image', 'video', 'pdf', 'file']
const isRecord = (r: unknown): r is MediaRecord => {
  if (typeof r !== 'object' || r === null) return false
  const x = r as Record<string, unknown>
  if (typeof x.id !== 'string' || !MEDIA_ID.test(x.id) || typeof x.name !== 'string') return false
  if (x.crm !== undefined) return typeof x.crm === 'string' && CRM_FILE_ID.test(x.crm) && typeof x.type === 'string' && CRM_KINDS.includes(x.kind) && (x.size === null || typeof x.size === 'number')
  return typeof x.file === 'string' && path.isAbsolute(x.file) && MEDIA_TYPES.some(t => t.type === x.type) && (x.kind === 'image' || x.kind === 'video') && typeof x.size === 'number'
}

/** A download's name: plain ASCII in filename=, the real one in filename*. */
function disposition(download: boolean, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'media'
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** A refusal of the CRM files service (CrmFilesError: its status and plain words), as this API's error. */
function crmError(e: unknown, what: string): Error {
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 502
  const words = e instanceof Error && e.message ? e.message : `The CRM did not give ${what}.`
  return apiError(status, words)
}

/** o528e: a copy of a CRM file coming to this PC: how much has come, and a promise that settles at the next bytes (or the end). */
interface Fill {
  have: number
  size: number | null
  done: boolean
  error: Error | null
  /** The CRM said yes and the copy is open (its size, when the CRM says it, is known). */
  started: Promise<void>
  /** Settles when the copy is whole or failed (never rejects: see error). */
  finished: Promise<void>
  next(): Promise<void>
}

export function createMediaShelf(o: {
  file: string
  now?: () => Date
  randomId?: () => string
  maxBytes?: number
  /** o528e: the CRM files (the agent's service); without it show_crm_file is refused. */
  crm?: CrmFileSource
  /** o528e: where the CRM copies and the drawn pages are kept (default: media-cache beside the list). */
  cacheDir?: string
  cacheAll?: number
  cacheOne?: number
  pdf?: PdfPages
}): MediaShelf {
  const maxBytes = o.maxBytes ?? MEDIA_MAX_BYTES
  const now = o.now ?? (() => new Date())
  const randomId = o.randomId ?? (() => crypto.randomBytes(18).toString('base64url'))
  const cacheDir = o.cacheDir ?? path.join(path.dirname(o.file), 'media-cache')
  const cacheAll = o.cacheAll ?? CACHE_ALL
  const cacheOne = o.cacheOne ?? CACHE_ONE
  const pdf = o.pdf ?? createPdfPages()
  let list: MediaRecord[] | null = null
  let writing: Promise<void> = Promise.resolve()

  async function load(): Promise<MediaRecord[]> {
    if (list) return list
    try {
      const data = JSON.parse(await readFile(o.file, 'utf8')) as { media?: unknown }
      list = Array.isArray(data.media) ? data.media.filter(isRecord) : []
    } catch {
      list = []
    }
    return list
  }
  function save(): Promise<void> {
    // One write at a time, each the whole list (small: at most KEEP short rows), through a temporary file.
    writing = writing.then(async () => {
      await mkdir(path.dirname(o.file), { recursive: true })
      const tmp = `${o.file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ media: list ?? [] }))
      await rename(tmp, o.file)
    })
    return writing
  }
  async function keep(rec: MediaRecord): Promise<void> {
    const l = await load()
    l.push(rec)
    while (l.length > KEEP) l.shift()
    await save()
  }

  async function get(id: string): Promise<MediaRecord | null> {
    if (!MEDIA_ID.test(id)) return null
    return (await load()).find(r => r.id === id) ?? null
  }

  // ---- o528e: the copies of CRM files on this PC -----------------------------------------------------------------------------------------------------

  const binOf = (id: string) => path.join(cacheDir, `${id}.bin`)
  const okOf = (id: string) => path.join(cacheDir, `${id}.ok`)
  const pageOf = (id: string) => (page: number, width: number) => path.join(cacheDir, `${id}.w${width}.p${page}.jpg`)
  const fills = new Map<string, Fill>()

  /** A whole copy made within the day: its path and size. */
  async function copyOf(rec: MediaRecord): Promise<{ file: string; size: number } | null> {
    try {
      const ok = JSON.parse(await readFile(okOf(rec.id), 'utf8')) as { size?: unknown }
      const st = await stat(binOf(rec.id))
      if (typeof ok.size === 'number' && st.size === ok.size && now().getTime() - st.mtimeMs < CACHE_KEEP_MS) return { file: binOf(rec.id), size: st.size }
    } catch {
      // none (yet)
    }
    return null
  }

  /** Starts (or joins) the copy of a CRM file: the whole file, from the CRM, written as it comes. */
  function fill(rec: MediaRecord): Fill {
    const had = fills.get(rec.id)
    if (had) return had
    let tick: () => void = () => undefined
    let waiting = new Promise<void>(r => (tick = r))
    const bump = () => {
      const t = tick
      waiting = new Promise<void>(r => (tick = r))
      t()
    }
    let started!: () => void
    let refused!: (e: Error) => void
    const f: Fill = {
      have: 0,
      size: rec.size,
      done: false,
      error: null,
      started: new Promise<void>((a, b) => {
        started = a
        refused = b
      }),
      finished: Promise.resolve(),
      next: () => waiting,
    }
    f.started.catch(() => undefined)
    const bin = binOf(rec.id)
    f.finished = (async () => {
      await mkdir(cacheDir, { recursive: true })
      await rm(okOf(rec.id), { force: true })
      const got = await o.crm!.file(rec.crm!)
      try {
        if (typeof got.size === 'number' && got.size >= 0) f.size = got.size
        if (f.size !== null && f.size > cacheOne) throw apiError(413, `${rec.name} is ${sizeWords(f.size)}; a copy is kept of files up to ${sizeWords(cacheOne)}.`)
        const h = await open(bin, 'w')
        started()
        try {
          for await (const chunk of got.stream as AsyncIterable<Buffer>) {
            if (f.have + chunk.length > cacheOne) throw apiError(413, `${rec.name} is more than ${sizeWords(cacheOne)}; a copy is kept of files up to that.`)
            await h.write(chunk, 0, chunk.length, f.have)
            f.have += chunk.length
            bump()
          }
        } finally {
          await h.close()
        }
      } finally {
        got.stream.destroy()
      }
      if (f.size === null) f.size = f.have
      if (f.have !== f.size) throw new Error(`The CRM gave ${f.have} of the ${f.size} bytes of ${rec.name}.`)
      await writeFile(okOf(rec.id), JSON.stringify({ size: f.have }))
      f.done = true
      if (rec.size === null) {
        rec.size = f.have
        void save().catch(() => undefined)
      }
    })()
      .catch(async (e: unknown) => {
        f.error = e instanceof Error ? e : new Error(String(e))
        refused(f.error)
        await rm(bin, { force: true }).catch(() => undefined)
      })
      .finally(() => {
        fills.delete(rec.id)
        bump()
        void prune()
      })
    fills.set(rec.id, f)
    return f
  }

  /** The whole copy (waiting for it): for a PDF's pages. */
  async function whole(rec: MediaRecord): Promise<string> {
    const c = await copyOf(rec)
    if (c) return c.file
    const f = fill(rec)
    await f.finished
    if (f.error) throw f.error
    return binOf(rec.id)
  }

  /** Waits for `p`, at most `ms`; false when the time ran out. */
  const within = (p: Promise<void>, ms: number) =>
    new Promise<boolean>(resolve => {
      const t = setTimeout(() => resolve(false), ms)
      t.unref?.()
      void p.then(() => {
        clearTimeout(t)
        resolve(true)
      })
    })

  /** Sends bytes [start, end] of the copy at `file`, waiting for those that have not come yet (f: the copy still coming; null: it is whole). */
  async function follow(file: string, f: Fill | null, start: number, end: number, res: ServerResponse): Promise<void> {
    const h = await open(file, 'r')
    try {
      let pos = start
      while (pos <= end) {
        if (res.destroyed) return
        const next = f ? f.next() : null
        const avail = f && !f.done ? f.have : Number.POSITIVE_INFINITY
        if (pos >= avail) {
          if (f!.error) throw f!.error
          if (!(await within(next!, STALL_MS))) throw new Error('The CRM stopped sending this file.')
          continue
        }
        const n = Math.min(256 * 1024, end - pos + 1, avail - pos)
        const buf = Buffer.allocUnsafe(n)
        const { bytesRead } = await h.read(buf, 0, n, pos)
        if (bytesRead === 0) {
          if (!f || f.done || f.error) throw new Error('The copy of this file is shorter than it should be.')
          if (!(await within(next!, STALL_MS))) throw new Error('The CRM stopped sending this file.')
          continue
        }
        pos += bytesRead
        if (!res.write(buf.subarray(0, bytesRead))) {
          await new Promise<void>(r => {
            const go = () => {
              res.off('drain', go)
              res.off('close', go)
              r()
            }
            res.on('drain', go)
            res.on('close', go)
          })
        }
      }
      res.end()
    } catch (e) {
      res.destroy()
      throw e
    } finally {
      await h.close()
    }
  }

  /** Pipes a stream to the answer (stopping it when the reader goes away). */
  const pipeTo = (s: Readable, res: ServerResponse) =>
    new Promise<void>(resolve => {
      const done = () => {
        s.destroy()
        resolve()
      }
      s.on('error', () => {
        res.destroy()
        done()
      })
      res.on('close', done)
      s.pipe(res)
    })

  let pruning = false
  /** Forgets copies and drawn pages older than a day, then the oldest while there is more than cacheAll; never one being made. */
  async function prune(): Promise<void> {
    if (pruning) return
    pruning = true
    try {
      const names = await readdir(cacheDir).catch(() => [] as string[])
      const groups = new Map<string, { at: number; bytes: number; names: string[] }>()
      for (const n of names) {
        const id = n.slice(0, 24)
        if (!MEDIA_ID.test(id) || n[24] !== '.') continue
        const st = await stat(path.join(cacheDir, n)).catch(() => null)
        if (!st) continue
        const g = groups.get(id) ?? { at: 0, bytes: 0, names: [] }
        g.at = Math.max(g.at, st.mtimeMs)
        g.bytes += st.size
        g.names.push(n)
        groups.set(id, g)
      }
      const t = now().getTime()
      let total = [...groups.values()].reduce((sum, g) => sum + g.bytes, 0)
      for (const [id, g] of [...groups.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (fills.has(id)) continue
        if (t - g.at <= CACHE_KEEP_MS && total <= cacheAll) continue
        for (const n of g.names) await rm(path.join(cacheDir, n), { force: true }).catch(() => undefined)
        total -= g.bytes
      }
    } finally {
      pruning = false
    }
  }

  async function serveCrm(rec: MediaRecord, req: IncomingMessage, res: ServerResponse, download: boolean): Promise<void> {
    // A picture or a video is shown (or saved with ?download=1); a PDF (the chat draws it from its pages) and any other file are only ever downloaded,
    // another file as plain bytes.
    const attach = download || rec.kind === 'pdf' || rec.kind === 'file'
    const type = rec.kind === 'file' ? 'application/octet-stream' : rec.type
    const headers = (length: number | null, range: { start: number; end: number; size: number } | null): Record<string, string | number> => ({
      'Content-Type': type,
      ...(length !== null ? { 'Content-Length': length } : {}),
      'Accept-Ranges': rec.kind === 'file' ? 'none' : 'bytes',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
      'Content-Disposition': disposition(attach, rec.name),
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${range.size}` } : {}),
    })
    const head = req.method === 'HEAD'

    // Another file: one stream from the CRM, no copy (it is downloaded once).
    if (rec.kind === 'file') {
      if (head) {
        res.writeHead(200, headers(rec.size, null))
        res.end()
        return
      }
      let got: Awaited<ReturnType<CrmFileSource['file']>>
      try {
        got = await o.crm!.file(rec.crm!)
      } catch (e) {
        throw crmError(e, rec.name)
      }
      res.writeHead(200, headers(got.size ?? rec.size, null))
      await pipeTo(got.stream, res)
      return
    }

    const copy = await copyOf(rec)
    let f: Fill | null = null
    let size = copy ? copy.size : rec.size
    if (head && (copy || size !== null)) {
      res.writeHead(200, headers(size, null))
      res.end()
      return
    }
    // Too large to keep a copy of: ranges read from the CRM as asked (at most CHUNK each), the whole as one stream.
    if (!copy && size !== null && size > cacheOne) {
      const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)
      if (range === 'bad') {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0, 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      if (range) {
        const end = Math.min(range.end, range.start + CHUNK - 1)
        const bytes = await o.crm!.fileBytes(rec.crm!, range.start, end - range.start + 1).catch(e => {
          throw crmError(e, rec.name)
        })
        res.writeHead(206, headers(bytes.length, { start: range.start, end: range.start + bytes.length - 1, size }))
        res.end(bytes)
        return
      }
      const got = await o.crm!.file(rec.crm!).catch(e => {
        throw crmError(e, rec.name)
      })
      res.writeHead(200, headers(got.size ?? size, null))
      await pipeTo(got.stream, res)
      return
    }
    if (!copy) {
      f = fill(rec)
      try {
        await f.started
      } catch (e) {
        throw crmError(e, rec.name)
      }
      size = f.size
      if (size === null) {
        // The CRM did not say how big it is: answered once it has all come.
        await f.finished
        if (f.error) throw crmError(f.error, rec.name)
        size = f.have
        f = null
      }
    }
    if (size === null) throw apiError(502, `The CRM did not say how big ${rec.name} is.`)
    if (head) {
      res.writeHead(200, headers(size, null))
      res.end()
      return
    }
    const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)
    if (range === 'bad') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0, 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    // Far past what has come (a video's index at its end): read from the CRM by itself.
    if (range && f && !f.done && range.start > f.have + FAR) {
      const end = Math.min(range.end, range.start + CHUNK - 1)
      const bytes = await o.crm!.fileBytes(rec.crm!, range.start, end - range.start + 1).catch(e => {
        throw crmError(e, rec.name)
      })
      res.writeHead(206, headers(bytes.length, { start: range.start, end: range.start + bytes.length - 1, size }))
      res.end(bytes)
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    res.writeHead(range ? 206 : 200, headers(end - start + 1, range ? { start, end, size } : null))
    await follow(binOf(rec.id), f && !f.done ? f : null, start, end, res).catch(() => undefined)
  }

  return {
    async share(input, who) {
      const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim().slice(0, CAPTION_MAX) : null
      const hasPath = typeof input.path === 'string' && input.path.trim() !== ''
      const hasUrl = typeof input.url === 'string' && input.url.trim() !== ''
      if (hasPath === hasUrl) throw apiError(400, 'Give either path (a picture or video file on this PC) or url (an https address): one of the two.')
      if (hasUrl) {
        const src = safeMediaSrc(String(input.url))
        if (!src || !/^https:\/\//i.test(src)) throw apiError(400, 'url must be an https:// address (not http, not a file path).')
        const kind: MediaKind = input.kind === 'image' || input.kind === 'video' ? input.kind : kindOfSrc(src)
        return { kind, src, name: nameOfSrc(src), size: null, caption }
      }
      const given = String(input.path).trim().replace(/^["']+|["']+$/g, '')
      if (!path.isAbsolute(given)) throw apiError(400, `path must be the file's full path on this PC (like C:\\Users\\you\\Pictures\\shot.png), not "${given}".`)
      let file: string
      try {
        file = await realpath(given)
      } catch {
        throw apiError(404, `There is no file at ${given}.`)
      }
      const st = await stat(file)
      if (!st.isFile()) throw apiError(400, `${given} is not a file.`)
      if (st.size === 0) throw apiError(400, `${given} is empty.`)
      if (st.size > maxBytes) throw apiError(413, `${given} is ${sizeWords(st.size)}; the chat shows files up to ${sizeWords(maxBytes)}.`)
      const ext = path.extname(file).toLowerCase()
      const byName = MEDIA_TYPES.filter(t => t.ext.includes(ext))
      if (!byName.length) throw apiError(415, `The chat shows pictures and videos only (${ENDINGS}); ${path.basename(file)} is not one.`)
      const head = await headOf(file)
      const t = byName.find(x => x.is(head))
      if (!t) throw apiError(415, `${path.basename(file)} does not hold what its name says (its first bytes are not a ${byName[0].type} file).`)
      const rec: MediaRecord = { id: randomId(), file, type: t.type, kind: t.kind, name: path.basename(file), size: st.size, caption, at: now().toISOString(), sessionId: who.sessionId, agent: who.agent }
      await keep(rec)
      return { kind: rec.kind, src: mediaPath(rec.id), name: rec.name, size: rec.size, caption }
    },

    async shareCrm(input, who) {
      if (!o.crm) throw apiError(503, 'The CRM files are not reachable from this PC.')
      const caption = typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim().slice(0, CAPTION_MAX) : null
      const given = typeof input.id === 'string' ? input.id.trim() : ''
      const id = given && !given.startsWith('file:') ? `file:${given}` : given
      if (!CRM_FILE_ID.test(id)) throw apiError(400, "Give id: a file's id from crm_files (like file:3f2a9c...).")
      let node: CrmNode
      try {
        node = await o.crm.node(id)
      } catch (e) {
        throw crmError(e, 'that file')
      }
      if (node.isFolder || node.kind !== 'file') throw apiError(400, `${node.name} is a folder; give a file's id from crm_files.`)
      // Where it is, and its size when the CRM has none on record (its folder's listing asks Google's metadata for it, never its bytes).
      let where: string | undefined
      let size = typeof node.size === 'number' ? node.size : null
      if (node.parentId) {
        const listing = await o.crm.children(node.parentId).catch(() => null)
        if (listing) {
          where = listing.path.slice(1).map(p => p.name).join(' / ') || undefined
          const here = listing.children.find(c => c.id === id)
          if (size === null && typeof here?.size === 'number') size = here.size
        }
      }
      // A picture, a video or a PDF only when its first bytes say so too; anything else is a file to download.
      const ext = endingOf(node.name, node.type ?? null)
      const byName = MEDIA_TYPES.filter(t => t.ext.includes(`.${ext}`))
      let kind: MediaKind = 'file'
      let type = 'application/octet-stream'
      if (byName.length > 0 || ext === 'pdf') {
        let head: Buffer
        try {
          head = await o.crm.fileBytes(id, 0, 1024)
        } catch (e) {
          throw crmError(e, node.name)
        }
        const t = byName.find(x => x.is(head))
        if (t) {
          kind = t.kind
          type = t.type
        } else if (ext === 'pdf' && head.includes('%PDF-')) {
          kind = 'pdf'
          type = 'application/pdf'
        }
      }
      const rec: MediaRecord = { id: randomId(), file: '', crm: id, type, kind, name: node.name, size, caption, at: now().toISOString(), sessionId: who.sessionId, agent: who.agent, ...(where ? { where } : {}) }
      await keep(rec)
      // A PDF comes to this PC and its pages are counted now, so its card has them by the time the chat draws it.
      if (kind === 'pdf' && pdf.can) void whole(rec).then(file => pdf.count(rec.id, file)).catch(() => undefined)
      return { kind, src: mediaPath(rec.id), name: rec.name, size, caption, ...(where ? { where } : {}) }
    },

    get,

    async serve(id, req, res, download) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw apiError(405, 'Only GET or HEAD here')
      const rec = await get(id)
      if (!rec) throw apiError(404, 'No such picture or video')
      if (rec.crm) {
        if (!o.crm) throw apiError(503, 'The CRM files are not reachable from this PC.')
        return serveCrm(rec, req, res, download)
      }
      let size: number
      try {
        const st = await stat(rec.file)
        if (!st.isFile()) throw new Error('not a file')
        size = st.size
      } catch {
        throw apiError(410, `${rec.name} is gone from the PC (moved or deleted).`)
      }
      if (size > maxBytes) throw apiError(413, `${rec.name} is ${sizeWords(size)} now; the chat shows files up to ${sizeWords(maxBytes)}.`)
      // The file at that path must still be what was shared (a picture is not swapped for something else under the same name).
      const head = await headOf(rec.file).catch(() => Buffer.alloc(0))
      if (!MEDIA_TYPES.some(t => t.type === rec.type && t.is(head))) throw apiError(410, `${rec.name} is not the picture or video that was shown any more.`)
      const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)
      if (range === 'bad') {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0, 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      const start = range ? range.start : 0
      const end = range ? range.end : size - 1
      const headers: Record<string, string | number> = {
        'Content-Type': rec.type,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        // Opened on its own (not in the page), it is a sandboxed document: nothing in it runs.
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
        'Content-Disposition': disposition(download, rec.name),
      }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      res.writeHead(range ? 206 : 200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      await pipeTo(createReadStream(rec.file, { start, end }), res)
    },

    async pdf(id, page, width, req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw apiError(405, 'Only GET or HEAD here')
      const rec = await get(id)
      if (!rec || rec.kind !== 'pdf' || !rec.crm) throw apiError(404, 'No such PDF')
      if (!o.crm) throw apiError(503, 'The CRM files are not reachable from this PC.')
      if (!pdf.can) throw apiError(501, 'The pages of a PDF are drawn on Windows only; download it to open it.')
      let file: string
      try {
        file = await whole(rec)
      } catch (e) {
        throw crmError(e, rec.name)
      }
      try {
        if (page === null) {
          const pages = await pdf.count(rec.id, file)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' })
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ pages }))
          return
        }
        const jpg = await pdf.page(rec.id, file, page, pdfWidth(width), pageOf(rec.id))
        const st = await stat(jpg)
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': st.size,
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        await pipeTo(createReadStream(jpg), res)
      } catch (e) {
        if (e instanceof PdfUnreadable) throw apiError(422, e.message)
        throw e
      }
    },
  }
}
