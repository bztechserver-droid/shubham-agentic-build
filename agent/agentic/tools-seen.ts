import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeAtomic } from '../config.ts'

// Why an Assistant chat that was running at an Update did not have the new tools: a chat's MCP process (mcp-shim.ts, started by
// claude with the chat) read the tool list once when it started, and the chat host keeps the chat (and so that process) running
// through the agent's restart. So the chat went on with the old list. Now the shim asks the agent for the current list (GET
// /mcp/tools) and tells claude when it changes (notifications/tools/list_changed); the agent writes down which list each chat's
// shim was last given, so a chat that was not given the current one (one started by an older build never asks) can be seen, and the
// Assistant's chat is restarted (its conversation resumes) when it is idle (index.ts, refreshAssistantTools).

/** A short stamp of a tool list: any change to a name, a description or a schema changes it. */
export const toolsVersion = (tools: readonly unknown[]): string => createHash('sha1').update(JSON.stringify(tools)).digest('hex').slice(0, 12)

export interface ToolsSeen {
  /** This chat's shim was given the list stamped `version`. */
  note(sessionId: string, version: string): void
  /** The stamp of the list the chat's shim was last given; undefined: never (a shim from before this existed, or no shim yet). */
  get(sessionId: string): string | undefined
}

const KEEP = 200

export function createToolsSeen(file: string): ToolsSeen {
  const seen = new Map<string, string>()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof raw === 'object' && raw !== null) for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') seen.set(k, v)
  } catch {
    // No file yet: nothing seen.
  }
  return {
    get: sid => seen.get(sid),
    note(sid, version) {
      if (seen.get(sid) === version) return
      seen.delete(sid)
      seen.set(sid, version)
      while (seen.size > KEEP) seen.delete(seen.keys().next().value as string)
      try {
        writeAtomic(file, `${JSON.stringify(Object.fromEntries(seen))}\n`)
      } catch {
        // Kept in memory; the next change writes it.
      }
    },
  }
}

export interface RefreshFacts {
  /** The stamp the chat's shim was last given (ToolsSeen.get). */
  listed: string | undefined
  /** The stamp of the list now. */
  current: string
  /** The chat's state in the terminal. */
  state: string | undefined
  /** How long this agent has been up, in ms (a chat that asks again by itself is given time to). */
  upMs: number
  graceMs: number
}

/** Should the Assistant's chat be restarted now for its tool list? Only when it is behind, has had time to catch up by itself, and is idle. */
export const needsRefresh = (f: RefreshFacts): boolean => f.listed !== f.current && f.upMs >= f.graceMs && f.state === 'idle'
