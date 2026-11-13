import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CrmNode, CrmUpload, CrmUploadStart } from '../../shared/crm-files.ts'
import { writeAtomic } from '../config.ts'

// F-211, stage 1 (orders obd04, o63c5 and o7472; Shubham's own answers, 13 Nov 2026): every floor chat's conversation (its Claude Code JSONL) is kept in two places, on the PC
// and in the CRM files drive: project "Conversations" › <owner> › <PC> › <floor> › <agent> › <sessionId> › part-0001.jsonl, part-0002.jsonl, … and manifest.json. His choices:
// plain JSONL with readable names (no encryption), all floors, one way only (the drive is a copy: nothing is read back and nothing on the PC is changed), no automatic carry-on
// and no hand-back. The files are not shared by link (the CRM's own "anyone with the link" policy is skipped for them; the CRM itself still shows every file to its organisation).
//
// How: the hub (or a PC on its own) holds every PC's copy of every session's JSONL (F-021), so it alone sends. Every few seconds it looks at each session's file; what the file
// grew by goes up as a PART when 8 MiB is waiting (a backlog goes in parts of up to 64 MiB), when the file has been quiet for 10 minutes, at the latest an hour after its first
// waiting byte, or 30 s after the chat stopped. A part always ends at the end of a row. Parts go through the drive's resumable uploads (od0b1: a journal, retries for ever, md5
// checked) in an engine of their own (index.ts: its own waiting folder, so they never show in the page's uploads list). One part of a session is on its way at a time, and at
// most a few in all. claude only appends to its file; a copy that is shorter, or differs before the bytes already sent (F-021 replaced a diverged copy whole), starts again from
// its first byte as a new EPOCH. manifest.json (a new version of the same file each time: once everything that waited is up, and every 5 minutes while a long backlog goes)
// lists the parts the CRM has, in order, with their byte ranges and sha256: the parts of the last epoch, joined in that order, are the conversation.

/** The CRM project the conversations go into. */
export const CONVERSATIONS_PROJECT = 'Conversations'

export interface ConvSession {
  sessionId: string
  /** Its folder's names: the chat's owner (username), the PC it ran on, its floor and its agent. */
  owner: string
  pc: string
  floor: string
  agent: string
  /** Its claude is running now (once it has stopped, what waits goes up soon). */
  running: boolean
}

/** What this needs of the CRM files drive (agent/crm-files/service.ts) and of the CRM. */
export interface ConvDrive {
  children(id: string): Promise<{ children: CrmNode[] }>
  folder(parent: string, name: string): Promise<CrmNode>
  /** POST org/projects {name}: the drive shows it once its listing is read again (seconds). */
  createProject(name: string): Promise<void>
}

/** What this needs of the uploads in parts (agent/crm-files/uploads.ts). */
export interface ConvUploads {
  addFile(p: Omit<CrmUploadStart, 'size'>, file: string): Promise<CrmUpload>
  get(id: string): CrmUpload
}

export interface ConvRules {
  /** A part goes up once this much waits. */
  readyBytes: number
  /** The most one part holds (a longer row still goes whole). */
  maxPart: number
  /** Or once the file has been quiet this long, */
  quietMs: number
  /** or at the latest this long after its first waiting byte, */
  maxWaitMs: number
  /** or this long after the chat stopped. */
  endedQuietMs: number
  /** manifest.json is written again as soon as all that waited is up, and at least this often while a long backlog goes. */
  manifestEveryMs: number
  /** Parts and manifests on their way at once, in all. */
  maxInFlight: number
}

export const CONV_RULES: ConvRules = {
  readyBytes: 8 * 1024 * 1024,
  maxPart: 64 * 1024 * 1024,
  quietMs: 10 * 60_000,
  maxWaitMs: 60 * 60_000,
  endedQuietMs: 30_000,
  manifestEveryMs: 5 * 60_000,
  maxInFlight: 4,
}

