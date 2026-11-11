import { createHash } from 'node:crypto'
import { DETAIL_KINDS, countEnvVars, safeText, safeUrl, type CodebaseImportReport, type CopyPlan, type DetailKind } from '../../shared/codebase-accounts.ts'
import { apiError } from '../api.ts'
import { WORDS, openAccountsDb, readAccountsDb, reasonOf, type AccountsSql, type Row, type Tx } from './accounts-db.ts'
import { createCrmCall, isObject } from './crm-call.ts'
import type { CrmProxy } from './crmproxy.ts'

// orders o0e2a, oc2db: the one-way copy of the CRM's Codebases (name, repository, stack, owner, products, the detail rows) and of the CRM's platform accounts (Code > Accounts: Vercel, Supabase, GitHub...
// and which codebases each is connected to) into the NEW Supabase project, schema sad (db/accounts/0004_codebases.sql). Same shape and rules as the email copy (accounts-import.ts):
//  * It only READS the CRM (two GETs, through the CRM sign-in this PC already holds) and writes only to the new database.
//  * NO SECRET IS EVER COPIED, because the tables have no place for one: the .env is reduced to "there is one" and a COUNT of its NAME=value lines; a platform account's password to "there is one"; a link,
//    repository address or note that looks like it holds a secret (a login or token in the address, a connection string, "password: ...") is not kept, only flagged hidden. The CRM's answer is never
//    logged or returned: the report holds counts only.
//  * Idempotent, resumable (one transaction per codebase / platform account), no deletes: what is gone from the CRM is only flagged (gone_from_source).
//  * "check" writes nothing and still says how many the CRM has when the new database is not reachable.

export interface CodebaseImportOptions {
  proxy: Pick<CrmProxy, 'request'>
  dir: string
  open?: typeof openAccountsDb
  log?: { warn(message: string): void }
}

interface CopyDetail {
  sourceId: string
  name: string
  kind: DetailKind | null
  url: string | null
  urlHidden: boolean
  description: string | null
  descriptionHidden: boolean
  emailSourceId: string | null
  sortOrder: number
  isDisabled: boolean
}
export interface CopyCodebase {
  sourceId: string
  name: string
  repoUrl: string | null
  repoUrlHidden: boolean
  localPath: string | null
  description: string | null
  descriptionHidden: boolean
  stack: string | null
  ownerName: string | null
  serviceNames: string[]
  hasEnv: boolean
  envVarCount: number
  isDisabled: boolean
  sourceCreatedAt: string | null
  sourceUpdatedAt: string | null
  details: CopyDetail[]
}
interface CopyLink {
  codebaseSourceId: string
  parts: ('be' | 'fe')[]
}
export interface CopyPlatform {
  sourceId: string
  platform: string
  accountType: string | null
  name: string | null
  signInEmail: string | null
  emailSourceId: string | null
  phone: string | null
  contactName: string | null
  /** order o4029 (0005): the type is switched off on the CRM; the phone is linked to a contact; that contact is switched off. */
  accountTypeDisabled: boolean
  contactLinked: boolean
  contactDisabled: boolean
  hasPassword: boolean
  isDisabled: boolean
  sourceCreatedAt: string | null
  sourceUpdatedAt: string | null
  links: CopyLink[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/
const BATCH = 10
/** A list of words goes to the database as one text joined by this character (chr(31), which no name contains) and is split there by string_to_array: no array or JSON typing is left to the driver. An empty list is an empty text, which splits to an empty array. */
const SEP = String.fromCharCode(31)

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const stamp = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null)
const uuidOr = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null)

