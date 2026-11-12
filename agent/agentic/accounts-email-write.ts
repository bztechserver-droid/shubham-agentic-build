import { apiError } from '../api.ts'
import { checkEmailEdit, type Checked, type EmailEditInput } from '../../shared/email-edit.ts'
import { decryptPassword, encryptPassword, passwordMac } from './accounts-crypto.ts'
import { openAccountsDb, readAccountsDb, readAccountsKey, reasonOf, WORDS, type AccountsSql, type Row, type Tx } from './accounts-db.ts'

// Order ofd53 (slice 1 of o45c0): the email edit modal's writes, through the app's own agent routes only, into the new Supabase project (schema sad,
// db/accounts/0007_email_write.sql). Owner only: the person the agent says is asking, checked by the database's rules as well. SOFT DELETE: a delete sets
// deleted_at; nothing is removed. A password is sealed here (the same code and key as the Accounts passwords) and is never read back: the login has no
// right to read the sealed columns. 
export interface AccountsEmailWriteOptions {
  dir: string
  open?: typeof openAccountsDb
  log?: { warn(message: string): void; info?(message: string): void }
}

const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/
const UUID = /^[0-9a-f-]{36}$/i
const NO_ROW = 'That email account is not there any more (it may have been deleted).'
const KEY_MISSING = 'The key file for the Accounts passwords is not on this PC, so a password cannot be saved. Nothing was changed.'

function need<T>(c: Checked<T>): T {
  if (!c.ok) throw apiError(400, c.message)
  return c.value
}

export function createAccountsEmailWrite(o: AccountsEmailWriteOptions) {
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
      o.log?.warn(`accounts db (email write): ${reason} (${code})`)
      throw apiError(503, WORDS[reason])
    } finally {
      await sql?.end({ timeout: 2 }).catch(() => {})
    }
  }

  /** The sealed password and its fingerprint, or nulls when no new password was given. The key is needed only for a password. */
  function sealed(password: string | null): { enc: string; mac: string } | null {
    if (password === null) return null
    const k = readAccountsKey(o.dir)
    if (!k.ok) throw apiError(503, KEY_MISSING)
    return { enc: encryptPassword(k.key, password), mac: passwordMac(k.key, password) }
  }

  async function ownedLive(tx: Tx, id: string): Promise<string> {
    const rows: Row[] = await tx`select source from sad.account_email where id = ${id} and deleted_at is null`
    if (rows.length === 0) throw apiError(404, NO_ROW)
    return String(rows[0].source)
  }

  return {
    /** A new email account, made in the app (source 'app'). */
    async create(person: string, raw: unknown): Promise<{ id: string }> {
      const v: EmailEditInput = need(checkEmailEdit(raw))
      const s = sealed(v.password)
      return run(person, async tx => {
        const made: Row[] = await tx`insert into sad.account_email (owner_id, source, address, recovery_email, phone, description, has_password, password_enc, password_mac, is_disabled)
          values (${person}, 'app', ${v.address}, ${v.recoveryEmail}, ${v.phone}, ${v.note}, ${s !== null}, ${s?.enc ?? null}, ${s?.mac ?? null}, ${v.disabled}) returning id`
        return { id: String(made[0]?.id) }
      })
    },

    /** Changes an account made in the app. A password left empty keeps the stored one. */
    async update(person: string, id: string, raw: unknown): Promise<{ ok: true }> {
      if (!UUID.test(id)) throw apiError(400, 'That email account id is not valid.')
      const v = need(checkEmailEdit(raw))
      const s = sealed(v.password)
      return run(person, async tx => {
        await ownedLive(tx, id)
        if (s) {
          if (v.keepNote) await tx`update sad.account_email set address = ${v.address}, recovery_email = ${v.recoveryEmail}, phone = ${v.phone}, is_disabled = ${v.disabled},
            has_password = true, password_enc = ${s.enc}, password_mac = ${s.mac}, app_touched_at = now(), updated_at = now() where id = ${id} and deleted_at is null`
          else await tx`update sad.account_email set address = ${v.address}, recovery_email = ${v.recoveryEmail}, phone = ${v.phone}, description = ${v.note}, is_disabled = ${v.disabled},
            has_password = true, password_enc = ${s.enc}, password_mac = ${s.mac}, app_touched_at = now(), updated_at = now() where id = ${id} and deleted_at is null`
        } else if (v.keepNote) {
          await tx`update sad.account_email set address = ${v.address}, recovery_email = ${v.recoveryEmail}, phone = ${v.phone}, is_disabled = ${v.disabled}, app_touched_at = now(), updated_at = now()
            where id = ${id} and deleted_at is null`
        } else {
          await tx`update sad.account_email set address = ${v.address}, recovery_email = ${v.recoveryEmail}, phone = ${v.phone}, description = ${v.note}, is_disabled = ${v.disabled}, app_touched_at = now(), updated_at = now()
            where id = ${id} and deleted_at is null`
        }
        return { ok: true as const }
      })
    },

    /** Soft delete: deleted_at is set; the row stays in the database and leaves the list. */
    /**
   * Reveal: the stored password of one of the owner's rows, decrypted HERE (the browser gets it for this reveal only). The reveal is logged: who, which row, when.
   * The password itself is never logged.
   */
  async reveal(person: string, id: string): Promise<{ password: string }> {
    if (!UUID.test(id)) throw apiError(400, 'That email account id is not valid.')
    const k = readAccountsKey(o.dir)
    if (!k.ok) throw apiError(503, KEY_MISSING)
    const out = await run(person, async tx => {
      const rows: Row[] = await tx`select password_enc from sad.account_email where id = ${id} and deleted_at is null`
      if (rows.length === 0) throw apiError(404, NO_ROW)
      const sealedText = rows[0].password_enc
      if (typeof sealedText !== 'string' || sealedText === '') throw apiError(404, 'No password is stored for this account.')
      try {
        return { password: decryptPassword(k.key, sealedText) }
      } catch {
        throw apiError(500, 'That password could not be opened with the key on this PC.')
      }
    })
    o.log?.info?.(`email password revealed: row ${id} by ${person} at ${new Date().toISOString()}`)
    return out
  },

  async remove(person: string, id: string): Promise<{ ok: true }> {
      if (!UUID.test(id)) throw apiError(400, 'That email account id is not valid.')
      return run(person, async tx => {
        await ownedLive(tx, id)
        await tx`update sad.account_email set deleted_at = now(), app_touched_at = now(), updated_at = now() where id = ${id} and deleted_at is null`
        return { ok: true as const }
      })
    },
  }
}

export type AccountsEmailWrite = ReturnType<typeof createAccountsEmailWrite>
