import {
  CRM_UPLOAD_PART,
  type CrmUpload,
  type CrmUploadLimitFrom,
  type CrmUploadList,
  type CrmUploadSettingsChange,
  type CrmUploadSettingsView,
  type CrmUploadSpace,
  type CrmUploadState,
} from './crm-files.ts'

// od0b1 (U1): the page's helper for the agent's uploads in parts (shared/crm-files.ts, /uploads/*). It sends each file to the agent in parts (CRM_UPLOAD_PART, 8 MiB), strictly in order,
// `parallel` files at a time; a part that fails (the agent restarting, the Wi-Fi dropping) is sent again after a growing wait, from where the AGENT says it is; it reads the list while
// anything is going, and tells the page (subscribe) what to show. Once the agent has every byte the page may close: the agent finishes by itself. After a reload the page calls refresh():
// an upload the agent still waits bytes for shows `needsFile`, and resumeWith(id, file) goes on with the same file picked again (the same name, size and date).
// It knows nothing of React and holds no secret: the page's own sign-in cookie goes with every call (same origin). DOM-free, so it runs (and is tested) on Node too.
//
// Wiring (Web): const up = crmUploader({ base: `${AGENT_API_PREFIX}${CRM_FILES_BASE}`, sendPart: xhrSendPart(XMLHttpRequest) })
//   up.subscribe(list => setRows(list)); await up.refresh()
//   new file: up.add({ kind: 'new', parent: folder.id }, file)   new version: up.add({ kind: 'version', id: fileNode.id }, file)
//   rows: name, size, sent/size (Google), received/size (this PC), state, note ?? pageNote, needsFile -> "Pick the file again" -> up.resumeWith(id, file)
//   buttons: pause / resume / retry / cancel (ends the upload, never deletes a file) / clear (a done or cancelled row)

/** A file as the helper needs it: a browser File is one. */
export interface UploadFile {
  name: string
  size: number
  type?: string
  lastModified?: number
  slice(start: number, end: number): Blob
}

export type UploadTarget = { kind: 'new'; parent: string } | { kind: 'version'; id: string }

/** Sends one part: PUT `url` with `body`; resolves with the agent's status and JSON answer (status 0 never: a line that did not answer rejects). */
export type SendPart = (url: string, body: Blob, o: { signal: AbortSignal; headers: Record<string, string>; onProgress(loaded: number): void }) => Promise<{ status: number; body: unknown }>

export interface UploaderOptions {
  /** The routes' base, e.g. '/agent-api/agentic/crm-files'. */
  base: string
  fetch?: typeof fetch
  /** Extra headers (tests: the app token). */
  headers?: Record<string, string>
  /** The page passes xhrSendPart(XMLHttpRequest) for progress inside a part; the default (fetch) says each part only when it is in. */
  sendPart?: SendPart
  /** Files sent at the same time (default 3). */
  parallel?: number
  /** Bytes per part (default CRM_UPLOAD_PART, 8 MiB). */
  partSize?: number
  /** How often the list is read while anything is going (ms, default 1000). */
  pollMs?: number
  /** The wait before try `tries` of a failed part (ms; default 1 s, 2 s, 4 s ... 30 s). */
  delay?: (tries: number) => number
}

export interface UploadView extends CrmUpload {
  /** Bytes of the part on its way from this page right now. */
  sending: number
  /** This page holds the file (it can send the rest). */
  local: boolean
  /** The agent waits for bytes this page does not hold: pick the same file again (resumeWith). */
  needsFile: boolean
  /** This page's own trouble sending (the agent cannot be reached), in plain words; null when none. */
  pageNote: string | null
}

export class CrmUploadError extends Error {
  code: string
  status: number
  upload?: CrmUpload
  constructor(message: string, code = 'other', status = 0, upload?: CrmUpload) {
    super(message)
    this.name = 'CrmUploadError'
    this.code = code
    this.status = status
    if (upload) this.upload = upload
  }
}