/** The CRM's codebase list as copy rows. A row without a CRM id or a name is left out (counted in `skipped`). The .env text goes in and only its count comes out. */
export function readCrmCodebases(raw: unknown): { rows: CopyCodebase[]; skipped: number; hidden: number } | null {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.codebases) ? raw.codebases : null
  if (!list) return null
  const rows: CopyCodebase[] = []
  let skipped = 0
  let hidden = 0
  for (const r of list) {
    const id = isObject(r) ? uuidOr(r.id) : null
    const name = isObject(r) ? text(r.name, 200) : null
    if (!isObject(r) || !id || !name) {
      skipped++
      continue
    }
    const repo = safeUrl(r.repoUrl)
    const desc = safeText(r.description)
    const details: CopyDetail[] = []
    for (const [i, d] of (Array.isArray(r.details) ? r.details : []).entries()) {
      const did = isObject(d) ? uuidOr(d.id) : null
      const dname = isObject(d) ? text(d.name, 200) : null
      if (!isObject(d) || !did || !dname) continue
      const url = safeUrl(d.url)
      const ddesc = safeText(d.description)
      if (url.hidden) hidden++
      if (ddesc.hidden) hidden++
      details.push({
        sourceId: did,
        name: dname,
        kind: DETAIL_KINDS.includes(d.kind as DetailKind) ? (d.kind as DetailKind) : null,
        url: url.url,
        urlHidden: url.hidden,
        description: ddesc.text,
        descriptionHidden: ddesc.hidden,
        emailSourceId: uuidOr(d.emailAccountId),
        sortOrder: typeof d.sortOrder === 'number' && Number.isFinite(d.sortOrder) ? Math.trunc(d.sortOrder) : i,
        isDisabled: d.isDisabled === true,
      })
    }
    if (repo.hidden) hidden++
    if (desc.hidden) hidden++
    const env = typeof r.envContent === 'string' ? r.envContent : ''
    const envVarCount = countEnvVars(env)
    rows.push({
      sourceId: id,
      name,
      repoUrl: repo.url,
      repoUrlHidden: repo.hidden,
      localPath: text(r.localPath, 500),
      description: desc.text,
      descriptionHidden: desc.hidden,
      stack: text(r.stack, 500),
      ownerName: text(r.ownerName, 200) ?? text(r.ownerUsername, 200),
      serviceNames: (Array.isArray(r.services) ? r.services : []).map(s => (isObject(s) ? text(s.name, 200) : null)).filter((s): s is string => s !== null).slice(0, 20),
      // "there is one" = any text at all (even with no NAME=value lines, it may hold something): only the flag and the count are kept.
      hasEnv: env.trim() !== '',
      envVarCount,
      isDisabled: r.isDisabled === true,
      sourceCreatedAt: stamp(r.createdAt),
      sourceUpdatedAt: stamp(r.updatedAt),
      details,
    })
  }
  return { rows, skipped, hidden }
}

/** The CRM's platform accounts as copy rows. The password goes in as "is there one" and is dropped on the spot. */
export function readCrmPlatforms(raw: unknown): { rows: CopyPlatform[]; skipped: number } | null {
  const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.vercelAccounts) ? raw.vercelAccounts : null
  if (!list) return null
  const rows: CopyPlatform[] = []
  let skipped = 0
  for (const r of list) {
    const id = isObject(r) ? uuidOr(r.id) : null
    const platform = isObject(r) ? text(r.platform, 80) : null
    if (!isObject(r) || !id || !platform) {
      skipped++
      continue
    }
    const links: CopyLink[] = []
    for (const c of Array.isArray(r.codebases) ? r.codebases : []) {
      const cid = isObject(c) ? uuidOr(c.id) : null
      if (!isObject(c) || !cid) continue
      links.push({ codebaseSourceId: cid, parts: (Array.isArray(c.parts) ? c.parts : []).filter((p): p is 'be' | 'fe' => p === 'be' || p === 'fe') })
    }
    rows.push({
      sourceId: id,
      platform,
      accountType: text(r.accountTypeName, 80),
      name: text(r.name, 200),
      signInEmail: text(r.email, 200),
      emailSourceId: uuidOr(r.emailAccountId),
      phone: text(r.phone, 60),
      contactName: text(r.contactName, 200),
      accountTypeDisabled: r.accountTypeDisabled === true,
      contactLinked: typeof r.contactId === 'string' && r.contactId !== '',
      contactDisabled: r.contactDisabled === true,
      hasPassword: typeof r.password === 'string' && r.password !== '',
      isDisabled: r.isDisabled === true,
      sourceCreatedAt: stamp(r.createdAt),
      sourceUpdatedAt: stamp(r.updatedAt),
      links,
    })
  }
  return { rows, skipped }
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

