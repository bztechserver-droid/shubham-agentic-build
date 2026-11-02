import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HOST_PROTOCOL, HOST_VERSION } from './protocol.ts'

// F-075: the chat host runs from a copy of its own files, not from the build folder. Windows will not let a
// folder be deleted while a process has a native module of it loaded (measured on 1 Nov 2026: EPERM on
// node_modules with node-pty loaded), so a host that ran from the build would make `npm ci` after an update
// fail, and `git pull` could swap its files under it. The copy is made once per version of its code:
//   <state>/chathost/host-p<protocol>-v<version>-<hash>/{agent/..., node_modules/node-pty}
// and old copies are removed when no host runs from them.

const HOST_FILES = ['agent/chathost/main.ts', 'agent/chathost/host.ts', 'agent/chathost/protocol.ts', 'agent/log.ts', 'agent/proc-tree.ts']

export interface HostCopy {
  /** The folder. */
  dir: string
  /** The file to run with node. */
  entry: string
}

const other = (p: string) => /[\\/]prebuilds[\\/](?!win32-x64)[^\\/]+$/.test(p) || /[\\/]node-pty[\\/](src|typings|scripts|third_party[\\/]conpty[\\/][^\\/]+[\\/]win10-arm64)/.test(p)

/** A fingerprint of what the host runs: its files and the node-pty it uses. */
export function hostFingerprint(buildRoot: string): string {
  const h = createHash('sha256')
  for (const f of HOST_FILES) h.update(f).update(readFileSync(path.join(buildRoot, f)))
  try {
    const pkg = JSON.parse(readFileSync(path.join(buildRoot, 'node_modules', 'node-pty', 'package.json'), 'utf8')) as { version?: string }
    h.update(`node-pty ${pkg.version ?? '?'}`)
  } catch {
    h.update('no node-pty')
  }
  return h.digest('hex').slice(0, 10)
}

/** Makes the copy for this build's host code if it is not there yet. Throws when the build has no node-pty. */
export function prepareHostCopy(buildRoot: string, stateRoot: string): HostCopy {
  const base = path.join(stateRoot, 'chathost')
  const dir = path.join(base, `host-p${HOST_PROTOCOL}-v${HOST_VERSION}-${hostFingerprint(buildRoot)}`)
  const entry = path.join(dir, 'agent', 'chathost', 'main.ts')
  if (existsSync(path.join(dir, '.complete'))) return { dir, entry }
  const pty = path.join(buildRoot, 'node_modules', 'node-pty')
  if (!existsSync(pty)) throw new Error("node-pty isn't installed in the build (npm ci)")
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(path.join(dir, 'agent', 'chathost'), { recursive: true })
  for (const f of HOST_FILES) cpSync(path.join(buildRoot, f), path.join(dir, f))
  cpSync(pty, path.join(dir, 'node_modules', 'node-pty'), { recursive: true, filter: src => !other(src) })
  // The package scope node reads the files' module type from.
  cpSync(path.join(buildRoot, 'package.json'), path.join(dir, 'package.json'))
  // Written last: a copy without it was interrupted and is made again.
  writeFileSync(path.join(dir, '.complete'), new Date().toISOString())
  return { dir, entry }
}

/** Removes copies other than `keep` and `running` (the folder a running host was started from). */
export function pruneHostCopies(stateRoot: string, keep: string, running: string | null) {
  const base = path.join(stateRoot, 'chathost')
  let names: string[] = []
  try {
    names = readdirSync(base).filter(n => n.startsWith('host-p'))
  } catch {
    return
  }
  for (const n of names) {
    const dir = path.join(base, n)
    if (path.resolve(dir) === path.resolve(keep) || (running && path.resolve(running).startsWith(path.resolve(dir)))) continue
    try {
      if (statSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
    } catch {
      // In use: the next time.
    }
  }
}
