// F-075: the chat host's wire protocol. One TCP connection on 127.0.0.1, one JSON object per line,
// between the host (host.ts: owns every chat's terminal) and its one controller (the agent: client.ts).
// This file is the contract and nothing else, with no imports, so the host's own copy can carry it.
//
// HOST_PROTOCOL changes only when an old agent could no longer drive a new host (or the reverse):
// then an update has to replace the host, which waits for the chats to be idle (agent/SPEC.md › F-075).
// HOST_VERSION is the host's code version (informational: a newer build with the same protocol
// goes on with the host that runs).

export const HOST_PROTOCOL = 1
export const HOST_VERSION = 1

/** A line longer than this is a broken or hostile peer. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024
/** What the host keeps of a chat's output (the agent keeps its own the same size). */
export const RING_BYTES = 256 * 1024
/** An ended chat is remembered this long for an agent that was away when it ended. */
export const EXITED_KEEP_MS = 10 * 60 * 1000

/** What the agent asked to be kept with a chat, and gets back whole (keys, who it is). The host reads none of it. */
export type ChatMeta = Record<string, unknown>

export interface HostChat {
  id: string
  pid: number
  meta: ChatMeta
  cols: number
  rows: number
  startedAt: number
  /** Set when the chat has ended: its exit code (null: killed). */
  exited: { code: number | null; at: number } | null
}

export type ClientMsg =
  | { t: 'hello'; token: string; protocol: number }
  | { t: 'spawn'; id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number; meta: ChatMeta }
  | { t: 'write'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  /** Ends the chat's terminal and the processes it started, by exact PID. */
  | { t: 'kill'; id: string }
  | { t: 'list' }
  /** From now on this chat's output is sent; first everything the host has of it (`replay`), so nothing is missed or doubled. */
  | { t: 'attach'; id: string }
  /** The agent has taken note that an ended chat ended: forget it. */
  | { t: 'forget'; id: string }
  | { t: 'ping' }
  /** Stops the host. `killChats`: end every chat first; without it the host refuses while a chat runs. */
  | { t: 'shutdown'; killChats: boolean }

export type HostMsg =
  | { t: 'hello-ok'; protocol: number; version: number; pid: number; startedAt: number }
  | { t: 'spawned'; id: string; pid: number }
  | { t: 'spawn-failed'; id: string; error: string }
  | { t: 'chats'; chats: HostChat[] }
  | { t: 'replay'; id: string; d: string }
  | { t: 'data'; id: string; d: string }
  | { t: 'exit'; id: string; code: number | null }
  | { t: 'pong' }
  /** The host is not going to answer this connection any more (another controller took over, shutdown). */
  | { t: 'bye'; why: string }
  | { t: 'error'; error: string; id?: string }

export function encode(m: ClientMsg | HostMsg): string {
  return JSON.stringify(m) + '\n'
}

/** Splits a byte stream into lines; a line over MAX_LINE_BYTES makes `onTooLong` fire and the rest of it is dropped. */
export function lineReader(onLine: (line: string) => void, onTooLong: () => void) {
  let rest = ''
  let dropping = false
  return (chunk: string) => {
    rest += chunk
    for (;;) {
      const at = rest.indexOf('\n')
      if (at === -1) break
      const line = rest.slice(0, at)
      rest = rest.slice(at + 1)
      if (dropping) {
        dropping = false
        continue
      }
      if (line) onLine(line)
    }
    if (rest.length > MAX_LINE_BYTES) {
      rest = ''
      dropping = true
      onTooLong()
    }
  }
}

export function parse<T>(line: string): T | null {
  try {
    const v = JSON.parse(line) as unknown
    return v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string' ? (v as T) : null
  } catch {
    return null
  }
}
