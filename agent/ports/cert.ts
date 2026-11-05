import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import type { Runner } from '../drive/tailscale.ts'

// F-114: this PC's real certificate for its tailnet name, so the Ports gate can answer https itself (and plain http on the same port).
//  - Fetched with `tailscale cert` ONLY when it is missing, is for another name, or runs out within 21 days; never in a loop (Let's Encrypt has limits):
//    after a failure the next try waits 10 minutes, then 20, 40 ... up to a day, and that wait survives an agent restart.
//  - The key stays in the agent's own folder (<state>/agent/ports/cert/). It is NEVER printed, logged, put in git or in any state: only the expiry date and a plain sentence leave this file.

export interface CertInfo {
  /** 'ready': a valid certificate is loaded; 'getting': being fetched; 'none': there is none (yet). */
  state: 'ready' | 'getting' | 'none'
  expires: string | null
  detail: string | null
}

export interface Cert {
  /** The TLS context for the gate, or null when there is no valid certificate. */
  context(): tls.SecureContext | null
  info(): CertInfo
  /** Make sure there is a good certificate for `name` (a no-op when there is one, or when the wait after a failure has not passed). Never throws. */
  ensure(name: string): Promise<void>
}

const RENEW_BEFORE_MS = 21 * 24 * 3600_000
const FIRST_WAIT_MS = 10 * 60_000
const MAX_WAIT_MS = 24 * 3600_000

interface Meta {
  name?: string
  lastTry?: number
  failures?: number
}

export function createCert(o: { dir: string; run: Runner; now?: () => number; onChange?: () => void; warn?: (line: string) => void }): Cert {
  const now = o.now ?? Date.now
  const certFile = path.join(o.dir, 'cert.pem')
  const keyFile = path.join(o.dir, 'key.pem')
  const metaFile = path.join(o.dir, 'cert.json')
  let ctx: tls.SecureContext | null = null
  let loadedFor: string | null = null
  let expires: number | null = null
  let state: CertInfo['state'] = 'none'
  let detail: string | null = null
  let busy: Promise<void> | null = null

  const readMeta = (): Meta => {
    try {
      return JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Meta
    } catch {
      return {}
    }
  }
  const writeMeta = (m: Meta) => {
    try {
      fs.mkdirSync(o.dir, { recursive: true })
      fs.writeFileSync(metaFile, JSON.stringify(m))
    } catch {
      // the wait after a failure is then only remembered in memory
    }
  }

  /** Load the files from disk; true when they hold a certificate for `name` that is valid now. */
  function load(name: string): boolean {
    try {
      const cert = fs.readFileSync(certFile)
      const key = fs.readFileSync(keyFile)
      const x = new X509Certificate(cert)
      const until = Date.parse(x.validTo)
      const names = x.subjectAltName ?? ''
      if (!(until > now()) || !names.toLowerCase().split(',').some(s => s.trim() === `dns:${name}`)) return false
      ctx = tls.createSecureContext({ cert, key })
      loadedFor = name
      expires = until
      state = 'ready'
      detail = null
      return true
    } catch {
      return false
    }
  }

  async function fetchIt(name: string) {
    state = 'getting'
    o.onChange?.()
    const meta = readMeta()
    const failures = meta.name === name ? (meta.failures ?? 0) : 0
    fs.mkdirSync(o.dir, { recursive: true })
    writeMeta({ name, lastTry: now(), failures })
    const r = await o.run(['cert', '--cert-file', certFile, '--key-file', keyFile, name]).catch(e => ({ code: 1, stdout: '', stderr: String(e instanceof Error ? e.message : e) }))
    if (r.code === 0 && load(name)) {
      writeMeta({ name, lastTry: now(), failures: 0 })
      o.warn?.(`the certificate for ${name} is ready, valid until ${new Date(expires as number).toISOString().slice(0, 10)}`)
    } else {
      state = ctx && expires !== null && expires > now() ? 'ready' : 'none'
      // Tailscale's own words, short; the files are never part of it.
      const why = (r.stderr || r.stdout || 'no answer').trim().split(/\r?\n/)[0].slice(0, 160)
      detail = r.code === 0 ? 'Tailscale wrote the certificate but it could not be read' : `Tailscale would not give a certificate: ${why}`
      writeMeta({ name, lastTry: now(), failures: failures + 1 })
      o.warn?.(detail)
    }
    o.onChange?.()
  }

  return {
    context: () => (ctx && expires !== null && expires > now() ? ctx : null),
    info: () => ({ state, expires: expires !== null && state === 'ready' ? new Date(expires).toISOString() : null, detail }),
    ensure(name) {
      if (busy) return busy
      const good = loadedFor === name && expires !== null && expires - now() > RENEW_BEFORE_MS
      if (good) return Promise.resolve()
      // The files may already hold one (a restart): use it and renew only when it is close to running out.
      if (loadedFor !== name && load(name) && (expires as number) - now() > RENEW_BEFORE_MS) {
        o.onChange?.()
        return Promise.resolve()
      }
      const meta = readMeta()
      const failures = meta.name === name ? (meta.failures ?? 0) : 0
      const wait = failures === 0 ? 0 : Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (failures - 1))
      if (meta.name === name && meta.lastTry !== undefined && now() - meta.lastTry < wait) {
        if (!detail && state !== 'ready') detail = 'Waiting a while before asking Tailscale for the certificate again'
        return Promise.resolve()
      }
      busy = fetchIt(name)
        .catch(() => undefined)
        .finally(() => {
          busy = null
        })
      return busy
    },
  }
}
