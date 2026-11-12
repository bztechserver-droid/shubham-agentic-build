import { apiError } from '../api.ts'
import { checkDescription, checkLink, checkSubsetName, checkVarName, checkVarValue, isSecretName, isSection, type Checked, type TabSection, type TabsAnswer, type TabsVar } from '../../shared/codebase-tabs.ts'
import { decryptPassword, encryptPassword } from './accounts-crypto.ts'
import { openAccountsDb, readAccountsDb, readAccountsKey, reasonOf, WORDS, type AccountsSql, type Row, type Tx } from './accounts-db.ts'

// Order ocf00 (version 2): the Codebases modal's tabs, kept in the NEW Supabase project (schema sad, db/accounts/0006_codebase_tabs.sql). Only the owner
// (the person the agent says is asking) reads or changes them: row-level security decides, the same as the other Accounts tables.
// DELETE IS SOFT: nothing is deleted from the database. A delete sets deleted_at (an UPDATE); every read leaves those rows out; a deleted name does not
// count as taken, and adding a name again brings its deleted row back with the new value (no second row). The app's login has no delete right.
// The rules: a variable's VALUE is stored only encrypted (the Accounts key file, the same code as the mailbox passwords); a secret-looking name's value
// is never given back except by an explicit reveal; a non-secret value is given with the list. Nothing is logged but a reason and a code, and no error
// text names a value. The .env of the CRM is never read here.

export interface CodebaseTabsOptions {
  dir: string
  open?: typeof openAccountsDb
  log?: { warn(message: string): void; info?(message: string): void }
}

const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/
const KEY_MISSING = 'The key file for the Accounts passwords is not on this PC, so environment variables cannot be saved or read. Nothing was changed.'
const NO_CODEBASE = 'That codebase is not on the list.'
const NO_ROW = 'That row is not there any more (it may have been deleted).'
const NAME_TAKEN = 'A variable with that name is already in this subset.'

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const uuid = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null)

