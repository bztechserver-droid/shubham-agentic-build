import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// F-134: the Codex CLI on this PC. Not installed by this app: a person (or a later step, with Shubham's yes, a pinned download) puts it there. Found the way claude is:
// SAD_CODEX_BIN, else codex on PATH, else ~/.local/bin. Its version is asked once per file (`codex --version`) and remembered until the file changes.

export interface CodexInstall {
  path: string
  version: string | null
}

const cache = new Map<string, { key: string; version: string | null }>()

/** "codex-cli 0.163.0" to "0.163.0". */
export const parseVersion = (out: string): string | null => /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(out)?.[1] ?? null

function versionOf(file: string): string | null {
  let key: string
  try {
    const st = statSync(file)
    key = `${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
  const hit = cache.get(file)
  if (hit?.key === key) return hit.version
  let version: string | null = null
  try {
    const cmd = /\.cmd$/i.test(file)
    const r = spawnSync(cmd ? (process.env.ComSpec ?? 'cmd.exe') : file, cmd ? ['/d', '/c', file, '--version'] : ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    if (r.status === 0) version = parseVersion(`${r.stdout ?? ''}`)
  } catch {
    // Not runnable: installed, version unknown.
  }
  cache.set(file, { key, version })
  return version
}

export function findCodex(env: NodeJS.ProcessEnv = process.env): CodexInstall | null {
  const explicit = env.SAD_CODEX_BIN?.trim()
  if (explicit) return existsSync(explicit) ? { path: explicit, version: versionOf(explicit) } : null
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']
  for (const name of names)
    for (const dir of dirs) {
      const file = path.join(dir, name)
      if (existsSync(file)) return { path: file, version: versionOf(file) }
    }
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
  return existsSync(local) ? { path: local, version: versionOf(local) } : null
}
