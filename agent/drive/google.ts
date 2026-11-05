import { open, readFile } from 'node:fs/promises'
import type { BackupItem, BackupMeta, BackupTarget } from './backup-target.ts'

// F-097 part D: Google Drive as a backup target, through Google's REST API with Node's fetch (no library). The account's three secrets
// (client id, client secret, refresh token) are read from an env file ONLY when a token is needed, held in memory for the access token's
// life, and never logged, printed or put in an error message. Everything goes under one folder, "Common Drive", that this program makes;
// each file carries appProperties (the path in the pool and the pool's etag), which is how the nightly check finds what is already there.

export interface GoogleKeys {
  clientId: string
  clientSecret: string
  refreshToken: string
}

/**
 * Reads whatever of the three keys a text holds. Two forms (F-125):
 *  - an env file: GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN (KEY=value, # comments, optional quotes, a leading BOM);
 *  - Google's client JSON ({"installed":{"client_id","client_secret"}} or "web"), which has no refresh token unless one was added as "refresh_token".
 * Values are returned to the caller and nowhere else: this function logs and throws nothing that holds one.
 */
export function parsePartialKeys(text: string): Partial<GoogleKeys> {
  const body = text.replace(/^\uFEFF/, '')
  const out: Partial<GoogleKeys> = {}
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  if (body.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(body) as Record<string, unknown>
      const inner = (typeof j.installed === 'object' && j.installed ? j.installed : typeof j.web === 'object' && j.web ? j.web : j) as Record<string, unknown>
      const get = (...names: string[]) => names.map(n => str(inner[n]) ?? str(j[n])).find(Boolean)
      const clientId = get('client_id', 'GDRIVE_CLIENT_ID')
      const clientSecret = get('client_secret', 'GDRIVE_CLIENT_SECRET')
      const refreshToken = get('refresh_token', 'GDRIVE_REFRESH_TOKEN')
      if (clientId) out.clientId = clientId
      if (clientSecret) out.clientSecret = clientSecret
      if (refreshToken) out.refreshToken = refreshToken
    } catch {
      // Not JSON after all: nothing in it.
    }
    return out
  }
  const env = new Map<string, string>()
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    env.set(line.slice(0, eq).trim().replace(/^export\s+/, ''), v)
  }
  const clientId = env.get('GDRIVE_CLIENT_ID')
  const clientSecret = env.get('GDRIVE_CLIENT_SECRET')
  const refreshToken = env.get('GDRIVE_REFRESH_TOKEN')
  if (clientId) out.clientId = clientId
  if (clientSecret) out.clientSecret = clientSecret
  if (refreshToken) out.refreshToken = refreshToken
  return out
}

/** All three keys from one text, or null when any is missing. */
export function parseKeys(text: string): GoogleKeys | null {
  const k = parsePartialKeys(text)
  return k.clientId && k.clientSecret && k.refreshToken ? { clientId: k.clientId, clientSecret: k.clientSecret, refreshToken: k.refreshToken } : null
}

export interface GoogleOptions {
  /** Reads the keys when needed (a file, in the program; a function in tests). */
  keys: () => Promise<GoogleKeys | null>
  /** Shown in messages; not a secret (e.g. the account's address). */
  account?: string
  rootName?: string
  fetch?: typeof fetch
  /** Tests point these at a fake server. */
  apiBase?: string
  uploadBase?: string
  tokenUrl?: string
  /** Tests: how long to wait before a retry. */
  retryMs?: number
}

const FOLDER = 'application/vnd.google-apps.folder'
const SMALL = 5 * 1024 * 1024
const CHUNK = 8 * 1024 * 1024
const TRIES = 5

export class GoogleError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)

interface DriveFile {
  id: string
  name: string
  mimeType?: string
  size?: string
  parents?: string[]
  appProperties?: Record<string, string>
}