/** The fingerprint of a copy row (everything that is copied): equal means nothing needs writing. */
export function codebaseFingerprint(c: CopyCodebase): string {
  const details = [...c.details].sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  return sha([c.name, c.repoUrl, c.repoUrlHidden, c.localPath, c.description, c.descriptionHidden, c.stack, c.ownerName, c.serviceNames, c.hasEnv, c.envVarCount, c.isDisabled, c.sourceCreatedAt, c.sourceUpdatedAt, details])
}
export function platformFingerprint(p: CopyPlatform): string {
  const links = [...p.links].sort((a, b) => a.codebaseSourceId.localeCompare(b.codebaseSourceId))
  return sha([p.platform, p.accountType, p.name, p.signInEmail, p.emailSourceId, p.phone, p.contactName, p.accountTypeDisabled, p.contactLinked, p.contactDisabled, p.hasPassword, p.isDisabled, p.sourceCreatedAt, p.sourceUpdatedAt, links])
}


function plan<T extends { id: string; hash: string }>(items: T[], have: Map<string, { hash: string; gone: boolean }>) {
  const seen = new Set(items.map(i => i.id))
  const toInsert = items.filter(i => !have.has(i.id))
  const toUpdate = items.filter(i => have.has(i.id) && have.get(i.id)!.hash !== i.hash)
  const same = items.filter(i => have.has(i.id) && have.get(i.id)!.hash === i.hash)
  const missing = [...have.entries()].filter(([id, h]) => !seen.has(id) && !h.gone).map(([id]) => id)
  const p: CopyPlan = { insert: toInsert.length, update: toUpdate.length, unchanged: same.length, goneFromCrm: missing.length }
  return { p, toInsert, toUpdate, same, missing }
}

