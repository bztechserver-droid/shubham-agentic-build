import { apiError } from '../api.ts'
import { checkPlatformEdit, type PlatformEditInput } from '../../shared/platform-edit.ts'
import { checkPlatformAdd, type PlatformAddInput } from '../../shared/platform-add.ts'
import { openAccountsDb, readAccountsDb, reasonOf, WORDS, type AccountsSql, type Row, type Tx } from './accounts-db.ts'

// Accounts edit slice (Shubham's o45c0 rule): the platform accounts (the CRM's Accounts page) can be EDITED and soft-DELETED in the app, in the new database (sad) only.
// Every app edit or delete sets app_touched_at; the copy job then leaves the row alone (accounts-codebase-import.ts). A copied row is editable here: the CRM is never written.
// No password here: the app keeps only whether a platform account has one (has_password), never the password.

export interface AccountsPlatformWriteOptions {
  dir: string
  open?: typeof openAccountsDb
  log?: { warn(message: string): void }
}

const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/
const UUID = /^[0-9a-f-]{36}$/i
const NO_ROW = 'That account is not there any more (it may have been deleted).'

function need<T>(c: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!c.ok) throw apiError(400, c.message)
  return c.value
}

export function createAccountsPlatformWrite(o: AccountsPlatformWriteOptions) {
  const open = o.open ?? openAccountsDb

  async function run<T>(person: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const read = readAccountsDb(o.dir)
    if (!read.ok) throw apiError(503, WORDS['not-set-up'])
    if (!PERSON.test(person)) throw apiError(400, 'The person asking is not a valid id.')
    let sql: AccountsSql | null = null
    try {
      sql = await open(read)
      return await sql.begin(async tx => {
        await tx`select set_config('app.person_id', ${person}, true)`
        return fn(tx)
      })
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'status' in e) throw e
      const { reason, code } = reasonOf(e)
      o.log?.warn(`accounts db (platform write): ${reason} (${code})`)
      throw apiError(503, WORDS[reason])
    } finally {
      await sql?.end({ timeout: 2 }).catch(() => {})
    }
  }

  async function liveOrNotFound(tx: Tx, id: string): Promise<void> {
    const rows: Row[] = await tx`select id from sad.account_platform where id = ${id} and deleted_at is null`
    if (rows.length === 0) throw apiError(404, NO_ROW)
  }

  return {
    /** Add account (order oc35dc): a platform account made in the app (source 'app'), with the codebases it is connected to. Nothing is written to the CRM. */
    async create(person: string, raw: unknown): Promise<{ id: string }> {
      const v: PlatformAddInput = need(checkPlatformAdd(raw))
      return run(person, async tx => {
        // Each codebase must be the owner's own, live codebase (the read rule of 0004 limits the rows; a missing one is refused, not skipped).
        const found: Row[] = v.codebases.length
          ? await tx`select id::text as id, source_id::text as source_id from sad.account_codebase where id = any(${v.codebases}::uuid[]) and deleted_at is null`
          : []
        if (found.length !== v.codebases.length) throw apiError(400, 'One of the codebases is not there any more. Choose the codebases again.')
        const made: Row[] = await tx`insert into sad.account_platform (owner_id, source, platform, account_type, name, sign_in_email, phone, contact_name, has_password, is_disabled, note, app_touched_at)
          values (${person}, 'app', ${v.platform}, ${v.accountType}, ${v.name}, ${v.signInEmail}, ${v.phone}, ${v.contactName}, false, ${v.disabled}, ${v.note}, now())
          returning id::text as id`
        const platformId = String(made[0]?.id)
        // A copied codebase is linked by its CRM id (source_id); an app-made one by its own id (source_id is empty for it).
        for (const cb of found) {
          await tx`insert into sad.account_platform_codebase (platform_id, codebase_source_id, parts) values (${platformId}, ${cb.source_id ?? cb.id}, '{}')`
        }
        return { id: platformId }
      })
    },

    async update(person: string, id: string, raw: unknown): Promise<{ ok: true }> {
      if (!UUID.test(id)) throw apiError(400, 'That account id is not valid.')
      const v: PlatformEditInput = need(checkPlatformEdit(raw))
      return run(person, async tx => {
        await liveOrNotFound(tx, id)
        await tx`update sad.account_platform set platform = ${v.platform}, account_type = ${v.accountType}, name = ${v.name}, sign_in_email = ${v.signInEmail}, phone = ${v.phone}, is_disabled = ${v.disabled}, app_touched_at = now(), updated_at = now()
          where id = ${id} and deleted_at is null`
        return { ok: true as const }
      })
    },

    /** Soft delete: deleted_at is set and the row leaves the list; nothing is removed. The copy job leaves it alone. */
    async remove(person: string, id: string): Promise<{ ok: true }> {
      if (!UUID.test(id)) throw apiError(400, 'That account id is not valid.')
      return run(person, async tx => {
        await liveOrNotFound(tx, id)
        await tx`update sad.account_platform set deleted_at = now(), app_touched_at = now(), updated_at = now() where id = ${id} and deleted_at is null`
        return { ok: true as const }
      })
    },
  }
}

export type AccountsPlatformWrite = ReturnType<typeof createAccountsPlatformWrite>
