import type { PortBlock } from '../../shared/agent-api.ts'

// F-114: which ports Ports may never share, by Share all or one by one. Pure rules: a listening port, the process behind it, and what the agent knows of itself.
// The `debugger` rule has a second half that needs the network (probe.ts); this file decides everything that can be told from names, command lines and numbers.

export interface Listen {
  port: number
  pid: number
  /** Listens on loopback or on all addresses (the Ports gate reaches it as localhost). */
  reachable: boolean
  /** F-116, Linux only: the socket's owner. Its PID can't be read when it is another account's (pid -1 then). */
  uid?: number
}

export interface Proc {
  pid: number
  ppid: number
  /** Without .exe, lower case. */
  name: string
  exe: string | null
  /** Read for matching only. NEVER stored, logged or shown: command lines can hold secrets. */
  cmd: string | null
}

export interface Block {
  why: PortBlock
  text: string
}

export interface BlockContext {
  /** The agent's own process. */
  selfPid: number
  /** The ports the app itself uses (peer, api, discovery, hbbs, hbbr, chat host, this gate ...). */
  appPorts: ReadonlySet<number>
  /** The build folder with forward slashes, lower case, ending in '/agent/': a process whose command line has it is the app's (chat host, guard). */
  appMarker: string | null
  /** The app's own page port (SAD_UI_PORT, 5173): the one app port that may be shared like any page (Lead, 5 Nov). Its page server forwards /agent-api, so sharing it lets every device of the tailnet use this PC's app. */
  pagePort: number
  /** F-116: the agent runs on Linux, where the system's own ports are told by their account (uid) and their service names. */
  linux?: boolean
  /** F-116: the agent's own account (Linux). When it is not root, its own sockets never count as the system's, whatever its number. */
  selfUid?: number
}

export const RESERVED: readonly number[] = [80, 443, 4740, 4741, 4742, 8443, 8444]
export const RUSTDESK_PORTS: readonly number[] = [21115, 21116, 21117, 21118, 21119]
const WINDOWS_PORTS = new Set([1900, 2869, 3389, 5040, 5353, 5355, 5357, 5985, 5986, 7680, 47001])
const WINDOWS_NAMES = new Set(['system', 'svchost', 'lsass', 'services', 'wininit', 'spoolsv', 'wuauserv', 'searchindexer', 'fdhost', 'msdtc', 'mqsvc', 'dashost', 'winlogon', 'csrss', 'smss', 'lsm', 'sihost', 'dllhost', 'rundll32', 'wudfhost', 'dps', 'dnscache', 'nvcontainer', 'sqlwriter'])
/** F-116: Linux's own services (their program names; a socket of a system account is told by its uid). */
export const LINUX_SYSTEM_NAMES: ReadonlySet<string> = new Set([
  'systemd', 'systemd-resolved', 'systemd-resolve', 'systemd-networkd', 'systemd-timesyncd', 'init', 'sshd', 'cupsd', 'cups-browsed', 'avahi-daemon', 'snapd', 'containerd',
  'dnsmasq', 'rpcbind', 'rpc.statd', 'chronyd', 'ntpd', 'networkmanager', 'modemmanager', 'smbd', 'nmbd', 'winbindd', 'exim4', 'master', 'postfix', 'xrdp', 'xrdp-sesman',
  'gnome-remote-desktop-daemon', 'gnome-remote-de', 'vino-server', 'gdm', 'gdm3', 'sddm', 'lightdm', 'colord', 'polkitd', 'dbus-daemon', 'kdeconnectd', 'gsd-sharing',
])
const TAILSCALE_NAMES = new Set(['tailscaled', 'tailscale', 'tailscale-ipn'])
const APP_NAMES = new Set(['rustdesk', 'hbbs', 'hbbr', 'rustdesk-server'])

/** 'debugger' by process name: a browser, a driver, Docker. */
export const DEBUGGER_NAMES: ReadonlySet<string> = new Set([
  'chrome', 'msedge', 'chromium', 'brave', 'firefox', 'opera', 'vivaldi', 'chromedriver', 'geckodriver', 'msedgedriver', 'dockerd', 'docker', 'com.docker.backend', 'vpnkit',
])
/** 'debugger' by command line (matched on the lower-case text; never stored). */
export const DEBUGGER_FLAGS: readonly string[] = [
  '--inspect', '--remote-debugging-port', '--remote-debugging-pipe', '--marionette', '-agentlib:jdwp', '-xrunjdwp', '-xdebug', 'debugpy', '--debug-port', '--remote-allow-origins',
]
/** 'debugger' by well-known port, whatever the process. */
export const DEBUGGER_PORTS: ReadonlySet<number> = new Set([2375, 2376, 9222, 9223, 9229, 9515, 4444, 4723, 2828, 5005, 5678, 5858, 5900, 5901, 5902, 5903, 5904, 5905, 5906, 5907, 5908, 5909])

/**
 * A program's name the same on every system: lower case, no .exe, no version (python3, python3.12 -> python; php8.2 -> php; nodejs -> node), so one list of programs matches Windows and Linux.
 */
export function programKey(name: string | null | undefined): string {
  const n = (name ?? '').toLowerCase().replace(/\.exe$/, '')
  if (n === 'nodejs') return 'node'
  const m = /^(python|pythonw|php|php-cgi|php-fpm|ruby|java|javaw|perl)[-\d.]+$/.exec(n)
  return m ? m[1] : n
}

