import { createHash } from 'node:crypto'
import type { ImportReport } from '../../shared/email-accounts.ts'
import { apiError } from '../api.ts'
import { encryptPassword, passwordMac } from './accounts-crypto.ts'
import { openAccountsDb, readAccountsDb, readAccountsKey, reasonOf, WORDS, type AccountsSql, type Row, type Tx } from './accounts-db.ts'
import { createCrmCall, isObject } from './crm-call.ts'
import type { CrmProxy } from './crmproxy.ts'

// order o5c4d: the one-way copy of the CRM's email accounts (the CRM's Emails page: address, password, recovery email, phone, note, switched off, and where each is used) into the NEW Supabase project,
// schema sad (db/accounts/README.md). It only READS the CRM (one GET of its list, through the CRM sign-in this PC already holds) and writes only to the new database, never the other way round.
//  * Idempotent and re-runnable: each row is matched by the CRM's own id (an upsert), and a row whose fingerprint has not changed is skipped, so running it twice changes nothing the second time.
//  * Resumable: every batch is its own transaction; a run that stops half way leaves the finished batches and the next run carries on (it skips what is already there).
//  * Nothing is ever deleted, on either side: a row or a use that is gone from the CRM is only FLAGGED (gone_from_source).
//  * Passwords: encrypted here (accounts-crypto.ts) with the key in accounts-db.key before they leave this function; the plain text is never logged, returned or kept; only counts are reported.
//  * "check" writes nothing at all and, when the new database is not set up yet, still tells how many the CRM has: that is how its size is learnt without touching either database.

export interface AccountsImportOptions {
  proxy: Pick<CrmProxy, 'request'>
  /** The agent's state folder (accounts-db.json, accounts-db.pass, accounts-db.key). */
  dir: string
  open?: typeof openAccountsDb
  log?: { warn(message: string): void }
}

interface CrmUse {
  sourceId: string
  usedFor: string
  description: string | null
  sortOrder: number
}
interface CrmEmail {
  sourceId: string
  address: string
  recoveryEmail: string | null
  phone: string | null
  description: string | null
  isDisabled: boolean
  createdByName: string | null
  sourceCreatedAt: string | null
  sourceUpdatedAt: string | null
  password: string | null
  uses: CrmUse[]
}

const BATCH = 25
const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const stamp = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null)

/** The CRM's list as copy rows. A row without a CRM id or a usable address is left out (counted in `skipped`). */
export function readCrmEmails(raw: unknown): { rows: CrmEmail[]; skipped: number } | null {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.emailAccounts) ? raw.emailAccounts : null
  if (!list) return null
  const rows: CrmEmail[] = []
  let skipped = 0
  for (const r of list) {
    if (!isObject(r) || typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.address !== 'string' || !r.address.trim().includes('@') || r.address.length > 200) {
      skipped++
      continue
    }
    const uses: CrmUse[] = []
    for (const [i, u] of (Array.isArray(r.uses) ? r.uses : []).entries()) {
      if (!isObject(u) || typeof u.id !== 'string' || !UUID.test(u.id) || typeof u.usedFor !== 'string' || !u.usedFor.trim()) continue
      uses.push({ sourceId: u.id, usedFor: u.usedFor.trim().slice(0, 200), description: text(u.description, 2000), sortOrder: typeof u.sortOrder === 'number' ? u.sortOrder : i })
    }
    rows.push({
      sourceId: r.id,
      address: r.address.trim(),
      recoveryEmail: text(r.recoveryEmail, 200),
      phone: text(r.phone, 60),
      description: text(r.description, 5000),
      isDisabled: r.isDisabled === true,
      createdByName: text(r.creatorName, 120) ?? text(r.creatorUsername, 120),
      sourceCreatedAt: stamp(r.createdAt),
      sourceUpdatedAt: stamp(r.updatedAt),
      password: typeof r.password === 'string' && r.password !== '' ? r.password : null,
      uses,
    })
  }
  return { rows, skipped }
}

/** The fingerprint of a copy row (everything that is copied, the password as its keyed fingerprint): equal means nothing needs writing. */
export function fingerprint(r: CrmEmail, mac: string | null): string {
  const uses = [...r.uses].sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map(u => [u.sourceId, u.usedFor, u.description, u.sortOrder])
  return createHash('sha256').update(JSON.stringify([r.address, r.recoveryEmail, r.phone, r.description, r.isDisabled, r.createdByName, r.sourceCreatedAt, r.sourceUpdatedAt, mac, uses])).digest('hex')
}

