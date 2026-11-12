import net from 'node:net'
import { apiError } from '../api.ts'
import { FIXED_DATABASES, type DatabasesAnswer, type PingResult } from '../../shared/accounts-databases.ts'
import { openAccountsDb, readAccountsDb, reasonOf, WORDS, type AccountsSql } from './accounts-db.ts'

// Accounts Databases section (order oba25). Two fixed databases; a ping checks each and says what it checked.
// - the OTHER database (the app's): a real login with the app's own login (sad_app) and "select 1". No data is read. The settings must be the fixed ones.
// - the CRM database: the app has NO login to it, and never reads the CRM backend's DATABASE_URL. A ping checks only that the pooler's TCP port answers and that the
//   project's REST endpoint answers (401 without a key means the project is up). It says "reachable (no login)".
// No password, key or connection string ever reaches a result, a log or the browser. A failure is a plain reason (a code, never the error's text).

export interface AccountsDatabasesOptions {
  dir: string
  open?: typeof openAccountsDb
  /** Tests: the TCP check and the HTTP check. */
  connect?: (host: string, port: number, timeoutMs: number) => Promise<void>
  httpGet?: (url: string, timeoutMs: number) => Promise<number>
  now?: () => number
  log?: { info?(message: string): void; warn(message: string): void }
}

const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/
const TIMEOUT_MS = 5000

const defaultConnect = (host: string, port: number, timeoutMs: number) =>
  new Promise<void>((resolve, reject) => {
    const s = net.connect({ host, port })
    const done = (ok: boolean) => {
      s.destroy()
      if (ok) resolve()
      else reject(new Error('no answer'))
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })

const defaultHttpGet = async (url: string, timeoutMs: number): Promise<number> => {
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
  await res.body?.cancel().catch(() => undefined)
  return res.status
}

export function createAccountsDatabases(o: AccountsDatabasesOptions) {
  const open = o.open ?? openAccountsDb
  const connect = o.connect ?? defaultConnect
  const httpGet = o.httpGet ?? defaultHttpGet
  const now = o.now ?? Date.now
  const last: Record<'crm' | 'other', PingResult | null> = { crm: null, other: null }

  function owner(person: string) {
    if (!PERSON.test(person)) throw apiError(400, 'The person asking is not a valid id.')
  }

  async function pingCrm(): Promise<PingResult> {
    const fixed = FIXED_DATABASES.find(d => d.key === 'crm')!
    const t0 = now()
    const at = new Date(t0).toISOString()
    try {
      await connect(fixed.host, fixed.port, TIMEOUT_MS)
    } catch {
      return { key: 'crm', state: 'down', latencyMs: now() - t0, checked: 'The pooler port (TCP).', reason: 'The pooler port does not answer.', at }
    }
    let status: number
    try {
      status = await httpGet(`https://${fixed.ref}.supabase.co/rest/v1/`, TIMEOUT_MS)
    } catch {
      return { key: 'crm', state: 'down', latencyMs: now() - t0, checked: 'The pooler port (TCP) answers; the project REST endpoint.', reason: 'The project did not answer.', at }
    }
    const up = status >= 200 && status < 500
    return {
      key: 'crm',
      state: up ? 'up' : 'down',
      latencyMs: now() - t0,
      checked: `The pooler port (TCP) answers; the project REST endpoint answers (HTTP ${status}). Reachable (no login): the app has no login to the CRM database.`,
      reason: up ? null : 'The project answered with a server error.',
      at,
    }
  }

  async function pingOther(): Promise<PingResult> {
    const fixed = FIXED_DATABASES.find(d => d.key === 'other')!
    const t0 = now()
    const at = new Date(t0).toISOString()
    const read = readAccountsDb(o.dir)
    if (!read.ok) return { key: 'other', state: 'down', latencyMs: null, checked: 'The app\'s login settings (accounts-db.json).', reason: WORDS['not-set-up'], at }
    if (read.config.host !== fixed.host || read.config.port !== fixed.port || read.config.schema !== fixed.schema) {
      return { key: 'other', state: 'down', latencyMs: null, checked: 'The app\'s login settings (accounts-db.json).', reason: 'The settings point somewhere else than this section is set up for. Nothing was tried.', at }
    }
    let sql: AccountsSql | null = null
    try {
      sql = await open(read)
      await sql.begin(async tx => {
        await tx`select 1 as ok`
      })
      return { key: 'other', state: 'up', latencyMs: now() - t0, checked: 'A real login with the app\'s own login (sad_app), then select 1. No data is read.', reason: null, at }
    } catch (e) {
      const { reason, code } = reasonOf(e)
      o.log?.warn(`accounts databases (other): ${reason} (${code})`)
      return { key: 'other', state: 'down', latencyMs: now() - t0, checked: 'A real login with the app\'s own login (sad_app), then select 1.', reason: WORDS[reason], at }
    } finally {
      await sql?.end({ timeout: 2 }).catch(() => {})
    }
  }

  return {
    list(person: string): DatabasesAnswer {
      owner(person)
      return { databases: FIXED_DATABASES, last: { ...last } }
    },
    async ping(person: string, key: unknown): Promise<PingResult> {
      owner(person)
      if (key !== 'crm' && key !== 'other') throw apiError(404, 'There is no such database here.')
      const result = key === 'crm' ? await pingCrm() : await pingOther()
      last[key] = result
      o.log?.info?.(`accounts database ping: ${key} ${result.state}${result.latencyMs !== null ? ` ${result.latencyMs} ms` : ''}`)
      return result
    },
  }
}

export type AccountsDatabases = ReturnType<typeof createAccountsDatabases>
