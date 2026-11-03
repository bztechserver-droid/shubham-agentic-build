import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { driveType } from './mime.ts'
import type { DriveStore } from './store.ts'

// F-097: a pool file sent to a client, the same way for the page and for WebDAV: streamed (never whole in memory), with Range, HEAD,
// ETag and a 304. Pictures, PDFs, text, sound and video may be shown inline; everything else is a download (mime.ts).

/** `Range: bytes=a-b` for a file of `size` bytes: [start, end] inclusive; null for none (or a header we don't read); 'bad' when it can't be met. */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'bad' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const last = Number(m[2])
    if (last === 0) return 'bad'
    start = Math.max(0, size - last)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'bad'
  return [start, end]
}

export const quoted = (etag: string) => `"${etag}"`

export const disposition = (kind: 'inline' | 'attachment', name: string) =>
  `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`

export async function sendFile(req: IncomingMessage, res: ServerResponse, s: DriveStore, rel: string, opt: { version?: string; download?: boolean } = {}): Promise<void> {
  const { abs, entry } = await s.fileOf(rel, opt.version)
  const etag = quoted(entry.etag)
  const { type, inline } = driveType(entry.name)
  const base: Record<string, string | number> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(entry.mtime).toUTCString(),
    'X-Drive-Mtime': entry.mtime,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': disposition(inline && !opt.download ? 'inline' : 'attachment', entry.name),
  }
  if (req.headers['if-none-match'] === etag && !opt.version) {
    res.writeHead(304, base)
    return void res.end()
  }
  const range = parseRange(req.headers.range, entry.size)
  if (range === 'bad') {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${entry.size}` })
    return void res.end()
  }
  const [start, end] = range ?? [0, entry.size - 1]
  if (range) res.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${entry.size}` })
  else res.writeHead(200, { ...base, 'Content-Length': entry.size })
  if (req.method === 'HEAD' || entry.size === 0) return void res.end()
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(abs, { start, end })
    rs.on('error', reject)
    res.on('close', () => {
      rs.destroy()
      resolve()
    })
    rs.pipe(res)
  })
}
