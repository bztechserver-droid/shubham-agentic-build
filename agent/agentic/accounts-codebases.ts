import { safeCodebaseRows, type CodebasesAnswer } from '../../shared/codebase-accounts.ts'
import type { NotConnected } from '../../shared/email-accounts.ts'
import { apiError } from '../api.ts'
import { BAD_WORDS, WORDS, openAccountsDb, readAccountsDb, reasonOf, type AccountsSql, type Row } from './accounts-db.ts'

// orders o0e2a, oc2db: the Accounts page's Codebases tab, read from the NEW Supabase project (schema sad, db/accounts/0004_codebases.sql). Same rules as the Email tab (accounts-email.ts): only SELECTs,
// each inside a transaction that first says who is asking (set_config app.person_id, bound), so the database's row-level security decides what that person sees; every row goes through the whitelist of
// shared/codebase-accounts.ts on the way out; the connection is opened for the call and ended after it; a failure becomes a plain reason (never the error's text) and only a code is logged.
// The tables hold no secret to read (no .env, no password), and the whitelist runs the secret guards again regardless.

export interface AccountsCodebasesOptions {
  dir: string
  open?: typeof openAccountsDb
  log?: { warn(message: string): void }
}

const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/
const notConnected = (reason: NotConnected, detail?: string): CodebasesAnswer => ({ connected: false, reason, message: detail ? `${WORDS[reason]} (${detail}.)` : WORDS[reason] })

export function createAccountsCodebases(o: AccountsCodebasesOptions) {
  const open = o.open ?? openAccountsDb
  return {
    /** The codebases `person` may see, each with its detail rows and the platform accounts connected to it. */
    async list(person: string): Promise<CodebasesAnswer> {
      const read = readAccountsDb(o.dir)
      if (!read.ok) return read.bad === null ? notConnected('not-set-up') : notConnected('not-set-up', BAD_WORDS[read.bad])
      if (!PERSON.test(person)) throw apiError(400, 'The person asking is not a valid id.')
      let sql: AccountsSql | null = null
      try {
        sql = await open(read)
        const got = await sql.begin(async tx => {
          await tx`select set_config('app.person_id', ${person}, true)`
          const cbs: Row[] = await tx`
            select id, source_id::text as source_id, name, repo_url, repo_url_hidden, local_path, description, description_hidden, stack, owner_name, service_names, has_env, env_var_count, is_disabled, source_updated_at
            from sad.account_codebase order by is_disabled, lower(name) limit 501`
          const details: Row[] = await tx`
            select d.id, d.codebase_id, d.name, d.kind, d.url, d.url_hidden, d.description, d.description_hidden, d.is_disabled, e.id as email_id, e.address as email_address
            from sad.account_codebase_detail d left join sad.account_email e on e.source_id = d.email_source_id
            where d.gone_from_source = false order by d.codebase_id, d.sort_order, d.created_at limit 8000`
          const links: Row[] = await tx`
            select p.id, p.platform, p.account_type, p.name, p.sign_in_email, p.phone, p.has_password, p.is_disabled, pc.codebase_source_id::text as codebase_source_id, pc.parts, e.id as email_id
            from sad.account_platform p join sad.account_platform_codebase pc on pc.platform_id = p.id left join sad.account_email e on e.source_id = p.email_source_id
            where pc.gone_from_source = false order by lower(p.platform), lower(coalesce(p.name, p.sign_in_email, '')) limit 8000`
          return { cbs, details, links }
        })
        const detailsBy = new Map<string, unknown[]>()
        for (const d of got.details) {
          const key = String(d.codebase_id)
          detailsBy.set(key, [
            ...(detailsBy.get(key) ?? []),
            { id: String(d.id), name: d.name, kind: d.kind, url: d.url, urlHidden: d.url_hidden === true, note: d.description, noteHidden: d.description_hidden === true, disabled: d.is_disabled === true, emailId: d.email_id === null || d.email_id === undefined ? null : String(d.email_id), emailAddress: d.email_address },
          ])
        }
        const platformsBy = new Map<string, unknown[]>()
        for (const l of got.links) {
          const key = String(l.codebase_source_id)
          platformsBy.set(key, [
            ...(platformsBy.get(key) ?? []),
            { id: String(l.id), platform: l.platform, accountType: l.account_type, name: l.name, signInEmail: l.sign_in_email, emailId: l.email_id === null || l.email_id === undefined ? null : String(l.email_id), phone: l.phone, hasPassword: l.has_password === true, disabled: l.is_disabled === true, parts: Array.isArray(l.parts) ? l.parts : [] },
          ])
        }
        const codebases = safeCodebaseRows(
          got.cbs.map(c => ({
            id: String(c.id),
            name: c.name,
            repoUrl: c.repo_url,
            repoHidden: c.repo_url_hidden === true,
            localPath: c.local_path,
            note: c.description,
            noteHidden: c.description_hidden === true,
            stack: c.stack,
            owner: c.owner_name,
            services: Array.isArray(c.service_names) ? c.service_names : [],
            hasEnv: c.has_env === true,
            envCount: Number(c.env_var_count ?? 0),
            retired: c.is_disabled === true,
            updatedAt: c.source_updated_at,
            details: detailsBy.get(String(c.id)) ?? [],
            platforms: platformsBy.get(String(c.source_id)) ?? [],
          })),
        )
        return { connected: true, codebases: codebases ?? [] }
      } catch (e) {
        const { reason, code } = reasonOf(e)
        o.log?.warn(`accounts db (codebases): ${reason} (${code})`)
        return notConnected(reason)
      } finally {
        await sql?.end({ timeout: 2 }).catch(() => {})
      }
    },
  }
}

export type AccountsCodebases = ReturnType<typeof createAccountsCodebases>
