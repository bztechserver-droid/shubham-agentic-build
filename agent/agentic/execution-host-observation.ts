import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { executionHttpError } from '../../shared/chat-execution-http.ts'
import type { HostChat } from '../chathost/protocol.ts'

interface Epoch { generation: number; hostPid: number; hostStartedAt: number }
interface ProxyProcess { pid: number; ppid: number; created: number; file: string }
export interface MissingHostPidPorts {
  current(): Epoch
  /** Reads owner-only, exact-run private artifacts; never a public request's PID. */
  ready(chat: HostChat): number
  process(pid: number): Promise<ProxyProcess | null>
  node: string
}

/** The pinned Windows node-pty exposes its PID only after spawn returns. The protocol-1
 * host retained the initial undefined value. Recover that missing value only from an
 * exact private run plus an OS-observed direct child of this authenticated host.
 * The bridge subsequently checks command, executable hash, Claude child, listener and lease.
 */
export async function recoverUnreportedHostPids<T extends { hostPid: number; hostStartedAt: number; chats: HostChat[] }>(observation: T, ports: MissingHostPidPorts): Promise<T> {
  const epoch = ports.current()
  const fence = () => {
    if (!isDeepStrictEqual(epoch, ports.current()) || observation.hostPid !== epoch.hostPid || observation.hostStartedAt !== epoch.hostStartedAt) {
      throw executionHttpError('execution-runtime-mismatch', 'runtime')
    }
  }
  fence()
  let changed = false
  const chats: HostChat[] = []
  for (const chat of observation.chats) {
    if (chat.exited || (chat.pid !== undefined && chat.pid !== 0) || typeof chat.meta.bridgeRunId !== 'string'
      || !/^[A-Za-z0-9_-]{16,128}$/.test(chat.meta.bridgeRunId)) { chats.push(chat); continue }
    let pid: number
    try { pid = ports.ready(chat) } catch { chats.push(chat); continue }
    if (!Number.isSafeInteger(pid) || pid <= 0) { chats.push(chat); continue }
    const process = await ports.process(pid)
    fence()
    const started = Date.parse(String(chat.meta.startedAt))
    if (!process || process.pid !== pid || process.ppid !== epoch.hostPid || !Number.isSafeInteger(process.created)
      || process.created < epoch.hostStartedAt || !Number.isFinite(started) || !Number.isSafeInteger(chat.startedAt)
      || Math.abs(process.created - started) > 10_000 || Math.abs(process.created - chat.startedAt) > 10_000
      || typeof process.file !== 'string' || path.resolve(process.file).toLowerCase() !== path.resolve(ports.node).toLowerCase()) {
      chats.push(chat); continue
    }
    changed = true; chats.push({ ...chat, pid })
  }
  fence()
  return changed ? { ...observation, chats } : observation
}
