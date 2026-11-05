import { readdir, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import type { Listen, Proc } from './block.ts'
import type { NetScan, ProcScan } from './scan.ts'

// F-116: Ports' two scanners on Linux, read straight from /proc (nothing is run):
//  - the listening TCP ports: /proc/net/tcp and tcp6 (state 0A), each with the socket's owner (uid) and inode. The inode is matched to a PID through
//    /proc/<pid>/fd of the processes this user may read (its own). A port of another user's or a system account's process has no PID here: the uid says whose it is.
//      uid < 1000 (root, systemd-resolve, cups ...) or 65534 (nobody): the system's, never shared (block.ts, 'windows', worded for both systems).
//      another person's (uid >= 1000, not ours): no PID and no program, so Share all never takes it.
//  - the processes: /proc/<pid>/exe, cmdline, comm and status (PPid). The name is the program file's (exe; Node's own process calls itself "MainThread" in comm),
//    then the command's first word, then comm. Another user's exe can't be read: its cmdline still can, and decides.

/** One listening socket from /proc/net/tcp(6). */
export interface ProcSocket {
  port: number
  /** On loopback or on all addresses (the Ports gate reaches it as localhost). */
  reachable: boolean
  uid: number
  inode: number
}

const ANY4 = '00000000'
const LOOP4 = '0100007F' // 127.0.0.1, as the kernel prints it (little-endian)
const ANY6 = '0'.repeat(32)
const LOOP6 = '00000000000000000000000001000000' // ::1
const LISTEN = '0A'

/** The listening sockets in /proc/net/tcp (or tcp6, `v6`). */
export function parseProcNet(text: string, v6 = false): ProcSocket[] {
  const out: ProcSocket[] = []
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== LISTEN) continue
    const [addr, portHex] = f[1].split(':')
    const port = parseInt(portHex, 16)
    const uid = Number(f[7])
    const inode = Number(f[9])
    if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(uid) || !Number.isInteger(inode)) continue
    const a = addr.toUpperCase()
    const reachable = v6 ? a === ANY6 || a === LOOP6 : a === ANY4 || a === LOOP4
    out.push({ port, reachable, uid, inode })
  }
  return out
}

/** A system account's socket (root, a service's own account, nobody): never shared. */
export const systemUid = (uid: number) => uid < 1000 || uid === 65534

/**
 * One Listen per port, as netstat's parser does it: reachable if ANY of its sockets is; the PID of a reachable one first. `pidOf` maps an inode to its PID (or null).
 * A socket whose PID can't be read gets -1; `uid` is kept so block.ts can tell the system's ports.
 */
export function listensOf(sockets: ProcSocket[], pidOf: (inode: number) => number | null): Listen[] {
  const out = new Map<number, Listen>()
  for (const s of sockets) {
    const pid = pidOf(s.inode) ?? -1
    const had = out.get(s.port)
    const keepHad = had && ((had.reachable && !s.reachable) || (had.pid > 0 && pid < 0))
    out.set(s.port, keepHad ? { ...had, reachable: had.reachable || s.reachable } : { port: s.port, pid, reachable: Boolean(had?.reachable) || s.reachable, uid: s.uid })
  }
  return [...out.values()].sort((a, b) => a.port - b.port)
}

export interface LinuxScanDeps {
  /** /proc; tests give a folder of their own. */
  root?: string
}

/** The two scanners for Linux. The inode -> PID map is kept between scans, so a port that stays does not cost a walk of every process's files again. */
export function linuxScanners(d: LinuxScanDeps = {}): { net: NetScan; procs: ProcScan } {
  const root = d.root ?? '/proc'
  const known = new Map<number, number>()

  async function socketsNow(): Promise<ProcSocket[]> {
    const read = (f: string) => readFile(path.join(root, 'net', f), 'utf8').catch(() => '')
    const [t4, t6] = await Promise.all([read('tcp'), read('tcp6')])
    return [...parseProcNet(t4), ...parseProcNet(t6, true)]
  }

  /** Walks /proc/<pid>/fd of the processes it may read, for the inodes not known yet. */
  async function findPids(wanted: Set<number>) {
    if (wanted.size === 0) return
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!/^\d+$/.test(name)) continue
      const fds = await readdir(path.join(root, name, 'fd')).catch(() => null)
      if (!fds) continue
      for (const fd of fds) {
        const link = await readlink(path.join(root, name, 'fd', fd)).catch(() => '')
        const m = /^socket:\[(\d+)\]$/.exec(link)
        if (m && wanted.has(Number(m[1]))) {
          known.set(Number(m[1]), Number(name))
          wanted.delete(Number(m[1]))
          if (wanted.size === 0) return
        }
      }
    }
  }

  const net: NetScan = async () => {
    const sockets = await socketsNow()
    const live = new Set(sockets.map(s => s.inode))
    for (const inode of [...known.keys()]) if (!live.has(inode)) known.delete(inode)
    // Only sockets that could be ours: a system account's or another person's can't be read anyway.
    const me = process.getuid?.() ?? -1
    await findPids(new Set(sockets.filter(s => s.uid === me && !known.has(s.inode)).map(s => s.inode)))
    return listensOf(sockets, inode => known.get(inode) ?? null)
  }

  const procs: ProcScan = async () => {
    const out: Proc[] = []
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (!/^\d+$/.test(name)) continue
      const dir = path.join(root, name)
      const [status, cmdline, comm, exe] = await Promise.all([
        readFile(path.join(dir, 'status'), 'utf8').catch(() => null),
        readFile(path.join(dir, 'cmdline'), 'utf8').catch(() => null),
        readFile(path.join(dir, 'comm'), 'utf8').catch(() => null),
        readlink(path.join(dir, 'exe')).catch(() => null),
      ])
      if (status === null) continue
      const p = procOf(Number(name), status, cmdline, comm, exe)
      if (p) out.push(p)
    }
    return out
  }

  return { net, procs }
}

/** One process from its /proc files. `exe` is null when it can't be read (another user's); `cmdline` is null or empty for kernel threads. */
export function procOf(pid: number, status: string, cmdline: string | null, comm: string | null, exe: string | null): Proc | null {
  const ppid = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0)
  const args = (cmdline ?? '').split('\0').filter(Boolean)
  const cmd = args.length ? args.join(' ') : null
  const file = exe ? exe.replace(/ \(deleted\)$/, '') : null
  const base = (s: string) => path.posix.basename(s)
  const name = (file ? base(file) : args[0] ? base(args[0]) : (comm ?? '').trim()).toLowerCase()
  if (!name) return null
  return { pid, ppid, name, exe: file, cmd }
}
