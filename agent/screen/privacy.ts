import { spawn } from 'node:child_process'
import type { Logger } from '../log.ts'
import type { PrivacyPort } from './host.ts'

// Privacy mode on this PC (F-012): the black cover over its screen (win32.ts › cover), and its
// pointer hidden with it (asked 2026-10-30: "please dont show cursor on the ... server"), which
// RustDesk's privacy mode leaves showing. Windows keeps the pointer hidden after the process that
// hid it ends (tried on this PC), so it is shown again here: when the screen comes back, at every
// start of the agent (one that died with it hidden), and, while it is hidden, by a watcher that
// outlives this agent: a hidden PowerShell that waits for this process to end, then shows it.

export interface PrivacyCalls {
  cover(on: boolean): boolean
  showPointer(show: boolean, nudge?: boolean): boolean
}

export interface Watcher {
  stop(): void
}

/** Waits for the agent (SAD_AGENT_PID) to end, then shows the pointer. */
const WATCHER = [
  "$m = Add-Type -PassThru -Name Pointer -Namespace ShubhamAgentic -MemberDefinition '",
  '[DllImport("magnification.dll")] public static extern bool MagInitialize();',
  '[DllImport("magnification.dll")] public static extern bool MagShowSystemCursor(bool show);',
  "'",
  'Wait-Process -Id ([int]$env:SAD_AGENT_PID) -ErrorAction SilentlyContinue',
  '[void]$m::MagInitialize()',
  '[void]$m::MagShowSystemCursor($true)',
].join('\n')

/** The watcher for this agent; base64 UTF-16, so no quoting can break the script. */
export function startWatcher(log: Logger): Watcher {
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WATCHER, 'utf16le').toString('base64')], {
      env: { ...process.env, SAD_AGENT_PID: String(process.pid) },
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    })
    child.on('error', e => log.warn(`no pointer watcher: ${e.message}`))
    child.unref()
    return { stop: () => void child.kill() }
  } catch (e) {
    log.warn(`no pointer watcher: ${e instanceof Error ? e.message : String(e)}`)
    return { stop: () => {} }
  }
}

/** The PrivacyPort the sessions on this PC share (host.ts). */
export function createPrivacy(o: { calls: PrivacyCalls; log: Logger; watch?: () => Watcher }): PrivacyPort {
  // A pointer an agent before this one left hidden.
  o.calls.showPointer(true)
  let watcher: Watcher | null = null
  return {
    owner: null,
    cover(on) {
      if (!on) {
        o.calls.cover(false)
        o.calls.showPointer(true, true)
        watcher?.stop()
        watcher = null
        return true
      }
      if (!o.calls.cover(true)) return false
      // The watcher first: from the moment it is hidden, an end of this agent shows it again.
      watcher ??= (o.watch ?? (() => startWatcher(o.log)))()
      if (!o.calls.showPointer(false)) o.log.warn("this PC's pointer couldn't be hidden; its screen is dark all the same")
      return true
    },
  }
}