export function createCodebaseImport(o: CodebaseImportOptions) {
  const open = o.open ?? openAccountsDb
  const crm = createCrmCall({ proxy: o.proxy, afterServerError: 'Nothing was changed in the CRM.' })
  let running = false

  return {
    /** apply false: a check (nothing is written anywhere). apply true: the copy. `person` is the app's owner (the rows' owner). */
    async run(args: { person: string; apply: boolean }): Promise<CodebaseImportReport> {
      if (!PERSON.test(args.person)) throw apiError(400, 'The person asking is not a valid id.')
      if (running) throw apiError(409, 'A copy is already running. Wait for it to finish.')
      running = true
      let sql: AccountsSql | null = null
      try {
        const rawCb = await crm<unknown>('GET', 'v1/org/codebases?include_disabled=true')
        const rawPl = await crm<unknown>('GET', 'v1/org/vercel-accounts')
        const cbs = readCrmCodebases(rawCb)
        const pls = readCrmPlatforms(rawPl)
        // Never echo the CRM's answer: it carries .env files and passwords.
        if (!cbs) throw apiError(502, "The CRM's answer was not a list of codebases.")
        if (!pls) throw apiError(502, "The CRM's answer was not a list of platform accounts.")
        const bytes = Buffer.byteLength(JSON.stringify(rawCb)) + Buffer.byteLength(JSON.stringify(rawPl))
        const report: CodebaseImportReport = {
          mode: args.apply ? 'copy' : 'check',
          crm: {
            codebases: cbs.rows.length,
            live: cbs.rows.filter(r => !r.isDisabled).length,
            retired: cbs.rows.filter(r => r.isDisabled).length,
            withEnv: cbs.rows.filter(r => r.hasEnv).length,
            envVars: cbs.rows.reduce((n, r) => n + r.envVarCount, 0),
            details: cbs.rows.reduce((n, r) => n + r.details.length, 0),
            platforms: pls.rows.length,
            links: pls.rows.reduce((n, p) => n + p.links.length, 0),
            hiddenValues: cbs.hidden,
            bytes,
          },
          plan: null,
          planNote: null,
          done: null,
        }
        const cfg = readAccountsDb(o.dir)
        if (!cfg.ok) {
          report.planNote = WORDS['not-set-up']
          if (args.apply) throw apiError(409, 'The new database is not set up yet, so nothing was copied. The CRM was only read.')
          return report
        }

        const cItems = cbs.rows.map(c => ({ c, id: c.sourceId, hash: codebaseFingerprint(c) }))
        const pItems = pls.rows.map(p => ({ p, id: p.sourceId, hash: platformFingerprint(p) }))
        try {
          sql = await open(cfg)
          const existing = await sql.begin(async tx => {
            await tx`select set_config('app.person_id', ${args.person}, true)`
            const a: Row[] = await tx`select source_id::text as source_id, source_hash, gone_from_source from sad.account_codebase where source = 'crm'`
            const b: Row[] = await tx`select source_id::text as source_id, source_hash, gone_from_source from sad.account_platform where source = 'crm'`
            return { a, b }
          })
          const haveOf = (rows: Row[]) => new Map(rows.map(e => [String(e.source_id), { hash: String(e.source_hash ?? ''), gone: e.gone_from_source === true }]))
          const cPlan = plan(cItems, haveOf(existing.a))
          const pPlan = plan(pItems, haveOf(existing.b))
          report.plan = { codebases: cPlan.p, platforms: pPlan.p }
          if (!args.apply) return report

          const done = { codebases: { inserted: 0, updated: 0, unchanged: 0, flaggedGone: 0 }, platforms: { inserted: 0, updated: 0, unchanged: 0, flaggedGone: 0 }, batches: 0 }
          const runId = await sql.begin(async tx => {
            await tx`select set_config('app.person_id', ${args.person}, true)`
            const made: Row[] = await tx`insert into sad.account_import_run (owner_id, kind, status) values (${args.person}, 'codebase', 'running') returning id::text as id`
            return String(made[0]?.id)
          })
          try {
            // Codebases first (a platform account's links name them by their CRM id: they need not exist yet, but this is the order a reader expects).
            const cWork = [...cPlan.toInsert, ...cPlan.toUpdate]
            for (let i = 0; i < cWork.length; i += BATCH) {
              await sql.begin(async tx => {
                await tx`select set_config('app.person_id', ${args.person}, true)`
                for (const it of cWork.slice(i, i + BATCH)) await writeCodebase(tx, args.person, it.c, it.hash)
              })
              done.batches++
            }
            const pWork = [...pPlan.toInsert, ...pPlan.toUpdate]
            for (let i = 0; i < pWork.length; i += BATCH) {
              await sql.begin(async tx => {
                await tx`select set_config('app.person_id', ${args.person}, true)`
                for (const it of pWork.slice(i, i + BATCH)) await writePlatform(tx, args.person, it.p, it.hash)
              })
              done.batches++
            }
            done.codebases = { inserted: cPlan.p.insert, updated: cPlan.p.update, unchanged: cPlan.p.unchanged, flaggedGone: cPlan.p.goneFromCrm }
            done.platforms = { inserted: pPlan.p.insert, updated: pPlan.p.update, unchanged: pPlan.p.unchanged, flaggedGone: pPlan.p.goneFromCrm }
            // Rows that are the same are only "seen again" (and un-flagged if they were flagged); rows gone from the CRM are only flagged.
            await sql.begin(async tx => {
              await tx`select set_config('app.person_id', ${args.person}, true)`
              for (const it of cPlan.same) await tx`update sad.account_codebase set last_seen_at = now(), gone_from_source = false, gone_at = null where source = 'crm' and source_id = ${it.id}`
              for (const it of pPlan.same) await tx`update sad.account_platform set last_seen_at = now(), gone_from_source = false, gone_at = null where source = 'crm' and source_id = ${it.id}`
              for (const id of cPlan.missing) await tx`update sad.account_codebase set gone_from_source = true, gone_at = now() where source = 'crm' and source_id = ${id}`
              for (const id of pPlan.missing) await tx`update sad.account_platform set gone_from_source = true, gone_at = now() where source = 'crm' and source_id = ${id}`
            })
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
          o.log?.warn(`accounts codebase import: ${reason} (${code})`)
          if (args.apply && code === '42501') throw apiError(409, 'The database refused a write (42501): either db/accounts/0004_codebases.sql has not been run yet, or a row broke the database rules. What was copied before stays; the copy can be run again.')
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

async function writeCodebase(tx: Tx, person: string, c: CopyCodebase, hash: string): Promise<void> {
  // UPDATE first, then INSERT when there was nothing to update (the same order as the email copy: no "on conflict ... excluded" tricks that need extra rights).
  const changed: Row[] = await tx`
    update sad.account_codebase set source_hash = ${hash}, name = ${c.name}, repo_url = ${c.repoUrl}, repo_url_hidden = ${c.repoUrlHidden}, local_path = ${c.localPath}, description = ${c.description},
      description_hidden = ${c.descriptionHidden}, stack = ${c.stack}, owner_name = ${c.ownerName}, service_names = string_to_array(${c.serviceNames.join(SEP)}, chr(31)), has_env = ${c.hasEnv}, env_var_count = ${c.envVarCount},
      is_disabled = ${c.isDisabled}, source_created_at = ${c.sourceCreatedAt}, source_updated_at = ${c.sourceUpdatedAt}, last_seen_at = now(), gone_from_source = false, gone_at = null, updated_at = now()
    where owner_id = ${person} and source = 'crm' and source_id = ${c.sourceId}
    returning id::text as id`
  const saved: Row[] =
    changed.length > 0
      ? changed
      : await tx`
    insert into sad.account_codebase (owner_id, source, source_id, source_hash, name, repo_url, repo_url_hidden, local_path, description, description_hidden, stack, owner_name, service_names, has_env, env_var_count,
      is_disabled, source_created_at, source_updated_at, last_seen_at, gone_from_source, gone_at)
    values (${person}, 'crm', ${c.sourceId}, ${hash}, ${c.name}, ${c.repoUrl}, ${c.repoUrlHidden}, ${c.localPath}, ${c.description}, ${c.descriptionHidden}, ${c.stack}, ${c.ownerName}, string_to_array(${c.serviceNames.join(SEP)}, chr(31)), ${c.hasEnv},
      ${c.envVarCount}, ${c.isDisabled}, ${c.sourceCreatedAt}, ${c.sourceUpdatedAt}, now(), false, null)
    returning id::text as id`
  const cid = String(saved[0]?.id)
  const present: Row[] = await tx`select source_id::text as source_id from sad.account_codebase_detail where codebase_id = ${cid} and gone_from_source = false and source_id is not null`
  for (const d of c.details) {
    const upd: Row[] = await tx`
      update sad.account_codebase_detail set name = ${d.name}, kind = ${d.kind}, url = ${d.url}, url_hidden = ${d.urlHidden}, description = ${d.description}, description_hidden = ${d.descriptionHidden},
        email_source_id = ${d.emailSourceId}, sort_order = ${d.sortOrder}, is_disabled = ${d.isDisabled}, last_seen_at = now(), gone_from_source = false
      where codebase_id = ${cid} and source_id = ${d.sourceId}
      returning id::text as id`
    if (upd.length === 0) {
      await tx`
        insert into sad.account_codebase_detail (codebase_id, source_id, name, kind, url, url_hidden, description, description_hidden, email_source_id, sort_order, is_disabled, last_seen_at, gone_from_source)
        values (${cid}, ${d.sourceId}, ${d.name}, ${d.kind}, ${d.url}, ${d.urlHidden}, ${d.description}, ${d.descriptionHidden}, ${d.emailSourceId}, ${d.sortOrder}, ${d.isDisabled}, now(), false)`
    }
  }
  const keep = new Set(c.details.map(d => d.sourceId))
  for (const p of present) if (!keep.has(String(p.source_id))) await tx`update sad.account_codebase_detail set gone_from_source = true where codebase_id = ${cid} and source_id = ${String(p.source_id)}`
}

async function writePlatform(tx: Tx, person: string, p: CopyPlatform, hash: string): Promise<void> {
  const changed: Row[] = await tx`
    update sad.account_platform set source_hash = ${hash}, platform = ${p.platform}, account_type = ${p.accountType}, name = ${p.name}, sign_in_email = ${p.signInEmail}, email_source_id = ${p.emailSourceId},
      phone = ${p.phone}, contact_name = ${p.contactName}, account_type_disabled = ${p.accountTypeDisabled}, contact_linked = ${p.contactLinked}, contact_disabled = ${p.contactDisabled}, has_password = ${p.hasPassword}, is_disabled = ${p.isDisabled}, source_created_at = ${p.sourceCreatedAt}, source_updated_at = ${p.sourceUpdatedAt},
      last_seen_at = now(), gone_from_source = false, gone_at = null, updated_at = now()
    where owner_id = ${person} and source = 'crm' and source_id = ${p.sourceId}
    returning id::text as id`
  const saved: Row[] =
    changed.length > 0
      ? changed
      : await tx`
    insert into sad.account_platform (owner_id, source, source_id, source_hash, platform, account_type, name, sign_in_email, email_source_id, phone, contact_name, account_type_disabled, contact_linked, contact_disabled, has_password, is_disabled,
      source_created_at, source_updated_at, last_seen_at, gone_from_source, gone_at)
    values (${person}, 'crm', ${p.sourceId}, ${hash}, ${p.platform}, ${p.accountType}, ${p.name}, ${p.signInEmail}, ${p.emailSourceId}, ${p.phone}, ${p.contactName}, ${p.accountTypeDisabled}, ${p.contactLinked}, ${p.contactDisabled}, ${p.hasPassword}, ${p.isDisabled},
      ${p.sourceCreatedAt}, ${p.sourceUpdatedAt}, now(), false, null)
    returning id::text as id`
  const pid = String(saved[0]?.id)
  const present: Row[] = await tx`select codebase_source_id::text as codebase_source_id from sad.account_platform_codebase where platform_id = ${pid} and gone_from_source = false`
  for (const l of p.links) {
    const upd: Row[] = await tx`
      update sad.account_platform_codebase set parts = string_to_array(${l.parts.join(SEP)}, chr(31)), last_seen_at = now(), gone_from_source = false
      where platform_id = ${pid} and codebase_source_id = ${l.codebaseSourceId}
      returning id::text as id`
    if (upd.length === 0) await tx`insert into sad.account_platform_codebase (platform_id, codebase_source_id, parts, last_seen_at, gone_from_source) values (${pid}, ${l.codebaseSourceId}, string_to_array(${l.parts.join(SEP)}, chr(31)), now(), false)`
  }
  const keep = new Set(p.links.map(l => l.codebaseSourceId))
  for (const r of present) if (!keep.has(String(r.codebase_source_id))) await tx`update sad.account_platform_codebase set gone_from_source = true where platform_id = ${pid} and codebase_source_id = ${String(r.codebase_source_id)}`
}

async function finishRun(sql: AccountsSql, person: string, runId: string, status: 'done' | 'failed', counts: Record<string, unknown>): Promise<void> {
  await sql.begin(async tx => {
    await tx`select set_config('app.person_id', ${person}, true)`
    await tx`update sad.account_import_run set status = ${status}, finished_at = now(), counts = ${JSON.stringify(counts)}::jsonb where id = ${runId}::uuid`
  })
}

export type CodebaseImport = ReturnType<typeof createCodebaseImport>
