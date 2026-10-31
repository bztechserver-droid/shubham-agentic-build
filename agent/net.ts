import os from 'node:os'

// LAN detection and address checks (agent/SPEC.md › State, config and ports). IPv4 only:
// hbbs's --mask, the direct probe and discovery's directed broadcast all work on IPv4.

/** Adapters that are never "the LAN": VPNs, virtual switches, loopback, Bluetooth PAN. */
const VIRTUAL_ADAPTER = /tailscale|vethernet|wsl|hyper-v|virtualbox|vmware|loopback|bluetooth/i

// One octet, without leading zeros: "010" is octal to some parsers and decimal to others.
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)

export type InterfaceTable = ReturnType<typeof os.networkInterfaces>

export interface Subnet {
  /** This PC's address on it, e.g. "192.168.1.118". */
  address: string
  /** e.g. "192.168.1.0/24". */
  cidr: string
  prefix: number
  /** Directed broadcast, e.g. "192.168.1.255" (LAN discovery sends here). */
  broadcast: string
  /** The adapter, e.g. "Wi-Fi"; null when the address came from config.json and no adapter has it. */
  adapter: string | null
}

export interface NetOptions {
  /** config.json's `lanAddress`: wins over detection when set. */
  lanAddress?: string | null
  /** Tests: a fake os.networkInterfaces() table. */
  interfaces?: InterfaceTable
}

/** "192.168.1.118" or "::ffff:192.168.1.118" as a uint32, or null when it is not IPv4. */
export function parseIPv4(ip: string): number | null {
  const m = IPV4.exec(unmapIPv4(ip))
  if (!m) return null
  return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0
}

export function formatIPv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

// Dual-stack sockets report IPv4 peers as "::ffff:a.b.c.d".
function unmapIPv4(ip: string) {
  return /^::ffff:\d/i.test(ip) ? ip.slice(7) : ip
}

function maskOf(prefix: number) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
}

/** "255.255.255.0" → 24; null for a mask that is not contiguous. */
export function prefixFromNetmask(netmask: string): number | null {
  const n = parseIPv4(netmask)
  if (n === null) return null
  for (let p = 0; p <= 32; p++) if (maskOf(p) === n) return p
  return null
}

/** "192.168.1.0/24" → its network and prefix, or null. The host bits may be set ("192.168.1.118/24"). */
export function parseCidr(cidr: string): { network: number; prefix: number } | null {
  const m = /^([^/]+)\/(\d{1,2})$/.exec(cidr.trim())
  if (!m) return null
  const ip = parseIPv4(m[1])
  const prefix = Number(m[2])
  if (ip === null || prefix > 32) return null
  return { network: (ip & maskOf(prefix)) >>> 0, prefix }
}

/** The network an address is on: ("192.168.1.118", 24) → "192.168.1.0/24". */
export function cidrOf(address: string, prefix: number): string {
  const ip = parseIPv4(address)
  if (ip === null || prefix < 0 || prefix > 32) throw new Error(`Not an IPv4 address/prefix: ${address}/${prefix}`)
  return `${formatIPv4((ip & maskOf(prefix)) >>> 0)}/${prefix}`
}

/** ("192.168.1.118", 24) → "192.168.1.255". */
export function broadcastOf(address: string, prefix: number): string {
  const ip = parseIPv4(address)
  if (ip === null || prefix < 0 || prefix > 32) throw new Error(`Not an IPv4 address/prefix: ${address}/${prefix}`)
  return formatIPv4((ip | ~maskOf(prefix)) >>> 0)
}

export function inCidr(ip: string, cidr: string): boolean {
  const n = parseIPv4(ip)
  const net = parseCidr(cidr)
  if (n === null || !net) return false
  return ((n & maskOf(net.prefix)) >>> 0) === net.network
}

/** RFC 1918 (and IPv6 unique-local): an address that can only be on a private network. */
export function isPrivate(ip: string): boolean {
  if (parseIPv4(ip) !== null) {
    return inCidr(ip, '10.0.0.0/8') || inCidr(ip, '172.16.0.0/12') || inCidr(ip, '192.168.0.0/16')
  }
  return /^f[cd][0-9a-f]{0,2}:/i.test(ip)
}

