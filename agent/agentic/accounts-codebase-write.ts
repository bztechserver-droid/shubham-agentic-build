import { apiError } from '../api.ts'
import { checkCodebaseEdit, type CodebaseEditInput } from '../../shared/codebase-edit.ts'
import { openAccountsDb, readAccountsDb, reasonOf, WORDS, type AccountsSql, type Row, type Tx } from './accounts-db.ts'

// Codebase details slice (Shubham's o45c0 rule): a codebase's details can be EDITED in the app, in the new database (sad) only; the CRM is never written.
// Every app edit sets app_touched_at; the copy job then leaves the codebase, its detail rows and its links alone (accounts-codebase-import.ts).
// A codebase's environment variables and its BE/FE/deployment/database notes are not here: they have their own tables (0006).

export interface AccountsCodebaseWriteOptions {
  dir: string
  open?: typeof openAccountsDb
  log?: { warn(message: string): void }
}

const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/
const UUID = /^[0-9a-f-]{36}$/i
const NO_ROW = 'That codebase is not there any more.'

function need<T>(c: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!c.ok) throw apiError(400, c.message)
  return c.value
}

export function createAccountsCodebaseWrite(o: AccountsCodebaseWriteOptions) {
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
      o.log?.warn(`accounts db (codebase write): ${reason} (${code})`)
      throw apiError(503, WORDS[reason])
    } finally {
      await sql?.end({ timeout: 2 }).catch(() => {})
    }
  }

  return {
    async update(person: string, id: string, raw: unknown): Promise<{ ok: true }> {
      if (!UUID.test(id)) throw apiError(400, 'That codebase id is not valid.')
      const v: CodebaseEditInput = need(checkCodebaseEdit(raw))
      return run(person, async tx => {
        const rows: Row[] = await tx`select id from sad.account_codebase where id = ${id}`
        if (rows.length === 0) throw apiError(404, NO_ROW)
        // A value the app writes is the app's own: its "hidden" flags are cleared (the text is shown).
        // A hidden address or description that was not retyped is kept as it is (the CASE leaves its column and its hidden flag alone).
        await tx`update sad.account_codebase set name = ${v.name}, repo_url = case when ${v.keepRepo} then repo_url else ${v.repoUrl} end, repo_url_hidden = case when ${v.keepRepo} then repo_url_hidden else false end,
          local_path = ${v.localPath}, description = case when ${v.keepDescription} then description else ${v.description} end, description_hidden = case when ${v.keepDescription} then description_hidden else false end,
          stack = ${v.stack}, owner_name = ${v.ownerName}, is_disabled = ${v.retired}, app_touched_at = now(), updated_at = now()
          where id = ${id}`
        return { ok: true as const }
      })
    },
  }
}

export type AccountsCodebaseWrite = ReturnType<typeof createAccountsCodebaseWrite>
