import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'

// Stable ports (order od91f): one stable port. It is the app's own page, nothing else: `/` lands on its PC's tab (a relative redirect, so it works by name,
// by address and through the Ports gate alike), and every other request (the page's files, /agent-api, WebSockets) goes on, byte for byte, to the page
// on this PC (SAD_UI_PORT, 5173). So the page server's rules (its Host check, the API token only for the app's own pages, F-118's sign-in) apply exactly
// as on 5173, and the sign-in carries over: the session cookie is the host's, whatever the port. Listens on this PC's loopbacks only; the tailnet reaches
// it only through the Ports gate, like every other shared page.

export interface StableProxyOptions {
  /** The stable port. */
  port: number
  host: string
  /** Where `/` goes, e.g. /pc-control?pc=<id>&view=chat1. */
  landing: string
  /** The app's page on this PC, read per request. */
  pagePort: () => number
  /** Where the page is reached (default 'localhost': both loopbacks, as Vite in Dev may listen on ::1 only). */
  upstreamHost?: string
}

export interface StableProxy {
  port: number
  close(): Promise<void>
}

export async function startStableProxy(o: StableProxyOptions): Promise<StableProxy> {
  const upstreamHost = o.upstreamHost ?? 'localhost'
  const sockets = new Set<Duplex>()
  const track = (s: Duplex) => {
    sockets.add(s)
    s.once('close', () => sockets.delete(s))
  }

  const web = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if ((req.method === 'GET' || req.method === 'HEAD') && url === '/') {
      // Not cached: a Change on the Ports page moves the port, and the old number must not stick in a browser.
      res.writeHead(302, { location: o.landing, 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      return void res.end(req.method === 'HEAD' ? undefined : `This page is at ${o.landing}\n`)
    }
    const page = o.pagePort()
    // The headers go on as the visitor sent them (a flat list: same order and case), Host included: the page server judges the stable port's own Host and Origin.
    const options = { host: upstreamHost, port: page, autoSelectFamily: true, method: req.method, path: url, headers: req.rawHeaders, setHost: false } as http.RequestOptions
    const up = http.request(options, answer => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders)
      answer.pipe(res)
    })
    up.on('error', () => {
      if (res.headersSent) return void res.destroy()
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`The app's page is not answering on this PC right now (port ${page}).\n`)
    })
    req.pipe(up)
  })

  // A WebSocket (the app's state, a terminal, a screen): the handshake as it came, then bytes both ways; either side closing closes the other.
  web.on('upgrade', (req, socket, head) => {
    track(socket)
    socket.on('error', () => socket.destroy())
    const up = net.connect({ host: upstreamHost, port: o.pagePort(), autoSelectFamily: true }, () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      up.write(raw + '\r\n')
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    track(up)
    const close = () => {
      socket.destroy()
      up.destroy()
    }
    up.on('error', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      close()
    })
    socket.on('close', close)
    up.on('close', close)
  })
  web.on('connection', s => track(s))
  web.requestTimeout = 0
  web.headersTimeout = 60_000
  web.keepAliveTimeout = 65_000

  await new Promise<void>((resolve, reject) => {
    web.once('error', reject)
    // exclusive: never shared with another listener on the same port, so a clash is seen at once rather than hidden.
    web.listen({ port: o.port, host: o.host, exclusive: true }, () => {
      web.off('error', reject)
      web.on('error', () => undefined)
      resolve()
    })
  })
  return {
    port: (web.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>(resolve => {
        for (const s of sockets) s.destroy()
        sockets.clear()
        web.close(() => resolve())
        web.closeAllConnections()
      }),
  }
}
