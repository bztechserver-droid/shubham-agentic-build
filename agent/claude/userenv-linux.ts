import { createRequire } from 'node:module'
import type * as Koffi from 'koffi'
import type { UserEnv } from './userenv.ts'

// F-116: where F-007's CLAUDE_CODE_OAUTH_TOKEN is kept on Linux, never in a file and never on a command line.
//
// Windows keeps it in the account's own environment (userenv.ts), and every program started afterwards gets it. On
// Linux the only reader that matters is this agent: it hands the token to each chat's claude in that chat's
// environment (agentic/chats.ts, librarian.ts). So it lives in the kernel's SESSION keyring, the one this agent shares
// with start.sh, which runs it (a systemd user service gets a session keyring of its own). It stays there while the
// agent restarts (Update, a crash), and it is gone when start.sh ends (the service stops, the PC restarts); the agent's
// check at its start then asks the CRM again with the 7-day session it keeps, as it does every hour, and puts it back.
// Other programs of this account outside that session can't read it, and a claude started by hand in a terminal
// doesn't get it (the page says so).
//
// The kernel calls go through libc's syscall() with koffi (no keyutils package needed, nothing run). When that can't
// be had, the token is kept in this process's memory only: the CRM is asked again at every start.

export type LinuxStore = 'keyring' | 'memory'

/** The kernel keyring as this file uses it; tests give a pretend one. */
export interface Keyring {
  /** The key's payload, or null when there is none. */
  read(description: string): Buffer | null
  /** Makes the key, or replaces its payload. */
  write(description: string, payload: Buffer): void
  /** False when there was none. */
  remove(description: string): boolean
}

// The syscall numbers (they differ by architecture), and the keyctl() operations used.
const SYSCALLS: Record<string, { addKey: number; keyctl: number }> = {
  x64: { addKey: 248, keyctl: 250 },
  arm64: { addKey: 217, keyctl: 219 },
}
const KEY_SPEC_SESSION_KEYRING = -3
const KEYCTL_GET_KEYRING_ID = 0
const KEYCTL_UNLINK = 9
const KEYCTL_SEARCH = 10
const KEYCTL_READ = 11
const ENOKEY = 126
const EKEYEXPIRED = 127
const EKEYREVOKED = 128

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The session keyring through libc's syscall(); throws when it can't be had here. */
export function kernelKeyring(k: typeof Koffi, arch: string = process.arch): Keyring {
  const nr = SYSCALLS[arch]
  if (!nr) throw new Error(`no keyring calls for ${arch}`)
  const libc = k.load('libc.so.6')
  const syscall = libc.func('long syscall(long number, ...)')
  const fail = (what: string) => new Error(`${what}: errno ${k.errno()}`)
  // Make sure there is a session keyring (the kernel makes one when asked with create = 1).
  if ((syscall(nr.keyctl, 'long', KEYCTL_GET_KEYRING_ID, 'long', KEY_SPEC_SESSION_KEYRING, 'long', 1) as number) < 0) throw fail('no session keyring')
  const find = (description: string): number | null => {
    const id = syscall(nr.keyctl, 'long', KEYCTL_SEARCH, 'long', KEY_SPEC_SESSION_KEYRING, 'str', 'user', 'str', description, 'long', 0) as number
    if (id >= 0) return id
    const e = k.errno()
    if (e === ENOKEY || e === EKEYEXPIRED || e === EKEYREVOKED) return null
    throw fail(`couldn't look up ${description}`)
  }
  return {
    read(description) {
      const id = find(description)
      if (id === null) return null
      // Twice: once for the size, once for the payload (as userenv.ts does on Windows).
      const size = syscall(nr.keyctl, 'long', KEYCTL_READ, 'long', id, 'void *', null, 'long', 0) as number
      if (size < 0) throw fail(`couldn't read ${description}`)
      const data = Buffer.alloc(size)
      const got = syscall(nr.keyctl, 'long', KEYCTL_READ, 'long', id, 'void *', data, 'long', size) as number
      if (got < 0) throw fail(`couldn't read ${description}`)
      return data.subarray(0, Math.min(got, size))
    },
    write(description, payload) {
      // add_key replaces the payload of a key with the same type and description in that keyring.
      const id = syscall(nr.addKey, 'str', 'user', 'str', description, 'void *', payload, 'long', payload.length, 'long', KEY_SPEC_SESSION_KEYRING) as number
      if (id < 0) throw fail(`couldn't keep ${description}`)
    },
    remove(description) {
      const id = find(description)
      if (id === null) return false
      if ((syscall(nr.keyctl, 'long', KEYCTL_UNLINK, 'long', id, 'long', KEY_SPEC_SESSION_KEYRING) as number) < 0) throw fail(`couldn't remove ${description}`)
      return true
    },
  }
}

/** Kept in this process only. */
export function memoryKeyring(): Keyring {
  const keys = new Map<string, Buffer>()
  return {
    read: d => keys.get(d) ?? null,
    write: (d, p) => void keys.set(d, Buffer.from(p)),
    remove: d => keys.delete(d),
  }
}

/** A UserEnv over a keyring: each variable is one key, "shubham-agentic:<scope>:<name>", its payload the value in UTF-8. */
export function keyringUserEnv(ring: Keyring, scope: string): UserEnv {
  const d = (name: string) => `shubham-agentic:${scope}:${name}`
  return {
    get(name) {
      const b = ring.read(d(name))
      return b === null ? null : b.toString('utf8')
    },
    set(name, value) {
      ring.write(d(name), Buffer.from(value, 'utf8'))
    },
    remove(name) {
      return ring.remove(d(name))
    },
    // Nothing to tell: only this agent reads it, and it reads it again for each chat it starts.
    announce: () => Promise.resolve(),
  }
}

// One per scope in this process: main.ts and claude/index.ts each load it, and must see the same value (with the
// memory store above all, which two separate copies would not share).
const made = new Map<string, { env: UserEnv; store: LinuxStore; note: string | null }>()

/** The Linux UserEnv for `scope` (userenv.ts's key: "Environment"): the kernel keyring, else memory only. */
export function linuxUserEnv(scope: string, o: { koffi?: () => typeof Koffi; arch?: string } = {}): { env: UserEnv; store: LinuxStore; note: string | null } {
  const had = made.get(scope)
  if (had) return had
  let out: { env: UserEnv; store: LinuxStore; note: string | null }
  try {
    const k = o.koffi ? o.koffi() : (createRequire(import.meta.url)('koffi') as typeof Koffi)
    out = { env: keyringUserEnv(kernelKeyring(k, o.arch), scope), store: 'keyring', note: null }
  } catch (e) {
    out = { env: keyringUserEnv(memoryKeyring(), scope), store: 'memory', note: `the kernel keyring couldn't be used (${message(e)}): the sign-in is kept in memory only, and the CRM is asked again at each start` }
  }
  made.set(scope, out)
  return out
}

/** Tests: forget what was made. */
export function resetLinuxUserEnv() {
  made.clear()
}
