import { spawn } from 'node:child_process'

// A stop must end. On 31 Oct 2026 at 23:37 the build was asked to update with five chats open: it
// logged "stopped" and then never exited (idle, every thread waiting), so Start.cmd waited on it
// all night and neither pulled the new build nor started the app again; 5173 stayed closed until
// it was ended by hand. Nothing inside a process can end it once it hangs there (process.exit
// itself waits for worker threads and the thread pool), so the watchdog runs outside it: a hidden
// PowerShell that holds a handle to the process and, if it is still running `ms` later, ends it
// with the code the stop meant (75 = update), so the supervisor goes on as if it had exited.
// Windows only; elsewhere it does nothing.
//
// It is an ordinary child, not a detached one: PowerShell started detached (no console) exits at
// once without running its command. As a child it is in the job Node puts its children in, which
// ends them when this process ends, so it lives exactly as long as it is needed: a stop that ends
// by itself takes the watchdog with it, and one that hangs keeps it until it has ended the stop.

export interface ExitWatchdog {
  /** The process to watch. */
  pid: number
  /** When it started (ms since the epoch); a process under that PID that started at another time is left alone. */
  startedAt: number
  /** The exit code it gets if it has to be ended. */
  code: number
  /** How long it has to exit by itself. */
  ms: number
  /** A line is appended here when it had to be ended. */
  logFile?: string
}

/** How far the PID's start time may be from `startedAt` and still be the same process. */
const SAME_PROCESS_MS = 2000

/** The PowerShell that does it; exported for the test. */
export function watchdogScript(w: ExitWatchdog): string {
  const started = new Date(w.startedAt).toISOString()
  const note = w.logFile
    ? `Add-Content -LiteralPath '${w.logFile.replaceAll("'", "''")}' -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + ' exit-watchdog: pid ${w.pid} was still running ${Math.round(w.ms / 1000)} s after it began to stop; ended it with exit code ${w.code}')`
    : ''
  return [
    `try { $p = [Diagnostics.Process]::GetProcessById(${w.pid}) } catch { exit }`,
    // A number Windows has handed to another process since: not ours.
    `if ([Math]::Abs(($p.StartTime.ToUniversalTime() - [DateTimeOffset]::Parse('${started}').UtcDateTime).TotalMilliseconds) -gt ${SAME_PROCESS_MS}) { exit }`,
    // The handle keeps the process object, so the number can't move to another one while we wait.
    `$h = $p.Handle`,
    `if ($p.WaitForExit(${w.ms})) { exit }`,
    `Add-Type -Namespace SadExitWatchdog -Name Kernel32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool TerminateProcess(System.IntPtr h, uint code);'`,
    // Written first: ending the process ends this watchdog too (see above).
    note,
    `[void][SadExitWatchdog.Kernel32]::TerminateProcess($h, ${w.code})`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Starts the watchdog and returns at once. */
export function armExitWatchdog(w: ExitWatchdog): void {
  if (process.platform !== 'win32') return
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', watchdogScript(w)], {
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
  } catch {
    // No PowerShell: the stop is as it was before.
  }
}

/** This process's start, for `startedAt`. */
export function processStartedAt(): number {
  return Date.now() - process.uptime() * 1000
}
