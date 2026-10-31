import { loadConfig } from '../config.ts'
import { createLogger, type Logger } from '../log.ts'
import { keeperAlive, readKeeperState, writeKeeperState } from './keeper-state.ts'
import { startServers, type Servers, type ServersConfig, type ServersOptions } from './rustdesk-server.ts'

// F-058: the hub's RustDesk servers, in a process of their own. The guard (agent/guard.ts) starts
// this and starts it again if it dies; the agent only reads what it writes (external-servers.ts).
// The servers are the same module the agent used to run itself (rustdesk-server.ts, untouched):
// key checks, restarts and all. What changes is whose child they are: the keeper's, so an agent
// that is killed, crashes or is updated takes nothing of RustDesk with it, and Control keeps working.
//   node agent/hub/keeper.ts [--role hub]     exit 0 when this PC is not the hub; 3 when a keeper runs already

export const HEARTBEAT_MS = 2000

export interface Keeper {
  servers: Servers
  /** Stops the servers and the heartbeat. */
  stop(): Promise<void>
}

/** Starts the servers and reports them to the state file. Tests pass `opts` (a fake command, a short wait). */
export function runKeeper(config: ServersConfig, log: Logger, opts: ServersOptions = {}): Keeper {
  const workDir = opts.workDir ?? config.paths.rustdeskServer
  const startedAt = new Date().toISOString()
  let servers: Servers | null = null
  const write = () => {
    if (!servers) return
    try {
      writeKeeperState(workDir, { v: 1, pid: process.pid, startedAt, updatedAt: Date.now(), servers: servers.status(), key: servers.licenceKey() })
    } catch (e) {
      log.warn(`could not write the keeper state: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // startServers reports its first states before it returns.
  servers = startServers(config, {
    ...opts,
    log: log.child('rustdesk-server'),
    onChange: s => {
      opts.onChange?.(s)
      write()
    },
  })
  write()
  const beat = setInterval(write, HEARTBEAT_MS)
  return {
    servers,
    async stop() {
      clearInterval(beat)
      await servers?.stop()
      write()
    },
  }
}

if (import.meta.main) {
  const config = loadConfig({ argv: process.argv.slice(2) })
  const log = createLogger({ dir: config.paths.logs, prefix: 'keeper' })
  const quit = async (code: number) => {
    await log.close()
    process.exit(code)
  }
  if (config.role !== 'hub') {
    log.info('this PC is not the hub: there are no RustDesk servers to keep')
    await quit(0)
  }
  const other = readKeeperState(config.paths.rustdeskServer)
  if (keeperAlive(other) && other.pid !== process.pid) {
    log.info(`another keeper runs already (pid ${other.pid})`)
    await quit(3)
  }
  log.info(`keeping the RustDesk servers (pid ${process.pid})`)
  const keeper = runKeeper(config, log)
  let stopping = false
  const stop = (why: string) => {
    if (stopping) return process.exit(1)
    stopping = true
    log.info(`stopping: ${why}`)
    void keeper.stop().then(() => quit(0))
  }
  process.on('SIGINT', () => stop('Ctrl+C'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGBREAK', () => stop('Ctrl+Break'))
  process.on('uncaughtException', e => {
    log.error(`internal error: ${e.stack ?? e.message}`)
    stop('internal error')
  })
  process.on('unhandledRejection', e => log.error(`internal error (unhandled rejection): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))
}
