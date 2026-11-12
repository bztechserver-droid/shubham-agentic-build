import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// F-173a: is a test run, a type-check, a lint or a build going on this PC right now, even one started by a script after a chat's turn ended
// (a chat that looks idle can still have such a thing running under it)? Read from the process table WITH command lines, and reduced at once
// to a few fixed words: a command line is never kept, logged or shown. proc-tree.ts reads names only, which cannot tell `node --test` from the app.
//
// What this cannot see: a run that starts after the snapshot (the coordinator takes a fresh one at the moment it commits, so the gap is the
// time that snapshot takes), and a program with an unusual command line. The page says so.

export interface ProcRow {
  pid: number
  name: string
  cmd: string
}

export type BusyKind = 'tests' | 'type-check' | 'lint' | 'page-build' | 'bundler' | 'publish' | 'regression'

const TOKEN = (word: string) => new RegExp(`(?:^|[\\s\\\\/"'])${word}(?:\\.cmd|\\.js|\\.mjs|\\.exe)?(?=$|[\\s"'])`, 'i')

const PATTERNS: Array<{ kind: BusyKind; test: (name: string, cmd: string) => boolean }> = [
  // node --test (the app's own `npm run test:agent` and a direct run), also with options before it.
  { kind: 'tests', test: (name, cmd) => /^node(?:\.exe)?$/i.test(name) && /(?:^|\s)--test(?:\s|=|$)/.test(cmd) },
  { kind: 'type-check', test: (_n, cmd) => TOKEN('tsc').test(cmd) || TOKEN('tsgo').test(cmd) },
  { kind: 'lint', test: (_n, cmd) => /oxlint/i.test(cmd) },
  // `vite build`, never the dev server (`vite`, `vite --host`): that one runs all day.
  { kind: 'page-build', test: (_n, cmd) => /(?:^|[\s\\/"'])vite(?:\.js|\.cmd)?["']?\s+build(?:\s|$)/i.test(cmd) },
  { kind: 'bundler', test: (_n, cmd) => TOKEN('rolldown').test(cmd) },
  { kind: 'publish', test: (_n, cmd) => /agent[\\/]scripts[\\/]publish\.ts/i.test(cmd) },
  { kind: 'regression', test: (_n, cmd) => /run-regression/i.test(cmd) },
]

/** The kinds of work in the table, each once, sorted. `selfPid`'s own process is left out. */
export function classify(rows: readonly ProcRow[], selfPid: number = process.pid): BusyKind[] {
  const found = new Set<BusyKind>()
  for (const r of rows) {
    if (r.pid === selfPid) continue
    for (const p of PATTERNS) if (p.test(r.name, r.cmd)) found.add(p.kind)
  }
  return [...found].sort()
}

/** What was found, in words the page can say (and nothing else of the process). */
export const BUSY_LABEL: Record<BusyKind, string> = {
  tests: 'a test run',
  'type-check': 'a type-check',
  lint: 'a lint run',
  'page-build': 'a page build',
  bundler: 'a bundler',
  publish: 'a publish',
  regression: 'a regression run',
}

// ---------------------------------------------------------------------------------------------
// The process table with command lines

// pid TAB name TAB command line (line breaks and tabs inside it turned into spaces); built with [char]9 so no escape is needed.
const SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '' + $_.ProcessId + [char]9 + $_.Name + [char]9 + ($_.CommandLine -replace '[\\r\\n\\t]+', ' ') }"

export function parseRows(text: string): ProcRow[] {
  const out: ProcRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const [pid, name, ...rest] = line.split('\t')
    const n = Number(pid)
    if (Number.isInteger(n) && n > 0 && name) out.push({ pid: n, name, cmd: rest.join(' ') })
  }
  return out
}

/** Windows: one PowerShell call (20 s at most). Linux: /proc/<pid>/cmdline. Rejects when the table can't be read: the caller treats that as unknown. */
export function listWithCommandLines(o: { timeoutMs?: number; procRoot?: string; platform?: string } = {}): Promise<ProcRow[]> {
  const platform = o.platform ?? process.platform
  if (platform === 'linux') return listLinux(o.procRoot ?? '/proc')
  return new Promise((resolve, reject) => {
    if (platform !== 'win32') return reject(new Error('the process table is read on Windows and Linux only'))
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: o.timeoutMs ?? 20_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      const rows = parseRows(String(stdout))
      if (!rows.length) return reject(new Error('the process table came back empty'))
      resolve(rows)
    })
  })
}

export async function listLinux(root: string): Promise<ProcRow[]> {
  const out: ProcRow[] = []
  for (const dir of await readdir(root)) {
    if (!/^\d+$/.test(dir)) continue
    try {
      const [cmd, comm] = await Promise.all([readFile(path.join(root, dir, 'cmdline'), 'utf8'), readFile(path.join(root, dir, 'comm'), 'utf8')])
      out.push({ pid: Number(dir), name: comm.trim(), cmd: cmd.split('\0').join(' ').trim() })
    } catch {
      // It ended while the table was read.
    }
  }
  if (!out.length) throw new Error('the process table came back empty')
  return out
}
