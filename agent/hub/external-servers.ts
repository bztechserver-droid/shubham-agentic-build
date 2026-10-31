import type { ServerStatus } from '../../shared/agent-api.ts'
import { keeperAlive, readKeeperState, type KeeperState } from './keeper-state.ts'
import { serverPorts, type Servers, type ServersConfig } from './rustdesk-server.ts'
import type { Logger } from '../log.ts'

// F-058: the agent's view of RustDesk servers that live in the keeper's process (keeper.ts). It has
// the interface of startServers() (status, licence key, ready, stop) and starts and stops nothing:
// it reads the keeper's state file once a second and says when something changed. The agent used
// on SAD_RUSTDESK_EXTERNAL=1, which the guard sets; without it the agent runs the servers itself, as before.

export interface ExternalOptions {
  log?: Logger
  /** Called when a server's state, pid or the key changes. */
  onChange?: (servers: ServerStatus[]) => void
  pollMs?: number
  /** Tests. */
  now?: () => number
  read?: () => KeeperState | null
  alive?: (pid: number) => boolean
}

export function externalServers(cfg: ServersConfig, opts: ExternalOptions = {}): Servers & { close(): void } {
  const now = opts.now ?? Date.now
  const read = opts.read ?? (() => readKeeperState(cfg.paths.rustdeskServer))
  const waiters = new Set<() => void>()
  let key: string | null = null
  let last = ''
  let closed = false

  const away = (): ServerStatus[] =>
    (['hbbs', 'hbbr'] as const).map(name => ({
      name,
      state: 'stopped',
      pid: null,
      ports: serverPorts(name, cfg.ports[name]),
      since: null,
      restarts: 0,
      lastError: 'The RustDesk keeper (the guard starts it) is not running.',
    }))

  let current: ServerStatus[] = away()

  function look() {
    if (closed) return
    const state = read()
    const there = keeperAlive(state, now(), opts.alive)
    const next = there ? state.servers : away()
    // The key does not change when the keeper does: keep the last one while it is away.
    if (there && state.key) key = state.key
    const text = JSON.stringify([next, key])
    current = next
    if (text === last) return
    last = text
    opts.onChange?.(next)
    for (const w of [...waiters]) w()
  }

  look()
  const timer = setInterval(look, opts.pollMs ?? 1000)
  timer.unref()

  return {
    status: () => current,
    licenceKey: () => key,
    ready(timeoutMs = 20_000) {
      return new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => {
          clearTimeout(t)
          waiters.delete(waiter)
          if (error) reject(error)
          else resolve()
        }
        const waiter = () => {
          if (current.every(s => s.state === 'running')) done()
        }
        const t = setTimeout(() => done(new Error(`hbbs/hbbr not running after ${timeoutMs / 1000} s: ${current.map(s => `${s.name} ${s.state}`).join('; ')}`)), timeoutMs)
        waiters.add(waiter)
        waiter()
      })
    },
    // The keeper watches the LAN itself.
    checkLan() {},
    // They are not this agent's to stop: they outlive it.
    async stop() {
      closed = true
      clearInterval(timer)
    },
    close() {
      closed = true
      clearInterval(timer)
    },
  }
}
