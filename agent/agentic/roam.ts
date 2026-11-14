import type { Duplex } from 'node:stream'
import { apiError } from '../api.ts'
import { appendAt, CHUNK, markOf, NO_FILE, readRange, replacer, sameMark, type FileMark } from './mirror.ts'

// F-021: the Agents section's part of the link between the hub's PCs: 'agentic' streams on the
// link's mux (agent/link/mux.ts), each newline-delimited JSON both ways. The opener's meta says
// what the stream is ({op}); the link adds `from`, the paired PC that opened it, which is how
// the far end is known (never from what it says).
//   a request    the opener writes one line and ends; the answer is one line,
//                {ok: true, value} or {ok: false, status, error}
//   subscribe    a member's standing stream to its hub: the hub's floors and who runs what
//                one way, the member's live chats and JSONL the other, as events
//   pull         a copy brought up to the far end's: one line asking, then {replace, bytes}
//                and the bytes as base64 lines

export const LINK_KIND = 'agentic'
/** A line longer than this ends the stream: a JSONL piece (CHUNK) in base64 fits well within. */
const MAX_LINE = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

/** One of the hub's other PCs, as far as the Agents section needs: who, and a stream to it. */
export interface LinkPeer {
  id: string
  name: string
  /** Opens an 'agentic' stream with this meta. */
  open(meta: Record<string, unknown>): Promise<Duplex>
  /** The link it rides (a new one after a reconnect). */
  token: object
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Calls `onLine` with each line's JSON, in order; a malformed or overlong line ends the stream. */
export function readLines(stream: Duplex, onLine: (v: unknown) => void): void {
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    rest += chunk
    let at: number
    while ((at = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, at)
      rest = rest.slice(at + 1)
      if (!line.trim()) continue
      let v: unknown
      try {
        v = JSON.parse(line)
      } catch {
        stream.destroy(new Error('a line that is not JSON'))
        return
      }
      onLine(v)
    }
    if (rest.length > MAX_LINE) stream.destroy(new Error('a line too long'))
  })
  stream.on('error', () => {})
}

export const writeLine = (stream: Duplex, v: unknown) => !stream.destroyed && stream.write(`${JSON.stringify(v)}\n`)

