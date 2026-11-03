import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { startApi, type ApiActions, type ApiMount } from '../api.ts'
import { createDrive } from './index.ts'
import type { Runner } from './tailscale.ts'

// F-097, for building the Drive page before the real agent runs this code: a small API server with ONLY the Common Drive on it, on its
// own port, with a pool in a temporary folder (or --root). It guards nothing real: the token is the one you pass (or `dev`).
//   node agent/drive/dev-server.ts --port 4799 --token dev [--root <folder>] [--limit-gb 1] [--webdav-port 21280] [--program <file>]
//        [--fake-google | --backup-folder <folder>] [--real-tailscale]
// Point the page's proxy at http://127.0.0.1:4799 with the header x-sad-token: dev. Stop it with Ctrl+C.
// `tailscale` is a PRETEND one unless --real-tailscale is given: switching "the https address" on and off only changes what the page shows; the real serve is never touched.
// The backup, for page tests, never reaches real Google:
//   --fake-google          keys exist (made up) and Google is a pretend server on this PC: switch the backup on and it copies there
//   --backup-folder <dir>  no keys: the copy goes to that folder (the "no keys" fallback); default: a folder in the scratch area
//   (neither)              no keys and no folder: the backup says there is nowhere to copy to
// Scenario helpers under /agent-api/dev (same token): POST /dev/seed {files, size?}, POST /dev/remove {count} (removing more than 20 at once,
// after a copy, makes the backup HOLD the removals), POST /dev/google {fail: true|false} (the pretend Google refuses everything / works again).

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

/** A tailscale that answers like the real one and remembers one serve entry, in memory only. */
function pretendTailscale(): Runner {
  let served: number | null = null
  const status = JSON.stringify({ Self: { DNSName: 'dev-server.example.ts.net.', UserID: 1 }, User: { '1': { LoginName: 'owner@example.com' } } })
  return async args => {
    const line = args.join(' ')
    if (line === 'status --json') return { code: 0, stdout: status, stderr: '' }
    const on = /^serve --bg --https=(\d+) http:\/\/127\.0\.0\.1:(\d+)$/.exec(line)
    if (on) {
      served = Number(on[2])
      return { code: 0, stdout: '', stderr: '' }
    }
    if (/^serve --https=\d+ off$/.test(line)) {
      served = null
      return { code: 0, stdout: '', stderr: '' }
    }
    if (line === 'serve status --json') {
      const web = served === null ? {} : { 'dev-server.example.ts.net:8444': { Handlers: { '/': { Proxy: `http://127.0.0.1:${served}` } } } }
      return { code: 0, stdout: JSON.stringify({ Web: web }), stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `pretend tailscale: not supported: ${line}` }
  }
}

const port = Number(arg('port', '4799'))
const token = arg('token', 'dev')
const base = mkdtempSync(path.join(tmpdir(), 'drive-dev-'))
const root = arg('root', path.join(base, 'pool'))
const real = process.argv.includes('--real-tailscale')
const program = arg('program', '')
const fakeGoogleOn = process.argv.includes('--fake-google')
const keysFile = path.join(base, 'secrets', 'fake-google.env')
const fallback = arg('backup-folder', '')

let google: Awaited<ReturnType<typeof import('./google.fake.ts').fakeGoogle>> | null = null
if (fakeGoogleOn) {
  const fake = await import('./google.fake.ts')
  google = await fake.fakeGoogle()
  mkdirSync(path.dirname(keysFile), { recursive: true })
  writeFileSync(keysFile, `GDRIVE_CLIENT_ID=${fake.SECRET.id}\nGDRIVE_CLIENT_SECRET=${fake.SECRET.secret}\nGDRIVE_REFRESH_TOKEN=${fake.SECRET.refresh}\n`)
}

const drive = createDrive({
  dir: path.join(base, 'state'),
  root,
  device: 'Dev server',
  role: 'hub',
  webdavPort: Number(arg('webdav-port', '21280')),
  backupFolder: fallback || null,
  keysFile,
  backup: { settleMs: 500 },
  ...(google ? { google: { apiBase: google.apiBase, uploadBase: google.uploadBase, tokenUrl: google.tokenUrl, retryMs: 5, account: 'someone@example.com' } } : {}),
  ...(real ? {} : { runner: pretendTailscale() }),
  ...(program ? { programFile: program } : {}),
})

/** Scenario helpers for page tests. Guarded like the rest (the token). */
const scenarios: ApiMount = {
  prefix: '/dev',
  async http(r) {
    const body = (r.body ?? {}) as Record<string, unknown>
    const store = await drive.store()
    if (!store) throw Object.assign(new Error('The drive is off.'), { status: 409 })
    if (r.rest === '/seed' && r.method === 'POST') {
      const n = Math.min(500, Math.max(1, Number(body.files ?? 30)))
      const size = Math.min(1_000_000, Math.max(1, Number(body.size ?? 200)))
      for (let i = 0; i < n; i++) await store.putFile(`seed/file-${String(i).padStart(3, '0')}.txt`, Readable.from([Buffer.alloc(size, 97 + (i % 20))]), { mode: 'overwrite' })
      return { seeded: n }
    }
    if (r.rest === '/remove' && r.method === 'POST') {
      const n = Math.min(500, Math.max(1, Number(body.count ?? 25)))
      const names = (await store.list('seed', { limit: 1000 })).entries.filter(e => e.kind === 'file').slice(0, n)
      for (const e of names) await store.remove(e.path)
      return { removed: names.length }
    }
    if (r.rest === '/google' && r.method === 'POST') {
      if (!google) throw Object.assign(new Error('Not started with --fake-google.'), { status: 409 })
      google.stats.fail = body.fail === true ? Array(200).fill(400) : []
      return { failing: body.fail === true }
    }
    throw Object.assign(new Error(`No such helper: ${r.method} ${r.rest}`), { status: 404 })
  },
}

const limit = Number(arg('limit-gb', '1'))
const api = await startApi({ port, token, actions: {} as ApiActions, mounts: [drive.mount, scenarios] })
await fetch(`http://127.0.0.1:${api.port}/agent-api/agentic/drive/settings`, {
  method: 'PATCH',
  headers: { 'x-sad-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ limitBytes: limit * 1024 ** 3 }),
})
console.log(
  `Common Drive dev server: http://127.0.0.1:${api.port}/agent-api/agentic/drive  (x-sad-token: ${token})\npool: ${root}\nlimit: ${limit} GB\ntailscale: ${real ? 'REAL' : 'pretend (nothing real is touched)'}\nbackup: ${
    google ? 'fake Google (keys made up)' : fallback ? `folder ${fallback} (no keys)` : 'nowhere to copy to (no keys, no folder)'
  }`,
)
process.on('SIGINT', () => void api.close().then(() => drive.close()).then(() => google?.close()).then(() => process.exit(0)))
