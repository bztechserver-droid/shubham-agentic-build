import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'

type FenceProtocol = 'execution-profile-v1'
interface Fence { sessionId: string; token: string; state: 'preparing' | 'sealed' | 'retired'; file?: string; sha256?: string; protocol?: FenceProtocol }

/** Streaming source identity. Kept privately on the source PC, never sent as transcript content. */
export function sourceHash(file: string): string {
  const fd = openSync(file, 'r'), chunk = Buffer.alloc(64 * 1024), hash = createHash('sha256')
  try { let n: number; while ((n = readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, n)); return hash.digest('hex') }
  finally { closeSync(fd) }
}

/** Durable source-host fence. A lost hub reply never turns an old session writable again by timeout. */
export function createSwitchFences(file: string) {
  const records = new Map<string, Fence>()
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(raw)) throw new Error('Invalid fence state')
    for (const f of raw) {
      if (!f || typeof f.sessionId !== 'string' || typeof f.token !== 'string' || !['preparing', 'sealed', 'retired'].includes(f.state) || records.has(f.sessionId)
        || (f.protocol !== undefined && f.protocol !== 'execution-profile-v1')) throw new Error('Invalid fence record')
      records.set(f.sessionId, f)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Engine-switch state is unreadable; original session artifacts must be kept until it is repaired')
  }
  const save = () => writeAtomic(file, JSON.stringify([...records.values()]) + '\n')
  const get = (sid: string, token: string, protocol?: FenceProtocol) => {
    const f = records.get(sid)
    if (!f || f.token !== token || f.protocol !== protocol) throw Object.assign(apiError(409, 'Engine switch preparation changed. Retry from the current conversation.'), { code: 'engine-change-stale' })
    return f
  }
  return {
    // Legacy reconciliation owns only untagged fences. Profile CAS/recovery must retain its own fences.
    pending: (protocol?: FenceProtocol) => [...records.values()].filter(f => f.state !== 'retired' && f.protocol === protocol).map(f => ({ ...f })),
    blocked: (sid: string) => records.has(sid),
    assertWritable(sid: string) {
      const f = records.get(sid)
      if (f) throw Object.assign(apiError(409, f.state === 'retired' ? 'This session was carried to another engine. Refresh to open the current conversation.' : 'This conversation is being carried to another engine. Wait for the switch to finish.'), { code: f.state === 'retired' ? 'engine-change-stale' : 'engine-change-in-progress' })
    },
    begin(sid: string, token: string, protocol?: FenceProtocol) {
      const old = records.get(sid)
      if (protocol !== undefined && protocol !== 'execution-profile-v1') throw Object.assign(apiError(409, 'Unsupported source fence protocol.'), { code: 'engine-change-stale' })
      if (old?.state === 'retired') throw Object.assign(apiError(409, 'This native session has already been carried to another engine.'), { code: 'engine-change-stale' })
      if (old && (old.token !== token || old.protocol !== protocol)) throw Object.assign(apiError(409, 'Another switch already holds this conversation.'), { code: 'engine-change-in-progress' })
      if (!old) { records.set(sid, { sessionId: sid, token, state: 'preparing', ...(protocol ? { protocol } : {}) }); save() }
    },
    snapshot(sid: string, token: string, source: string, protocol?: FenceProtocol) {
      const f = get(sid, token, protocol)
      f.file = source; f.sha256 = sourceHash(source); save()
    },
    seal(sid: string, token: string, protocol?: FenceProtocol) {
      const f = get(sid, token, protocol)
      if (!f.file || !f.sha256 || sourceHash(f.file) !== f.sha256) throw Object.assign(apiError(409, 'The source history changed after its snapshot. No switch was committed; new turns remain in the original.'), { code: 'engine-change-stale' })
      f.state = 'sealed'; save()
    },
    retire(sid: string, token: string, protocol?: FenceProtocol) { const f = get(sid, token, protocol); f.state = 'retired'; save() },
    cancel(sid: string, token: string, protocol?: FenceProtocol) { const f = records.get(sid); if (f?.token === token && f.state !== 'retired') { get(sid, token, protocol); records.delete(sid); save() } },
  }
}