export interface Uploader {
  /** Checks it with the agent (rights, name, size, kind of file, room on its disk) and starts sending. Rejects with the agent's reason (CrmUploadError) when it may not go. */
  add(target: UploadTarget, file: UploadFile): Promise<UploadView>
  /** After a reload: the same file again (same name for a new file, same size and date), and the sending goes on from where the agent is. */
  resumeWith(id: string, file: UploadFile): Promise<UploadView>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  retry(id: string): Promise<void>
  /** Ends the upload (the agent drops its copy); nothing in the CRM is touched. */
  cancel(id: string): Promise<void>
  /** Forgets a done or cancelled row. */
  clear(id: string): Promise<void>
  /** Reads the agent's list now. */
  refresh(): Promise<void>
  list(): UploadView[]
  subscribe(cb: (list: UploadView[]) => void): () => void
  /** oa2f8: the waiting folder, its free space, what the uploads hold, the warning (from the last list read; null before the first, or from an older agent). Subscribers are told when it changes. */
  space(): CrmUploadSpace | null
  /** oa2f8: the most one file may be now, and where that comes from (from the last list read; null before the first). */
  limit(): { maxSize: number; from: CrmUploadLimitFrom | null } | null
  /** oa2f8: the uploads' settings (GET /uploads/settings). Rejects with CrmUploadError (404 from an older agent). */
  settings(): Promise<CrmUploadSettingsView>
  /** oa2f8: changes some of them. Rejects with the agent's reason (409 'conflict' while uploads wait in the folder). */
  saveSettings(c: CrmUploadSettingsChange): Promise<CrmUploadSettingsView>
  /** Stops sending and polling (the agent keeps what it has). */
  dispose(): void
}

const ACTIVE: readonly CrmUploadState[] = ['receiving', 'waiting', 'sending', 'saving']
const WANTS_BYTES: readonly CrmUploadState[] = ['receiving', 'waiting', 'sending', 'paused']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const asUpload = (v: unknown): CrmUpload | null => (isObject(v) && typeof v.id === 'string' && typeof v.received === 'number' && typeof v.size === 'number' ? (v as unknown as CrmUpload) : null)

const OFFLINE = "This PC's agent can't be reached right now. Trying again."

function randomKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return `p-${c.randomUUID()}`
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** The default way to send a part: fetch (the whole part, then its answer). */
export function fetchSendPart(f: typeof fetch = fetch): SendPart {
  return async (url, body, o) => {
    const res = await f(url, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream', ...o.headers }, signal: o.signal, credentials: 'same-origin' })
    const b: unknown = await res.json().catch(() => null)
    if (res.ok) o.onProgress(body.size)
    return { status: res.status, body: b }
  }
}

/** What the helper needs of XMLHttpRequest (so this file needs no DOM types). */
export interface XhrLike {
  open(method: string, url: string): void
  setRequestHeader(name: string, value: string): void
  withCredentials: boolean
  upload: { onprogress: ((e: { loaded: number }) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  ontimeout: (() => void) | null
  status: number
  responseText: string
  send(body: unknown): void
  abort(): void
}

/** A part through XMLHttpRequest, which says how much of it has gone (fetch can't). The page passes its XMLHttpRequest. */
export function xhrSendPart(Xhr: new () => XhrLike): SendPart {
  return (url, body, o) =>
    new Promise((resolve, reject) => {
      const x = new Xhr()
      x.open('PUT', url)
      x.withCredentials = true
      x.setRequestHeader('Content-Type', 'application/octet-stream')
      for (const [k, v] of Object.entries(o.headers)) x.setRequestHeader(k, v)
      x.upload.onprogress = e => o.onProgress(e.loaded)
      x.onload = () => {
        let b: unknown = null
        try {
          b = JSON.parse(x.responseText)
        } catch {
          // no body
        }
        resolve({ status: x.status, body: b })
      }
      x.onerror = () => reject(new Error('offline'))
      x.ontimeout = x.onerror
      x.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (o.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      o.signal.addEventListener('abort', () => x.abort(), { once: true })
      x.send(body)
    })
}

interface Local {
  file: UploadFile
  sending: number
  ctl: AbortController | null
  /** In the queue or sending now. */
  queued: boolean
  stopped: boolean
  tries: number
  pageNote: string | null
}

export function crmUploader(o: UploaderOptions): Uploader {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const base = o.base.replace(/\/+$/, '')
  const headers = o.headers ?? {}
  const sendPart = o.sendPart ?? fetchSendPart(f)
  const parallel = Math.max(1, o.parallel ?? 3)
  const partSize = Math.max(1, o.partSize ?? CRM_UPLOAD_PART)
  const pollMs = o.pollMs ?? 1000
  const delay = o.delay ?? ((tries: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, tries - 1)))

  const views = new Map<string, CrmUpload>()
  const locals = new Map<string, Local>()
  const queue: string[] = []
  const subs = new Set<(list: UploadView[]) => void>()
  let active = 0
  let disposed = false
  let poll: ReturnType<typeof setTimeout> | null = null
  let lastSpace: CrmUploadSpace | null = null
  let lastLimit: { maxSize: number; from: CrmUploadLimitFrom | null } | null = null

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await f(base + path, {
        method,
        credentials: 'same-origin',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new CrmUploadError(OFFLINE.replace(' Trying again.', ''), 'offline')
    }
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const d = isObject(data) ? data : {}
      throw new CrmUploadError(typeof d.error === 'string' ? d.error : `The agent answered ${res.status}.`, typeof d.code === 'string' ? d.code : 'other', res.status, asUpload(d.upload) ?? undefined)
    }
    return data as T
  }

  function viewOf(u: CrmUpload): UploadView {
    const l = locals.get(u.id)
    const ended = u.state === 'done' || u.state === 'cancelled'
    return {
      ...u,
      sending: l?.sending ?? 0,
      local: !!l && !ended,
      needsFile: !l && !ended && u.received < u.size && WANTS_BYTES.includes(u.state),
      pageNote: l?.pageNote ?? null,
    }
  }

  function list(): UploadView[] {
    return [...views.values()].sort((a, b) => b.createdAt - a.createdAt).map(viewOf)
  }

  function emit() {
    const l = list()
    for (const cb of subs) {
      try {
        cb(l)
      } catch {
        // a subscriber's own trouble
      }
    }
  }

  function put(u: CrmUpload) {
    views.set(u.id, u)
    if (u.state === 'done' || u.state === 'cancelled' || u.state === 'failed') {
      const l = locals.get(u.id)
      if (l && u.state !== 'failed') locals.delete(u.id)
    }
  }

  function schedulePoll() {
    if (disposed || poll) return
    const going = [...views.values()].some(u => ACTIVE.includes(u.state)) || active > 0
    if (!going) return
    poll = setTimeout(() => {
      poll = null
      void refresh().catch(() => undefined)
    }, pollMs)
  }

  async function refresh() {
    if (disposed) return
    const r = await call<CrmUploadList>('GET', '/uploads')
    // oa2f8: the waiting folder's space and the limit in force (an older agent leaves them out).
    lastSpace = r.space ?? null
    lastLimit = typeof r.maxSize === 'number' ? { maxSize: r.maxSize, from: r.maxSizeFrom ?? null } : null
    const seen = new Set<string>()
    for (const u of r.uploads) {
      seen.add(u.id)
      put(u)
    }
    for (const id of [...views.keys()]) if (!seen.has(id)) views.delete(id)
    emit()
    schedulePoll()
  }

  function enqueue(id: string) {
    const l = locals.get(id)
    if (!l || l.queued || disposed) return
    l.queued = true
    l.stopped = false
    queue.push(id)
    pump()
  }

  function pump() {
    while (active < parallel && queue.length && !disposed) {
      const id = queue.shift()!
      active++
      void sendAll(id).finally(() => {
        active--
        const l = locals.get(id)
        if (l) {
          l.queued = false
          l.sending = 0
        }
        emit()
        pump()
        schedulePoll()
      })
    }
  }

  const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  async function sendAll(id: string) {
    const l = locals.get(id)
    let u = views.get(id)
    while (l && u && !l.stopped && !disposed && u.received < u.size && (u.state === 'receiving' || u.state === 'waiting' || u.state === 'sending')) {
      const start = u.received
      const end = Math.min(u.size, start + partSize)
      const ctl = new AbortController()
      l.ctl = ctl
      try {
        const r = await sendPart(`${base}/uploads/part?id=${encodeURIComponent(id)}&offset=${start}`, l.file.slice(start, end), {
          signal: ctl.signal,
          headers,
          onProgress: n => {
            l.sending = Math.min(n, end - start)
            emit()
          },
        })
        l.ctl = null
        const b = isObject(r.body) ? r.body : {}
        const answered = asUpload(r.status === 200 ? r.body : b.upload)
        if (answered) {
          put(answered)
          u = answered
        }
        l.sending = 0
        if (r.status === 200) {
          l.tries = 0
          l.pageNote = null
          emit()
          continue
        }
        if (r.status === 409 && answered) {
          // 'offset': go on from where the agent is; 'busy': its last part is still being written; 'paused' or ended: stop.
          if (b.code === 'offset') continue
          if (b.code === 'busy') {
            await wait(300)
            continue
          }
          break
        }
        if (r.status >= 500 || r.status === 408 || r.status === 429) throw new Error(`agent ${r.status}`)
        // Refused for good (the upload is unknown, a part the agent will not take, its disk is full): say so and stop sending.
        l.pageNote = typeof b.error === 'string' ? b.error : `The agent answered ${r.status}.`
        emit()
        break
      } catch (e) {
        l.ctl = null
        l.sending = 0
        if (l.stopped || disposed || (e as Error)?.name === 'AbortError') break
        l.tries++
        l.pageNote = OFFLINE
        emit()
        await wait(delay(l.tries))
        if (l.stopped || disposed) break
        // Where is the agent now (it may have restarted, or taken the part before the line broke)?
        try {
          u = await call<CrmUpload>('GET', `/uploads?id=${encodeURIComponent(id)}`)
          put(u)
          l.pageNote = null
          emit()
        } catch (e2) {
          if (e2 instanceof CrmUploadError && e2.status === 404) {
            l.pageNote = e2.message
            emit()
            break
          }
        }
      }
    }
  }

  function sameFile(u: CrmUpload, file: UploadFile): boolean {
    if (file.size !== u.size) return false
    if (u.kind === 'new' && file.name !== u.name) return false
    if (u.lastModified !== undefined && file.lastModified !== undefined && file.lastModified !== u.lastModified) return false
    return true
  }

  return {
    async add(target, file) {
      const body = {
        kind: target.kind,
        target: target.kind === 'new' ? target.parent : target.id,
        name: file.name,
        type: file.type ?? '',
        size: file.size,
        ...(typeof file.lastModified === 'number' ? { lastModified: Math.floor(file.lastModified) } : {}),
        clientKey: randomKey(),
      }
      // The same key makes a repeated start the same upload, so a start whose answer was lost is simply asked again.
      let u: CrmUpload | null = null
      for (let i = 0; !u; i++) {
        try {
          u = await call<CrmUpload>('POST', '/uploads/start', body)
        } catch (e) {
          if (!(e instanceof CrmUploadError) || e.code !== 'offline' || i >= 2) throw e
          await wait(delay(i + 1))
        }
      }
      put(u)
      locals.set(u.id, { file, sending: 0, ctl: null, queued: false, stopped: false, tries: 0, pageNote: null })
      if (u.received < u.size) enqueue(u.id)
      emit()
      schedulePoll()
      return viewOf(u)
    },

    async resumeWith(id, file) {
      const u = views.get(id) ?? (await call<CrmUpload>('GET', `/uploads?id=${encodeURIComponent(id)}`))
      if (!sameFile(u, file)) throw new CrmUploadError(`That is not the same file as “${u.name}” (${u.size} bytes). Pick that one.`, 'notsame')
      put(u)
      const l = locals.get(id)
      if (l) l.file = file
      else locals.set(id, { file, sending: 0, ctl: null, queued: false, stopped: false, tries: 0, pageNote: null })
      if (u.state === 'paused') put(await call<CrmUpload>('POST', '/uploads/resume', { id }))
      enqueue(id)
      emit()
      return viewOf(views.get(id)!)
    },

    async pause(id) {
      const l = locals.get(id)
      if (l) {
        l.stopped = true
        l.ctl?.abort()
      }
      put(await call<CrmUpload>('POST', '/uploads/pause', { id }))
      emit()
    },

    async resume(id) {
      put(await call<CrmUpload>('POST', '/uploads/resume', { id }))
      enqueue(id)
      emit()
      schedulePoll()
    },

    async retry(id) {
      const l = locals.get(id)
      if (l) {
        l.tries = 0
        l.pageNote = null
      }
      put(await call<CrmUpload>('POST', '/uploads/retry', { id }))
      enqueue(id)
      emit()
      schedulePoll()
    },

    async cancel(id) {
      const l = locals.get(id)
      if (l) {
        l.stopped = true
        l.ctl?.abort()
      }
      const i = queue.indexOf(id)
      if (i >= 0) queue.splice(i, 1)
      put(await call<CrmUpload>('POST', '/uploads/cancel', { id }))
      locals.delete(id)
      emit()
    },

    async clear(id) {
      await call<{ ok: true }>('POST', '/uploads/clear', { id })
      views.delete(id)
      locals.delete(id)
      emit()
    },

    refresh,
    list,

    subscribe(cb) {
      subs.add(cb)
      return () => void subs.delete(cb)
    },

    space: () => lastSpace,
    limit: () => lastLimit,

    settings: () => call<CrmUploadSettingsView>('GET', '/uploads/settings'),

    async saveSettings(c) {
      const v = await call<CrmUploadSettingsView>('POST', '/uploads/settings', c)
      lastSpace = v.space
      lastLimit = { maxSize: v.maxSize, from: v.maxSizeFrom }
      void refresh().catch(() => undefined)
      return v
    },

    dispose() {
      disposed = true
      if (poll) clearTimeout(poll)
      poll = null
      for (const l of locals.values()) {
        l.stopped = true
        l.ctl?.abort()
      }
      queue.length = 0
      subs.clear()
    },
  }
}
