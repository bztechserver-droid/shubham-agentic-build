import { createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DriveChanges, DriveCommit, DriveEntry, DriveList, DriveStatus, DriveUpload, DriveUploadInfo } from '../../shared/drive.ts'
import type { SyncRemote } from './sync.ts'

// F-097 part C: the SyncRemote for a PC that is not the hub: it speaks the drive listener's /api (the same routes as the page, minus what a
// sync device must not touch) over HTTP with the device's name and password. From a PC on the tailnet that is
// https://<hub>.<tailnet>.ts.net:8444 (tailscale serve); on the hub itself, http://127.0.0.1:21280. No dependencies: Node's fetch only.

export interface HttpRemoteOptions {
  /** e.g. https://server.tailc768e5.ts.net:8444 (no /api). */
  baseUrl: string
  name: string
  password: string
  fetch?: typeof fetch
  /** Tests: how long to wait between tries of a piece. */
  retryMs?: number
}

export class DriveHttpError extends Error {
  status: number
  code?: string
  received?: number
  constructor(status: number, message: string, code?: string, received?: number) {
    super(message)
    this.status = status
    this.code = code
    this.received = received
  }
}

const TRIES = 4

export function httpRemote(o: HttpRemoteOptions): SyncRemote {
  const f = o.fetch ?? fetch
  const root = `${o.baseUrl.replace(/\/+$/, '')}/api`
  const auth = `Basic ${Buffer.from(`${o.name}:${o.password}`).toString('base64')}`
  const q = (params: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v))
    const s = u.toString()
    return s ? `?${s}` : ''
  }

  async function raw(method: string, rest: string, opt: { body?: Buffer | string; json?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: auth, 'x-drive-client': o.name, ...opt.headers }
    let body = opt.body
    if (opt.json !== undefined) {
      body = JSON.stringify(opt.json)
      headers['content-type'] = 'application/json'
    }
    const res = await f(`${root}${rest}`, { method, headers, body, signal: opt.signal })
    if (res.ok) return res
    let message = `${res.status}`
    let code: string | undefined
    let received: number | undefined
    const text = await res.text().catch(() => '')
    try {
      const j = JSON.parse(text) as { error?: string; code?: string; received?: number }
      message = j.error ?? message
      code = j.code
      received = j.received
    } catch {
      message = text.slice(0, 200) || message
    }
    if (res.status === 401) message = 'The server did not accept this device’s password. Pair it again from the Drive page.'
    throw new DriveHttpError(res.status, message, code, received)
  }
  const json = async <T>(method: string, rest: string, opt: Parameters<typeof raw>[2] = {}): Promise<T> => (await raw(method, rest, opt)).json() as Promise<T>
  const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
  const transient = (e: unknown) => !(e instanceof DriveHttpError) || e.status >= 500 || e.status === 429

  return {
    rev: async () => (await json<DriveStatus>('GET', '/status')).rev,

    changes: (since, waitMs, signal) => {
      const t = AbortSignal.timeout(waitMs + 20_000)
      return json<DriveChanges>('GET', `/changes${q({ since, wait: waitMs, limit: 2000 })}`, { signal: signal ? AbortSignal.any([signal, t]) : t })
    },

    list: (path, cursor) => json<DriveList>('GET', `/list${q({ path, cursor, limit: 1000 })}`),

    async stat(path): Promise<DriveEntry | null> {
      try {
        return await json<DriveEntry>('GET', `/stat${q({ path })}`)
      } catch (e) {
        if (e instanceof DriveHttpError && e.code === 'notfound') return null
        throw e
      }
    },

    async download(path, dest): Promise<DriveEntry> {
      const res = await raw('GET', `/file${q({ path, download: 1 })}`)
      try {
        if (!res.body) throw new Error('The server sent no content.')
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
      } catch (e) {
        await rm(dest, { force: true })
        throw e
      }
      const size = Number(res.headers.get('content-length') ?? '0')
      const etag = (res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, '')
      const mtime = Number(res.headers.get('x-drive-mtime') ?? Date.parse(res.headers.get('last-modified') ?? ''))
      const name = path.slice(path.lastIndexOf('/') + 1)
      return { name, path, kind: 'file', size, etag, mtime: Number.isFinite(mtime) ? mtime : Date.now() }
    },

    async upload(path, src, opt): Promise<DriveCommit> {
      const start = await json<DriveUpload>('POST', '/upload', { json: { path, size: opt.size, mode: opt.mode, baseEtag: opt.baseEtag, modified: opt.modified } })
      try {
        const fh = await open(src, 'r')
        try {
          let offset = 0
          const buf = Buffer.alloc(start.pieceBytes)
          while (offset < opt.size) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, opt.size - offset), offset)
            if (bytesRead <= 0) throw new Error('The file changed while it was being sent.')
            const piece = Buffer.from(buf.subarray(0, bytesRead))
            for (let attempt = 1; ; attempt++) {
              try {
                await raw('PUT', `/upload/${start.id}${q({ offset })}`, { body: piece, headers: { 'content-type': 'application/octet-stream' } })
                break
              } catch (e) {
                if (!transient(e) && !(e instanceof DriveHttpError && e.code === 'offset')) throw e
                if (attempt >= TRIES) throw e
                await pause(o.retryMs ?? 500 * attempt)
                // The piece may or may not have arrived: ask where the server is, and carry on from there.
                const info = await json<DriveUploadInfo>('GET', `/upload/${start.id}`).catch(() => null)
                if (info && info.received === offset + bytesRead) break
                if (info && info.received !== offset) throw new Error('The upload got out of step; it will be tried again from the start.')
              }
            }
            offset += bytesRead
          }
        } finally {
          await fh.close()
        }
        return await json<DriveCommit>('POST', `/upload/${start.id}/commit`)
      } catch (e) {
        await raw('DELETE', `/upload/${start.id}`).catch(() => undefined)
        throw e
      }
    },

    async mkdir(path) {
      await json('POST', '/mkdir', { json: { path } })
    },

    async remove(path) {
      await json('POST', '/delete', { json: { path } })
    },
  }
}