export function googleTarget(o: GoogleOptions): BackupTarget {
  const f = o.fetch ?? fetch
  const api = o.apiBase ?? 'https://www.googleapis.com/drive/v3'
  const upload = o.uploadBase ?? 'https://www.googleapis.com/upload/drive/v3'
  const tokenUrl = o.tokenUrl ?? 'https://oauth2.googleapis.com/token'
  const rootName = o.rootName ?? 'Common Drive'
  let token: { value: string; until: number } | null = null
  let rootId: string | null = null
  // path -> folder id, remembered for this run (a fresh run asks Google again).
  const folders = new Map<string, string>()
  const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  async function accessToken(): Promise<string> {
    if (token && token.until > Date.now() + 60_000) return token.value
    const keys = await o.keys()
    if (!keys) throw new GoogleError(0, `The Google keys are not available${o.account ? ` (${o.account})` : ''}.`)
    const res = await f(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: keys.clientId, client_secret: keys.clientSecret, refresh_token: keys.refreshToken, grant_type: 'refresh_token' }),
    })
    if (!res.ok) {
      // Google's reason (invalid_grant, …) is a short code, not a secret; the request body is never echoed.
      let why = ''
      try {
        why = String(((await res.json()) as { error?: string }).error ?? '')
      } catch {
        // No body.
      }
      throw new GoogleError(res.status, `Google would not give an access token (${res.status}${why ? ` ${why}` : ''}). ${o.account ? `The refresh token for ${o.account} may have expired or been revoked: make a new refresh token for ${o.account} (one consent run).` : 'The key may have been revoked: make a new one.'}`)
    }
    const j = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!j.access_token) throw new GoogleError(0, 'Google gave no access token.')
    token = { value: j.access_token, until: Date.now() + (j.expires_in ?? 3000) * 1000 }
    return token.value
  }

  /** A request with the token, retried on 429/5xx/network trouble with a growing wait; 401 once with a new token. */
  async function call(method: string, url: string, init: { json?: unknown; body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Response> {
    let refreshed = false
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bearer ${await accessToken()}`, ...init.headers }
      let body = init.body
      if (init.json !== undefined) {
        body = JSON.stringify(init.json)
        headers['content-type'] = 'application/json; charset=UTF-8'
      }
      let res: Response | null = null
      try {
        res = await f(url, { method, headers, body })
      } catch (e) {
        if (attempt >= TRIES) throw new GoogleError(0, `Google could not be reached (${e instanceof Error ? e.message : String(e)}).`)
      }
      if (res) {
        if (res.ok || res.status === 308) return res
        if (res.status === 401 && !refreshed) {
          refreshed = true
          token = null
          continue
        }
        if ((res.status === 429 || res.status >= 500 || res.status === 403) && attempt < TRIES) {
          const text = await res.text().catch(() => '')
          // 403 is a rate limit only when Google says so; otherwise it is a refusal.
          if (res.status !== 403 || /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(text)) {
            await pause((o.retryMs ?? 1000) * 2 ** (attempt - 1))
            continue
          }
          throw new GoogleError(res.status, `Google refused: ${text.slice(0, 200)}`)
        }
        const text = await res.text().catch(() => '')
        throw new GoogleError(res.status, `Google answered ${res.status}: ${text.slice(0, 200)}`)
      }
      await pause((o.retryMs ?? 1000) * 2 ** (attempt - 1))
    }
  }
  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T

  async function find(q: string, fields = 'files(id,name,mimeType,size,parents,appProperties)'): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken = ''
    do {
      const url = `${api}/files?${new URLSearchParams({ q, fields: `nextPageToken,${fields}`, pageSize: '1000', ...(pageToken ? { pageToken } : {}) })}`
      const j = await json<{ files?: DriveFile[]; nextPageToken?: string }>(await call('GET', url))
      out.push(...(j.files ?? []))
      pageToken = j.nextPageToken ?? ''
    } while (pageToken)
    return out
  }

  async function root(): Promise<string> {
    if (rootId) return rootId
    const hit = await find(`name = '${esc(rootName)}' and 'root' in parents and mimeType = '${FOLDER}' and trashed = false and appProperties has { key='sadRoot' and value='1' }`)
    if (hit[0]) return (rootId = hit[0].id)
    const made = await json<DriveFile>(await call('POST', `${api}/files?fields=id`, { json: { name: rootName, mimeType: FOLDER, parents: ['root'], appProperties: { sadRoot: '1' } } }))
    return (rootId = made.id)
  }

  async function folderId(path: string): Promise<string> {
    if (path === '') return root()
    const known = folders.get(path)
    if (known) return known
    const parent = await folderId(parentOf(path))
    const name = baseName(path)
    const hit = await find(`name = '${esc(name)}' and '${parent}' in parents and mimeType = '${FOLDER}' and trashed = false`)
    let id = hit[0]?.id
    if (!id) id = (await json<DriveFile>(await call('POST', `${api}/files?fields=id`, { json: { name, mimeType: FOLDER, parents: [parent], appProperties: { sad: '1', path } } }))).id
    folders.set(path, id)
    return id
  }

  /** The file the backup already holds for `path`, if any. */
  async function existing(path: string): Promise<DriveFile | null> {
    const parent = await folderId(parentOf(path))
    const hit = await find(`name = '${esc(baseName(path))}' and '${parent}' in parents and mimeType != '${FOLDER}' and trashed = false`)
    return hit[0] ?? null
  }

  async function putFile(path: string, src: string, meta: BackupMeta) {
    const parent = await folderId(parentOf(path))
    const old = await existing(path)
    const appProperties = { sad: '1', path, etag: meta.etag }
    const modifiedTime = new Date(meta.mtime).toISOString()
    const metadata = old ? { appProperties, modifiedTime } : { name: baseName(path), parents: [parent], appProperties, modifiedTime }
    const base = old ? `${upload}/files/${old.id}` : `${upload}/files`
    const method = old ? 'PATCH' : 'POST'
    if (meta.size <= SMALL) {
      const data = await readFile(src)
      const boundary = `sad${Math.random().toString(36).slice(2)}`
      const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`)
      const tail = Buffer.from(`\r\n--${boundary}--`)
      await call(method, `${base}?uploadType=multipart&fields=id`, { body: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/related; boundary=${boundary}` } })
      return
    }
    // Resumable: ask for a session, then send the file in chunks; a chunk that fails is asked about and carried on from where Google has got to.
    const start = await call(method, `${base}?uploadType=resumable&fields=id`, { json: metadata, headers: { 'x-upload-content-length': String(meta.size) } })
    const session = start.headers.get('location')
    if (!session) throw new GoogleError(0, 'Google gave no upload address.')
    const fh = await open(src, 'r')
    try {
      let offset = 0
      while (offset < meta.size) {
        const len = Math.min(CHUNK, meta.size - offset)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fh.read(buf, 0, len, offset)
        if (bytesRead !== len) throw new GoogleError(0, 'The file changed while it was being copied.')
        const res = await call('PUT', session, { body: buf, headers: { 'content-range': `bytes ${offset}-${offset + len - 1}/${meta.size}`, 'content-type': 'application/octet-stream' } })
        if (res.status === 308) {
          const range = res.headers.get('range')
          const got = range ? Number(range.split('-')[1]) + 1 : offset + len
          offset = Number.isFinite(got) ? got : offset + len
        } else offset += len
      }
    } finally {
      await fh.close()
    }
  }

  return {
    label: `Google Drive${o.account ? ` (${o.account})` : ''}`,
    async ensureDir(path) {
      await folderId(path)
    },
    put: putFile,
    async remove(path) {
      const file = await existing(path)
      if (file) {
        await call('PATCH', `${api}/files/${file.id}?fields=id`, { json: { trashed: true } })
        return
      }
      // A folder: its id, if we have made it.
      const id = folders.get(path)
      if (id) {
        await call('PATCH', `${api}/files/${id}?fields=id`, { json: { trashed: true } })
        folders.delete(path)
        for (const k of [...folders.keys()]) if (k.startsWith(`${path}/`)) folders.delete(k)
      }
    },
    async move(from, to) {
      const file = await existing(from)
      if (!file) return false
      const newParent = await folderId(parentOf(to))
      const oldParent = file.parents?.[0]
      const qs = new URLSearchParams({ fields: 'id', addParents: newParent, ...(oldParent && oldParent !== newParent ? { removeParents: oldParent } : {}) })
      await call('PATCH', `${api}/files/${file.id}?${qs}`, { json: { name: baseName(to), appProperties: { sad: '1', path: to } } })
      return true
    },
    async list() {
      const out = new Map<string, BackupItem>()
      const files = await find(`appProperties has { key='sad' and value='1' } and trashed = false`, 'files(id,name,mimeType,size,appProperties)')
      for (const x of files) {
        const p = x.appProperties?.path
        if (!p) continue
        out.set(p, { etag: x.appProperties?.etag ?? '', size: Number(x.size ?? 0), kind: x.mimeType === FOLDER ? 'dir' : 'file' })
      }
      return out
    },
  }
}
