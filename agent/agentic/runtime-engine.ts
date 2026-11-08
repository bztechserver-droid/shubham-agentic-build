export type RuntimeEngine = 'claude' | 'codex' | 'opencode'

export function engineMismatch(expected: RuntimeEngine, actual: string | undefined) {
  return Object.assign(new Error(`This conversation is saved as ${expected}, but its running process is ${actual ?? 'unverified'}. Nothing was restarted or rebound. Preserve its current native history and reconcile the engine before opening it.`),
    { status: 409, code: 'engine-runtime-mismatch', expectedEngine: expected, runningEngine: actual ?? null })
}

export function requireRunningEngine(expected: RuntimeEngine, actual: RuntimeEngine | undefined): void {
  if (actual !== expected) throw engineMismatch(expected, actual)
}

export function engineUpdateRequired(pc: string) {
  return Object.assign(new Error(`Update the Agentic app on ${pc}: its installed version has not proved support for the requested engine. Installing the CLI alone is insufficient. No fallback engine was requested.`),
    { status: 409, code: 'engine-start-update-required' })
}