/** Tailscale's addresses: the CGNAT range, 100.64.0.0/10. */
export const TAILNET_CIDR = '100.64.0.0/10'

export const isTailnet = (ip: string): boolean => inCidr(ip, TAILNET_CIDR)

/**
 * This PC's Tailscale IPv4 ("100.65.101.123"), or null when Tailscale isn't up here: an
 * address in 100.64.0.0/10 on Tailscale's adapter ("Tailscale" on Windows, "tailscale0" on
 * Linux). Other adapters are left out, as a phone hotspot or an ISP may hand out that range too.
 */
export function tailnetAddress(opts: Pick<NetOptions, 'interfaces'> = {}): string | null {
  const table = opts.interfaces ?? os.networkInterfaces()
  for (const [name, infos] of Object.entries(table)) {
    if (!/tailscale/i.test(name)) continue
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal && isTailnet(info.address)) return info.address
    }
  }
  return null
}

/** False for VPN, virtual-switch, loopback and Bluetooth adapters. */
export function isLanAdapter(name: string): boolean {
  return !VIRTUAL_ADAPTER.test(name)
}

function subnetOf(address: string, prefix: number, adapter: string | null): Subnet {
  return { address, cidr: cidrOf(address, prefix), prefix, broadcast: broadcastOf(address, prefix), adapter }
}

/**
 * This PC's physical LAN subnets, the main one first: config.json's `lanAddress` when set,
 * then private addresses before others. Leaves out loopback, link-local (169.254/16),
 * CGNAT/Tailscale (100.64/10) and virtual adapters.
 */
export function localSubnets(opts: NetOptions = {}): Subnet[] {
  const table = opts.interfaces ?? os.networkInterfaces()
  const pin = opts.lanAddress ? parsePin(opts.lanAddress) : null
  const found: Subnet[] = []
  let pinned: Subnet | null = null
  for (const [name, infos] of Object.entries(table)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4') continue
      const prefix = prefixFromNetmask(info.netmask)
      if (prefix === null || parseIPv4(info.address) === null) continue
      // The config wins even on an adapter detection would skip: the user chose it.
      if (pin && info.address === pin.address) {
        pinned ??= subnetOf(info.address, prefix, name)
        continue
      }
      if (info.internal || !isLanAdapter(name)) continue
      if (inCidr(info.address, '169.254.0.0/16') || inCidr(info.address, '100.64.0.0/10')) continue
      found.push(subnetOf(info.address, prefix, name))
    }
  }
  // Stable sort: private addresses first, otherwise the adapters' own order.
  found.sort((a, b) => Number(isPrivate(b.address)) - Number(isPrivate(a.address)))
  // A pinned address no adapter has right now (Wi-Fi down) keeps its own prefix, or /24.
  if (pin && !pinned) pinned = subnetOf(pin.address, pin.prefix ?? 24, null)
  return pinned ? [pinned, ...found.filter(s => s.address !== pinned.address)] : found
}

// config.json's lanAddress: "192.168.1.118", or "192.168.1.118/24" to give the prefix too.
function parsePin(value: string): { address: string; prefix: number | null } | null {
  const [address, prefix] = value.trim().split('/')
  if (parseIPv4(address) === null) return null
  if (prefix === undefined) return { address, prefix: null }
  return /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32 ? { address, prefix: Number(prefix) } : null
}

/** The main LAN subnet (the hub's --mask and local-ip, SelfInfo.lanAddress), or null. */
export function primaryLan(opts: NetOptions = {}): Subnet | null {
  return localSubnets(opts)[0] ?? null
}

/** True when `ip` is on one of this PC's LAN subnets. */
export function inLocalSubnet(ip: string, opts: NetOptions = {}): boolean {
  return localSubnets(opts).some(s => inCidr(ip, s.cidr))
}

/** "192.168.1.118:21220" or "[::1]:21220" → host and port, or null. */
export function parseHostPort(value: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value.trim())
  if (!m) return null
  const port = Number(m[3])
  if (port < 1 || port > 65535) return null
  return { host: m[1] ?? m[2], port }
}

export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}
