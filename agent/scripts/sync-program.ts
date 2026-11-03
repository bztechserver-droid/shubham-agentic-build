import { cpSync, existsSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

// F-097: the Common Drive's sync program (one file, common-drive-sync.mjs, built from agent/drive/sync-cli.ts) goes into every published build, at
// <build>/dist-sync/, which is where the agent's GET /sync/program looks (agent/drive/index.ts: two folders up from agent/drive). If the program can't be
// built, the publish stops: a build without it would hand out a Settings button that leads nowhere.

export const SYNC_PROGRAM_DIR = 'dist-sync'
export const SYNC_PROGRAM_FILE = 'common-drive-sync.mjs'

/** A command runner like publish.ts's `run`: resolves when the command succeeds, rejects when it fails. */
export type Run = (cmd: string, args: string[], cwd: string, o?: { shell?: boolean }) => Promise<void>

function checked(file: string): string {
  if (!existsSync(file)) throw new Error(`The sync program was not built: ${file} is missing.`)
  const size = statSync(file).size
  if (size < 1000) throw new Error(`The sync program looks wrong (${size} bytes): ${file}`)
  return file
}

/** Builds the program in Dev (`npm run build:drive-sync`), from a clean slate so an old file can never be shipped by mistake. Throws if it fails. */
export async function buildSyncProgram(dev: string, run: Run): Promise<string> {
  rmSync(path.join(dev, SYNC_PROGRAM_DIR), { recursive: true, force: true })
  await run('npm', ['run', 'build:drive-sync'], dev, { shell: true })
  return checked(path.join(dev, SYNC_PROGRAM_DIR, SYNC_PROGRAM_FILE))
}

/** Puts the built program into the assembled build. Throws if it isn't there. */
export function shipSyncProgram(dev: string, stage: string): string {
  checked(path.join(dev, SYNC_PROGRAM_DIR, SYNC_PROGRAM_FILE))
  cpSync(path.join(dev, SYNC_PROGRAM_DIR), path.join(stage, SYNC_PROGRAM_DIR), { recursive: true })
  return checked(path.join(stage, SYNC_PROGRAM_DIR, SYNC_PROGRAM_FILE))
}
