import { execFile } from 'node:child_process'
import type { Listen, Proc } from './block.ts'

// F-114: what listens on this PC and which program owns it. Two commands, both read-only: netstat (cheap, every scan) and the process table (only when the
// set of listening ports changed). Injected, so tests run neither.

export type NetScan = () => Promise<Listen[]>
export type ProcScan = () => Promise<Proc[]>

const LOOPBACK_OR_ANY = new Set(['0.0.0.0', '127.0.0.1', '[::]', '[::1]'])

/** `netstat -ano` → the listening TCP ports (one entry per port; reachable if ANY of its sockets is on loopback or all addresses). */
export function parseNetstat(text: string): Listen[] {
  const out = new Map<number, Listen>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\[[^\]]+\]|[\d.]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const port = Number(m[2])
    const pid = Number(m[3])
    const reachable = LOOPBACK_OR_ANY.has(m[1])
    const had = out.get(port)
    out.set(port, { port, pid: had && had.reachable && !reachable ? had.pid : pid, reachable: Boolean(had?.reachable) || reachable })
  }
  return [...out.values()].sort((a, b) => a.port - b.port)
}

/** The process table as PowerShell's ConvertTo-Json gives it (an array, or one object when there is one process). */
export function parseProcs(json: string): Proc[] {
  let raw: unknown
  try {
    raw = JSON.parse(json.replace(/^﻿/, ''))
  } catch {
    return []
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
  const procs: Proc[] = []
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r.ProcessId !== 'number' || typeof r.Name !== 'string') continue
    procs.push({
      pid: r.ProcessId,
      ppid: typeof r.ParentProcessId === 'number' ? r.ParentProcessId : 0,
      name: r.Name.toLowerCase().replace(/\.exe$/, ''),
      exe: typeof r.ExecutablePath === 'string' ? r.ExecutablePath : null,
      cmd: typeof r.CommandLine === 'string' ? r.CommandLine : null,
    })
  }
  return procs
}

/** `tasklist /FO CSV /NH` → names only (no parents, no command lines): the fallback when PowerShell does not answer. */
export function parseTasklist(csv: string): Proc[] {
  const procs: Proc[] = []
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line)
    if (m) procs.push({ pid: Number(m[2]), ppid: 0, name: m[1].toLowerCase().replace(/\.exe$/, ''), exe: null, cmd: null })
  }
  return procs
}

function run(file: string, args: string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })
}

export const realNetstat: NetScan = async () => parseNetstat(await run('netstat.exe', ['-ano']))

/** The scanners for a system, or null when there are none yet (Linux: the Linux agent adds its own and passes them in; this file stays Windows). */
export function scannersFor(platform: string): { net: NetScan; procs: ProcScan } | null {
  return platform === 'win32' ? { net: realNetstat, procs: realProcs } : null
}

export const realProcs: ProcScan = async () => {
  try {
    const out = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],
      25_000,
    )
    const procs = parseProcs(out)
    if (procs.length > 0) return procs
  } catch {
    // fall through to tasklist
  }
  return parseTasklist(await run('tasklist.exe', ['/FO', 'CSV', '/NH']))
}
