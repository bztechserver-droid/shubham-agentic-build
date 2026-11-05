import http from 'node:http'

// F-114: does the program on this port answer like a debugger or a remote-control endpoint? GET only, loopback only, 1.5 s, and nothing is opened or started:
//  - /json/version and /json/list (Chrome, Edge, Electron, Node --inspect, Puppeteer, chrome-devtools-mcp): "webSocketDebuggerUrl" or "Protocol-Version";
//  - /_ping with an Api-Version header (the Docker engine);
//  - /status with {"value":{"ready":...}} (WebDriver: chromedriver, geckodriver, Selenium, Appium).
// Pure of side effects; the caller keeps the answer per (port, pid).

export type Probe = (port: number) => Promise<boolean>

interface Answer {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

function get(port: number, path: string, timeoutMs: number): Promise<Answer | null> {
  return new Promise(resolve => {
    const options = { host: 'localhost', port, path, method: 'GET', timeout: timeoutMs, autoSelectFamily: true, headers: { accept: 'application/json', 'user-agent': 'shubham-agentic-ports-probe' } } as http.RequestOptions
    const req = http.request(options, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => {
        if (body.length < 8192) body += c
        else res.destroy()
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    req.end()
  })
}

/** Does this answer to `path` look like a debugger / remote-control endpoint? Exported for tests. */
export function looksLikeDebugger(path: string, a: Answer | null): boolean {
  if (!a) return false
  if (path === '/_ping') return a.headers['api-version'] !== undefined || a.headers['docker-experimental'] !== undefined || /docker/i.test(String(a.headers.server ?? ''))
  if (path === '/status') {
    try {
      const v = (JSON.parse(a.body) as { value?: unknown }).value
      return typeof v === 'object' && v !== null && 'ready' in v
    } catch {
      return false
    }
  }
  // /json/version, /json/list
  return /"webSocketDebuggerUrl"|"Protocol-Version"/.test(a.body)
}

export const PROBE_PATHS: readonly string[] = ['/json/version', '/json/list', '/_ping', '/status']

export const realProbe: Probe = async port => {
  const answers = await Promise.all(PROBE_PATHS.map(async p => looksLikeDebugger(p, await get(port, p, 1500))))
  return answers.some(Boolean)
}