export function createAccountsImport(o: AccountsImportOptions) {
  const open = o.open ?? openAccountsDb
  const crm = createCrmCall({ proxy: o.proxy, afterServerError: 'Nothing was changed in the CRM.' })
  let running = false

  return {
    /** apply false: a check (nothing is written anywhere). apply true: the copy. `person` is the app's owner (the rows' owner). */
    async run(args: { person: string; apply: boolean }): Promise<ImportReport> {
      if (!PERSON.test(args.person)) throw apiError(400, 'The person asking is not a valid id.')
      if (running) throw apiError(409, 'A copy is already running. Wait for it to finish.')
      running = true
      let sql: AccountsSql | null = null
      try {
        const raw = await crm<unknown>('GET', 'v1/org/email-accounts?include_disabled=true')
        const parsed = readCrmEmails(raw)
        // Never echo the CRM's answer: it carries passwords.
        if (!parsed) throw apiError(502, "The CRM's answer was not a list of email accounts.")
        const { rows } = parsed
        const bytes = Buffer.byteLength(JSON.stringify(raw))
        const report: ImportReport = {
          mode: args.apply ? 'copy' : 'check',
          crm: { total: rows.length, active: rows.filter(r => !r.isDisabled).length, disabled: rows.filter(r => r.isDisabled).length, withPassword: rows.filter(r => r.password !== null).length, uses: rows.reduce((n, r) => n + r.uses.length, 0), bytes },
          plan: null,
          planNote: null,
          done: null,
        }
        const cfg = readAccountsDb(o.dir)
        if (!cfg.ok) {
          report.planNote = `${WORDS['not-set-up']}`
          if (args.apply) throw apiError(409, 'The new database is not set up yet, so nothing was copied. The CRM was only read.')
          return report
        }
        const keyRead = readAccountsKey(o.dir)
        if (!keyRead.ok) {
          report.planNote = keyRead.missing ? 'The encryption key file (accounts-db.key) is not there yet: without it passwords cannot be copied or compared.' : 'accounts-db.key is not a valid key (one line: 32 random bytes in base64).'
          if (args.apply) throw apiError(409, `${report.planNote} Nothing was copied.`)
          return report
        }
        const key = keyRead.key
        const items = rows.map(r => ({ r, mac: r.password === null ? null : passwordMac(key, r.password) })).map(x => ({ ...x, hash: fingerprint(x.r, x.mac) }))

        try {
          sql = await open(cfg)
          const existing = await sql.begin(async tx => {
            await tx`select set_config('app.person_id', ${args.person}, true)`
            const found: Row[] = await tx`select source_id::text as source_id, source_hash, gone_from_source from sad.account_email where source = 'crm'`
            return found
          })
          const have = new Map(existing.map(e => [String(e.source_id), { hash: String(e.source_hash ?? ''), gone: e.gone_from_source === true }]))
          const seen = new Set(items.map(i => i.r.sourceId))
          const toInsert = items.filter(i => !have.has(i.r.sourceId))
          const toUpdate = items.filter(i => have.has(i.r.sourceId) && have.get(i.r.sourceId)!.hash !== i.hash)
          const same = items.filter(i => have.has(i.r.sourceId) && have.get(i.r.sourceId)!.hash === i.hash)
          const missing = [...have.entries()].filter(([id, h]) => !seen.has(id) && !h.gone).map(([id]) => id)
          report.plan = { insert: toInsert.length, update: toUpdate.length, unchanged: same.length, goneFromCrm: missing.length }
          if (!args.apply) return report

          const done = { inserted: 0, updated: 0, unchanged: 0, flaggedGone: 0, batches: 0 }
          const runId = await sql.begin(async tx => {
            await tx`select set_config('app.person_id', ${args.person}, true)`
            const made: Row[] = await tx`insert into sad.account_import_run (owner_id, kind, status) values (${args.person}, 'email', 'running') returning id::text as id`
            return String(made[0]?.id)
          })
          try {
            const work = [...toInsert, ...toUpdate]
            for (let i = 0; i < work.length; i += BATCH) {
              const batch = work.slice(i, i + BATCH)
              await sql.begin(async tx => {
                await tx`select set_config('app.person_id', ${args.person}, true)`
                for (const it of batch) await writeOne(tx, args.person, key, it.r, it.mac, it.hash)
              })
              done.batches++
            }
            done.inserted = toInsert.length
            done.updated = toUpdate.length
            done.unchanged = same.length
            // Rows that are the same only get "seen again" (and un-flagged if they had been flagged): one small update each, in batches.
            for (let i = 0; i < same.length; i += BATCH) {
              await sql.begin(async tx => {
                await tx`select set_config('app.person_id', ${args.person}, true)`
                for (const it of same.slice(i, i + BATCH)) await tx`update sad.account_email set last_seen_at = now(), gone_from_source = false, gone_at = null where source = 'crm' and source_id = ${it.r.sourceId}`
              })
            }
            for (let i = 0; i < missing.length; i += BATCH) {
              await sql.begin(async tx => {
                await tx`select set_config('app.person_id', ${args.person}, true)`
                for (const id of missing.slice(i, i + BATCH)) await tx`update sad.account_email set gone_from_source = true, gone_at = now() where source = 'crm' and source_id = ${id}`
              })
            }
            done.flaggedGone = missing.length
            report.done = done
            await finishRun(sql, args.person, runId, 'done', { ...done, crm: report.crm })
            return report
          } catch (e) {
            await finishRun(sql, args.person, runId, 'failed', { ...done, crm: report.crm }).catch(() => {})
            throw e
          }
        } catch (e) {
          if (isObject(e) && typeof e.status === 'number') throw e
          const { reason, code } = reasonOf(e)
          o.log?.warn(`accounts import: ${reason} (${code})`)
          // A check still answers with what the CRM has (that is the part that did not need the new database); a copy says what failed.
          if (!args.apply) {
            report.plan = null
            report.planNote = WORDS[reason]
            return report
          }
          throw apiError(502, `${WORDS[reason]} Nothing was lost: the copy can be run again.`)
        }
      } finally {
        running = false
        await sql?.end({ timeout: 2 }).catch(() => {})
      }
    },
  }
}

