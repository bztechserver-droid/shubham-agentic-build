import { FsStatusError, NT, READ_PART, WRITE_PART, type FsEntry, type FsOps, type FsWriteOps } from './winfsp-ops.ts'

// o6e65 S9a: how the drive's worker thread asks the agent's main thread about the CRM.
//
// WinFsp calls the file system's functions on its own threads and wants each answer BEFORE the function returns. koffi runs those functions on the JS thread of whoever loaded WinFsp, so a
// function that needs the CRM (the network) cannot wait for it on the agent's busy main thread. So WinFsp lives in a worker thread, whose functions block on Atomics.wait while the MAIN thread
// does the asynchronous work and fills a shared buffer (proved in the spike: 600 MB read through such a bridge, same SHA-256).
//
// Bounded memory, said here once: ONE request is open at a time (the worker is blocked while it waits), the shared data buffer is BRIDGE_DATA_BYTES (2 MiB: a read part of READ_PART = 1 MiB
// or a folder page as JSON), nothing else is shared. A part or a page that does not fit is cut (reads) or paged by marker (folders), never grown.

export const BRIDGE_DATA_BYTES = 2 * 1024 * 1024
/** How long the worker waits for the main thread before it gives WinFsp a network error (and goes on). */
export const BRIDGE_TIMEOUT_MS = 90_000
/** A folder page is at most this many entries (and always fits BRIDGE_DATA_BYTES as JSON): WinFsp asks again with a marker for the rest. */
export const LIST_PAGE = 400

export interface BridgeBuffers {
  ctrl: SharedArrayBuffer
  data: SharedArrayBuffer
}
export const newBridgeBuffers = (): BridgeBuffers => ({ ctrl: new SharedArrayBuffer(16), data: new SharedArrayBuffer(BRIDGE_DATA_BYTES) })

// ctrl (Int32): [0] state 0 idle / 1 asked / 2 answered, [1] result 0 ok / 1 not found / 2 error, [2] bytes put in data, [3] the number of the request being answered.
const STATE = 0
const RESULT = 1
const LENGTH = 2
const NUMBER = 3
const OK = 0
const NOT_FOUND = 1
const FAILED = 2

export type BridgeRequest =
  | { n: number; op: 'stat'; path: string }
  | { n: number; op: 'list'; path: string; marker: string | null }
  | { n: number; op: 'read'; path: string; offset: number; length: number }
  // S9b, the saves. For these the reply's `result` is 0 (done) or the NTSTATUS to answer WinFsp with; `write` carries its bytes in the shared data buffer (`length` of them).
  | { n: number; op: 'create'; path: string; dir: boolean }
  | { n: number; op: 'open'; path: string; truncate: boolean }
  | { n: number; op: 'write'; sid: number; offset: number; length: number; toEnd: boolean }
  | { n: number; op: 'setsize'; sid: number; size: number }
  | { n: number; op: 'release'; sid: number; del: boolean }
  | { n: number; op: 'rename'; from: string; to: string; replace: boolean }
  | { n: number; op: 'candelete'; sid: number; path: string }
  | { n: number; op: 'remove'; path: string }

type NoNumber<T> = T extends unknown ? Omit<T, 'n'> : never

export interface BridgePort {
  postMessage(value: unknown): void
}

/** The worker's side: `FsOps` whose every call blocks until the main thread has answered. */
export function createBridgeClient(port: BridgePort, bufs: BridgeBuffers, timeoutMs = BRIDGE_TIMEOUT_MS): FsOps {
  const c = new Int32Array(bufs.ctrl)
  const d = new Uint8Array(bufs.data)
  let counter = 0
  function ask(req: NoNumber<BridgeRequest>): { result: number; length: number } {
    const n = ++counter
    Atomics.store(c, NUMBER, n)
    Atomics.store(c, STATE, 1)
    port.postMessage({ type: 'fs', ...req, n })
    const waited = Atomics.wait(c, STATE, 1, timeoutMs)
    if (waited === 'timed-out') {
      // The answer may still come: its number no longer matches, so it is dropped.
      Atomics.store(c, NUMBER, 0)
      Atomics.store(c, STATE, 0)
      throw new Error('the agent did not answer in time')
    }
    const out = { result: Atomics.load(c, RESULT), length: Atomics.load(c, LENGTH) }
    Atomics.store(c, STATE, 0)
    return out
  }
  const json = (length: number): unknown => JSON.parse(Buffer.from(d.subarray(0, length)).toString('utf8'))
  /** A save call: done, or the status WinFsp is to be answered with. */
  function change(req: NoNumber<BridgeRequest>): { length: number } {
    const r = ask(req)
    if (r.result === OK) return { length: r.length }
    if (r.result === NOT_FOUND) throw new FsStatusError(NT.OBJECT_NAME_NOT_FOUND)
    if (r.result === FAILED) throw new Error('the agent could not do that')
    throw new FsStatusError(r.result)
  }
  const writes: FsWriteOps = {
    create: (path, dir) => json(change({ op: 'create', path, dir }).length) as { sid: number; entry: FsEntry },
    open: (path, truncate) => json(change({ op: 'open', path, truncate }).length) as { sid: number; entry: FsEntry },
    write(sid, offset, data, toEnd) {
      if (data.length > WRITE_PART || data.length > d.length) throw new Error('a write part is too large')
      d.set(data, 0)
      return json(change({ op: 'write', sid, offset, length: data.length, toEnd }).length) as { written: number; entry: FsEntry }
    },
    setSize: (sid, size) => json(change({ op: 'setsize', sid, size }).length) as FsEntry,
    release(sid, del) {
      change({ op: 'release', sid, del })
    },
    rename(from, to, replace) {
      change({ op: 'rename', from, to, replace })
    },
    canDelete: (sid, path) => (json(change({ op: 'candelete', sid, path }).length) as { ok: boolean }).ok,
    remove(path) {
      change({ op: 'remove', path })
    },
  }
  return {
    writes,
    stat(path) {
      const r = ask({ op: 'stat', path })
      if (r.result === NOT_FOUND) return null
      if (r.result !== OK) throw new Error('stat failed')
      return json(r.length) as FsEntry
    },
    list(path, marker) {
      const r = ask({ op: 'list', path, marker })
      if (r.result === NOT_FOUND) return { entries: [], more: false }
      if (r.result !== OK) throw new Error('list failed')
      return json(r.length) as { entries: FsEntry[]; more: boolean }
    },
    read(path, offset, into) {
      const length = Math.min(into.length, READ_PART)
      const r = ask({ op: 'read', path, offset, length })
      if (r.result === NOT_FOUND) throw new Error('gone')
      if (r.result !== OK) throw new Error('read failed')
      into.set(d.subarray(0, r.length), 0)
      return r.length
    },
  }
}

