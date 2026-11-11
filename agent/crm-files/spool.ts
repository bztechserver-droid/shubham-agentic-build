import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CRM_FILES_REASONS, type CrmNode, type CrmSpoolEntry, type CrmSpoolState } from '../../shared/crm-files.ts'
import { CrmFilesError } from './service.ts'

// o6e65 (S5, rule 4): a save through the drive is written to a SPOOL on this PC and acknowledged at once, like the old drive host did; a worker sends it to the CRM in the background.
//   <dir>/<job id>/<the file's own name>   the bytes, as the person saved them (so "Open the folder" shows real files)
//   <dir>/<job id>/job.json                the journal note: what it is, where it goes, the size, when, how often it was tried, why it waits
// The spool survives the agent restarting, the app being off and the drive being unmounted. A job is removed ONLY when the CRM has the file (our own copy of it then is surplus); one that
// is refused for good (no right, the project is gone, the name is taken) is kept and says why: nothing here ever deletes what a person saved, and no job is ever dropped for being old.
// The same job twice (the same new name in the same folder, or the same file): a newer save that arrives while the older one has not started to go up replaces it (it is the same document).

export const SPOOL_JOURNAL = 'job.json'

/** How long a failed job waits before the next try: 5 s, 15 s, 45 s, 2 min, then every 5 min (it never gives up while the CRM is unreachable). */
export const SPOOL_RETRY_MS = [5_000, 15_000, 45_000, 120_000, 300_000]

/** The most the spool may hold (bytes): a save that would pass it is refused at once with plain words (it is not accepted and then lost). */
export const SPOOL_MAX_BYTES = 10 * 1024 * 1024 * 1024

interface Job {
  id: string
  kind: 'new' | 'version'
  /** The folder a NEW file goes into (a project or one of its folders); for a version, the folder the file was in. */
  parent: string
  /** A version: the CRM file it is a new version of. */
  target: string | null
  name: string
  type: string
  size: number
  project: string | null
  createdAt: string
  /** The kept copy's name inside the job's folder. */
  file: string
  attempts: number
  state: Exclude<CrmSpoolState, 'sending'>
  reason: string | null
  /** The earliest time of the next try (ms since 1970). */
  nextAt: number
}

/** What the spool needs of the CRM side (the files service). */
export interface SpoolSender {
  upload(parent: string, name: string, type: string, stream: Readable, size: number): Promise<CrmNode>
  version(id: string, name: string, type: string, stream: Readable, size: number): Promise<CrmNode>
  /** The file or folder of that name in the folder, or null. A new save of a name that is already a CRM file becomes a new version of it (as the drive did when the save was direct). */
  find(parent: string, name: string): Promise<CrmNode | null>
}

export interface SpoolOptions {
  dir: string
  send: SpoolSender
  now?: () => number
  retryMs?: number[]
  maxBytes?: number
  /** Something left the spool (it is in the CRM now): the listing of the CRM should be read again. */
  onChange?: () => void
  log?: { info(m: string): void; warn(m: string): void }
}

export interface SaveRequest {
  kind: 'new' | 'version'
  parent: string
  target?: string | null
  name: string
  type: string
  project?: string | null
  /** The bytes, as a stream... */
  body?: Readable
  /** ...or a finished file on this PC that is MOVED into the spool (S9b: the drive's staging copy; it must be on the same disk, inside the spool's own folder). */
  from?: string
  size: number
  /** S9b: kept but not to be sent: the CRM would refuse it (a right that went away while the file was open). It is listed as refused with these words, until the person says Try again. */
  parked?: string
}

export interface Spool {
  readonly dir: string
  /** Keeps the bytes (all of them, or it throws and keeps nothing) and returns at once; the worker sends them. */
  add(r: SaveRequest): Promise<CrmSpoolEntry>
  list(): CrmSpoolEntry[]
  count(): number
  /** A new file waiting in that folder under that name. */
  pendingNew(parent: string, name: string): CrmSpoolEntry | null
  pendingIn(parent: string): CrmSpoolEntry[]
  /** The newest save waiting to become a new version of that CRM file. */
  pendingVersion(target: string): CrmSpoolEntry | null
  /** Where the kept copy is (for reading it back through the drive while it waits). */
  fileOf(id: string): { path: string; size: number; mtime: number } | null
  /** A waiting NEW file given another name or folder (a program's save, a move in Explorer). False when the job is not waiting, or is going up right now. */
  rename(id: string, to: { parent?: string; name?: string; project?: string | null }): boolean
  /** S9b: a waiting NEW file that turns out to be a new version of a CRM file (a program's save: a temporary file renamed over the document). False when it is going up, or refused. A waiting older save of that file is replaced. */
  retarget(id: string, to: { target: string; name: string; parent?: string; project?: string | null }): boolean
  /** Try again now (one job, or all when no id); a refused one is tried again too (the person decided). */
  retry(id?: string): number
  /** Starts the worker. Idle when nothing is waiting. */
  start(): void
  /** Tests: resolves when no job is due and none is going up. */
  settled(): Promise<void>
  close(): Promise<void>
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The name a kept copy has inside its folder: the person's own name, made safe for any file system. */
export function keptName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let n = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120)
  if (!n || n === SPOOL_JOURNAL || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = `_${n}`
  return n
}

