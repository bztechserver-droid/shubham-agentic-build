import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseVersion } from '../codex/find.ts'
import { protectPath } from './storage.ts'

/**
 * The Claude Code program Codex in Claude Code runs: the bridge's own copy of the one version it is proved with
 * (BRIDGE_REQUIREMENTS.claude), kept in a private folder beside its storage. Claude Code updates itself by replacing
 * the program on PATH; when the bridge ran that program, an update refused every open ("The operation outcome is
 * uncertain") and paused every running Codex in Claude Code chat (10 Nov 2026 01:00: 2.1.319 to 2.1.321), and after a
 * restart it refused them all as an unproved version. Plain Claude chats keep using (and updating) the PATH program.
 *
 * The copy is made once, from an installed program of exactly that version: the PATH program while it still is that
 * version, or the native installer's kept copy (~/.local/share/claude/versions/<version>). Each is checked with
 * --version before it is used. Nothing is downloaded and the installed programs are never changed.
 */
export const claudeBinDir = (storageDirectory: string) => path.join(path.dirname(storageDirectory), 'codex-claude-bin')

/** `claude --version` of one program, or null when it does not run or says no version. */
export function claudeVersionOf(file: string): string | null {
  try {
    const r = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
    return r.status === 0 ? parseVersion(`${r.stdout ?? ''}`) : null
  } catch { return null }
}

/** Where an installed copy of that exact version may be: the PATH program first, then the native installer's kept versions. */
export function installedClaudeSources(version: string, onPath: string | null, home = os.homedir()): string[] {
  const kept = path.join(home, '.local', 'share', 'claude', 'versions', version)
  return [...new Set([onPath, kept].filter((file): file is string => typeof file === 'string' && path.isAbsolute(file)))]
}

export interface ProvedClaudeOptions {
  /** The bridge's private program folder (claudeBinDir). */
  binDir: string
  /** The one proved version, e.g. 2.1.319. */
  version: string
  /** Installed programs that may be that version (installedClaudeSources). */
  sources: readonly string[]
  versionOf?: (file: string) => string | null
  protect?: (file: string) => void
}

/**
 * The bridge's copy of the proved Claude Code program (claude-<version>.exe), made from the first source that is
 * exactly that version when it is missing or broken. Null when no installed program is that version: the bridge then
 * refuses to start, as before, and no other version is ever used.
 */
export function provedClaudeBinary(o: ProvedClaudeOptions): string | null {
  const versionOf = o.versionOf ?? claudeVersionOf, protect = o.protect ?? protectPath
  if (!/^\d+\.\d+\.\d+$/.test(o.version) || !path.isAbsolute(o.binDir)) return null
  const target = path.join(o.binDir, `claude-${o.version}.exe`)
  fs.mkdirSync(o.binDir, { recursive: true })
  protect(o.binDir)
  if (fs.existsSync(target) && versionOf(target) === o.version) return target
  for (const source of o.sources) {
    let file: fs.Stats
    try { file = fs.statSync(source) } catch { continue }
    if (!file.isFile() || path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) continue
    // A program that runs as it is (.exe) is asked first, so an updated PATH program is not copied for nothing.
    // The installer's kept versions have no extension, so they are asked once copied.
    if (/\.exe$/i.test(source) && versionOf(source) !== o.version) continue
    // Copied under a fresh name, checked, then moved into place: a half-copied or wrong program is never the bridge's.
    const staging = path.join(o.binDir, `claude-${o.version}.${randomUUID()}.next.exe`)
    try {
      fs.copyFileSync(source, staging, fs.constants.COPYFILE_EXCL)
      protect(staging)
      if (versionOf(staging) !== o.version) continue
      fs.renameSync(staging, target)
      return target
    } finally { fs.rmSync(staging, { force: true }) }
  }
  return null
}
