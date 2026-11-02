import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createLogger } from '../log.ts'
import { startChatHost, type HostSpawn } from './host.ts'
import { HOST_PROTOCOL, HOST_VERSION } from './protocol.ts'

// F-075: the chat host as a process. Started detached by the agent or the guard, from its own versioned copy
// (install.ts), so that an update of the build can replace every file of the app while it runs:
//   node main.ts --state <state root> [--port N]
// It writes <state>/chathost/host.json (who it is and where) and the token it takes is the agent's own
// (<state>/agent/api-token): whoever has that is the app already. It never ends by itself: it runs until a
// controller asks it to stop (shutdown), or it is ended from outside.

export interface HostFile {
  pid: number
  port: number
  startedAt: number
  version: number
  protocol: number
  /** The folder it runs from. */
  dir: string
}

export const hostFile = (stateRoot: string) => path.join(stateRoot, 'chathost', 'host.json')
export const DEFAULT_HOST_PORT = 21229

export function readHostFile(stateRoot: string): HostFile | null {
  try {
    const v = JSON.parse(readFileSync(hostFile(stateRoot), 'utf8')) as Partial<HostFile>
    if (typeof v.pid !== 'number' || typeof v.port !== 'number' || typeof v.startedAt !== 'number') return null
    return { pid: v.pid, port: v.port, startedAt: v.startedAt, version: Number(v.version) || 0, protocol: Number(v.protocol) || 0, dir: String(v.dir ?? '') }
  } catch {
    return null
  }
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? undefined : process.argv[i + 1]
  }
  const stateRoot = arg('state')
  if (!stateRoot) {
    console.error('usage: node main.ts --state <state root> [--port N]')
    process.exit(2)
  }
  const dir = path.join(stateRoot, 'chathost')
  mkdirSync(dir, { recursive: true })
  const log = createLogger({ dir: path.join(dir, 'logs'), prefix: 'chathost', console: false })
  const token = readFileSync(path.join(stateRoot, 'agent', 'api-token'), 'utf8').trim()
  // node-pty from the folder this copy runs in.
  const nodePty = createRequire(import.meta.url)('node-pty') as { spawn(file: string, args: string[], o: Record<string, unknown>): ReturnType<HostSpawn> }
  const spawn: HostSpawn = (file, args, o) => nodePty.spawn(file, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env })
  const port = Number(arg('port') ?? process.env.SAD_CHAT_HOST_PORT) || DEFAULT_HOST_PORT
  try {
    const host = await startChatHost({ port, token, spawn, log })
    const file: HostFile = { pid: process.pid, port: host.port, startedAt: Date.now(), version: HOST_VERSION, protocol: HOST_PROTOCOL, dir: import.meta.dirname }
    const tmp = `${hostFile(stateRoot)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file))
    renameSync(tmp, hostFile(stateRoot))
    host.stopped.then(async () => {
      log.info('stopped')
      try {
        if (readHostFile(stateRoot)?.pid === process.pid) rmSync(hostFile(stateRoot), { force: true })
      } catch {
        // Left behind: the next start finds that nothing answers on it.
      }
      await log.close()
      process.exit(0)
    })
    process.on('uncaughtException', e => log.error(`internal error: ${e.stack ?? e.message}`))
    process.on('unhandledRejection', e => log.error(`internal error (unhandled rejection): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    log.error(code === 'EADDRINUSE' ? `a chat host runs already (port ${port} is taken)` : `could not start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    await log.close()
    process.exit(code === 'EADDRINUSE' ? 3 : 1)
  }
}
