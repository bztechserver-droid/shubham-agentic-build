import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { apiError } from '../api.ts'

// F-085 (and F-084): the PC's side of Chris's Update button (mobile/docs/HUB-PROTOCOL.md §12).
// Mobile's `node mobile/scripts/offer.mjs --sha256 <hex>` writes C:\sac\out\offer.json for ONE build that passed the PC
// tests, verify-apk and a phone check. The hub offers that build and nothing else:
//   GET /voice/app       {offered: {versionCode, versionName, sha256, bytes, notes?, offeredAt}} or {offered: null}
//   GET /voice/app/apk   the file offer.json names, with Content-Length and Range (device key; never an Origin)
// The file is served only while its sha256 still matches offer.json (hashed once, then cached by size and mtime), and only
// from the folder offer.json is in (the name must be a plain file name). The phone checks the hash again after the download
// and Android refuses an update not signed with the Chris key. Logs: the version and the bytes, nothing else.

export const DEFAULT_OFFER_FILE = 'C:\\sac\\out\\offer.json'
export const APK_MIME = 'application/vnd.android.package-archive'

export interface Offer {
  versionCode: number
  versionName: string
  sha256: string
  bytes: number
  notes?: string
  offeredAt: number
}

export interface AppUpdateDeps {
  /** offer.json */
  file: string
  log?: { info(m: string): void; warn(m: string): void }
}

export interface AppUpdate {
  /** The build offered to phones right now, or null (and why, in `reason()`). */
  offered(): Promise<Offer | null>
  /** Why nothing is offered, as a sentence; null while something is. */
  reason(): string | null
  /** Streams the offered APK to `res` (GET or HEAD, one Range). Throws an apiError (404) when nothing is offered. */
  serve(req: IncomingMessage, res: ServerResponse): Promise<void>
}

const APK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.apk$/

/** offer.json's text as an Offer plus the file name it names, or why it is not usable. */
export function parseOffer(text: string): { offer: Offer; apk: string } | string {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return 'offer.json is not valid JSON'
  }
  if (!v || typeof v !== 'object') return 'offer.json is not an object'
  const o = v as Record<string, unknown>
  if (typeof o.apk !== 'string' || !APK_NAME.test(o.apk)) return 'offer.json does not name a plain .apk file'
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) return 'offer.json has no full sha256'
  if (!Number.isInteger(o.versionCode) || (o.versionCode as number) <= 0) return 'offer.json has no version code'
  if (!Number.isSafeInteger(o.bytes) || (o.bytes as number) <= 0) return 'offer.json has no size'
  if (typeof o.versionName !== 'string') return 'offer.json has no version name'
  const offer: Offer = {
    versionCode: o.versionCode as number,
    versionName: o.versionName.slice(0, 40),
    sha256: o.sha256,
    bytes: o.bytes as number,
    offeredAt: typeof o.offeredAt === 'number' && Number.isFinite(o.offeredAt) ? o.offeredAt : 0,
  }
  if (typeof o.notes === 'string' && o.notes.trim()) offer.notes = o.notes.trim().slice(0, 500)
  return { offer, apk: o.apk }
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` of a file of `size` bytes: its [start, end], null for no usable single range (serve it whole), 'bad' for one that cannot be met. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  // Anything else (several ranges, another unit) is answered with the whole file, as the standard allows.
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return 'bad'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'bad'
  return { start, end }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('data', c => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

export function createAppUpdate(deps: AppUpdateDeps): AppUpdate {
  let why: string | null = 'No build is offered.'
  let parsed: { key: string; value: { offer: Offer; apk: string } | string } | null = null
  /** The hash of the file last looked at, by its size and mtime. */
  let hashed: { key: string; sha256: string } | null = null
  let hashing: { key: string; p: Promise<string> } | null = null

  async function hashOf(file: string, key: string): Promise<string> {
    if (hashed?.key === key) return hashed.sha256
    if (hashing?.key !== key) {
      const p = sha256File(file)
      hashing = { key, p }
      p.then(
        sha256 => {
          hashed = { key, sha256 }
          if (hashing?.p === p) hashing = null
        },
        () => {
          if (hashing?.p === p) hashing = null
        },
      )
    }
    return hashing.p
  }

  /** What is offered, with the APK's path and the size and mtime it was checked at. */
  async function current(): Promise<{ offer: Offer; apk: string; size: number; mtimeMs: number } | null> {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(deps.file)
    } catch {
      parsed = null
      why = 'No build is offered.'
      return null
    }
    const key = `${st.size}:${Math.round(st.mtimeMs)}`
    if (parsed?.key !== key) {
      let text: string
      try {
        text = readFileSync(deps.file, 'utf8')
      } catch {
        why = 'No build is offered.'
        return null
      }
      parsed = { key, value: parseOffer(text) }
    }
    if (typeof parsed.value === 'string') {
      why = `No build is offered: ${parsed.value}.`
      return null
    }
    const { offer, apk } = parsed.value
    const file = path.join(path.dirname(deps.file), apk)
    let fst: ReturnType<typeof statSync>
    try {
      fst = statSync(file)
    } catch {
      why = `No build is offered: ${apk} is not there.`
      return null
    }
    if (!fst.isFile() || fst.size !== offer.bytes) {
      why = `No build is offered: ${apk} is not the size offer.json says.`
      return null
    }
    let sha: string
    try {
      sha = await hashOf(file, `${file}:${fst.size}:${Math.round(fst.mtimeMs)}`)
    } catch {
      why = `No build is offered: ${apk} could not be read.`
      return null
    }
    if (sha !== offer.sha256) {
      why = `No build is offered: ${apk} no longer matches the sha256 in offer.json.`
      deps.log?.warn(`voice: app: the offered file no longer matches offer.json (version ${offer.versionName}); not offering it`)
      return null
    }
    why = null
    return { offer, apk: file, size: fst.size, mtimeMs: fst.mtimeMs }
  }

  return {
    async offered() {
      return (await current())?.offer ?? null
    },
    reason: () => why,
    async serve(req, res) {
      const now = await current()
      if (!now) throw apiError(404, why ?? 'No build is offered.')
      const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, now.size)
      if (range === 'bad') {
        res.writeHead(416, { 'Content-Range': `bytes */${now.size}`, 'Content-Length': 0, 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      const head: Record<string, string | number> = {
        'Content-Type': APK_MIME,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        ETag: `"${now.offer.sha256.slice(0, 32)}"`,
        'Content-Disposition': `attachment; filename="${path.basename(now.apk)}"`,
      }
      const start = range ? range.start : 0
      const end = range ? range.end : now.size - 1
      head['Content-Length'] = end - start + 1
      if (range) head['Content-Range'] = `bytes ${start}-${end}/${now.size}`
      res.writeHead(range ? 206 : 200, head)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      await new Promise<void>(resolve => {
        const s = createReadStream(now.apk, { start, end })
        let sent = 0
        let over = false
        const done = () => {
          if (over) return
          over = true
          deps.log?.info(`voice: app: ${now.offer.versionName} (${now.offer.versionCode}), ${sent} of ${now.size} bytes sent`)
          resolve()
        }
        s.on('data', c => (sent += c.length))
        s.on('error', () => {
          res.destroy()
          done()
        })
        res.on('close', () => {
          s.destroy()
          done()
        })
        s.pipe(res)
      })
    },
  }
}
