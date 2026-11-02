import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import type { Logger } from '../log.ts'
import { prepareHostCopy, pruneHostCopies } from './install.ts'
import { connectLink, type ChatHostLink } from './link.ts'
import { DEFAULT_HOST_PORT, readHostFile } from './main.ts'
import { HOST_PROTOCOL } from './protocol.ts'

// F-075: finding the chat host, or starting it. Used by the agent at its start (main.ts, with SAD_CHAT_HOST=on) and
// again, by the link, if the host is ever lost. The host is started DETACHED and from its own copy (install.ts):
// it must outlive this agent, and no update of the build may be able to touch the files it runs from.

export interface EnsureOptions {
  /** The build (or Dev) folder: agent/, node_modules/. */
  buildRoot: string
  stateRoot: string
  token: string
  log: Logger
  port?: number
  /** Waits this long for a host that was just started to answer (10 s). */
  startTimeoutMs?: number
  /** Tests: another way to start the host process. */
  startHost?: (entry: string, args: string[], logFile: string) => void
  /** Tests: how long the link waits between tries to get a lost host back. */
  retryMs?: number
}

function startDetached(entry: string, args: string[], logFile: string, cwd: string) {
  mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(process.execPath, [entry, ...args], { cwd, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] })
    child.on('error', () => {})
    child.unref()
  } finally {
    closeSync(fd)
  }
}

/** Starts a host (a second one finds the port taken and ends at once), and waits until `where` answers. */
async function startAndWait(o: EnsureOptions, port: number): Promise<ChatHostLink | null> {
  const copy = prepareHostCopy(o.buildRoot, o.stateRoot)
  const args = ['--state', o.stateRoot, '--port', String(port)]
  const logFile = path.join(o.stateRoot, 'chathost', 'host-console.log')
  if (o.startHost) o.startHost(copy.entry, args, logFile)
  else startDetached(copy.entry, args, logFile, copy.dir)
  o.log.info(`chat host: started from ${copy.dir}`)
  for (const end = Date.now() + (o.startTimeoutMs ?? 10_000); Date.now() < end; ) {
    await new Promise(r => setTimeout(r, 250))
    try {
      return await link(o, port)
    } catch {
      // Not up yet.
    }
  }
  return null
}

async function link(o: EnsureOptions, port: number): Promise<ChatHostLink> {
  return connectLink({
    port,
    token: o.token,
    log: o.log,
    retryMs: o.retryMs,
    again: async () => {
      // Is one there? Else start it. Either way the link connects to what is on the port.
      try {
        const l = await connectLink({ port, token: o.token, log: o.log })
        l.close()
        return { port, token: o.token }
      } catch {
        const l = await startAndWait({ ...o, startTimeoutMs: 6000 }, port).catch(() => null)
        if (!l) return null
        l.close()
        return { port, token: o.token }
      }
    },
  })
}

/**
 * A link to the host: the one that runs, or a new one. Null (and why, in the log) when it cannot be had, or when it
 * speaks a protocol this agent does not: then the chats run in this process as they always did.
 */
export async function ensureChatHost(o: EnsureOptions): Promise<ChatHostLink | null> {
  const port = o.port ?? (readHostFile(o.stateRoot)?.port || DEFAULT_HOST_PORT)
  let l: ChatHostLink | null = null
  try {
    l = await link(o, port)
  } catch {
    try {
      l = await startAndWait(o, port)
    } catch (e) {
      o.log.error(`chat host: could not start it: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }
  if (!l) {
    o.log.error('chat host: started, but it does not answer')
    return null
  }
  if (l.info.protocol !== HOST_PROTOCOL) {
    o.log.error(`chat host: it speaks protocol ${l.info.protocol} and this agent ${HOST_PROTOCOL}: its chats can't be taken over; running without it`)
    l.close()
    return null
  }
  try {
    pruneHostCopies(o.stateRoot, prepareHostCopy(o.buildRoot, o.stateRoot).dir, readHostFile(o.stateRoot)?.dir ?? null)
  } catch {
    // Old copies stay until the next time.
  }
  o.log.info(`chat host: using the one that runs (pid ${l.info.pid}, version ${l.info.version})`)
  return l
}