/** The main thread's side: the questions, as asynchronous work over the CRM. */
export interface AsyncFsHandler {
  stat(path: string): Promise<FsEntry | null>
  list(path: string, marker: string | null): Promise<{ entries: FsEntry[]; more: boolean }>
  /** At most `length` bytes (never more than READ_PART) from `offset`; fewer only at the end of the file. */
  read(path: string, offset: number, length: number): Promise<Uint8Array>
  /** S9b: the saves, when this agent keeps a spool (absent: the drive is read-only and says so). */
  writes?: AsyncFsWrites
}

export interface AsyncFsWrites {
  create(path: string, dir: boolean): Promise<{ sid: number; entry: FsEntry }>
  open(path: string, truncate: boolean): Promise<{ sid: number; entry: FsEntry }>
  write(sid: number, offset: number, data: Uint8Array, toEnd: boolean): Promise<{ written: number; entry: FsEntry }>
  setSize(sid: number, size: number): Promise<FsEntry>
  release(sid: number, del: boolean): Promise<void>
  rename(from: string, to: string, replace: boolean): Promise<void>
  canDelete(sid: number, path: string): Promise<boolean>
  remove(path: string): Promise<void>
}

/** Answers one request: writes the reply into the shared buffer and wakes the worker. A late answer to a request the worker gave up on is dropped. */
export async function answerBridgeRequest(handler: AsyncFsHandler, bufs: BridgeBuffers, req: BridgeRequest): Promise<void> {
  const c = new Int32Array(bufs.ctrl)
  const d = new Uint8Array(bufs.data)
  let result = FAILED
  let length = 0
  try {
    if (req.op === 'stat') {
      const e = await handler.stat(req.path)
      if (e) {
        length = writeJson(d, e)
        result = OK
      } else result = NOT_FOUND
    } else if (req.op === 'list') {
      let page = await handler.list(req.path, req.marker)
      // A page that does not fit as JSON is cut (and says there is more): WinFsp asks again from the last name it was given.
      let entries = page.entries.slice(0, LIST_PAGE)
      let more = page.more || page.entries.length > entries.length
      let text = JSON.stringify({ entries, more })
      while (Buffer.byteLength(text) > d.length && entries.length > 1) {
        entries = entries.slice(0, Math.floor(entries.length / 2))
        more = true
        text = JSON.stringify({ entries, more })
      }
      page = { entries, more }
      length = writeBytes(d, Buffer.from(text, 'utf8'))
      result = OK
    } else if (req.op === 'read') {
      const bytes = await handler.read(req.path, req.offset, Math.min(req.length, READ_PART, d.length))
      length = Math.min(bytes.length, d.length)
      d.set(bytes.subarray(0, length), 0)
      result = OK
    } else {
      const w = handler.writes
      if (!w) throw new FsStatusError(NT.MEDIA_WRITE_PROTECTED)
      if (req.op === 'create') length = writeJson(d, await w.create(req.path, req.dir))
      else if (req.op === 'open') length = writeJson(d, await w.open(req.path, req.truncate))
      else if (req.op === 'write') {
        // The bytes are copied out of the shared buffer at once: the answer goes into the same buffer.
        const data = Buffer.from(d.subarray(0, Math.min(req.length, WRITE_PART, d.length)))
        length = writeJson(d, await w.write(req.sid, req.offset, data, req.toEnd))
      } else if (req.op === 'setsize') length = writeJson(d, await w.setSize(req.sid, req.size))
      else if (req.op === 'release') await w.release(req.sid, req.del)
      else if (req.op === 'rename') await w.rename(req.from, req.to, req.replace)
      else if (req.op === 'candelete') length = writeJson(d, { ok: await w.canDelete(req.sid, req.path) })
      else if (req.op === 'remove') await w.remove(req.path)
      result = OK
    }
  } catch (e) {
    const nt = (e as { nt?: unknown })?.nt
    result = typeof nt === 'number' ? nt : (e as { notFound?: boolean })?.notFound ? NOT_FOUND : FAILED
    length = 0
  }
  if (Atomics.load(c, NUMBER) !== req.n) return
  Atomics.store(c, RESULT, result)
  Atomics.store(c, LENGTH, length)
  Atomics.store(c, STATE, 2)
  Atomics.notify(c, STATE)
}

function writeJson(d: Uint8Array, value: unknown): number {
  return writeBytes(d, Buffer.from(JSON.stringify(value), 'utf8'))
}
function writeBytes(d: Uint8Array, b: Uint8Array): number {
  if (b.length > d.length) throw new Error('reply too large')
  d.set(b, 0)
  return b.length
}
