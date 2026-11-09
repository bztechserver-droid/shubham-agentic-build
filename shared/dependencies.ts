// F-165: what Codex in Claude Code needs on a PC, as GET /agent-api/agentic/dependencies answers it.
// Names, versions and plain sentences only: never a login, key, path to a secret or a CRM cookie.

/** ok: in place. missing: Codex in Claude Code can't open here until it is fixed. warning: works now, needs attention soon. unknown: not checked. */
export type DependencyState = 'ok' | 'missing' | 'warning' | 'unknown'

export interface DependencyCheck {
  id: string
  label: string
  state: DependencyState
  /** What this PC has now. */
  detail: string
  /** Why Codex in Claude Code needs it, and what shows when it is missing. */
  why: string
  /** What to do on this PC. */
  fix: string
}

export interface DependencyReport {
  version: 1
  pc: { id: string; name: string }
  checkedAt: string
  /** Every check is ok or a warning: Codex in Claude Code can open here. */
  ready: boolean
  checks: DependencyCheck[]
}

export interface DependencyPc {
  id: string
  name: string
  here: boolean
  report: DependencyReport | null
  /** Why there is no report (offline, an older build). */
  error: string | null
}

export interface DependenciesAnswer {
  pcs: DependencyPc[]
}
