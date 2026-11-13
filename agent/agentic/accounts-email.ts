import { safeEmailRows, type EmailAccountsAnswer, type NotConnected } from '../../shared/email-accounts.ts'
import { apiError } from '../api.ts'
import { BAD_WORDS, WORDS, openAccountsDb, readAccountsDb, reasonOf, type AccountsSql, type Row } from './accounts-db.ts'

// order o57e2, o4d14: the Accounts page's Email tab, read from the NEW Supabase project (schema sad; db/accounts/README.md). Only SELECTs, each inside a transaction that first says who is asking
// (set_config app.person_id, bound as a parameter, never glued into the text), so the database's own row-level security decides what that person sees. The rows go through shared/email-accounts.ts's
// whitelist on the way out. A connection is opened for the call and ended after it. Failures become plain reasons (never the error's text, the host, the login or the password) and only a code is logged.

export interface AccountsEmailOptions {
  /** The agent's state folder: where accounts-db.json and accounts-db.pass are. */
  dir: string
  /** For tests: how a connection is opened. */
  open?: typeof openAccountsDb
  log?: { warn(message: string): void }
}

const PERSON = /^[A-Za-z0-9._:@-]{1,80}$/

const notConnected = (reason: NotConnected, detail?: string): EmailAccountsAnswer => ({ connected: false, reason, message: detail ? `${WORDS[reason]} (${detail}.)` : WORDS[reason] })

export function createAccountsEmail(o: AccountsEmailOptions) {
  const open = o.open ?? openAccountsDb
  return {
    /** The email accounts `person` may see. */
    async list(person: string): Promise<EmailAccountsAnswer> {
      const read = readAccountsDb(o.dir)
      if (!read.ok) return read.bad === null ? notConnected('not-set-up') : notConnected('not-set-up', BAD_WORDS[read.bad])
      // The person is the app's own id of the signed-in owner; anything odd is refused rather than passed on.
      if (!PERSON.test(person)) throw apiError(400, 'The person asking is not a valid id.')
      let sql: AccountsSql | null = null
      try {
        sql = await open(read)
        const { mails, uses } = await sql.begin(async tx => {
          await tx`select set_config('app.person_id', ${person}, true)`
          const mails: Row[] = await tx`select id, address, recovery_email, phone, description, has_password, is_disabled, source_updated_at, authenticator_email, authenticator_app, authenticator_note from sad.account_email where deleted_at is null order by is_disabled, address limit 501`
          const uses: Row[] = await tx`select email_id, used_for from sad.account_email_use where gone_from_source = false order by email_id, sort_order limit 6000`
          return { mails, uses }
        })
        const byEmail = new Map<string, { usedFor: unknown }[]>()
        for (const u of uses) {
          const key = String(u.email_id)
          byEmail.set(key, [...(byEmail.get(key) ?? []), { usedFor: u.used_for }])
        }
        const accounts = safeEmailRows(
          mails.map(m => ({ id: String(m.id), address: m.address, recoveryEmail: m.recovery_email, phone: m.phone, description: m.description, hasPassword: m.has_password === true, isDisabled: m.is_disabled === true, updatedAt: m.source_updated_at, uses: byEmail.get(String(m.id)) ?? [], authenticatorEmail: m.authenticator_email, authenticatorApp: m.authenticator_app, authenticatorNote: m.authenticator_note })),
        )
        return { connected: true, accounts: accounts ?? [] }
      } catch (e) {
        const { reason, code } = reasonOf(e)
        o.log?.warn(`accounts db: ${reason} (${code})`)
        return notConnected(reason)
      } finally {
        // Ended whatever happened; a failure to end is nobody's business.
        await sql?.end({ timeout: 2 }).catch(() => {})
      }
    },
  }
}

export type AccountsEmail = ReturnType<typeof createAccountsEmail>