async function writeOne(tx: Tx, person: string, key: Buffer, r: CrmEmail, mac: string | null, hash: string): Promise<void> {
  const enc = r.password === null ? null : encryptPassword(key, r.password)
  const saved: Row[] = await tx`
    insert into sad.account_email (owner_id, source, source_id, source_hash, address, recovery_email, phone, description, has_password, password_enc, password_mac, is_disabled, created_by_name, source_created_at, source_updated_at, last_seen_at, gone_from_source, gone_at)
    values (${person}, 'crm', ${r.sourceId}, ${hash}, ${r.address}, ${r.recoveryEmail}, ${r.phone}, ${r.description}, ${r.password !== null}, ${enc}, ${mac}, ${r.isDisabled}, ${r.createdByName}, ${r.sourceCreatedAt}, ${r.sourceUpdatedAt}, now(), false, null)
    on conflict (owner_id, source, source_id) where source_id is not null do update set
      source_hash = excluded.source_hash, address = excluded.address, recovery_email = excluded.recovery_email, phone = excluded.phone, description = excluded.description, has_password = excluded.has_password,
      password_enc = excluded.password_enc, password_mac = excluded.password_mac, is_disabled = excluded.is_disabled, created_by_name = excluded.created_by_name, source_created_at = excluded.source_created_at,
      source_updated_at = excluded.source_updated_at, last_seen_at = now(), gone_from_source = false, gone_at = null, updated_at = now()
    returning id::text as id`
  const emailId = String(saved[0]?.id)
  const present = await tx`select source_id::text as source_id from sad.account_email_use where email_id = ${emailId} and gone_from_source = false and source_id is not null`
  for (const u of r.uses) {
    await tx`
      insert into sad.account_email_use (email_id, source_id, used_for, description, sort_order, last_seen_at, gone_from_source)
      values (${emailId}, ${u.sourceId}, ${u.usedFor}, ${u.description}, ${u.sortOrder}, now(), false)
      on conflict (email_id, source_id) where source_id is not null do update set used_for = excluded.used_for, description = excluded.description, sort_order = excluded.sort_order, last_seen_at = now(), gone_from_source = false`
  }
  const keep = new Set(r.uses.map(u => u.sourceId))
  for (const p of present) if (!keep.has(String(p.source_id))) await tx`update sad.account_email_use set gone_from_source = true where email_id = ${emailId} and source_id = ${String(p.source_id)}`
}

async function finishRun(sql: AccountsSql, person: string, runId: string, status: 'done' | 'failed', counts: Record<string, unknown>): Promise<void> {
  await sql.begin(async tx => {
    await tx`select set_config('app.person_id', ${person}, true)`
    await tx`update sad.account_import_run set status = ${status}, finished_at = now(), counts = ${JSON.stringify(counts)}::jsonb where id = ${runId}::uuid`
  })
}

export type AccountsImport = ReturnType<typeof createAccountsImport>
