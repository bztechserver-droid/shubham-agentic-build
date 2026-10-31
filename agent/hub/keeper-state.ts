import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ServerStatus } from '../../shared/agent-api.ts'
import { writeAtomic } from '../config.ts'

// F-058: the RustDesk servers (hbbs, hbbr) run in a process of their own, the keeper (keeper.ts), so
// that they go on when the agent dies, and Control by RustDesk works while the app restarts. The
// keeper writes what it sees to this file every few seconds and at every change; the agent
// (external-servers.ts) reads it, so its Devices page and its pairing still know the servers'
// state and key. A file older than STALE_MS, or one whose process is gone, is a keeper that is not there.

export const KEEPER_STALE_MS = 8000

export interface KeeperState {
  v: 1
  /** The keeper's own PID. */
  pid: number
  startedAt: string
  /** When this was written, in ms since the epoch. */
  updatedAt: number
  servers: ServerStatus[]
  /** hbbs's public key once it has proven it runs with it. */
  key: string | null
}

export const keeperFile = (workDir: string) => path.join(workDir, 'keeper-state.json')

export function writeKeeperState(workDir: string, state: KeeperState): void {
  writeAtomic(keeperFile(workDir), JSON.stringify(state))
}

const isStatus = (s: unknown): s is ServerStatus => {
  const o = s as Partial<ServerStatus> | null
  return !!o && (o.name === 'hbbs' || o.name === 'hbbr') && typeof o.state === 'string' && Array.isArray(o.ports) && typeof o.restarts === 'number'
}

/** The state file, or null when it is missing or not one of ours. */
export function readKeeperState(workDir: string): KeeperState | null {
  try {
    const v = JSON.parse(readFileSync(keeperFile(workDir), 'utf8')) as Partial<KeeperState>
    if (v.v !== 1 || typeof v.pid !== 'number' || typeof v.updatedAt !== 'number' || !Array.isArray(v.servers) || !v.servers.every(isStatus)) return null
    return { v: 1, pid: v.pid, startedAt: String(v.startedAt ?? ''), updatedAt: v.updatedAt, servers: v.servers, key: typeof v.key === 'string' ? v.key : null }
  } catch {
    return null
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A keeper is there if it wrote lately and its process still exists. */
export function keeperAlive(state: KeeperState | null, now: number = Date.now(), alive: (pid: number) => boolean = pidAlive): state is KeeperState {
  return state !== null && now - state.updatedAt <= KEEPER_STALE_MS && alive(state.pid)
}