/** Nothing tells what this process is (its command line and program file cannot be read: elevated, or another user's). Then, and only then, the port number decides 'app'. */
export const unidentified = (proc: Proc | undefined) => !proc || (proc.cmd === null && proc.exe === null)

export const normalizeCmd = (s: string) => s.toLowerCase().replaceAll('\\', '/')

/** The app's own programs by what they were started with: the guard, the agent, the chat host (any copy of the app on this PC, not only this one). Matched on the lower-case command line; never stored. */
const APP_CMD = ['agent/guard.ts', 'agent/main.ts', 'agent/chathost/', 'agent/guard/']
const looksLikeApp = (cmd: string | null, marker: string | null) => {
  if (!cmd) return false
  const c = normalizeCmd(cmd)
  return APP_CMD.some(m => c.includes(m)) || (marker !== null && c.includes(marker))
}

/**
 * Is this process the app's? The agent, everything below it, the guard above it (it serves the app's page and its control port and starts the agent), the chat host, RustDesk's
 * programs, and any process started as one of the app's programs (another copy of the app on this PC too).
 */
export function isAppProcess(pid: number, procs: ReadonlyMap<number, Proc>, ctx: Pick<BlockContext, 'selfPid' | 'appMarker'>): boolean {
  if (pid === ctx.selfPid) return true
  // The agent and its ancestors that are app programs (the guard): everything below any of them is the app's.
  const roots = new Set<number>([ctx.selfPid])
  let up = procs.get(ctx.selfPid)
  for (let depth = 0; up && depth < 8; depth++) {
    const parent = up.ppid && up.ppid !== up.pid ? procs.get(up.ppid) : undefined
    if (!parent || !looksLikeApp(parent.cmd, ctx.appMarker)) break
    roots.add(parent.pid)
    up = parent
  }
  let at: Proc | undefined = procs.get(pid)
  for (let depth = 0; at && depth < 24; depth++) {
    if (roots.has(at.pid) || APP_NAMES.has(at.name) || looksLikeApp(at.cmd, ctx.appMarker)) return true
    at = at.ppid && at.ppid !== at.pid ? procs.get(at.ppid) : undefined
  }
  return false
}

/** The debugger/remote-control rules that need no network: the process name, its command line and the well-known ports. */
export function debuggerByProcess(port: number, proc: Proc | undefined): boolean {
  if (DEBUGGER_PORTS.has(port)) return true
  if (!proc) return false
  if (DEBUGGER_NAMES.has(proc.name)) return true
  if (proc.cmd) {
    const c = normalizeCmd(proc.cmd)
    if (DEBUGGER_FLAGS.some(f => c.includes(f))) return true
  }
  return false
}

export const TEXT: Record<PortBlock, string> = {
  app: 'This is part of the app itself (the agent, the chat host or RustDesk), so it is never shared.',
  tailscale: 'This is Tailscale itself, so it is never shared.',
  low: 'Ports under 1024 are never shared.',
  windows: "This belongs to the PC's own system (a service of Windows or Linux), so it is never shared.",
  reserved: "This port is Christopher's, the phone gate's or the Drive's, so Ports leaves it alone.",
  debugger: 'This answers like a debugger or remote-control port: anyone who could open it could drive the program, so it is never shared.',
  'other-entry': 'Tailscale already shares this port for something else (the phone gate or another entry), so Ports leaves it alone.',
  'not-reachable': 'This only listens on one network address, which the Ports gate cannot reach.',
}

const block = (why: PortBlock): Block => ({ why, text: TEXT[why] })

/**
 * The first rule that applies, or null. Order: what is certain from the number or the process (low, reserved, app, Tailscale, Windows, debugger), then reach.
 * `other-entry` is added by the caller (it comes from Tailscale's own list, not from the port). `probed` is the answer of the network probe for a debugger.
 */
export function blockOf(l: Listen, procs: ReadonlyMap<number, Proc>, ctx: BlockContext, probed = false): Block | null {
  const proc = procs.get(l.pid)
  if (l.port < 1024) return block('low')
  if (RESERVED.includes(l.port)) return block('reserved')
  // By process first. The port number is only the fallback for a process that cannot be identified: a dev server that happens to sit on an app port is not the app.
  if (l.port !== ctx.pagePort && (isAppProcess(l.pid, procs, ctx) || (unidentified(proc) && (ctx.appPorts.has(l.port) || RUSTDESK_PORTS.includes(l.port))))) return block('app')
  if (proc && TAILSCALE_NAMES.has(proc.name)) return block('tailscale')
  if (WINDOWS_PORTS.has(l.port) || l.pid === 4 || l.pid === 0 || (proc && WINDOWS_NAMES.has(proc.name))) return block('windows')
  // F-116: on Linux, a socket of a system account (root, a service's own account, nobody) or a known system service.
  const systemAccount = l.uid !== undefined && (l.uid < 1000 || l.uid === 65534) && !(ctx.selfUid !== undefined && ctx.selfUid !== 0 && l.uid === ctx.selfUid)
  if (ctx.linux && (systemAccount || (proc && LINUX_SYSTEM_NAMES.has(proc.name)))) return block('windows')
  if (probed || debuggerByProcess(l.port, proc)) return block('debugger')
  if (!l.reachable) return block('not-reachable')
  return null
}
