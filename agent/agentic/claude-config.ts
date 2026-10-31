import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeAtomic } from '../config.ts'

// F-018: the agents' chats run on this Windows account's own Claude config (~/.claude.json).
// Before a chat starts, two questions claude would otherwise ask in its terminal are answered
// in that file, the way claude itself records the answers:
//   - its first-run setup ("Choose the text style…"): on a PC where Claude is usually run
//     through Christopher, which keeps its own config, this one was never set up. As
//     agentic-claude-manager does for its folders (server/index.js scaffoldConfigDir), the flags
//     that say setup is done are topped up.
//   - "Do you trust this folder?" for the floor's folder, which the person picked for the floor
//     in the app: projects["C:/the/folder"].hasTrustDialogAccepted, as claude writes on "Yes".
//     (In claude 2.1 that menu starts on "No, exit", so answering it with Enter would quit.)
// Only ABSENT keys are filled: a theme someone chose, and everything else in the file, stays.
// The sign-in is not touched: it comes from CLAUDE_CODE_OAUTH_TOKEN (F-007).

export const claudeJsonPath = (home = os.homedir()) => path.join(home, '.claude.json')

/** claude's key for a folder in projects: the path with forward slashes. */
export const projectKey = (cwd: string) => cwd.replace(/\\/g, '/')

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Marks setup done and `cwd` trusted when they aren't; returns what it changed (empty: nothing written). */
export function prepareClaudeConfig(cwd: string, file = claudeJsonPath()): string[] {
  let data: Record<string, unknown> = {}
  if (existsSync(file)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // Unreadable: leave it to claude, whose own file it is; it asks in the terminal instead.
      return []
    }
    if (!isObject(parsed)) return []
    data = parsed
  }
  const changed: string[] = []
  if (data.hasCompletedOnboarding === undefined) {
    data.hasCompletedOnboarding = true
    changed.push('first-run setup')
  }
  // The chats are drawn on a dark code surface in every theme and mode.
  if (data.theme === undefined) {
    data.theme = 'dark'
    changed.push('theme')
  }
  const projects = isObject(data.projects) ? data.projects : {}
  const key = projectKey(cwd)
  const project = isObject(projects[key]) ? projects[key] : {}
  if (project.hasTrustDialogAccepted !== true) {
    projects[key] = { ...project, hasTrustDialogAccepted: true }
    data.projects = projects
    changed.push(`trust for ${key}`)
  }
  if (changed.length) writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
  return changed
}
