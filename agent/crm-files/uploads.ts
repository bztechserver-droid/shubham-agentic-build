import { createHash, randomUUID, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, statfs, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  CRM_FILES_MAX_UPLOAD,
  CRM_UPLOAD_CHUNK,
  CRM_UPLOAD_MAX_PART,
  CRM_UPLOAD_PARALLEL,
  CRM_UPLOAD_PART,
  CRM_UPLOAD_REASONS,
  CRM_UPLOAD_UNIT,
  type CrmFilesErrorCode,
  type CrmNode,
  type CrmUpload,
  type CrmUploadKind,
  type CrmUploadList,
  type CrmUploadStart,
  type CrmUploadState,
} from '../../shared/crm-files.ts'
import { CrmFilesError, type CrmUploadBackend } from './service.ts'

// od0b1 (U1): uploads of any size the CRM takes, held by the AGENT, so a big file never has to go up in one request (the 50 MB WebDAV limit, a 5-minute request, a closed page).
//
// The page sends the file to this PC in parts (PUT /uploads/part: any size up to CRM_UPLOAD_MAX_PART, strictly in order). Each part is written to this upload's file in the pending folder and
// flushed to the disk before it is acknowledged; the journal next to it (<id>.json) says how much is here, and is written only after that, so after a crash or a restart the agent never
// claims bytes it does not have. A worker sends what is here on to Google Drive through ONE resumable session (the way the CRM's own pages upload, with the CRM's token), in pieces of
// CRM_UPLOAD_CHUNK (a multiple of Google's 256 KiB unit), as soon as a whole piece is here: so a slow page and a slow Google overlap. At most `parallel` uploads go at once.
// A broken line, a busy Google or a CRM that does not answer is retried with growing waits (1 s, 2 s, 4 s ... 5 min, for ever: a file waits on this PC until it is up); after a break
// Google is first asked how far it got ("bytes */size") and the upload goes on from there. A session Google forgot (404) starts again from the first byte.
// At the end Google's answer is checked: its size, and its md5 against the md5 of what this PC received (counted while the parts came in, or read again from the file after a restart);
// only then is the CRM told (its record, or the new version), as the one-request upload does. The CRM is told once: a try whose answer was lost is found by its key before a second one.
// A refusal that will not go away by waiting (no right any more, a refused kind of file, a checksum that differs) stops the upload as 'failed', keeps the bytes, and says why.
//
// Nothing is ever deleted: no DELETE to Google (a cancelled session simply lapses after a week), no file of the CRM touched; the only file the agent removes is its OWN copy in the pending
// folder, once the CRM has the file or the person cancels. The session address is a credential for that one upload: it is kept only in the journal, never logged, never given to a page.

export interface CrmUploadsOptions {
  /** The pending folder (the agent's own state folder): <id>.json (the journal) and <id>.part (the bytes). */
  dir: string
  backend: CrmUploadBackend
  log?: { info(m: string): void; warn(m: string): void }
  now?: () => number
  /** The most one file may be: the CRM's own rule (500 MB) unless a test says otherwise. */
  maxSize?: number
  /** Bytes per request to Google; a multiple of 256 KiB. */
  chunk?: number
  /** How many uploads go to Google at once. */
  parallel?: number
  /** How many uploads the agent holds at most (done and cancelled ones not counted). */
  maxHeld?: number
  /** The wait before try number `tries` after a failure (ms). */
  delay?: (tries: number) => number
  /** No byte moved for this long while sending: the request is dropped and retried (ms). */
  stallMs?: number
  /** After the last byte of a piece, how long Google may take to answer (ms). */
  answerMs?: number
  /** How long a done or cancelled upload stays in the list (ms). */
  keepEndedMs?: number
  /** Free bytes on the disk that holds `dir` (tests). */
  freeBytes?: (dir: string) => Promise<number>
  /** Kept free on that disk on top of what the uploads still need. */
  reserveBytes?: number
}

export interface CrmUploads {
  /** Reads the journal (uploads that were going on when the agent stopped) and carries on. Call once. */
  start(): Promise<void>
  list(): CrmUploadList
  get(id: string): CrmUpload
  /** Checks everything first (the CRM's rules, the size, the room on this PC's disk); nothing is sent yet. */
  begin(p: CrmUploadStart): Promise<CrmUpload>
  /** The next bytes of the file from the page, at `offset` (it must be where the upload is), `length` of them. */
  receive(id: string, offset: number, body: Readable, length: number): Promise<CrmUpload>
  /** For the agent itself (a save through the drive): a whole file that is already on this PC is copied into the pending folder and goes up the same way. The file itself is never touched. */
  addFile(p: Omit<CrmUploadStart, 'size'>, file: string): Promise<CrmUpload>
  pause(id: string): Promise<CrmUpload>
  resume(id: string): Promise<CrmUpload>
  retry(id: string): Promise<CrmUpload>
  cancel(id: string): Promise<CrmUpload>
  /** Forgets a done or cancelled upload. */
  clear(id: string): Promise<void>
  /** How many are still to go up (the "waiting" count). */
  waiting(): number
  close(): Promise<void>
}

/** A refusal of the routes that also carries the upload as it is now (the page goes on from `upload.received`). */
export class CrmUploadRefusal extends CrmFilesError {
  upload: CrmUpload
  constructor(status: number, code: CrmFilesErrorCode, message: string, upload: CrmUpload) {
    super(status, code, message)
    this.upload = upload
  }
}

