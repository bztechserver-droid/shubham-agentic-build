import { readFileSync } from 'node:fs'

// F-126 (Linux): who is on the other end of a loopback TCP connection. The CRM drive's WebDAV listener holds no password (nothing to store, nothing in a URL), so it lets in
// only sockets of the agent's own Linux user, as a private Unix socket would: the kernel lists every TCP socket in /proc/net/tcp with its owner's uid. A connection from
// 127.0.0.1:<client> to 127.0.0.1:<ours> has two lines there: ours (local = our port) and the client's (local = <client>, remote = our port). The client's line has its uid.

const field = (hex: string | undefined) => {
  const [, port] = (hex ?? '').split(':')
  return port ? parseInt(port, 16) : NaN
}

/** The uid of the socket whose local port is `clientPort` and whose remote port is `serverPort`, from the texts of /proc/net/tcp and tcp6; null when none is listed. */
export function peerUid(texts: string[], clientPort: number, serverPort: number): number | null {
  for (const text of texts) {
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10) continue
      if (field(f[1]) !== clientPort || field(f[2]) !== serverPort) continue
      const uid = Number(f[7])
      if (Number.isInteger(uid) && uid >= 0) return uid
    }
  }
  return null
}

/** The texts of /proc/net/tcp and /proc/net/tcp6 (a missing one is left out). */
export function readProcNet(read: (f: string) => string = f => readFileSync(f, 'utf8')): string[] {
  const out: string[] = []
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      out.push(read(f))
    } catch {
      // No IPv6, or no /proc: nothing from it.
    }
  }
  return out
}

/** Is this connection from the agent's own user? Unknown (not listed, not Linux) counts as no. */
export function sameUser(socket: { remotePort?: number; localPort?: number }, uid: number, procNet: () => string[] = readProcNet): boolean {
  if (!socket.remotePort || !socket.localPort) return false
  return peerUid(procNet(), socket.remotePort, socket.localPort) === uid
}
