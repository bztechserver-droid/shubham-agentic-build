import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { PHONE_APPS_PREFIX, downloadPath, type PhoneApp, type PhoneAppBuild, type PhoneAppId } from '../../shared/phone-apps.ts'
import { apiError, type ApiMount } from '../api.ts'
import type { Auth } from '../auth/index.ts'
import { APK_MIME, DEFAULT_OFFER_FILE, createAppUpdate, parseRange, type AppUpdate } from './app-update.ts'
import { requireCrmHuman } from './human-session.ts'

// Order o5dc6 (12 Nov 2026): the PC's side of the Phone app page (shared/phone-apps.ts). Owner only: every route wants a page
// signed in as the owner, through CRM (requireCrmHuman), on top of the API's own gate; a chat's tool key is refused.
//   GET  /agent-api/phone-apps/                      the apps: the build each would send, or why none
//   GET  /agent-api/phone-apps/agentic/<code>.apk    Shubham Agentic: the NEWEST build that passed verify, and only that one
//   GET  /agent-api/phone-apps/chris/<code>.apk      Hey Chris: the build its Update button offers (offer.json), and only that one
// "Verified" for Shubham Agentic: mobile/scripts/agentic.mjs writes a build's record (agentic-<version>-debug.build-info.json, with
// the APK's sha256 and size) only AFTER verify passed; a build that failed verify is never copied to C:\sac\out\agentic. The newest
// record by its build number is the build offered. Nothing older is offered in its place: a newest build whose file is missing
// or no longer matches its record is reported on the page, not skipped. At send time the file is read whole, its sha256 checked
// against the record, and exactly the bytes that were checked are sent. Hey Chris keeps its own rule (app-update.ts): the offered
// file is sent only while its sha256 matches offer.json. A <code> that is not the build offered now is refused (409): the page
// shows a build and the file is that build. Logs: the version and the bytes, nothing else.

export const DEFAULT_AGENTIC_DIR = 'C:\\sac\\out\\agentic'
export const AGENTIC_PACKAGE = 'com.shubhamagentic.agentic'
/** The record agentic.mjs writes beside each APK it copies (after verify passed): agentic-<versionName>-debug.build-info.json. */
const RECORD_NAME = /^agentic-(\d{1,4}\.\d{1,4}\.\d{1,4}-([1-9]\d{0,11}))-debug\.build-info\.json$/
/** Far above the app's 2.6 MB: a record that names more is not this app's. The file is read whole, hashed, then sent as read. */
export const MAX_AGENTIC_BYTES = 64 * 1024 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const SHA256 = /^[0-9a-f]{64}$/
const DOWNLOAD = /^\/(agentic|chris)\/([1-9]\d{0,11})\.apk$/

const NAMES: Record<PhoneAppId, string> = { agentic: 'Shubham Agentic', chris: 'Hey Chris' }

export interface AgenticRecord {
  build: PhoneAppBuild
  /** The APK's file name, in the record's folder. */
  apk: string
}

/** A build record of Shubham Agentic (its file name and text), or why it is not one. */
export function parseAgenticRecord(name: string, text: string): AgenticRecord | string {
  const m = RECORD_NAME.exec(name)
  if (!m) return `${name} is not a build record`
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return `${name} is not valid JSON`
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `${name} is not an object`
  const r = v as Record<string, unknown>
  if (r.app !== AGENTIC_PACKAGE) return `${name} is not a record of ${AGENTIC_PACKAGE}`
  if (r.type !== 'debug') return `${name} is not a debug build`
  if (r.versionName !== m[1]) return `${name} names another version`
  if (r.code !== Number(m[2])) return `${name} names another build number`
  if (typeof r.apkSha256 !== 'string' || !SHA256.test(r.apkSha256)) return `${name} has no whole sha256`
  if (!Number.isSafeInteger(r.bytes) || (r.bytes as number) <= 0 || (r.bytes as number) > MAX_AGENTIC_BYTES) return `${name} has no usable size`
  const apk = `agentic-${m[1]}-debug.apk`
  if (r.apk !== apk) return `${name} names another file`
  const built = typeof r.builtAt === 'string' ? Date.parse(r.builtAt) : Number.NaN
  return {
    build: { versionName: m[1], versionCode: r.code as number, bytes: r.bytes as number, sha256: r.apkSha256, at: Number.isFinite(built) ? new Date(built).toISOString() : null, file: apk },
    apk,
  }
}