export interface ConversationsOptions {
  /** This module's own folder in the agent's state: conversations.json (what was sent) and parts/ (a part while it is handed to the uploads). */
  dir: string
  sessions(): ConvSession[]
  /** The session's JSONL on this PC, or null. */
  fileOf(sessionId: string): string | null
  drive: ConvDrive
  uploads: ConvUploads
  /** The switch: false = nothing is looked at or sent. */
  on(): boolean
  /** The CRM is signed in on this PC: nothing is tried while it is not. */
  signedIn(): boolean
  rules?: Partial<ConvRules>
  now?: () => number
  /** How often the files are looked at (ms); 0: never by itself (tests call tick). */
  tickMs?: number
  log?: { info(m: string): void; warn(m: string): void }
}

interface Part {
  n: number
  epoch: number
  from: number
  to: number
  sha256: string
  pc: string
  at: string
  uploadId?: string
  done?: boolean
  fileId?: string
  failed?: string
  /** The uploads engine no longer knows its upload (an agent restart dropped an ended one): the folder is looked at, and it goes again if the CRM does not have it. */
  lost?: boolean
}

interface Sess {
  owner: string
  pc: string
  floor: string
  agent: string
  /** The session's folder in the drive (a node id) and its names, once made. */
  folder?: string
  path?: string[]
  epoch: number
  /** The next part's number (never reused, across epochs). */
  next: number
  /** Bytes of the file (this epoch) that are in a part, sent or on its way. */
  sent: number
  /** sha1 of the (at most) 4 KiB before `sent`: the file still holds what was sent. */
  mark?: string
  parts: Part[]
  manifest?: { fileId?: string; uploadId?: string; parts: number; at: number; failed?: string }
}

interface State {
  v: 1
  project?: string
  projectAskedAt?: number
  sessions: Record<string, Sess>
}

export interface ConvSessionStatus {
  sessionId: string
  owner: string
  pc: string
  floor: string
  agent: string
  folder: string[] | null
  epoch: number
  /** Bytes of the file now, and how many of them are in parts the CRM has. */
  size: number | null
  inDrive: number
  parts: number
  waitingParts: number
  error: string | null
}

export interface ConvStatus {
  on: boolean
  project: string | null
  sessions: ConvSessionStatus[]
}

export interface Conversations {
  /** One look at every session (one at a time; a call while one runs waits for it). */
  tick(): Promise<void>
  status(): ConvStatus
  close(): void
}

const KEY_SAFE = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)
/** A folder name the CRM and every PC's file system take: no path or reserved characters, no control characters, at most 100 characters. */
export function folderName(s: string): string {
  // oxlint-disable-next-line no-control-regex
  const t = s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100)
  return t && !/^\.+$/.test(t) ? t : '-'
}
export const partName = (n: number) => `part-${String(n).padStart(4, '0')}.jsonl`

function readAt(file: string, from: number, length: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(Math.max(0, length))
    let got = 0
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, from + got)
      if (n <= 0) break
      got += n
    }
    return got === length ? buf : buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/** sha1 of the (at most) 4 KiB before `offset`. */
export function markAt(file: string, offset: number): string {
  const from = Math.max(0, offset - 4096)
  return createHash('sha1').update(readAt(file, from, offset - from)).digest('hex')
}

/**
 * Where a part that starts at `from` ends: just after the last newline at or before `limit`; when there is none (one row longer than the most a part holds), just after the next
 * newline before `size`; `from` when the file has no whole row after `from` yet.
 */
export function partEnd(file: string, from: number, limit: number, size: number): number {
  const CHUNK = 64 * 1024
  for (let end = limit; end > from;) {
    const start = Math.max(from, end - CHUNK)
    const nl = readAt(file, start, end - start).lastIndexOf(0x0a)
    if (nl !== -1) return start + nl + 1
    end = start
  }
  for (let start = limit; start < size;) {
    const end = Math.min(size, start + CHUNK)
    const nl = readAt(file, start, end - start).indexOf(0x0a)
    if (nl !== -1) return start + nl + 1
    start = end
  }
  return from
}