/** A refusal that no waiting will change (the person has no right, the folder or file is gone, the name is taken, the file is too large), as against one that waiting can mend. */
export function isPermanent(e: unknown): boolean {
  if (!(e instanceof CrmFilesError)) return false
  if (['forbidden', 'notfound', 'conflict', 'toolarge', 'badname', 'nodelete', 'unsupported'].includes(e.code)) return true
  return e.code === 'failed' && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429
}

const isJob = (v: unknown): v is Job => {
  if (typeof v !== 'object' || v === null) return false
  const j = v as Record<string, unknown>
  return (
    typeof j.id === 'string' && ID.test(j.id) && (j.kind === 'new' || j.kind === 'version') && typeof j.parent === 'string' && typeof j.name === 'string' && typeof j.file === 'string' && j.file !== '' && !/[\\/]/.test(j.file) &&
    typeof j.size === 'number' && Number.isFinite(j.size) && j.size >= 0 && typeof j.createdAt === 'string' && (j.state === 'waiting' || j.state === 'unreachable' || j.state === 'refused')
  )
}

export function createSpool(o: SpoolOptions): Spool {
  const now = o.now ?? Date.now
  const retryMs = o.retryMs ?? SPOOL_RETRY_MS
  const maxBytes = o.maxBytes ?? SPOOL_MAX_BYTES
  const dir = o.dir
  const jobs = new Map<string, Job>()
  /** Jobs that are going up right now. */
  const sending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let closed = false
  let started = false

  const folderOf = (id: string) => path.join(dir, id)
  const noteOf = (id: string) => path.join(folderOf(id), SPOOL_JOURNAL)

  /** A journal note written whole or not at all (a temporary file, then a rename). */
  function persist(j: Job) {
    const tmp = `${noteOf(j.id)}.tmp`
    writeFileSync(tmp, JSON.stringify(j, null, 2))
    renameSync(tmp, noteOf(j.id))
  }

  // What was kept before: every folder with a readable journal note. A folder without one (a save cut short by the agent stopping) is left alone: it holds nothing that was acknowledged.
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(dir)) {
    if (!ID.test(name) || !existsSync(noteOf(name))) continue
    try {
      const j: unknown = JSON.parse(readFileSync(noteOf(name), 'utf8'))
      if (!isJob(j) || j.id !== name) throw new Error('the note does not describe this job')
      if (!existsSync(path.join(folderOf(name), j.file))) throw new Error('the kept copy is missing')
      // A restart is a fresh start: tried again at once.
      jobs.set(j.id, { ...j, type: j.type ?? '', target: j.target ?? null, project: j.project ?? null, reason: j.reason ?? null, attempts: j.attempts ?? 0, nextAt: 0 })
    } catch (e) {
      o.log?.warn(`crm spool: ${name} is not used (${e instanceof Error ? e.message : String(e)}); it is left where it is`)
    }
  }

  const keyOf = (j: Job) => (j.kind === 'version' && j.target ? `v\u0000${j.target}` : `n\u0000${j.parent}\u0000${j.name.toLowerCase()}`)

  const entryOf = (j: Job): CrmSpoolEntry => ({
    id: j.id,
    kind: j.kind,
    name: j.name,
    project: j.project,
    size: j.size,
    since: j.createdAt,
    state: sending.has(j.id) ? 'sending' : j.state,
    reason: j.reason,
    attempts: j.attempts,
  })

  const ordered = () => [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))

  const kept = () => ordered().reduce((n, j) => n + j.size, 0)

  /** The next job that may go up now: due, not refused, and the oldest of its own file (two saves of one document go up in the order they were made). */
  function pick(): { job: Job | null; wait: number | null } {
    const seen = new Set<string>()
    let wait: number | null = null
    for (const j of ordered()) {
      if (j.state === 'refused') continue
      const k = keyOf(j)
      const blocked = seen.has(k)
      seen.add(k)
      if (blocked || sending.has(j.id)) continue
      if (j.nextAt <= now()) return { job: j, wait: null }
      wait = wait === null ? j.nextAt - now() : Math.min(wait, j.nextAt - now())
    }
    return { job: null, wait }
  }

  function schedule(ms: number) {
    if (closed || !started) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      kick()
    }, Math.max(0, ms))
    timer.unref?.()
  }

  function kick() {
    if (closed || !started || running) return
    const p = (async () => {
      for (;;) {
        if (closed) return
        const { job, wait } = pick()
        if (!job) {
          if (wait !== null) schedule(wait)
          return
        }
        await sendJob(job)
      }
    })()
    running = p
    // Cleared AFTER the assignment above (a loop with nothing to do finishes before it).
    void p.finally(() => {
      if (running === p) running = null
    })
  }

  async function sendJob(j: Job) {
    sending.add(j.id)
    let stream: Readable | null = null
    try {
      const file = path.join(folderOf(j.id), j.file)
      const st = statSync(file)
      if (st.size !== j.size) throw new CrmFilesError(400, 'failed', 'The kept copy of this save is damaged (its size is not what was saved). It is kept; nothing was sent.')
      stream = createReadStream(file)
      stream.on('error', () => undefined)
      if (j.kind === 'version' && j.target) await o.send.version(j.target, j.name, j.type, stream, j.size)
      else {
        const there = await o.send.find(j.parent, j.name)
        if (there?.isFolder) throw new CrmFilesError(409, 'conflict', `"${j.name}" is a folder there.`)
        if (there) await o.send.version(there.id, there.name, j.type || there.type || '', stream, j.size)
        else await o.send.upload(j.parent, j.name, j.type, stream, j.size)
      }
      // The CRM has it: our own copy is surplus now. Only this job's own folder is removed.
      jobs.delete(j.id)
      rmSync(folderOf(j.id), { recursive: true, force: true })
      o.log?.info(`crm spool: "${j.name}" is in the CRM`)
      o.onChange?.()
    } catch (e) {
      const failures = j.attempts + 1
      if (isPermanent(e)) {
        j.state = 'refused'
        j.reason = e instanceof Error ? e.message : 'The CRM refused it.'
        j.nextAt = Number.MAX_SAFE_INTEGER
        o.log?.warn(`crm spool: "${j.name}" is refused and kept: ${j.reason}`)
      } else {
        j.state = 'unreachable'
        j.reason = e instanceof CrmFilesError && e.code === 'crm-signin' ? CRM_FILES_REASONS.signedOut : e instanceof CrmFilesError && e.code === 'crm-down' ? CRM_FILES_REASONS.crmDown : 'It could not be sent just now; it will be tried again.'
        j.nextAt = now() + retryMs[Math.min(failures - 1, retryMs.length - 1)]
      }
      j.attempts = failures
      try {
        persist(j)
      } catch {
        // the journal is a note for the next start; the job itself is still here
      }
    } finally {
      // A read stream the sender did not use (it refused first) must not open its file later, when the folder may be gone.
      stream?.destroy()
      sending.delete(j.id)
    }
  }

  async function add(r: SaveRequest): Promise<CrmSpoolEntry> {
    if (closed) throw new CrmFilesError(503, 'failed', 'The agent is stopping; this save was not kept. Try again in a moment.')
    if (!r.body && !r.from) throw new CrmFilesError(400, 'failed', 'There is nothing to keep.')
    if (kept() + r.size > maxBytes) {
      r.body?.destroy()
      throw new CrmFilesError(507 as number, 'failed', `This PC is already keeping ${Math.round(kept() / 1024 / 1024)} MB of saves that have not reached the CRM; this one is too much on top. Nothing was lost: it was not accepted.`)
    }
    const id = randomUUID()
    const file = keptName(r.name)
    const folder = folderOf(id)
    mkdirSync(folder, { recursive: true })
    const part = path.join(folder, `${file}.part`)
    let got = 0
    try {
      if (r.from) {
        // A finished file: moved in (a rename on one disk: instant, whatever its size).
        if (statSync(r.from).size !== r.size) throw new CrmFilesError(400, 'failed', 'The save was cut short on its way here; nothing was kept.')
        renameSync(r.from, part)
        got = r.size
      } else {
        await pipeline(
          r.body as Readable,
          new Transform({
            transform(chunk: Buffer, _e, cb) {
              got += chunk.length
              cb(null, chunk)
            },
          }),
          createWriteStream(part),
        )
      }
      if (got !== r.size) throw new CrmFilesError(400, 'failed', 'The save was cut short on its way here; nothing was kept.')
      // On disk before it is acknowledged (a power cut after the "saved" must not lose it).
      const fh = await open(part, 'r+')
      try {
        await fh.sync()
      } finally {
        await fh.close()
      }
      renameSync(part, path.join(folder, file))
    } catch (e) {
      // Only our own half-written copy goes (the person's bytes are still with the program that sent them).
      rmSync(folder, { recursive: true, force: true })
      throw e
    }
    const j: Job = {
      id,
      kind: r.kind,
      parent: r.parent,
      target: r.kind === 'version' ? (r.target ?? null) : null,
      name: r.name,
      type: r.type,
      size: r.size,
      project: r.project ?? null,
      createdAt: new Date(now()).toISOString(),
      file,
      attempts: 0,
      state: r.parked ? 'refused' : 'waiting',
      reason: r.parked ?? null,
      nextAt: r.parked ? Number.MAX_SAFE_INTEGER : 0,
    }
    try {
      persist(j)
    } catch (e) {
      rmSync(folder, { recursive: true, force: true })
      throw new CrmFilesError(507 as number, 'failed', `This PC could not keep the save (${e instanceof Error ? e.message : String(e)}). Nothing was accepted.`)
    }
    // A newer save of the same document that has not started to go up replaces the older one (the same name in the same folder, or the same file).
    for (const old of [...jobs.values()]) {
      if (keyOf(old) === keyOf(j) && (old.state === 'waiting' || old.state === 'unreachable') && !sending.has(old.id)) {
        jobs.delete(old.id)
        rmSync(folderOf(old.id), { recursive: true, force: true })
      }
    }
    jobs.set(id, j)
    kick()
    return entryOf(j)
  }

  return {
    dir,
    add,
    list: () => ordered().map(entryOf),
    count: () => jobs.size,
    pendingNew(parent, name) {
      const j = ordered().find(x => x.kind === 'new' && x.parent === parent && x.name.toLowerCase() === name.toLowerCase())
      return j ? entryOf(j) : null
    },
    pendingIn: parent => ordered().filter(j => j.kind === 'new' && j.parent === parent).map(entryOf),
    pendingVersion(target) {
      const list = ordered().filter(j => j.kind === 'version' && j.target === target)
      const j = list.at(-1)
      return j ? entryOf(j) : null
    },
    fileOf(id) {
      const j = jobs.get(id)
      if (!j) return null
      const p = path.join(folderOf(id), j.file)
      try {
        const st = statSync(p)
        return { path: p, size: st.size, mtime: st.mtimeMs }
      } catch {
        return null
      }
    },
    rename(id, to) {
      const j = jobs.get(id)
      if (!j || j.kind !== 'new' || sending.has(id) || j.state === 'refused') return false
      if (to.parent !== undefined) j.parent = to.parent
      if (to.project !== undefined) j.project = to.project
      if (to.name !== undefined) j.name = to.name
      persist(j)
      return true
    },
    retarget(id, to) {
      const j = jobs.get(id)
      if (!j || j.kind !== 'new' || sending.has(id) || j.state === 'refused') return false
      j.kind = 'version'
      j.target = to.target
      j.name = to.name
      if (to.parent !== undefined) j.parent = to.parent
      if (to.project !== undefined) j.project = to.project
      persist(j)
      // An older waiting save of the same file is the same document: replaced by this one (the newer).
      for (const old of [...jobs.values()]) {
        if (old.id !== j.id && keyOf(old) === keyOf(j) && (old.state === 'waiting' || old.state === 'unreachable') && !sending.has(old.id) && old.createdAt <= j.createdAt) {
          jobs.delete(old.id)
          rmSync(folderOf(old.id), { recursive: true, force: true })
        }
      }
      kick()
      return true
    },
    retry(id) {
      let n = 0
      for (const j of jobs.values()) {
        if (id && j.id !== id) continue
        if (sending.has(j.id)) continue
        j.state = 'waiting'
        j.reason = null
        j.nextAt = 0
        try {
          persist(j)
        } catch {
          // kept in memory
        }
        n++
      }
      if (n) kick()
      return n
    },
    start() {
      started = true
      kick()
    },
    async settled() {
      started = true
      for (;;) {
        // Nothing going up and nothing due: settled. (Checked BEFORE starting the worker: an idle worker run would otherwise keep this loop going for ever.)
        if (!running && !pick().job) return
        kick()
        const r = running
        if (r) await r.catch(() => undefined)
        await Promise.resolve()
      }
    },
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      await running?.catch(() => undefined)
    },
  }
}