/** Every line until the far end ends the stream. */
function allLines(stream: Duplex, timeoutMs: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const got: unknown[] = []
    const timer = setTimeout(() => {
      stream.destroy()
      reject(new Error('the other PC took too long to answer'))
    }, timeoutMs)
    timer.unref()
    readLines(stream, v => got.push(v))
    stream.on('end', () => {
      clearTimeout(timer)
      resolve(got)
    })
    stream.on('close', () => {
      clearTimeout(timer)
      resolve(got)
    })
    stream.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/** Asks `peer` for `op` with `body`; its answer, or its error (with its status) thrown. */
export async function request<T>(peer: LinkPeer, op: string, body: unknown = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  let stream: Duplex
  try {
    stream = await peer.open({ op })
  } catch (e) {
    // F-221 (ob98a, fix round 2): the stream never opened, so nothing of this request reached that PC (`sent: false`); a caller that must tell "not
    // done" from "not known" (a spoken line, his tap on a held message) reads it. Every failure after this point may have been carried out there.
    throw Object.assign(apiError(502, `${peer.name} turned it down: ${message(e)}`), { sent: false })
  }
  stream.end(`${JSON.stringify(body)}\n`)
  let lines: unknown[]
  try {
    lines = await allLines(stream, timeoutMs)
  } catch (e) {
    throw apiError(504, `${peer.name} didn't answer: ${message(e)}`)
  }
  const a = lines[0] as { ok?: boolean; value?: T; status?: number; error?: string; code?: string } | undefined
  if (!a || typeof a !== 'object') throw apiError(502, `${peer.name} gave no answer`)
  if (a.ok) return a.value as T
  throw Object.assign(apiError(typeof a.status === 'number' ? a.status : 502, a.error ?? `${peer.name} said no`), typeof a.code === 'string' ? { code: a.code } : {})
}

/** The far end of `request`: reads its one line, answers with what `run` gives (or its error). */
export function answer(run: (body: unknown) => Promise<unknown> | unknown): (stream: Duplex) => void {
  return stream => {
    let done = false
    readLines(stream, body => {
      if (done) return
      done = true
      Promise.resolve()
        .then(() => run(body))
        .then(
          value => stream.end(`${JSON.stringify({ ok: true, value: value ?? null })}\n`),
          (e: unknown) => {
            const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500
            const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : undefined
            stream.end(`${JSON.stringify({ ok: false, status, error: message(e), code })}\n`)
          },
        )
    })
  }
}

// ---------------------------------------------------------------------------------------------
// pull: a copy brought up to the far end's

export interface PullAsk {
  sessionId: string
  /** What the asker has: its size and the hash before it. */
  have: FileMark
}

/**
 * The far end of a pull, for `file` (null: it has none). The asker's bytes are checked against
 * this copy's at the same size: agreeing, only the rest is sent; not, all of it, to replace.
 */
export function servePull(fileOf: (sessionId: string) => string | null): (stream: Duplex) => void {
  return stream => {
    let asked = false
    readLines(stream, raw => {
      if (asked) return
      asked = true
      const ask = raw as Partial<PullAsk>
      const file = typeof ask.sessionId === 'string' ? fileOf(ask.sessionId) : null
      const mine = file ? markOf(file) : NO_FILE
      const have = ask.have && typeof ask.have.bytes === 'number' && typeof ask.have.tail === 'string' ? ask.have : NO_FILE
      // None here: the asker keeps what it has.
      if (!file || !mine.bytes) {
        writeLine(stream, { replace: false, bytes: have.bytes })
        return void stream.end()
      }
      const replace = have.bytes > mine.bytes || (have.bytes > 0 && !sameMark(markOf(file, have.bytes), have))
      let at = replace ? 0 : have.bytes
      writeLine(stream, { replace, bytes: mine.bytes })
      const more = () => {
        while (at < mine.bytes) {
          const data = readRange(file, at, Math.min(CHUNK, mine.bytes - at))
          if (!data.length) break
          at += data.length
          if (!writeLine(stream, { d: data.toString('base64') })) return void stream.once('drain', more)
        }
        stream.end()
      }
      more()
    })
  }
}

/**
 * Brings `file` up to `peer`'s copy of the session. Resolves with the mark it ends at (that
 * copy's size then). A copy that disagrees is replaced whole, written beside and swapped in.
 */
export async function pullFrom(peer: LinkPeer, sessionId: string, file: string, mayWrite: () => boolean = () => true): Promise<FileMark> {
  if (!mayWrite()) throw apiError(409, 'This conversation is fenced while changing engines')
  const stream = await peer.open({ op: 'pull' })
  stream.write(`${JSON.stringify({ sessionId, have: markOf(file) } satisfies PullAsk)}\n`)
  return new Promise<FileMark>((resolve, reject) => {
    let head: { replace: boolean; bytes: number } | null = null
    let into: ReturnType<typeof replacer> | null = null
    let at = 0
    let failed = false
    const fail = (e: Error) => {
      if (failed) return
      failed = true
      into?.abort()
      stream.destroy()
      reject(e)
    }
    readLines(stream, v => {
      if (failed) return
      if (!mayWrite()) return fail(apiError(409, 'This conversation became fenced during transcript transfer'))
      const line = v as { replace?: boolean; bytes?: number; d?: string }
      if (!head) {
        head = { replace: line.replace === true, bytes: typeof line.bytes === 'number' ? line.bytes : 0 }
        if (head.replace) into = replacer(file)
        at = head.replace ? 0 : markOf(file).bytes
        return
      }
      if (typeof line.d !== 'string') return
      const data = Buffer.from(line.d, 'base64')
      try {
        if (into) into.write(data)
        else if (appendAt(file, at, data) !== 'ok') return fail(new Error('the copy here changed while it was being brought up'))
      } catch (e) {
        return fail(e instanceof Error ? e : new Error(String(e)))
      }
      at += data.length
    })
    stream.on('end', () => {
      if (failed) return
      if (!head) return fail(new Error(`${peer.name} sent nothing`))
      if (at !== head.bytes) return fail(new Error(`${peer.name} sent ${at} of ${head.bytes} bytes`))
      try {
        if (!mayWrite()) return fail(apiError(409, 'This conversation became fenced before transcript replacement'))
        into?.done()
      } catch (e) {
        return fail(e instanceof Error ? e : new Error(String(e)))
      }
      resolve(markOf(file))
    })
    stream.on('error', e => fail(e))
  })
}