const sha256Of = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('data', c => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

export interface PhoneAppsDeps {
  /** The folder agentic.mjs copies verified builds to: C:\sac\out\agentic (SAD_AGENTIC_APK_DIR for another). */
  agenticDir?: string
  /** Hey Chris's offer (app-update.ts); null leaves Hey Chris out. Left out: offer.json, as the voice mount reads it. */
  chris?: AppUpdate | null
  log?: { info(m: string): void; warn(m: string): void }
}

export interface PhoneApps {
  /** Each app with the build it would send now, or why none. */
  list(): Promise<PhoneApp[]>
  /** Sends that app's build `code` (GET or HEAD, one Range) when it is the one offered now; throws an apiError otherwise. */
  serve(id: PhoneAppId, code: number, req: IncomingMessage, res: ServerResponse): Promise<void>
}

export function createPhoneApps(deps: PhoneAppsDeps = {}): PhoneApps {
  const dir = deps.agenticDir ?? process.env.SAD_AGENTIC_APK_DIR ?? DEFAULT_AGENTIC_DIR
  const chris = deps.chris === undefined ? createAppUpdate({ file: process.env.SAD_APP_OFFER ?? DEFAULT_OFFER_FILE, log: deps.log }) : deps.chris
  /** The sha256 of the newest APK as last hashed for the list, by its path, size and mtime (the send hashes the bytes it sends). */
  let hashed: { key: string; sha256: string } | null = null

  /** The newest build record (by the build number in its name), its APK checked against it; or why nothing is offered. */
  async function newestAgentic(): Promise<{ build: PhoneAppBuild; file: string } | string> {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return 'No Shubham Agentic build on this PC yet.'
    }
    const records = names.flatMap(n => {
      const m = RECORD_NAME.exec(n)
      return m ? [{ name: n, code: Number(m[2]) }] : []
    })
    if (!records.length) return 'No Shubham Agentic build on this PC yet.'
    const newest = records.reduce((a, b) => (b.code > a.code ? b : a))
    const recordFile = path.join(dir, newest.name)
    let text: string
    try {
      const st = statSync(recordFile)
      if (!st.isFile() || st.size > MAX_RECORD_BYTES) return `The newest build's record (${newest.name}) is not a small file, so nothing is offered.`
      text = await readFile(recordFile, 'utf8')
    } catch {
      return `The newest build's record (${newest.name}) could not be read, so nothing is offered.`
    }
    const r = parseAgenticRecord(newest.name, text)
    if (typeof r === 'string') return `The newest build's record is not usable (${r}), so nothing is offered.`
    const file = path.join(dir, r.apk)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(file)
    } catch {
      return `The newest build's file (${r.apk}) is not there, so nothing is offered.`
    }
    if (!st.isFile() || st.size !== r.build.bytes) return `The newest build's file (${r.apk}) is not the size its record says, so nothing is offered.`
    const key = `${file}:${st.size}:${Math.round(st.mtimeMs)}`
    let sha = hashed?.key === key ? hashed.sha256 : null
    if (!sha) {
      try {
        sha = await sha256File(file)
      } catch {
        return `The newest build's file (${r.apk}) could not be read, so nothing is offered.`
      }
      hashed = { key, sha256: sha }
    }
    if (sha !== r.build.sha256) {
      deps.log?.warn(`phone-apps: ${r.apk} no longer matches the sha256 in its record; not offering it`)
      return `The newest build's file (${r.apk}) no longer matches the sha256 in its record, so nothing is offered.`
    }
    return { build: r.build, file }
  }

  function sendBytes(req: IncomingMessage, res: ServerResponse, bytes: Buffer, build: PhoneAppBuild, name: string) {
    const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, bytes.length)
    if (range === 'bad') {
      res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': 0, 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : bytes.length - 1
    const head: Record<string, string | number> = {
      'Content-Type': APK_MIME,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ETag: `"${build.sha256.slice(0, 32)}"`,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': end - start + 1,
    }
    if (range) head['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`
    res.writeHead(range ? 206 : 200, head)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(bytes.subarray(start, end + 1))
    deps.log?.info(`phone-apps: Shubham Agentic ${build.versionName}, ${end - start + 1} of ${bytes.length} bytes sent`)
  }

  const notNewest = (code: number, versionName: string) => apiError(409, `Build ${code} is not the one offered now (${versionName} is): reload the page and download again.`)

  return {
    async list() {
      const a = await newestAgentic()
      const apps: PhoneApp[] = [
        typeof a === 'string'
          ? { id: 'agentic', name: NAMES.agentic, build: null, why: a, download: null }
          : { id: 'agentic', name: NAMES.agentic, build: a.build, why: null, download: downloadPath('agentic', a.build.versionCode) },
      ]
      if (chris) {
        const o = await chris.offered()
        apps.push(
          o
            ? {
                id: 'chris',
                name: NAMES.chris,
                build: { versionName: o.versionName, versionCode: o.versionCode, bytes: o.bytes, sha256: o.sha256, at: o.offeredAt > 0 ? new Date(o.offeredAt).toISOString() : null, file: null },
                why: null,
                download: downloadPath('chris', o.versionCode),
              }
            : { id: 'chris', name: NAMES.chris, build: null, why: chris.reason() ?? 'No Hey Chris build is offered.', download: null },
        )
      }
      return apps
    },

    async serve(id, code, req, res) {
      if (id === 'chris') {
        if (!chris) throw apiError(404, 'Hey Chris is not offered here.')
        const o = await chris.offered()
        if (!o) throw apiError(404, chris.reason() ?? 'No Hey Chris build is offered.')
        if (o.versionCode !== code) throw notNewest(code, o.versionName)
        await chris.serve(req, res)
        return
      }
      const now = await newestAgentic()
      if (typeof now === 'string') throw apiError(404, now)
      if (now.build.versionCode !== code) throw notNewest(code, now.build.versionName)
      let bytes: Buffer
      try {
        bytes = await readFile(now.file)
      } catch {
        throw apiError(404, `${path.basename(now.file)} could not be read.`)
      }
      // The check that counts: the very bytes about to be sent against the record (the list's hash may be a moment old).
      if (bytes.length !== now.build.bytes || sha256Of(bytes) !== now.build.sha256) {
        deps.log?.warn(`phone-apps: ${path.basename(now.file)} changed after its record was written; not sending it`)
        throw apiError(409, `${path.basename(now.file)} no longer matches its build record, so it is not sent.`)
      }
      sendBytes(req, res, bytes, now.build, path.basename(now.file))
    },
  }
}

/** The mount: owner only, signed in through CRM, for the list and for every file. */
export function createPhoneAppsMount(deps: PhoneAppsDeps & { auth?: Auth } = {}): ApiMount {
  const apps = createPhoneApps(deps)
  return {
    prefix: PHONE_APPS_PREFIX,
    async http(request) {
      requireCrmHuman(deps.auth, request, true)
      if (request.rest !== '/' && request.rest !== '') throw apiError(404, 'No such phone app route')
      if (request.method !== 'GET') throw apiError(405, 'The phone apps list is read only')
      return { apps: await apps.list() }
    },
    raw(rest) {
      const m = DOWNLOAD.exec(rest)
      if (!m) return null
      const id = m[1] as PhoneAppId
      const code = Number(m[2])
      return async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw apiError(405, 'Only GET or HEAD here')
        requireCrmHuman(deps.auth, { headers: req.headers }, true)
        await apps.serve(id, code, req, res)
      }
    },
  }
}
