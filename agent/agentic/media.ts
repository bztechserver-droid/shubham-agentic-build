// Order o16d2: the pictures and videos agents show in their chats (the show_media tool), and the one route that serves them.
// Safety (his spec): only a file an agent explicitly shared through the tool is ever served, by an unguessable id (18 random bytes), to
// the owner of the app only (the route checks that), read only, pictures and videos only (the name's ending AND the file's first bytes
// must agree, checked again each time it is served), at most MEDIA_MAX_BYTES, with Range so a video can be sought. A path is never
// taken from the request: the id picks a row of this list. The list is kept in <agentic dir>/media.json (the newest 5000 shares).

import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apiError } from '../api.ts'
import { parseRange } from './app-update.ts'
import { MEDIA_ID, MEDIA_MAX_BYTES, kindOfSrc, mediaPath, nameOfSrc, safeMediaSrc, sizeWords, type MediaKind, type MediaShown } from '../../shared/media.ts'

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

export interface MediaRecord {
  id: string
  /** The real path (links resolved) when it was shared. */
  file: string
  type: string
  kind: MediaKind
  name: string
  size: number
  caption: string | null
  at: string
  sessionId: string
  agent: string
}

export interface MediaShelf {
  /** The show_media tool: `path` (a file on this PC) or `url` (https), `caption`, `kind` (for an address with no file ending). */
  share(input: Record<string, unknown>, who: { sessionId: string; agent: string }): Promise<MediaShown>
  /** GET/HEAD /agentic/media/<id> (the caller is checked by the route: the owner only). */
  serve(id: string, req: IncomingMessage, res: ServerResponse, download: boolean): Promise<void>
  get(id: string): Promise<MediaRecord | null>
}

const KEEP = 5000
const CAPTION_MAX = 500

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

const isRecord = (r: unknown): r is MediaRecord => {
  if (typeof r !== 'object' || r === null) return false
  const x = r as Record<string, unknown>
  return typeof x.id === 'string' && MEDIA_ID.test(x.id) && typeof x.file === 'string' && path.isAbsolute(x.file) && MEDIA_TYPES.some(t => t.type === x.type) && (x.kind === 'image' || x.kind === 'video') && typeof x.name === 'string' && typeof x.size === 'number'
}

/** A download's name: plain ASCII in filename=, the real one in filename*. */
function disposition(download: boolean, name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'media'
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function createMediaShelf(o: { file: string; now?: () => Date; randomId?: () => string; maxBytes?: number }): MediaShelf {
  const maxBytes = o.maxBytes ?? MEDIA_MAX_BYTES
  const now = o.now ?? (() => new Date())
  const randomId = o.randomId ?? (() => crypto.randomBytes(18).toString('base64url'))
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

  async function get(id: string): Promise<MediaRecord | null> {
    if (!MEDIA_ID.test(id)) return null
    return (await load()).find(r => r.id === id) ?? null
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
      const l = await load()
      l.push(rec)
      while (l.length > KEEP) l.shift()
      await save()
      return { kind: rec.kind, src: mediaPath(rec.id), name: rec.name, size: rec.size, caption }
    },

    get,

    async serve(id, req, res, download) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw apiError(405, 'Only GET or HEAD here')
      const rec = await get(id)
      if (!rec) throw apiError(404, 'No such picture or video')
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
      await new Promise<void>(resolve => {
        const s = createReadStream(rec.file, { start, end })
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
    },
  }
}