export function createCodebaseTabs(o: CodebaseTabsOptions) {
  const open = o.open ?? openAccountsDb

  /** One transaction for `person`: the database's own rules then decide what they may see or change. Errors that are ours (status) pass through. */
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
      o.log?.warn(`accounts db (codebase tabs): ${reason} (${code})`)
      throw apiError(503, WORDS[reason])
    } finally {
      await sql?.end({ timeout: 2 }).catch(() => {})
    }
  }

  /** The key, or a plain refusal (values cannot be saved or read without it). */
  function keyOrRefuse(): Buffer {
    const k = readAccountsKey(o.dir)
    if (!k.ok) throw apiError(503, KEY_MISSING)
    return k.key
  }

  function need<T>(c: Checked<T>): T {
    if (!c.ok) throw apiError(400, c.message)
    return c.value
  }

  async function codebaseOr404(tx: Tx, cb: string) {
    const rows: Row[] = await tx`select id from sad.account_codebase where id = ${cb}`
    if (rows.length === 0) throw apiError(404, NO_CODEBASE)
  }

  return {
    /** Everything in the tabs of one codebase that is not deleted: the sections' descriptions, the links, the subsets and their variables (values only where they are not secret). */
    async read(person: string, codebaseId: string): Promise<TabsAnswer> {
      const cb = uuid(codebaseId)
      if (!cb) throw apiError(400, 'That codebase id is not valid.')
      const key = readAccountsKey(o.dir)
      return run(person, async tx => {
        await codebaseOr404(tx, cb)
        const secs: Row[] = await tx`select section, description from sad.account_codebase_section where codebase_id = ${cb} and deleted_at is null`
        const links: Row[] = await tx`select id, section, label, url, description from sad.account_codebase_link where codebase_id = ${cb} and deleted_at is null order by sort_order, created_at`
        const subs: Row[] = await tx`select id, name from sad.account_env_subset where codebase_id = ${cb} and deleted_at is null order by sort_order, created_at`
        const vars: Row[] = await tx`select v.id, v.subset_id, v.name, v.value_sealed from sad.account_env_var v join sad.account_env_subset s on s.id = v.subset_id where s.codebase_id = ${cb} and s.deleted_at is null and v.deleted_at is null order by v.name`
        const sections = { be: '', fe: '', deployment: '', database: '' } as Record<TabSection, string>
        for (const s of secs) if (isSection(s.section)) sections[s.section] = str(s.description)
        const varsBy = new Map<string, TabsVar[]>()
        for (const v of vars) {
          const name = str(v.name)
          const secret = isSecretName(name)
          let value: string | null = null
          if (!secret && key.ok) {
            try {
              value = decryptPassword(key.key, str(v.value_sealed))
            } catch {
              value = null
            }
          }
          const sid = str(v.subset_id)
          varsBy.set(sid, [...(varsBy.get(sid) ?? []), { id: str(v.id), name, secret, value }])
        }
        return {
          codebaseId: cb,
          sections,
          links: links.filter(l => isSection(l.section)).map(l => ({ id: str(l.id), section: l.section as TabSection, label: str(l.label), url: str(l.url), description: str(l.description) })),
          subsets: subs.map(s => ({ id: str(s.id), name: str(s.name), vars: varsBy.get(str(s.id)) ?? [] })),
          keyOk: key.ok,
        }
      })
    },

    /** The description of one section (empty clears it). */
    async setSection(person: string, codebaseId: string, section: unknown, description: unknown): Promise<{ section: TabSection; description: string }> {
      const cb = uuid(codebaseId)
      if (!cb) throw apiError(400, 'That codebase id is not valid.')
      if (!isSection(section)) throw apiError(400, 'The section is BE, FE, Deployment or Database.')
      const text = need(checkDescription(description))
      return run(person, async tx => {
        await codebaseOr404(tx, cb)
        const upd: Row[] = await tx`update sad.account_codebase_section set description = ${text}, updated_at = now() where codebase_id = ${cb} and section = ${section} returning id`
        if (upd.length === 0) await tx`insert into sad.account_codebase_section (owner_id, codebase_id, section, description) values (${person}, ${cb}, ${section}, ${text})`
        return { section, description: text }
      })
    },

    async addLink(person: string, codebaseId: string, input: unknown): Promise<{ id: string }> {
      const cb = uuid(codebaseId)
      if (!cb) throw apiError(400, 'That codebase id is not valid.')
      const r = input as Record<string, unknown>
      if (!isSection(r?.section)) throw apiError(400, 'The section is BE, FE, Deployment or Database.')
      const link = need(checkLink(input))
      const section = r.section
      return run(person, async tx => {
        await codebaseOr404(tx, cb)
        const next: Row[] = await tx`select coalesce(max(sort_order), 0) + 1 as n from sad.account_codebase_link where codebase_id = ${cb} and section = ${section}`
        const made: Row[] = await tx`insert into sad.account_codebase_link (owner_id, codebase_id, section, label, url, description, sort_order) values (${person}, ${cb}, ${section}, ${link.label}, ${link.url}, ${link.description}, ${Number(next[0]?.n ?? 1)}) returning id`
        return { id: str(made[0]?.id) }
      })
    },

    async updateLink(person: string, linkId: string, input: unknown): Promise<{ ok: true }> {
      const id = uuid(linkId)
      if (!id) throw apiError(400, 'That link id is not valid.')
      const link = need(checkLink(input))
      return run(person, async tx => {
        const rows: Row[] = await tx`update sad.account_codebase_link set label = ${link.label}, url = ${link.url}, description = ${link.description}, updated_at = now() where id = ${id} and deleted_at is null returning id`
        if (rows.length === 0) throw apiError(404, NO_ROW)
        return { ok: true as const }
      })
    },

    /** Soft delete: the row stays in the database with deleted_at set; the page no longer shows it. */
    async deleteLink(person: string, linkId: string): Promise<{ ok: true }> {
      const id = uuid(linkId)
      if (!id) throw apiError(400, 'That link id is not valid.')
      return run(person, async tx => {
        const rows: Row[] = await tx`update sad.account_codebase_link set deleted_at = now(), updated_at = now() where id = ${id} and deleted_at is null returning id`
        if (rows.length === 0) throw apiError(404, NO_ROW)
        return { ok: true as const }
      })
    },

    async addSubset(person: string, codebaseId: string, name: unknown): Promise<{ id: string }> {
      const cb = uuid(codebaseId)
      if (!cb) throw apiError(400, 'That codebase id is not valid.')
      const n = need(checkSubsetName(name))
      return run(person, async tx => {
        await codebaseOr404(tx, cb)
        const next: Row[] = await tx`select coalesce(max(sort_order), 0) + 1 as n from sad.account_env_subset where codebase_id = ${cb}`
        const made: Row[] = await tx`insert into sad.account_env_subset (owner_id, codebase_id, name, sort_order) values (${person}, ${cb}, ${n}, ${Number(next[0]?.n ?? 1)}) returning id`
        return { id: str(made[0]?.id) }
      })
    },

    async renameSubset(person: string, subsetId: string, name: unknown): Promise<{ ok: true }> {
      const id = uuid(subsetId)
      if (!id) throw apiError(400, 'That subset id is not valid.')
      const n = need(checkSubsetName(name))
      return run(person, async tx => {
        const rows: Row[] = await tx`update sad.account_env_subset set name = ${n}, updated_at = now() where id = ${id} and deleted_at is null returning id`
        if (rows.length === 0) throw apiError(404, NO_ROW)
        return { ok: true as const }
      })
    },

    /** Soft delete of a subset, and of the variables in it (they leave the page with it). */
    async deleteSubset(person: string, subsetId: string): Promise<{ ok: true }> {
      const id = uuid(subsetId)
      if (!id) throw apiError(400, 'That subset id is not valid.')
      return run(person, async tx => {
        const rows: Row[] = await tx`update sad.account_env_subset set deleted_at = now(), updated_at = now() where id = ${id} and deleted_at is null returning id`
        if (rows.length === 0) throw apiError(404, NO_ROW)
        await tx`update sad.account_env_var set deleted_at = now(), updated_at = now() where subset_id = ${id} and deleted_at is null`
        return { ok: true as const }
      })
    },

    /**
     * Adds a variable to a subset. The value is sealed before it is written. A name that is taken by a live variable is refused; a name whose
     * variable was deleted is brought back with the new value (so there is never a second row with the same name).
     */
    async addVar(person: string, subsetId: string, input: unknown): Promise<{ id: string }> {
      const id = uuid(subsetId)
      if (!id) throw apiError(400, 'That subset id is not valid.')
      const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
      const name = need(checkVarName(r.name))
      const value = need(checkVarValue(r.value ?? ''))
      const key = keyOrRefuse()
      const sealed = encryptPassword(key, value)
      return run(person, async tx => {
        const sub: Row[] = await tx`select id from sad.account_env_subset where id = ${id} and deleted_at is null`
        if (sub.length === 0) throw apiError(404, NO_ROW)
        const live: Row[] = await tx`select id from sad.account_env_var where subset_id = ${id} and name = ${name} and deleted_at is null`
        if (live.length > 0) throw apiError(409, NAME_TAKEN)
        const back: Row[] = await tx`update sad.account_env_var set deleted_at = null, value_sealed = ${sealed}, updated_at = now() where subset_id = ${id} and name = ${name} and deleted_at is not null returning id`
        if (back.length > 0) return { id: str(back[0].id) }
        const made: Row[] = await tx`insert into sad.account_env_var (owner_id, subset_id, name, value_sealed) values (${person}, ${id}, ${name}, ${sealed}) returning id`
        return { id: str(made[0]?.id) }
      })
    },

    /** Changes a variable's name and/or value (a value left out keeps the old one). */
    async updateVar(person: string, varId: string, input: unknown): Promise<{ ok: true; id: string }> {
      const id = uuid(varId)
      if (!id) throw apiError(400, 'That variable id is not valid.')
      const r = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
      const name = r.name === undefined ? null : need(checkVarName(r.name))
      const value = r.value === undefined ? null : need(checkVarValue(r.value))
      const sealed = value === null ? null : encryptPassword(keyOrRefuse(), value)
      return run(person, async tx => {
        const cur: Row[] = await tx`select id, name, subset_id, value_sealed from sad.account_env_var where id = ${id} and deleted_at is null`
        if (cur.length === 0) throw apiError(404, NO_ROW)
        const row = cur[0]
        const finalName = name ?? str(row.name)
        const finalSealed = sealed ?? str(row.value_sealed)
        if (name !== null && name !== str(row.name)) {
          const live: Row[] = await tx`select id from sad.account_env_var where subset_id = ${row.subset_id} and name = ${name} and deleted_at is null`
          if (live.length > 0) throw apiError(409, NAME_TAKEN)
          // A deleted variable with the new name is brought back with this value; this row goes to the deleted state (no second row with one name).
          const back: Row[] = await tx`select id from sad.account_env_var where subset_id = ${row.subset_id} and name = ${name} and deleted_at is not null`
          if (back.length > 0) {
            await tx`update sad.account_env_var set deleted_at = null, value_sealed = ${finalSealed}, updated_at = now() where id = ${back[0].id}`
            await tx`update sad.account_env_var set deleted_at = now(), updated_at = now() where id = ${id}`
            return { ok: true as const, id: str(back[0].id) }
          }
        }
        if (sealed !== null) await tx`update sad.account_env_var set name = ${finalName}, value_sealed = ${finalSealed}, updated_at = now() where id = ${id}`
        else await tx`update sad.account_env_var set name = ${finalName}, updated_at = now() where id = ${id}`
        return { ok: true as const, id }
      })
    },

    /** Soft delete: the variable stays in the database with deleted_at set; its name is free again. */
    async deleteVar(person: string, varId: string): Promise<{ ok: true }> {
      const id = uuid(varId)
      if (!id) throw apiError(400, 'That variable id is not valid.')
      return run(person, async tx => {
        const rows: Row[] = await tx`update sad.account_env_var set deleted_at = now(), updated_at = now() where id = ${id} and deleted_at is null returning id`
        if (rows.length === 0) throw apiError(404, NO_ROW)
        return { ok: true as const }
      })
    },

    /** The one way a secret value leaves the Server: when he asks for it (reveal). Nothing is logged. */
    async reveal(person: string, varId: string): Promise<{ value: string }> {
      const id = uuid(varId)
      if (!id) throw apiError(400, 'That variable id is not valid.')
      const key = keyOrRefuse()
      const out = await run(person, async tx => {
        const rows: Row[] = await tx`select value_sealed from sad.account_env_var where id = ${id} and deleted_at is null`
        if (rows.length === 0) throw apiError(404, NO_ROW)
        try {
          return { value: decryptPassword(key, str(rows[0].value_sealed)) }
        } catch {
          throw apiError(500, 'That value could not be opened with the key on this PC.')
        }
      })
      // The reveal is logged: who, which row, when. Never the value.
      o.log?.info?.(`environment variable revealed: row ${id} by ${person} at ${new Date().toISOString()}`)
      return out
    },
  }
}

export type CodebaseTabs = ReturnType<typeof createCodebaseTabs>
