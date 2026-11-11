import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { CRM_FILES_REASONS, type CrmMountStatus } from '../../shared/crm-files.ts'
import { createCrmDav } from './dav-crm.ts'
import type { CrmFilesService } from './service.ts'

// o6e65 (S4): the CRM files as a Windows drive WITHOUT a host program: the agent serves them as WebDAV on a loopback port (dav-crm.ts, names made legal for Windows) and Windows' own WebDAV
// client (the WebClient service, `net use`) maps that as a drive letter. Nothing is installed and no program of ours is run, so Smart App Control / WinFsp are not involved.
//   - The address carries a secret (a path segment, new every run); `net use` has it on its command line only while it runs, with /persistent:no, so the mapping ends with the session.
//     The secret is never logged, never in a status, never on the page; messages that could hold it are cleaned before they are kept.
//   - Only 127.0.0.1 with this port in the Host header, and no Origin (not a browser page).
//   - The mapped letter is ours only: it is mapped by this agent, and unmapped by this agent with `net use <that letter> /delete` (the exact letter, never a wildcard). A letter that
//     something else holds is never touched. A leftover mapping of OURS from an earlier run (its address is \\127.0.0.1@<port>\DavWWWRoot\<secret>\crm) is the one exception: it is removed
//     before mapping again.
//   - Windows' settings and services are NEVER changed here. If the WebClient service is stopped, the status says so in plain words and gives the step for the person.
//   - Deleting is refused with 423 Locked (not 403: Windows' client treats 403 as advice and fakes a local delete, leaving the file looking gone).

export interface RunResult {
  code: number
  out: string
  err: string
}

export interface WinDavOptions {
  /** The drive letter, "Y:". */
  letter: string
  service(): CrmFilesService | null
  log?: { info(m: string): void; warn(m: string): void }
  /** Tests: runs a command (net, sc) instead of the real one. */
  run?: (file: string, args: string[]) => Promise<RunResult>
  /** Tests: stands in for the file system's answer about the letter (sync form); `exists` is the one this module uses. */
  driveExists?: (letter: string) => boolean
  /**
   * While the server is up: does the letter answer? ASYNCHRONOUS, always: a synchronous file call on the mapped letter makes Windows ask THIS process's server, which cannot answer while the
   * call blocks its event loop (a deadlock until Windows' own time-out). Nothing in the agent calls the file system on the letter synchronously once it is mapped.
   */
  exists?: (letter: string) => Promise<boolean>
  /** How long to wait for the letter after `net use` says it is done. */
  waitMs?: number
  /** S4b: how long `answers()` waits for the letter before it takes silence for "stale or gone" (default 1.5 s), and how long it remembers an answer (default 10 s). */
  answerMs?: number
  cacheMs?: number
  /** A line per request (method, path WITHOUT the secret, the Depth header, the status and the body size the client got): for tests and for finding out why a Windows client refuses. */
  trace?: (line: string) => void
}

export type DavStart = { ok: true } | { ok: false; reason: string; code: NonNullable<CrmMountStatus['reasonCode']> }

const sys32 = (exe: string) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe)

const runFile = (file: string, args: string[]): Promise<RunResult> =>
  new Promise(resolve => {
    execFile(file, args, { timeout: 40_000, windowsHide: true }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0
      resolve({ code, out: String(out ?? ''), err: String(err ?? (e ? e.message : '')) })
    })
  })

/** The words for the person when Windows' WebDAV client is not running, with the exact step. */
export const WEBCLIENT_REASON =
  "Windows' built-in WebDAV client (the WebClient service) is not running, so the CRM files cannot be shown as a drive without a program of ours. This app does not change Windows services. To start it: press Windows+R, type services.msc, find “WebClient”, right-click it and choose Start (Properties › Startup type › Manual keeps it available)."

/** Windows' WebClient limit for a file through a mapped WebDAV drive (FileSizeLimitInBytes, 50,000,000 bytes by default). */
export const WEBDAV_FILE_LIMIT = 50_000_000

