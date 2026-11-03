import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DriveSyncCredentials } from '../../shared/drive.ts'
import type { Logger } from '../log.ts'
import { createSync } from './sync.ts'
import { httpRemote } from './sync-http.ts'

// F-097 part C: the Common Drive's sync folder as a program of its own, for a PC that does not run the app (Linux, macOS, or Windows):
//   node sync-cli.ts pair --server https://<hub>.<tailnet>.ts.net:8444 --code ABCD-2345 [--folder ~/CommonDrive] [--name <this device>]
//   node sync-cli.ts run      keep the folder in step until stopped (what a service runs)
//   node sync-cli.ts once     one round, print what it did
//   node sync-cli.ts status   where it is paired to, and the folder
//   node sync-cli.ts unit     print a systemd user unit that runs it
// No dependencies, no native parts. The device's password is kept in its config file (readable by this user only) and is never printed.

export interface CliConfig {
  server: string
  name: string
  password: string
  folder: string
}

export function configDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'CommonDrive')
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'CommonDrive')
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'common-drive')
}

const consoleLog = (scope = ''): Logger => {
  const line = (level: string) => (...a: unknown[]) => console.log(`${new Date().toISOString()} ${level} ${scope}${a.map(String).join(' ')}`)
  return { debug: () => undefined, info: line('info'), warn: line('warn'), error: line('error'), child: s => consoleLog(`${scope}${s}: `) }
}

export function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd = 'help', ...rest] = argv
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else flags[a.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true'
    }
  }
  return { cmd, flags }
}

async function readConfig(dir: string): Promise<CliConfig> {
  try {
    const c = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')) as CliConfig
    if (c.server && c.name && c.password && c.folder) return c
  } catch {
    // Falls through.
  }
  throw new Error(`Not paired yet. Make a code on the Drive page, then: node sync-cli.ts pair --server <address> --code <code>`)
}

async function writeConfig(dir: string, c: CliConfig) {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'config.json')
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => undefined)
  await rename(tmp, file)
}

export function unitText(nodePath: string, scriptPath: string): string {
  return `[Unit]
Description=Common Drive sync folder
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${nodePath} ${scriptPath} run
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = s => console.log(s)): Promise<number> {
  const { cmd, flags } = parseArgs(argv)
  const dir = flags.config ?? configDir(env)
  switch (cmd) {
    case 'pair': {
      const server = (flags.server ?? '').replace(/\/+$/, '')
      if (!server || !flags.code) {
        out('Usage: pair --server https://<hub>.<tailnet>.ts.net:8444 --code ABCD-2345 [--folder <folder>] [--name <this device>]')
        return 2
      }
      const res = await fetch(`${server}/api/pair`, { method: 'POST', body: JSON.stringify({ code: flags.code }) })
      if (!res.ok) {
        out(`Pairing failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
        return 1
      }
      const creds = (await res.json()) as DriveSyncCredentials
      const folder = path.resolve((flags.folder ?? path.join(homedir(), 'CommonDrive')).replace(/^~(?=$|\/|\\)/, homedir()))
      await writeConfig(dir, { server, name: creds.name, password: creds.password, folder })
      await mkdir(folder, { recursive: true })
      out(`Paired as "${creds.name}". The folder is ${folder}. Start it with: node sync-cli.ts run`)
      return 0
    }
    case 'status': {
      const c = await readConfig(dir)
      out(`Paired as "${c.name}" with ${c.server}; folder ${c.folder}; config ${path.join(dir, 'config.json')}`)
      return 0
    }
    case 'once':
    case 'run': {
      const c = await readConfig(dir)
      const sync = createSync({ folder: c.folder, stateDir: path.join(dir, 'state'), remote: httpRemote({ baseUrl: c.server, name: c.name, password: c.password }), device: c.name, log: consoleLog() })
      if (cmd === 'once') {
        const r = await sync.runOnce()
        out(`uploaded ${r.uploaded}, downloaded ${r.downloaded}, conflicts ${r.conflicts}, deleted here ${r.deletedLocal}, deleted there ${r.deletedRemote}${r.held ? `, ${r.held} deletes held (confirm with --allow-deletes)` : ''}${r.blocked ? `, PAUSED: ${r.blocked}` : ''}`)
        for (const e of r.errors) out(`  ${e.path}: ${e.why}`)
        return r.errors.length || r.blocked ? 1 : 0
      }
      if (flags['allow-deletes']) sync.allowMassDelete()
      sync.start()
      out(`Keeping ${c.folder} in step with ${c.server} as "${c.name}". Stop with Ctrl+C.`)
      await new Promise<void>(resolve => {
        const stop = () => void sync.stop().then(resolve)
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
      return 0
    }
    case 'unit':
      out(unitText(process.execPath, path.resolve(process.argv[1] ?? 'sync-cli.ts')))
      return 0
    default:
      out('Commands: pair, run, once, status, unit. See the comment at the top of sync-cli.ts.')
      return cmd === 'help' ? 0 : 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    },
  )
}
