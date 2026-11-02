import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { killTree } from '../proc-tree.ts'

// F-079: WhatsApp's program (whatsapp-web.js, and qrcode to draw the QR) is not one of the app's own packages: it is
// installed once, on the hub only, into the state folder (%LOCALAPPDATA%\shubham-agentic\whatsapp\lib), the way
// ffmpeg is, so the app's package.json, every PC's npm ci and every Publish stay as they were. The pinned versions
// are in agent/whatsapp/lib (package.json and its lockfile). npm ci installs exactly those, each checked against its
// hash, with no install scripts: nothing of theirs runs, and puppeteer downloads no Chrome (the PC's own is used).
// The lockfile was derived on 2 Nov 2026 from techserverbz/whatsapp-backend's (the same whatsapp-web.js commit, in its
// production since October): the closure of these two packages, 141 of them, nothing added.

/** The pinned packages, in the repo. */
export const MANIFEST_DIR = path.join(import.meta.dirname, 'lib')
/** Written when an install has finished: the lockfile's hash, so a changed lockfile asks for the setup again. */
const MARK = '.installed'

function lockHash(manifestDir: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path.join(manifestDir, 'package-lock.json'))).digest('hex')
  } catch {
    return null
  }
}

/** Whether `libDir` holds exactly the packages pinned in `manifestDir`. */
export function libReady(libDir: string, manifestDir = MANIFEST_DIR): boolean {
  const want = lockHash(manifestDir)
  if (!want) return false
  try {
    return readFileSync(path.join(libDir, MARK), 'utf8').trim() === want && existsSync(path.join(libDir, 'node_modules', 'whatsapp-web.js', 'package.json'))
  } catch {
    return false
  }
}

/** npm's own script beside this Node: a .cmd can't be started without a shell. */
export function npmCli(node = process.execPath): string {
  return path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

export interface InstallOptions {
  libDir: string
  log: Logger
  manifestDir?: string
  /** A line for the page while it works. */
  progress?(note: string): void
  /** Tests: the command run in place of npm ci. */
  command?: { cmd: string; args: string[] }
  timeoutMs?: number
}

/** Installs the pinned packages into libDir (see the top of this file). Rejects with npm's last lines on a failure. */
export async function installLib(o: InstallOptions): Promise<void> {
  const manifest = o.manifestDir ?? MANIFEST_DIR
  const hash = lockHash(manifest)
  if (!hash) throw new Error("the lockfile of WhatsApp's packages is missing from the app")
  // --omit=optional: whatsapp-web.js's RemoteAuth extras (archiver, unzipper, ...) aren't used (the login is LocalAuth).
  const cmd = o.command ?? { cmd: process.execPath, args: [npmCli(), 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'] }
  if (!o.command && !existsSync(cmd.args[0])) throw new Error(`npm was not found beside Node (${cmd.args[0]})`)
  mkdirSync(o.libDir, { recursive: true })
  rmSync(path.join(o.libDir, MARK), { force: true })
  for (const f of ['package.json', 'package-lock.json']) copyFileSync(path.join(manifest, f), path.join(o.libDir, f))
  o.progress?.("Installing WhatsApp's program (about a minute)…")
  o.log.info('installing whatsapp-web.js into the state folder (npm ci, no install scripts)')
  await run(cmd.cmd, cmd.args, o.libDir, o.timeoutMs ?? 15 * 60_000)
  writeAtomic(path.join(o.libDir, MARK), `${hash}\n`)
  o.log.info('whatsapp-web.js is installed')
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const p = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true', PUPPETEER_SKIP_CHROME_DOWNLOAD: 'true', PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD: 'true' },
    })
    let tail = ''
    const keep = (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-2000)
    }
    p.stdout.on('data', keep)
    p.stderr.on('data', keep)
    const timer = setTimeout(() => {
      // npm hangs: end exactly it (and what it started), by PID and start time.
      if (p.pid) void killTree(p.pid, { since: started })
    }, timeoutMs)
    timer.unref()
    p.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('exit', code => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      const last = tail.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400)
      reject(new Error(`npm ci failed (exit ${code ?? 'none'})${last ? `: ${last}` : ''}`))
    })
  })
}