export function createWinDav(o: WinDavOptions) {
  const letter = o.letter.toUpperCase()
  if (!/^[A-Z]:$/.test(letter)) throw new Error('a drive letter looks like "Y:"')
  const run = o.run ?? runFile
  const existsAsync = o.exists ?? (o.driveExists ? async (l: string) => o.driveExists!(l) : (l: string) => access(`${l}\\`).then(() => true, () => false))
  const answerMs = o.answerMs ?? 1500
  const cacheMs = o.cacheMs ?? 10_000
  let remembered: { at: number; value: boolean } | null = null
  const waitMs = o.waitMs ?? 15_000
  let server: http.Server | null = null
  let secret = ''
  let port = 0
  let mapped = false
  let starting: Promise<DavStart> | null = null

  /**
   * S4b: does the letter answer? ASYNCHRONOUS and time-boxed: a mapping of ours whose server is dead (the agent was killed) answers "yes" from Windows' cache for about a minute and
   * then takes 2 s per call to say no (measured); a synchronous call would block the event loop that long, every time. Silence for `answerMs` counts as "stale or gone" (false), which is
   * decided for good by `net use`'s own list (start() reads it). The answer is remembered for `cacheMs` (a status poll costs nothing) and forgotten whenever this module maps or unmaps.
   */
  async function answers(): Promise<boolean> {
    if (remembered && Date.now() - remembered.at < cacheMs) return remembered.value
    let timer: ReturnType<typeof setTimeout> | undefined
    const value = await Promise.race([
      existsAsync(letter).catch(() => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), answerMs)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    remembered = { at: Date.now(), value }
    return value
  }

  /** The `net use` line for this letter, or null: the list is Windows' own record, so a stale mapping shows in it even when the letter does not answer. */
  async function listed(): Promise<string | null> {
    const r = await run(sys32('net.exe'), ['use'])
    if (r.code !== 0) return null
    const pattern = new RegExp(`\\s${letter.replace(':', '\\:')}\\s`, 'i')
    return r.out.split(/\r?\n/).find(l => pattern.test(l)) ?? null
  }

  /** Anything that could hold the address is cleaned before it is shown or kept. */
  const clean = (s: string) => (secret ? s.split(secret).join('…') : s).replace(/http:\/\/127\.0\.0\.1:\d+\/[^\s"']*/g, 'the local address')

  const davHeaders = { DAV: '1, 2', 'MS-Author-Via': 'DAV', Allow: 'OPTIONS, GET, HEAD, PUT, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK' }

  async function listen(): Promise<void> {
    secret = randomBytes(24).toString('base64url')
    const dav = createCrmDav({ service: o.service, names: 'windows', deleteStatus: 423, log: o.log })
    const prefix = `/${secret}`
    server = http.createServer((req, res) => {
      const host = String(req.headers.host ?? '')
      if (host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        return void res.end('not for this')
      }
      const url = req.url ?? '/'
      if (o.trace) {
        const shown = url.split(secret).join('~').slice(0, 160)
        const started = Date.now()
        res.on('finish', () => o.trace?.(`${req.method} ${shown} depth=${req.headers.depth ?? '-'} -> ${res.statusCode} ${res.getHeader('content-type') ?? ''} ${res.getHeader('content-length') ?? ''} (${Date.now() - started} ms)`))
      }
      const under = url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)
      if (!under) {
        // Windows probes the server before mapping: an OPTIONS anywhere is answered (no data), everything else outside the secret path is not found.
        if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
          res.writeHead(200, { ...davHeaders, 'content-length': 0 })
          return void res.end()
        }
        res.writeHead(404, { 'content-type': 'text/plain' })
        return void res.end('no')
      }
      req.url = url.slice(prefix.length) || '/'
      void dav(req, res)
    })
    server.requestTimeout = 0
    server.keepAliveTimeout = 30_000
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject)
        resolve()
      })
    })
    port = (server.address() as AddressInfo).port
  }

  async function closeServer(): Promise<void> {
    const s = server
    server = null
    secret = ''
    port = 0
    if (!s) return
    s.closeAllConnections()
    await new Promise<void>(resolve => s.close(() => resolve()))
  }

  /** Is this `net use` line a mapping of OUR address (loopback, a secret path ending in \crm; with or without DavWWWRoot)? The only thing ever unmapped without having been mapped just now. */
  const isOurs = (line: string) => /\\\\127\.0\.0\.1@\d+\\(?:DavWWWRoot\\)?[A-Za-z0-9_-]{20,}\\crm/i.test(line)

  /** The plain words for a failed `net use`: from the system error number it gave. */
  function reasonOf(r: RunResult): { reason: string; code: NonNullable<CrmMountStatus['reasonCode']> } {
    const text = clean(`${r.err} ${r.out}`)
    const n = /System error (\d+)/i.exec(text)?.[1]
    // 67: the network name cannot be found; 1222: no network; 53: path not found: what Windows says when its WebDAV client is not running.
    if (n === '67' || n === '1222' || n === '53' || /WebClient/i.test(text)) return { reason: WEBCLIENT_REASON, code: 'webclient' }
    if (n === '85' || n === '1202' || n === '1219') return { reason: CRM_FILES_REASONS.letterTaken.replace('Y:', letter), code: 'letter-taken' }
    const first = text.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? 'no answer'
    return { reason: `Windows could not map the drive (${first.slice(0, 120)}).`, code: 'failed' }
  }

  async function start(): Promise<DavStart> {
    if (mapped) return { ok: true }
    starting ??= (async (): Promise<DavStart> => {
      try {
        // What holds the letter, by Windows' own list first (a stale mapping of ours shows there even when the letter does not answer), never by a synchronous file call.
        const taken = { ok: false as const, reason: CRM_FILES_REASONS.letterTaken.replace('Y:', letter), code: 'letter-taken' as const }
        const line = await listed()
        remembered = null
        if (line) {
          if (!isOurs(line)) return taken
          await run(sys32('net.exe'), ['use', letter, '/delete', '/y'])
          remembered = null
          if (await answers()) return taken
        } else if (await answers()) {
          // Not a network mapping, yet something answers: a local drive holds it.
          return taken
        }
        remembered = null
        await listen()
        // The address is on this command line only while it runs. /persistent:no: the mapping ends with the Windows session.
        const r = await run(sys32('net.exe'), ['use', letter, `http://127.0.0.1:${port}/${secret}/crm/`, '/persistent:no'])
        if (r.code !== 0) {
          const why = reasonOf(r)
          await closeServer()
          return { ok: false, ...why }
        }
        mapped = true
        remembered = null
        const until = Date.now() + waitMs
        let there = await existsAsync(letter)
        while (!there && Date.now() < until) {
          await new Promise(res => setTimeout(res, 200))
          there = await existsAsync(letter)
        }
        if (!there) {
          await end()
          return { ok: false, reason: 'Windows said the drive was mapped, but it did not appear.', code: 'failed' }
        }
        remembered = { at: Date.now(), value: true }
        o.log?.info(`crm drive: ${letter} is mapped (built-in WebDAV)`)
        return { ok: true }
      } catch (e) {
        await closeServer().catch(() => undefined)
        return { ok: false, reason: `The CRM drive could not start (${clean((e as Error).message).slice(0, 80)}).`, code: 'failed' }
      }
    })().finally(() => (starting = null))
    return starting
  }

  /** Unmaps the letter this agent mapped (exactly that letter) and stops serving. Does nothing for a letter it did not map. */
  async function end(): Promise<void> {
    if (mapped) {
      mapped = false
      const r = await run(sys32('net.exe'), ['use', letter, '/delete', '/y'])
      if (r.code !== 0) o.log?.warn(`crm drive: ${letter} could not be unmapped (${clean(r.err || r.out).split(/\r?\n/)[0].slice(0, 80)})`)
    }
    remembered = null
    await closeServer()
  }

  return {
    start,
    end,
    /** S4b: does the letter answer (async, time-boxed, remembered for a few seconds): see above. */
    answers,
    /** Ours: mapped by this agent and still served. */
    alive: () => mapped && server !== null,
    /** Read only: is Windows' WebClient service running? (null: could not tell.) The agent never starts or changes it. */
    async webClientRunning(): Promise<boolean | null> {
      const r = await run(sys32('sc.exe'), ['query', 'WebClient'])
      if (r.code !== 0) return null
      return /STATE\s*:\s*4\s+RUNNING/i.test(r.out)
    },
  }
}