// ---- the journal ----------------------------------------------------------------------------------------------------------

interface Job {
  v: 1
  id: string
  kind: CrmUploadKind
  target: string
  name: string
  type: string
  size: number
  lastModified?: number
  clientKey?: string
  state: CrmUploadState
  received: number
  sent: number
  note: string | null
  code?: string
  retryAt?: number
  tries: number
  createdAt: number
  updatedAt: number
  /** Google's resumable session for this upload: a credential, kept here only. */
  session?: string
  sessionAt?: number
  /** The CRM's key for the file (server-sided-s3/...), and the type Google was told. */
  key?: string
  mime?: string
  /** How far Google got is not known (after a broken line, a pause or a restart): it is asked before the next piece. */
  unsure?: boolean
  /** Google's answer once it has every byte: kept until the CRM has its record, so a failure there never sends the bytes again. */
  drive?: { id: string; url: string; md5?: string; size?: number }
  /** The CRM was asked for the record at least once: a later try looks for it first. */
  recordTried?: boolean
  /** The md5 of all the bytes received (hex), once known. */
  md5?: string
  checked?: 'md5' | 'size'
  node?: CrmNode
  savedAs?: string
}

/** What only this process knows about an upload. */
interface Live {
  /** The md5 of the first `hashAt` bytes, counted as the parts arrive (lost at a restart: then the file is read again at the end). */
  hash: Hash | null
  hashAt: number
  /** A part is arriving now. */
  receiving: boolean
  /** A step (a piece, a question, the record) is going now. */
  running: boolean
  step: 'open' | 'ask' | 'send' | 'finish' | null
  abort: AbortController | null
  stop: 'pause' | 'cancel' | 'close' | null
  /** Journal writes, one after the other. */
  writing: Promise<void>
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ENDED: readonly CrmUploadState[] = ['done', 'cancelled']
const ACTIVE: readonly CrmUploadState[] = ['receiving', 'waiting', 'sending', 'saving']
const STATES: readonly CrmUploadState[] = ['receiving', 'waiting', 'sending', 'saving', 'paused', 'failed', 'done', 'cancelled']
const EMPTY_MD5 = createHash('md5').digest('hex')

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function isJob(v: unknown): v is Job {
  if (!isObject(v)) return false
  return (
    v.v === 1 &&
    typeof v.id === 'string' &&
    ID.test(v.id) &&
    (v.kind === 'new' || v.kind === 'version') &&
    typeof v.target === 'string' &&
    typeof v.name === 'string' &&
    typeof v.type === 'string' &&
    isCount(v.size) &&
    isCount(v.received) &&
    isCount(v.sent) &&
    STATES.includes(v.state as CrmUploadState) &&
    isCount(v.createdAt)
  )
}

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Any web address in a message is replaced: an error from the network can name the session address, which must never reach a log or a page. */
export function scrub(s: string): string {
  return s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<address>').replace(/upload_id=\S+/gi, 'upload_id=<hidden>')
}

/** Bytes=0-N in Google's Range header: N+1 bytes are in; no header: none. */
export function rangeEnd(range: string | null): number {
  const m = /^bytes=0-(\d+)$/.exec((range ?? '').trim())
  return m ? Number(m[1]) + 1 : 0
}

/** The default waits: 1 s, 2 s, 4 s ... then every 5 minutes, with a little spread so many uploads do not all knock at once. */
function defaultDelay(tries: number): number {
  const base = Math.min(300_000, 1000 * 2 ** Math.max(0, Math.min(tries - 1, 9)))
  return Math.round(base * (1 + Math.random() * 0.2))
}

async function defaultFree(dir: string): Promise<number> {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** A failure that goes away by waiting (a broken line, a busy Google, a CRM that does not answer, the CRM signed out). */
class Transient extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** A failure that waiting will not cure: the upload stops as 'failed' and says why. */
class Permanent extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function createCrmUploads(o: CrmUploadsOptions): CrmUploads {
  const dir = o.dir
  const backend = o.backend
  const now = o.now ?? Date.now
  const maxSize = o.maxSize ?? CRM_FILES_MAX_UPLOAD
  const chunk = o.chunk ?? CRM_UPLOAD_CHUNK
  if (!(chunk > 0 && chunk % CRM_UPLOAD_UNIT === 0)) throw new Error('The chunk must be a whole number of 256 KiB units.')
  const parallel = Math.max(1, o.parallel ?? CRM_UPLOAD_PARALLEL)
  const maxHeld = o.maxHeld ?? 200
  const delay = o.delay ?? defaultDelay
  const stallMs = o.stallMs ?? 60_000
  const answerMs = o.answerMs ?? 120_000
  const keepEndedMs = o.keepEndedMs ?? 24 * 3600_000
  const freeBytes = o.freeBytes ?? defaultFree
  const reserve = o.reserveBytes ?? 512 * 1024 * 1024
  const log = o.log
  const gfetch = backend.fetch

  const jobs = new Map<string, Job>()
  const lives = new Map<string, Live>()
  let running = 0
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let started: Promise<void> | null = null

  const partOf = (id: string) => path.join(dir, `${id}.part`)
  const journalOf = (id: string) => path.join(dir, `${id}.json`)
  const short = (j: Job) => j.id.slice(0, 8)

  function live(j: Job): Live {
    let l = lives.get(j.id)
    if (!l) {
      l = { hash: null, hashAt: 0, receiving: false, running: false, step: null, abort: null, stop: null, writing: Promise.resolve() }
      lives.set(j.id, l)
    }
    return l
  }

  function view(j: Job): CrmUpload {
    return {
      id: j.id,
      kind: j.kind,
      target: j.target,
      name: j.name,
      type: j.type,
      size: j.size,
      ...(j.lastModified !== undefined ? { lastModified: j.lastModified } : {}),
      ...(j.clientKey ? { clientKey: j.clientKey } : {}),
      received: j.received,
      sent: j.sent,
      state: j.state,
      note: j.note,
      ...(j.code ? { code: j.code } : {}),
      ...(j.retryAt && j.note ? { retryAt: j.retryAt } : {}),
      ...(j.checked ? { checked: j.checked } : {}),
      ...(j.node ? { node: j.node } : {}),
      ...(j.savedAs ? { savedAs: j.savedAs } : {}),
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    }
  }

  async function writeJournal(j: Job) {
    const file = journalOf(j.id)
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(j))
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, file)
        return
      } catch (e) {
        // Windows: a scanner may hold the old journal for a moment.
        const code = (e as NodeJS.ErrnoException).code ?? ''
        if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e
        await sleep(25 * (i + 1))
      }
    }
  }

  /** Writes the journal now (after the ones before it); resolves when it is on the disk. */
  function save(j: Job): Promise<void> {
    j.updatedAt = now()
    const l = live(j)
    const p = l.writing.then(() => writeJournal(j))
    l.writing = p.catch(e => log?.warn(`upload ${short(j)}: its journal could not be written (${scrub(e instanceof Error ? e.message : String(e))})`))
    return p
  }

  /** Removes the agent's OWN copy of an ended upload (never anything else). Windows: a scanner may hold a new file for a moment, so it is tried a few times; one that stays is tried again at the next start. */
  async function dropCopy(j: Job): Promise<void> {
    for (let i = 0; i < 6; i++) {
      try {
        await rm(partOf(j.id), { force: true })
        return
      } catch {
        await sleep(50 * (i + 1))
      }
    }
    log?.warn(`upload ${short(j)}: its copy in the pending folder could not be removed yet; it is tried again at the next start`)
  }

  function jobOf(id: string): Job {
    const j = typeof id === 'string' && ID.test(id) ? jobs.get(id) : undefined
    if (!j) throw new CrmFilesError(404, 'notfound', CRM_UPLOAD_REASONS.gone)
    return j
  }

  /** Where an upload that is not paused, failed or ended stands now. */
  function activeState(j: Job): CrmUploadState {
    if (j.received < j.size) return 'receiving'
    if (j.drive) return 'saving'
    return j.session ? 'sending' : 'waiting'
  }

  function ok(j: Job) {
    j.note = null
    delete j.code
    delete j.retryAt
  }

  /** The Google or CRM side went well: its note goes (a "pick the file again" note is the page's, and stays until the page sends). */
  function sideOk(j: Job) {
    if (j.code === 'need-file') delete j.retryAt
    else ok(j)
  }

  // ---- the worker -------------------------------------------------------------------------------------------------------

  type Step = 'open' | 'ask' | 'send' | 'finish'

  function stepOf(j: Job): Step | null {
    if (!ACTIVE.includes(j.state)) return null
    const l = live(j)
    if (l.running) return null
    if (j.retryAt && j.retryAt > now()) return null
    if (j.drive) return 'finish'
    if (!j.session) return j.received === j.size || j.received >= chunk ? 'open' : null
    if (j.unsure) return 'ask'
    if (j.size === 0) return 'send'
    if (j.sent >= j.size) return 'ask'
    if (j.received === j.size) return 'send'
    return j.received - j.sent >= chunk ? 'send' : null
  }

  function pump() {
    if (closed) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    while (running < parallel) {
      let next: Job | null = null
      let step: Step | null = null
      for (const j of jobs.values()) {
        const s = stepOf(j)
        if (s && (!next || j.createdAt < next.createdAt)) {
          next = j
          step = s
        }
      }
      if (!next || !step) break
      void run(next, step)
    }
    // The next try of one that waits.
    let at = Infinity
    for (const j of jobs.values()) if (ACTIVE.includes(j.state) && j.retryAt && j.retryAt > now() && !live(j).running) at = Math.min(at, j.retryAt)
    if (at !== Infinity) {
      timer = setTimeout(pump, Math.max(10, at - now() + 5))
      timer.unref?.()
    }
  }

  async function run(j: Job, step: Step) {
    const l = live(j)
    l.running = true
    l.step = step
    l.stop = null
    running++
    try {
      if (step !== 'finish' && j.received === j.size && (j.state === 'waiting' || j.state === 'receiving')) j.state = 'sending'
      if (step === 'open') await stepOpen(j)
      else if (step === 'ask') await stepAsk(j)
      else if (step === 'send') await stepSend(j)
      else await stepFinish(j)
    } catch (e) {
      await failed(j, step, e)
    } finally {
      l.running = false
      l.step = null
      l.abort = null
      running--
      pump()
    }
  }

  async function failed(j: Job, step: Step, e: unknown) {
    const l = live(j)
    if (l.stop) {
      // Paused, cancelled or the agent closing: not a failure. How far Google got is asked next time.
      if (j.session && !j.drive && l.stop !== 'cancel') {
        j.unsure = true
        await save(j).catch(() => undefined)
      }
      return
    }
    if (j.state === 'cancelled' || j.state === 'paused') return
    if (j.session && !j.drive && (step === 'send' || step === 'ask')) j.unsure = true
    const why = classify(e)
    if (why instanceof Transient) {
      j.tries++
      j.note = why.message
      j.code = why.code
      j.retryAt = now() + (why.code === 'session' && j.tries <= 2 ? 0 : delay(j.tries))
      j.state = activeState(j)
      log?.warn(`upload ${short(j)} ("${j.name}"): ${why.message} (try ${j.tries}; next in ${Math.round((j.retryAt - now()) / 1000)} s)`)
    } else {
      j.state = 'failed'
      j.note = why.message
      j.code = why.code
      delete j.retryAt
      log?.warn(`upload ${short(j)} ("${j.name}") stopped: ${why.message}`)
    }
    await save(j).catch(() => undefined)
  }

  function classify(e: unknown): Transient | Permanent {
    if (e instanceof Transient || e instanceof Permanent) return e
    if (e instanceof CrmFilesError) {
      if (e.code === 'crm-signin') return new Transient('crm-signin', CRM_UPLOAD_REASONS.signIn)
      if (e.code === 'crm-down') return new Transient('crm-down', CRM_UPLOAD_REASONS.crmDown)
      if (e.upstream) return googleStatus(e.upstream.status, e.upstream.reason)
      // oa2f8: an answer that is not what the agent needs (the CRM's or Google's) is waited for like a busy line, but with its OWN words: the first real test showed "Google Drive did not
      // take it" for a CRM answer that had no organisation in it.
      if (e.code === 'failed' && e.status >= 500) return new Transient('failed', `${scrub(e.message).replace(/\.?$/, '.')} Trying again.`)
      return new Permanent(e.code, scrub(e.message))
    }
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return new Permanent('copy-gone', CRM_UPLOAD_REASONS.copyGone)
    // A broken or stalled line (fetch threw), a disk that hiccupped.
    return new Transient('network', CRM_UPLOAD_REASONS.network)
  }

  /** Google's status (and reason word) as a wait or a stop. */
  function googleStatus(status: number, reason?: string): Transient | Permanent {
    if (status === 408 || status === 429 || status >= 500) return new Transient('google', CRM_UPLOAD_REASONS.google)
    if (status === 401) return new Transient('google', CRM_UPLOAD_REASONS.google)
    if (status === 403 && reason && /rate ?limit|backendError/i.test(reason)) return new Transient('google', CRM_UPLOAD_REASONS.google)
    const why = reason === 'storageQuotaExceeded' ? ' Its storage is full.' : ''
    return new Permanent('google', `${CRM_UPLOAD_REASONS.googleRefused.replace(/\.$/, '')} (${status}${reason ? `, ${reason}` : ''}).${why}`)
  }

  async function stepOpen(j: Job) {
    const s = await backend.open(j.name, j.type, j.size)
    j.session = s.session
    j.sessionAt = now()
    j.key = s.key
    j.mime = s.mime
    j.sent = 0
    j.unsure = false
    sideOk(j)
    await save(j)
    log?.info(`upload ${short(j)} ("${j.name}", ${sizeText(j.size)}): Google Drive session open`)
  }

  // Asks Google how far it got (an empty PUT with Content-Range "bytes */size").
  async function stepAsk(j: Job) {
    const l = live(j)
    const ac = new AbortController()
    l.abort = ac
    const t = setTimeout(() => ac.abort(), answerMs)
    try {
      const res = await gfetch(j.session as string, { method: 'PUT', headers: { 'content-length': '0', 'content-range': `bytes */${j.size}` }, signal: ac.signal })
      await answer(j, res)
    } finally {
      clearTimeout(t)
    }
  }

  /** Sends the next piece: from where Google is, CRM_UPLOAD_CHUNK bytes (or the rest, when it is the last). */
  async function stepSend(j: Job) {
    const l = live(j)
    const start = j.sent
    const end = j.received === j.size ? Math.min(j.size, start + chunk) : start + chunk
    const length = end - start
    const ac = new AbortController()
    l.abort = ac
    let t: NodeJS.Timeout | null = null
    const arm = (ms: number) => {
      if (t) clearTimeout(t)
      t = setTimeout(() => ac.abort(), ms)
    }
    const src = length > 0 ? createReadStream(partOf(j.id), { start, end: end - 1, highWaterMark: 1024 * 1024 }) : null
    // The bytes are counted as the line takes them (pulled, so a stuck line stops them): no byte for stallMs, or no answer answerMs after the last, and the request is dropped.
    const body = src
      ? (Readable.toWeb(src) as unknown as ReadableStream<Uint8Array>).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(c, ctl) {
              arm(stallMs)
              ctl.enqueue(c)
            },
            flush() {
              arm(answerMs)
            },
          }),
        )
      : null
    arm(length > 0 ? stallMs : answerMs)
    try {
      const headers: Record<string, string> = length > 0 ? { 'content-type': j.mime || 'application/octet-stream', 'content-length': String(length), 'content-range': `bytes ${start}-${end - 1}/${j.size}` } : { 'content-length': '0' }
      const res = await gfetch(j.session as string, {
        method: 'PUT',
        headers,
        ...(body ? { body, duplex: 'half' } : {}),
        signal: ac.signal,
      } as RequestInit)
      await answer(j, res)
    } finally {
      if (t) clearTimeout(t)
      src?.destroy()
    }
    // Google took the piece but kept nothing of it: waited for like a failure, never sent again at once (no busy loop).
    if (!j.drive && j.sent <= start && length > 0) throw new Transient('google', CRM_UPLOAD_REASONS.google)
  }

  /** What Google said to a piece or to the question. */
  async function answer(j: Job, res: Response) {
    if (res.status === 308) {
      await res.body?.cancel().catch(() => undefined)
      const got = rangeEnd(res.headers.get('range'))
      if (got > j.size) throw new Permanent('google', `${CRM_UPLOAD_REASONS.googleRefused} (it says it has more bytes than the file).`)
      if (got > j.sent) j.tries = 0
      // Google may keep less than it was sent (a line that broke inside a piece): the upload goes on from what it has.
      j.sent = got
      j.unsure = false
      sideOk(j)
      await save(j)
      return
    }
    if (res.status === 200 || res.status === 201) {
      const d: unknown = await res.json().catch(() => null)
      const r = isObject(d) ? d : {}
      const id = typeof r.id === 'string' ? r.id : ''
      if (!id) throw new Transient('google', CRM_UPLOAD_REASONS.google)
      const url = (typeof r.webViewLink === 'string' && r.webViewLink) || (typeof r.webContentLink === 'string' && r.webContentLink) || `https://drive.google.com/uc?id=${id}`
      const md5 = typeof r.md5Checksum === 'string' && /^[0-9a-f]{32}$/i.test(r.md5Checksum) ? r.md5Checksum.toLowerCase() : undefined
      const size = typeof r.size === 'string' || typeof r.size === 'number' ? Number(r.size) : undefined
      j.drive = { id, url, ...(md5 ? { md5 } : {}), ...(size !== undefined && Number.isFinite(size) ? { size } : {}) }
      j.sent = j.size
      j.unsure = false
      await verify(j)
      j.state = 'saving'
      sideOk(j)
      await save(j)
      log?.info(`upload ${short(j)} ("${j.name}", ${sizeText(j.size)}): all in Google Drive (${j.checked === 'md5' ? 'md5 matches' : 'size matches'})`)
      return
    }
    // Google's reason word (only that is kept), read before the answer is dropped.
    let reason: string | undefined
    if (res.status === 403 || res.status === 429) {
      const b: unknown = await res.json().catch(() => null)
      const err = isObject(b) && isObject(b.error) ? b.error : null
      const first = err && Array.isArray(err.errors) && isObject(err.errors[0]) ? err.errors[0].reason : undefined
      reason = typeof first === 'string' && /^[A-Za-z_]{1,64}$/.test(first) ? first : undefined
    } else await res.body?.cancel().catch(() => undefined)
    if (res.status === 404 || res.status === 410) {
      // Google forgot the session (it lives a week): a new one, from the first byte.
      delete j.session
      delete j.sessionAt
      j.sent = 0
      j.unsure = false
      throw new Transient('session', 'Google Drive ended the upload session; starting it again.')
    }
    throw googleStatus(res.status, reason)
  }

  /** Google's copy against ours: the size, and the md5 where Google gives one. A mismatch stops before the CRM is told. */
  async function verify(j: Job) {
    const d = j.drive
    if (!d) return
    if (d.size !== undefined && d.size !== j.size) {
      fail(j)
      throw new Permanent('integrity', CRM_UPLOAD_REASONS.integrity)
    }
    if (d.md5) {
      if (!j.md5) j.md5 = await md5Of(j)
      if (j.md5 && j.md5 !== d.md5) {
        fail(j)
        throw new Permanent('integrity', CRM_UPLOAD_REASONS.integrity)
      }
      j.checked = j.md5 ? 'md5' : 'size'
    } else j.checked = 'size'
    function fail(x: Job) {
      log?.warn(`upload ${short(x)} ("${x.name}"): Google Drive's copy ${d?.id} does not match (size ${d?.size ?? '?'} of ${x.size}); it is left there, and no CRM record points at it`)
      delete x.drive
    }
  }

  /** The md5 of the received file, read again (after a restart the count kept while the parts came in is gone). Undefined if the copy is gone. */
  async function md5Of(j: Job): Promise<string | undefined> {
    if (j.size === 0) return EMPTY_MD5
    const h = createHash('md5')
    try {
      for await (const c of createReadStream(partOf(j.id), { start: 0, end: j.size - 1, highWaterMark: 1024 * 1024 })) h.update(c as Buffer)
    } catch {
      return undefined
    }
    return h.digest('hex')
  }

  async function stepFinish(j: Job) {
    const d = j.drive
    if (!d || !j.key) throw new Permanent('failed', 'The upload lost its place in Google Drive. Retry sends it again.')
    j.state = 'saving'
    const lookFirst = j.recordTried === true
    j.recordTried = true
    await save(j)
    const r = await backend.finish({ kind: j.kind, target: j.target, name: j.name, type: j.type, size: j.size, key: j.key, driveId: d.id, url: d.url, lookFirst })
    // The record is made: that is the truth now, whatever was pressed meanwhile.
    j.state = 'done'
    j.node = r.node
    if (r.savedAs) j.savedAs = r.savedAs
    ok(j)
    j.tries = 0
    // The session is not needed any more: the credential leaves the journal.
    delete j.session
    delete j.sessionAt
    await save(j)
    await dropCopy(j)
    live(j).hash = null
    log?.info(`upload ${short(j)} done: "${j.name}" (${sizeText(j.size)}) is in the CRM${r.savedAs ? ` as "${r.savedAs}"` : ''}; ${j.checked === 'md5' ? 'md5 checked' : 'size checked'}`)
  }

  // ---- the parts from the page --------------------------------------------------------------------------------------------

  async function receive(id: string, offset: number, body: Readable, length: number, maxPart = CRM_UPLOAD_MAX_PART): Promise<CrmUpload> {
    let j: Job
    try {
      if (closed) throw new CrmFilesError(503, 'failed', 'The agent is stopping. Send that part again in a moment.')
      j = jobOf(id)
      if (ENDED.includes(j.state)) throw new CrmUploadRefusal(409, 'conflict', CRM_UPLOAD_REASONS.ended, view(j))
      if (j.state === 'paused') throw new CrmUploadRefusal(409, 'paused', CRM_UPLOAD_REASONS.paused, view(j))
      if (j.state === 'failed' && j.code === 'copy-gone') throw new CrmUploadRefusal(409, 'conflict', CRM_UPLOAD_REASONS.copyGone, view(j))
      const l = live(j)
      if (l.receiving) throw new CrmUploadRefusal(409, 'busy', CRM_UPLOAD_REASONS.busy, view(j))
      if (!Number.isSafeInteger(offset) || offset !== j.received) throw new CrmUploadRefusal(409, 'offset', `This upload is at byte ${j.received}: go on from there.`, view(j))
      if (!Number.isSafeInteger(length) || length <= 0 || length > maxPart) throw new CrmFilesError(400, 'failed', `A part is 1 byte to ${Math.round(maxPart / 1024 / 1024)} MB.`)
      if (offset + length > j.size) throw new CrmFilesError(400, 'failed', 'That part goes past the end of the file.')
    } catch (e) {
      if (length > 0 && length <= maxPart) body.resume()
      else body.destroy()
      throw e
    }
    const l = live(j)
    l.receiving = true
    // The md5 so far is copied, fed this part, and kept only if the whole part arrives.
    const h = l.hash && l.hashAt === offset ? l.hash.copy() : null
    let fh: Awaited<ReturnType<typeof open>> | null = null
    try {
      fh = await open(partOf(j.id), 'r+')
      let pos = offset
      for await (const c of body) {
        const buf = c as Buffer
        if (pos + buf.length > offset + length) throw new CrmFilesError(400, 'failed', 'That part is longer than it said.')
        let done = 0
        while (done < buf.length) done += (await fh.write(buf, done, buf.length - done, pos + done)).bytesWritten
        h?.update(buf)
        pos += buf.length
      }
      if (pos !== offset + length) throw new CrmFilesError(400, 'failed', 'That part ended early. Send it again.')
      // On the disk before it is acknowledged.
      await fh.sync()
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') throw new CrmFilesError(507, 'nospace', CRM_UPLOAD_REASONS.noSpace)
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw new CrmFilesError(409, 'conflict', CRM_UPLOAD_REASONS.ended)
      throw e
    } finally {
      await fh?.close().catch(() => undefined)
      l.receiving = false
    }
    if (ENDED.includes(j.state)) throw new CrmUploadRefusal(409, 'conflict', CRM_UPLOAD_REASONS.ended, view(j))
    // The agent is stopping: this part is not acknowledged (the next start trims it off and the page sends it again).
    if (closed) throw new CrmFilesError(503, 'failed', 'The agent is stopping. Send that part again in a moment.')
    const before = j.received
    j.received = offset + length
    if (h) {
      l.hash = h
      l.hashAt = j.received
    } else l.hash = null
    // The page is sending again: "pick the file again" is no longer true.
    if (j.code === 'need-file') ok(j)
    if (j.received === j.size) {
      if (l.hash && l.hashAt === j.size) j.md5 = l.hash.digest('hex')
      l.hash = null
      if (j.state === 'receiving') j.state = activeState(j)
      log?.info(`upload ${short(j)} ("${j.name}", ${sizeText(j.size)}): every byte is on this PC`)
    }
    try {
      await save(j)
    } catch (e) {
      // Not acknowledged: the page sends this part again.
      j.received = before
      l.hash = null
      if (j.state !== 'paused' && j.state !== 'failed') j.state = activeState(j)
      throw (e as NodeJS.ErrnoException)?.code === 'ENOSPC' ? new CrmFilesError(507, 'nospace', CRM_UPLOAD_REASONS.noSpace) : e
    }
    pump()
    return view(j)
  }

  /** Starts in flight by their page key: the same start sent twice at once gives the one upload. */
  const starting = new Map<string, Promise<CrmUpload>>()

  function begin(p: CrmUploadStart): Promise<CrmUpload> {
    const key = isObject(p) && typeof p.clientKey === 'string' ? p.clientKey : ''
    const busy = key ? starting.get(key) : undefined
    if (busy) return busy.then(u => (u.size === p.size && u.target === p.target && u.kind === p.kind ? u : Promise.reject(new CrmFilesError(409, 'conflict', 'That key belongs to another upload.'))))
    const go = beginNow(p)
    if (key) {
      starting.set(key, go)
      const drop = () => void (starting.get(key) === go && starting.delete(key))
      go.then(drop, drop)
    }
    return go
  }

  async function beginNow(p: CrmUploadStart): Promise<CrmUpload> {
    if (closed) throw new CrmFilesError(503, 'failed', 'The agent is stopping.')
    await (started ?? Promise.resolve())
    if (!isObject(p)) throw new CrmFilesError(400, 'failed', 'An upload needs kind, target, name and size.')
    const kind = p.kind === 'version' ? 'version' : p.kind === 'new' ? 'new' : null
    if (!kind) throw new CrmFilesError(400, 'failed', "kind must be 'new' or 'version'.")
    if (typeof p.target !== 'string' || !p.target) throw new CrmFilesError(400, 'failed', 'target is needed.')
    if (typeof p.name !== 'string' || (kind === 'new' && !p.name.trim())) throw new CrmFilesError(400, 'badname', 'A name can not be empty.')
    if (!isCount(p.size)) throw new CrmFilesError(400, 'failed', 'size is needed (bytes).')
    const type = typeof p.type === 'string' ? p.type.slice(0, 200) : ''
    const clientKey = typeof p.clientKey === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(p.clientKey) ? p.clientKey : undefined
    if (clientKey) {
      const same = [...jobs.values()].find(j => j.clientKey === clientKey && j.state !== 'cancelled')
      if (same) {
        if (same.size !== p.size || same.target !== p.target || same.kind !== kind) throw new CrmFilesError(409, 'conflict', 'That key belongs to another upload.')
        return view(same)
      }
    }
    if (p.size > maxSize) throw new CrmFilesError(413, 'toolarge', CRM_UPLOAD_REASONS.tooLarge(maxSize))
    const held = [...jobs.values()].filter(j => !ENDED.includes(j.state)).length
    if (held >= maxHeld) throw new CrmFilesError(429, 'toomany', CRM_UPLOAD_REASONS.tooMany)
    const checked = await backend.check({ kind, target: p.target, name: p.name, type })
    await mkdir(dir, { recursive: true })
    let still = 0
    for (const j of jobs.values()) if (!ENDED.includes(j.state)) still += j.size - j.received
    const free = await freeBytes(dir).catch(() => Infinity)
    if (free < p.size + still + reserve) throw new CrmFilesError(507, 'nospace', CRM_UPLOAD_REASONS.noSpace)
    const t = now()
    const j: Job = {
      v: 1,
      id: randomUUID(),
      kind,
      target: p.target,
      name: checked.name,
      type: checked.type,
      size: p.size,
      ...(isCount(p.lastModified) ? { lastModified: p.lastModified } : {}),
      ...(clientKey ? { clientKey } : {}),
      state: p.size === 0 ? 'waiting' : 'receiving',
      received: 0,
      sent: 0,
      note: null,
      tries: 0,
      createdAt: t,
      updatedAt: t,
      ...(p.size === 0 ? { md5: EMPTY_MD5 } : {}),
    }
    await writeFile(partOf(j.id), '')
    const l = live(j)
    l.hash = createHash('md5')
    l.hashAt = 0
    jobs.set(j.id, j)
    try {
      await save(j)
    } catch (e) {
      jobs.delete(j.id)
      lives.delete(j.id)
      await rm(partOf(j.id), { force: true }).catch(() => undefined)
      throw e
    }
    log?.info(`upload ${short(j)} started: ${kind === 'new' ? 'a new file' : 'a new version'} "${j.name}" (${sizeText(j.size)})`)
    pump()
    return view(j)
  }

  async function addFile(p: Omit<CrmUploadStart, 'size'>, file: string): Promise<CrmUpload> {
    const st = await stat(file)
    if (!st.isFile()) throw new CrmFilesError(400, 'failed', 'That is not a file.')
    const u = await begin({ ...p, size: st.size })
    if (st.size === 0) return u
    try {
      return await receive(u.id, 0, createReadStream(file, { start: 0, end: st.size - 1 }), st.size, Number.MAX_SAFE_INTEGER)
    } catch (e) {
      // The copy could not be made (the file changed or went): this upload ends; the file itself is untouched.
      await cancel(u.id).catch(() => undefined)
      throw e
    }
  }

  // ---- what the person does -------------------------------------------------------------------------------------------------

  async function pause(id: string): Promise<CrmUpload> {
    const j = jobOf(id)
    if (!ACTIVE.includes(j.state)) return view(j)
    j.state = 'paused'
    const l = live(j)
    if (l.running && l.abort) {
      l.stop = 'pause'
      l.abort.abort()
    }
    if (j.session && !j.drive) j.unsure = true
    await save(j)
    log?.info(`upload ${short(j)} paused`)
    return view(j)
  }

  async function resume(id: string): Promise<CrmUpload> {
    const j = jobOf(id)
    if (j.state !== 'paused') return view(j)
    j.state = activeState(j)
    j.tries = 0
    sideOk(j)
    await save(j)
    log?.info(`upload ${short(j)} resumed`)
    pump()
    return view(j)
  }

  async function retry(id: string): Promise<CrmUpload> {
    const j = jobOf(id)
    if (j.state === 'failed') {
      if (j.code === 'copy-gone') throw new CrmUploadRefusal(409, 'conflict', CRM_UPLOAD_REASONS.copyGone, view(j))
      if (j.code === 'integrity') {
        // Google's copy did not match: a new session, from the first byte.
        delete j.session
        delete j.sessionAt
        delete j.drive
        j.sent = 0
        j.unsure = false
      } else if (j.session && !j.drive) j.unsure = true
    } else if (!(ACTIVE.includes(j.state) && j.retryAt)) return view(j)
    j.state = activeState(j)
    j.tries = 0
    sideOk(j)
    await save(j)
    log?.info(`upload ${short(j)}: tried again`)
    pump()
    return view(j)
  }

  async function cancel(id: string): Promise<CrmUpload> {
    const j = jobOf(id)
    if (ENDED.includes(j.state)) return view(j)
    const l = live(j)
    // Every byte is in Google Drive and the CRM is being told right now: that can not be taken back half way.
    if (l.running && l.step === 'finish') throw new CrmUploadRefusal(409, 'busy', 'It is being recorded in the CRM right now, so it can not be cancelled.', view(j))
    j.state = 'cancelled'
    if (l.running && l.abort) {
      l.stop = 'cancel'
      l.abort.abort()
    }
    l.hash = null
    // Only the agent's own copy goes; Google's session is left to lapse (no DELETE), the CRM is not touched.
    delete j.session
    delete j.sessionAt
    ok(j)
    await save(j)
    await dropCopy(j)
    log?.info(`upload ${short(j)} cancelled ("${j.name}"); its copy on this PC is dropped${j.drive ? `; Google Drive's copy ${j.drive.id} is left there, with no CRM record` : ''}`)
    return view(j)
  }

  async function clear(id: string): Promise<void> {
    const j = jobOf(id)
    if (!ENDED.includes(j.state)) throw new CrmFilesError(409, 'conflict', 'Only a done or cancelled upload can be cleared. Cancel it first.')
    await forget(j)
  }

  async function forget(j: Job) {
    jobs.delete(j.id)
    const l = lives.get(j.id)
    lives.delete(j.id)
    await l?.writing.catch(() => undefined)
    await rm(journalOf(j.id), { force: true }).catch(() => undefined)
    await rm(partOf(j.id), { force: true }).catch(() => undefined)
  }

  function prune() {
    for (const j of [...jobs.values()]) if (ENDED.includes(j.state) && now() - j.updatedAt > keepEndedMs) void forget(j)
  }

  // ---- the journal at the start -----------------------------------------------------------------------------------------------

  async function load() {
    await mkdir(dir, { recursive: true })
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      // One that is already going in this process (started before the journal was read) is never read over.
      if (jobs.has(n.slice(0, -'.json'.length))) continue
      let j: unknown
      try {
        j = JSON.parse(await readFile(path.join(dir, n), 'utf8'))
      } catch {
        log?.warn(`a journal in the uploads folder could not be read (${n}); it is left there`)
        continue
      }
      if (!isJob(j) || `${j.id}.json` !== n) continue
      j.tries = isCount(j.tries) ? j.tries : 0
      j.note = typeof j.note === 'string' ? j.note : null
      // An ended upload's copy that could not be removed then (its own file, nothing else).
      if (ENDED.includes(j.state)) await rm(partOf(j.id), { force: true }).catch(() => undefined)
      else {
        const st = await stat(partOf(j.id)).catch(() => null)
        if (!st) {
          if (!j.drive && j.size > 0) {
            j.state = 'failed'
            j.note = CRM_UPLOAD_REASONS.copyGone
            j.code = 'copy-gone'
          }
        } else if (st.size > j.received) {
          // Bytes after the last part that was acknowledged: the page sends that part again.
          await truncate(partOf(j.id), j.received).catch(() => undefined)
        } else if (st.size < j.received) j.received = st.size
        // (Google may hold more than this PC now has: the page sends the rest again, and the worker goes on from Google's place once it is here.)
        if (j.session && !j.drive) j.unsure = true
        if (ACTIVE.includes(j.state)) j.state = activeState(j)
        if (j.state === 'receiving') {
          j.note = CRM_UPLOAD_REASONS.needFile
          j.code = 'need-file'
        }
      }
      const l = live(j)
      l.hash = j.received === 0 && !ENDED.includes(j.state) ? createHash('md5') : null
      l.hashAt = 0
      jobs.set(j.id, j)
    }
    const going = [...jobs.values()].filter(j => !ENDED.includes(j.state))
    if (going.length) log?.info(`uploads: ${going.length} carried on from before the restart (${going.map(j => `${short(j)} ${j.state} ${sizeText(j.received)}/${sizeText(j.size)}`).join(', ')})`)
    prune()
  }

  return {
    async start() {
      started ??= load().then(() => pump())
      return started
    },

    list() {
      prune()
      const uploads = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(view)
      return { uploads, maxSize, partSize: CRM_UPLOAD_PART, parallel }
    },

    get: id => view(jobOf(id)),

    begin,

    receive: (id, offset, body, length) => receive(id, offset, body, length),

    addFile,
    pause,
    resume,
    retry,
    cancel,
    clear,

    waiting: () => [...jobs.values()].filter(j => !ENDED.includes(j.state)).length,

    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      for (const l of lives.values()) {
        if (l.running && l.abort) {
          l.stop = 'close'
          l.abort.abort()
        }
      }
      for (let i = 0; i < 100 && (running > 0 || [...lives.values()].some(l => l.receiving)); i++) await sleep(20)
      await Promise.all([...lives.values()].map(l => l.writing.catch(() => undefined)))
    },
  }
}