/** Copies bytes [from, to) of `file` into `out`, and gives their sha256. */
function copyRange(file: string, from: number, to: number, out: string): string {
  const hash = createHash('sha256')
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, '')
  const fdOut = openSync(out, 'a')
  try {
    for (let at = from; at < to;) {
      const chunk = readAt(file, at, Math.min(1024 * 1024, to - at))
      if (!chunk.length) throw new Error('the conversation file is shorter than it was a moment ago')
      hash.update(chunk)
      writeFileSync(fdOut, chunk)
      at += chunk.length
    }
  } finally {
    closeSync(fdOut)
  }
  return hash.digest('hex')
}

export function createConversations(o: ConversationsOptions): Conversations {
  const rules: ConvRules = { ...CONV_RULES, ...o.rules }
  const now = o.now ?? Date.now
  const stateFile = path.join(o.dir, 'conversations.json')
  const partsDir = path.join(o.dir, 'parts')
  const state: State = load()
  /** In memory only: per session, when its file was last seen to grow, how big it was, when its first waiting byte was seen, its last error. */
  const seen = new Map<string, { size: number; grewAt: number; waitingSince?: number; error?: string }>()
  const fileCache = new Map<string, string>()
  let dirty = false
  let running: Promise<void> | null = null
  let closed = false

  function load(): State {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as State
      if (raw && raw.v === 1 && raw.sessions && typeof raw.sessions === 'object') return raw
    } catch {
      // No state yet (or an unreadable one: started over; the CRM's names then move on, see `addPart`).
    }
    return { v: 1, sessions: {} }
  }
  function save() {
    if (!dirty) return
    try {
      mkdirSync(o.dir, { recursive: true })
      writeAtomic(stateFile, JSON.stringify(state))
      dirty = false
    } catch (e) {
      o.log?.warn(`conversations: what was sent could not be saved (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  const sessOf = (s: ConvSession): Sess => {
    let st = state.sessions[s.sessionId]
    if (!st) {
      st = { owner: s.owner, pc: s.pc, floor: s.floor, agent: s.agent, epoch: 0, next: 1, sent: 0, parts: [] }
      state.sessions[s.sessionId] = st
      dirty = true
    }
    return st
  }
  /** Says each different trouble of a session once (the log is not filled with the same line every few seconds). */
  function trouble(sid: string, what: string) {
    const v = seen.get(sid)
    if (v && v.error === what) return
    if (v) v.error = what
    else seen.set(sid, { size: -1, grewAt: now(), error: what })
    o.log?.warn(`conversations: chat ${sid.slice(0, 8)}: ${what}`)
  }
  const fileOf = (sid: string): string | null => {
    const cached = fileCache.get(sid)
    if (cached && existsSync(cached)) return cached
    const f = o.fileOf(sid)
    if (f) fileCache.set(sid, f)
    else fileCache.delete(sid)
    return f
  }
  const inFlight = () =>
    Object.values(state.sessions).reduce((n, st) => n + st.parts.filter(p => p.uploadId && !p.done && !p.failed).length + (st.manifest?.uploadId ? 1 : 0), 0)

  // ---- the drive: the project and each session's folder -------------------------------------------------------------------

  async function project(): Promise<string | null> {
    if (state.project) return state.project
    const kids = (await o.drive.children('cat:projects')).children
    const hit = kids.filter(k => k.kind === 'project' && k.name.trim() === CONVERSATIONS_PROJECT).sort((a, b) => a.id.localeCompare(b.id))[0]
    if (hit) {
      state.project = hit.id
      dirty = true
      o.log?.info(`conversations: the CRM project "${CONVERSATIONS_PROJECT}" is ${hit.id}`)
      return hit.id
    }
    // Made once; then looked for until the drive's listing shows it (never a second one while it may still be on its way).
    if (state.projectAskedAt && now() - state.projectAskedAt < 5 * 60_000) return null
    state.projectAskedAt = now()
    dirty = true
    save()
    await o.drive.createProject(CONVERSATIONS_PROJECT)
    o.log?.info(`conversations: the CRM project "${CONVERSATIONS_PROJECT}" was made`)
    return null
  }

  async function childFolder(parent: string, name: string): Promise<string> {
    const kids = (await o.drive.children(parent)).children
    const hit = kids.find(k => k.isFolder && k.kind === 'group' && k.name.trim().toLowerCase() === name.toLowerCase())
    if (hit) return hit.id
    return (await o.drive.folder(parent, name)).id
  }

  /** <project> › owner › PC › floor › agent › sessionId; where the CRM refuses that deep a folder, one folder with all of those names under the project. */
  async function folderOf(sid: string, st: Sess): Promise<string | null> {
    if (st.folder) return st.folder
    const top = await project()
    if (!top) return null
    const names = [folderName(st.owner), folderName(st.pc), folderName(st.floor), folderName(st.agent), sid]
    let at = top
    try {
      for (const name of names) at = await childFolder(at, name)
      st.path = names
    } catch (e) {
      if (at === top) throw e
      const flat = folderName(names.join(' · '))
      o.log?.warn(`conversations: chat ${sid.slice(0, 8)}: the nested folder was refused (${e instanceof Error ? e.message : String(e)}); "${flat}" under the project instead`)
      at = await childFolder(top, flat)
      st.path = [flat]
    }
    st.folder = at
    dirty = true
    return at
  }

  // ---- parts and the manifest --------------------------------------------------------------------------------------------

  async function addPart(sid: string, st: Sess, file: string, from: number, to: number): Promise<void> {
    const folder = await folderOf(sid, st)
    if (!folder) return
    const tmp = path.join(partsDir, `${KEY_SAFE(sid)}-${st.epoch}-${st.next}.jsonl`)
    const sha256 = copyRange(file, from, to, tmp)
    try {
      for (let tries = 0; ; tries++) {
        const n = st.next
        try {
          const u = await o.uploads.addFile({ kind: 'new', target: folder, name: partName(n), type: 'application/x-ndjson', clientKey: `cv-${KEY_SAFE(sid)}-${st.epoch}-${n}` }, tmp)
          st.parts.push({ n, epoch: st.epoch, from, to, sha256, pc: st.pc, at: new Date(now()).toISOString(), uploadId: u.id, ...(u.state === 'done' ? { done: true, fileId: u.node?.id } : {}) })
          st.next = n + 1
          break
        } catch (e) {
          // That name is in the folder already (what was sent was forgotten: the state was lost): the next number.
          if ((e as { code?: unknown }).code === 'conflict' && tries < 50) {
            st.next = n + 1
            continue
          }
          throw e
        }
      }
    } finally {
      rmSync(tmp, { force: true })
    }
    st.sent = to
    st.mark = markAt(file, to)
    dirty = true
  }

  function manifestOf(sid: string, st: Sess): string {
    const done = st.parts.filter(p => p.done && p.epoch === st.epoch).sort((a, b) => a.from - b.from)
    return `${JSON.stringify(
      {
        v: 1,
        what: 'A Claude Code conversation (its JSONL). The parts of the last epoch, joined in this order, are the whole file; a new epoch started again from its first byte.',
        sessionId: sid,
        owner: st.owner,
        pc: st.pc,
        floor: st.floor,
        agent: st.agent,
        epoch: st.epoch,
        bytes: done.reduce((n, p) => Math.max(n, p.to), 0),
        updatedAt: new Date(now()).toISOString(),
        parts: done.map(p => ({ name: partName(p.n), epoch: p.epoch, from: p.from, to: p.to, bytes: p.to - p.from, sha256: p.sha256, pc: p.pc, at: p.at })),
      },
      null,
      2,
    )}\n`
  }

  async function writeManifest(sid: string, st: Sess): Promise<void> {
    if (!st.folder) return
    const doneCount = st.parts.filter(p => p.done && p.epoch === st.epoch).length
    const m = (st.manifest ??= { parts: 0, at: 0 })
    const tmp = path.join(partsDir, `${KEY_SAFE(sid)}-manifest-${doneCount}.json`)
    mkdirSync(partsDir, { recursive: true })
    writeFileSync(tmp, manifestOf(sid, st))
    try {
      const u = await o.uploads.addFile(
        m.fileId ? { kind: 'version', target: m.fileId, name: 'manifest.json', type: 'application/json', clientKey: `cm-${KEY_SAFE(sid)}-${st.epoch}-${doneCount}` } : { kind: 'new', target: st.folder, name: 'manifest.json', type: 'application/json', clientKey: `cm-${KEY_SAFE(sid)}-${st.epoch}-${doneCount}` },
        tmp,
      )
      m.uploadId = u.id
      m.parts = doneCount
      m.at = now()
      delete m.failed
      if (u.state === 'done' && u.node) {
        m.fileId = u.node.id
        delete m.uploadId
      }
      dirty = true
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  /** The uploads on their way: done ones are noted, failed ones said once (the uploads engine retries what waiting can mend by itself). */
  function follow(sid: string, st: Sess) {
    for (const p of st.parts) {
      if (!p.uploadId || p.done || p.failed || p.lost) continue
      let u: CrmUpload
      try {
        u = o.uploads.get(p.uploadId)
      } catch {
        // The uploads engine no longer knows it: never taken as done on a guess; the folder is looked at (settleLost).
        p.lost = true
        dirty = true
        continue
      }
      if (u.state === 'done') {
        p.done = true
        if (u.node) p.fileId = u.node.id
        dirty = true
      } else if (u.state === 'failed' || u.state === 'cancelled') {
        p.failed = u.note ?? u.state
        dirty = true
        trouble(sid, `${partName(p.n)} did not go up: ${p.failed}`)
      }
    }
    const m = st.manifest
    if (m?.uploadId) {
      try {
        const u = o.uploads.get(m.uploadId)
        if (u.state === 'done') {
          if (u.node) m.fileId = u.node.id
          delete m.uploadId
          dirty = true
        } else if (u.state === 'failed' || u.state === 'cancelled') {
          m.failed = u.note ?? u.state
          delete m.uploadId
          dirty = true
          trouble(sid, `manifest.json did not go up: ${m.failed}`)
        }
      } catch {
        delete m.uploadId
        dirty = true
      }
    }
  }

  /**
   * A part whose upload the engine forgot: done when the session's folder has a file of its name and size; sent again (the same bytes, the same name) when it has none; said
   * once when another file of another size has its name. A part of an earlier epoch is let go (the manifest only lists the last epoch).
   */
  async function settleLost(sid: string, st: Sess, file: string, size: number) {
    const lost = st.parts.filter(p => p.lost && !p.done && !p.failed)
    if (!lost.length || !st.folder) return
    const kids = (await o.drive.children(st.folder)).children
    for (const p of lost) {
      const there = kids.find(k => !k.isFolder && k.name === partName(p.n))
      if (there && there.size === p.to - p.from) {
        p.done = true
        p.fileId = there.id
      } else if (there) {
        p.failed = `another ${partName(p.n)} (${there.size ?? '?'} bytes) is in its folder`
        trouble(sid, p.failed)
      } else if (p.epoch !== st.epoch || size < p.to) {
        p.failed = 'its bytes are no longer in the file on this PC (the copy was replaced)'
      } else {
        const tmp = path.join(partsDir, `${KEY_SAFE(sid)}-${p.epoch}-${p.n}-again.jsonl`)
        const sha256 = copyRange(file, p.from, p.to, tmp)
        try {
          if (sha256 !== p.sha256) {
            p.failed = 'its bytes changed in the file on this PC'
          } else {
            const u = await o.uploads.addFile({ kind: 'new', target: st.folder, name: partName(p.n), type: 'application/x-ndjson', clientKey: `cv-${KEY_SAFE(sid)}-${p.epoch}-${p.n}` }, tmp)
            p.uploadId = u.id
            if (u.state === 'done') {
              p.done = true
              if (u.node) p.fileId = u.node.id
            }
          }
        } catch (e) {
          if ((e as { code?: unknown }).code !== 'conflict') throw e
          p.done = true // it landed meanwhile
        } finally {
          rmSync(tmp, { force: true })
        }
      }
      delete p.lost
      dirty = true
    }
  }

  async function lookAt(s: ConvSession) {
    const sid = s.sessionId
    const st = sessOf(s)
    follow(sid, st)
    const file = fileOf(sid)
    if (!file) return
    let size: number
    try {
      size = statSync(file).size
    } catch {
      fileCache.delete(sid)
      return
    }
    const t = now()
    const v = seen.get(sid) ?? { size: -1, grewAt: t }
    if (size !== v.size) {
      v.grewAt = t
      v.size = size
    }
    seen.set(sid, v)
    await settleLost(sid, st, file, size)
    // The copy was replaced (shorter, or different before what was sent): a new epoch from its first byte.
    if (size < st.sent || (st.sent > 0 && st.mark !== markAt(file, st.sent))) {
      o.log?.info(`conversations: chat ${sid.slice(0, 8)}: its file on this PC was replaced; it goes up again from its first byte (epoch ${st.epoch + 1})`)
      st.epoch++
      st.sent = 0
      delete st.mark
      if (st.manifest) st.manifest.parts = -1
      dirty = true
    }
    const waiting = size - st.sent
    if (waiting <= 0) {
      delete v.waitingSince
    } else {
      v.waitingSince ??= t
      const onItsWay = st.parts.some(p => p.uploadId && !p.done && !p.failed)
      const due = waiting >= rules.readyBytes || t - v.grewAt >= rules.quietMs || t - v.waitingSince >= rules.maxWaitMs || (!s.running && t - v.grewAt >= rules.endedQuietMs)
      if (due && !onItsWay && inFlight() < rules.maxInFlight) {
        const end = partEnd(file, st.sent, Math.min(size, st.sent + rules.maxPart), size)
        if (end > st.sent) {
          await addPart(sid, st, file, st.sent, end)
          v.waitingSince = end < size ? t : undefined
        }
      }
    }
    // The manifest: once parts are in that it does not list yet, as soon as everything that waited is up (the end of a burst), and every few minutes while a long backlog goes.
    const doneNow = st.parts.filter(p => p.done && p.epoch === st.epoch).length
    const m = st.manifest
    const allUp = st.sent === size && !st.parts.some(p => p.uploadId && !p.done && !p.failed)
    if (doneNow > 0 && (!m || m.parts !== doneNow) && !m?.uploadId && inFlight() < rules.maxInFlight && (!m || allUp || t - m.at >= rules.manifestEveryMs)) {
      await writeManifest(sid, st)
    }
  }

  async function tickOnce() {
    if (closed || !o.on() || !o.signedIn()) return
    for (const s of o.sessions()) {
      if (closed) break
      try {
        await lookAt(s)
        const v = seen.get(s.sessionId)
        if (v?.error) delete v.error
      } catch (e) {
        trouble(s.sessionId, e instanceof Error ? e.message : String(e))
      }
    }
    save()
  }

  const timer = o.tickMs === 0 ? null : setInterval(() => void tick().catch(() => undefined), o.tickMs ?? 5000)
  timer?.unref?.()

  function tick(): Promise<void> {
    running ??= tickOnce().finally(() => {
      running = null
    })
    return running
  }

  return {
    tick,
    status() {
      const list = o.sessions()
      return {
        on: o.on(),
        project: state.project ?? null,
        sessions: list.map(s => {
          const st = state.sessions[s.sessionId]
          const file = fileCache.get(s.sessionId) ?? null
          let size: number | null = null
          try {
            size = file ? statSync(file).size : null
          } catch {
            size = null
          }
          const done = st ? st.parts.filter(p => p.done && p.epoch === st.epoch) : []
          return {
            sessionId: s.sessionId,
            owner: st?.owner ?? s.owner,
            pc: st?.pc ?? s.pc,
            floor: st?.floor ?? s.floor,
            agent: st?.agent ?? s.agent,
            folder: st?.path ?? null,
            epoch: st?.epoch ?? 0,
            size,
            inDrive: done.reduce((n, p) => Math.max(n, p.to), 0),
            parts: done.length,
            waitingParts: st ? st.parts.filter(p => p.uploadId && !p.done && !p.failed).length : 0,
            error: seen.get(s.sessionId)?.error ?? null,
          }
        }),
      }
    },
    close() {
      closed = true
      if (timer) clearInterval(timer)
      save()
    },
  }
}
