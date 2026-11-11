import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CodebaseImportReport, CodebasesAnswer } from '../../shared/codebase-accounts.ts'
import type { EmailAccountsAnswer, ImportReport } from '../../shared/email-accounts.ts'
import type { PlatformsAnswer } from '../../shared/platform-accounts.ts'
import { BAD_WORDS, CONFIG_FILE, KEY_FILE, PASS_FILE, WORDS, readAccountsDb, readAccountsKey, reasonOf } from './accounts-db.ts'
import type { AccountsDbConfig } from './accounts-db.ts'
import { SBSKRRT_OWNER } from './access.ts'

// order o4857, o28a6: the Accounts setup and copy as a command, so the data can be in the NEW Supabase before the page's route is in an installed build. Run from the app's own folder:
//   node agent/scripts/accounts.ts <status | files | sql | check | copy | count>
// This file is the testable core (every input and output goes through `Io`; the SQL runner, the connection and the importer are injected); agent/scripts/accounts.ts is the thin shell around it.
// Rules it keeps: a password is only ever read from a hidden prompt or a file, never from an argument or the environment, and is never printed, logged or returned; the app's login is only sad_app (never the
// project's postgres login: that one is asked for once, for the SQL, and used for nothing else); the SQL is run only after a summary and a typed "yes"; the copy asks the same; nothing is run by default.

export interface Io {
  say(line: string): void
  ask(question: string): Promise<string>
  /** Typed with no echo. */
  askHidden(question: string): Promise<string>
}

export interface AdminLogin {
  host: string
  port: number
  database: string
  user: string
  password: string
}
export type RunSql = (login: AdminLogin, text: string) => Promise<void>

export interface CliDeps {
  io: Io
  /** The agent's state folder (accounts-db.json, .pass, .key and crm-session.json are here). */
  dir: string
  /** db/accounts: the SQL files. */
  sqlDir: string
  runSql: RunSql
  /** The copy: apply false counts and compares, true copies (agent/agentic/accounts-import.ts). */
  importer: (args: { person: string; apply: boolean }) => Promise<ImportReport>
  /** The list as the page reads it (agent/agentic/accounts-email.ts). */
  lister: (person: string) => Promise<EmailAccountsAnswer>
  /** orders o0e2a, oc2db: the same two for the Codebases tab ("check codebases", "copy codebases", "count codebases"). */
  codebaseImporter?: (args: { person: string; apply: boolean }) => Promise<CodebaseImportReport>
  codebaseLister?: (person: string) => Promise<CodebasesAnswer>
  /** order o4029: "count platforms": the platform accounts the Accounts tab shows. */
  platformLister?: (person: string) => Promise<PlatformsAnswer>
  /** Whether the CRM is signed in on this PC (the session's own words, never the session). */
  crmSignedIn: () => boolean
  /** Whether the postgres package can be loaded. */
  packageThere: () => Promise<boolean>
  random?: (n: number) => Buffer
}

const PERSON = SBSKRRT_OWNER.id
const REF = /^[a-z0-9]{20}$/
const DEFAULT_HOST = 'aws-0-ap-south-1.pooler.supabase.com'
export const SQL_FILES: Record<string, string> = { '0001': '0001_schema_and_login.sql', '0002': '0002_email_tables.sql', '0003': '0003_email_copy_from_crm.sql', '0004': '0004_codebases.sql' }
export const PLACEHOLDER = 'CHANGE-ME-TYPE-A-NEW-PASSWORD-HERE'

const HELP = [
  'Accounts setup and copy (node agent/scripts/accounts.ts <command>):',
  '  status            what is in place (file names, the connector, the CRM sign-in). Nothing is changed or contacted.',
  '  files [--ask]     makes accounts-db.json, accounts-db.pass and accounts-db.key in the agent folder. The app\'s login password is MADE FOR YOU (random) and never shown;',
  '                    --ask lets you type your own (hidden). Existing files are kept unless --force; an existing key is NEVER replaced.',
  '  sql 0001 0002 0003  runs the reviewed SQL files in db/accounts in the new project, after a summary and a typed "yes". Asks the project\'s postgres password ONCE (hidden, used for the SQL only).',
  '  check             counts what the CRM has and what a copy would do. Writes nothing. Works even before the database is set up.',
  '  copy              the same check, then (after a typed "yes") copies the CRM\'s email accounts into the new database: encrypted passwords, idempotent, no deletes, counts only.',
  '  count             how many email accounts the new database holds (what the Email tab shows).',
  '  check codebases | copy codebases | count codebases   the same three for the Codebases tab (the CRM\'s codebases and platform accounts; no .env and no password is ever copied: flags and counts only).',
].join('\n')

const strip = (sql: string) => sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

/** What a SQL file contains, as counts of statements by kind: all that is ever shown of it (the summary before it runs). */
export function summarise(sql: string): { kind: string; n: number }[] {
  const code = strip(sql).toLowerCase()
  const kinds: [string, RegExp][] = [
    ['create schema', /\bcreate schema\b/g], ['create role', /\bcreate role\b/g], ['create table', /\bcreate table\b/g], ['create index', /\bcreate (unique )?index\b/g],
    ['enable/force row-level security', /\b(enable|force)\s+row level security\b/g], ['create policy', /\bcreate policy\b/g], ['drop policy (to remake it)', /\bdrop policy\b/g],
    ['grant', /\bgrant\b/g], ['revoke', /\brevoke\b/g], ['alter default privileges', /\balter default privileges\b/g],
  ]
  return kinds.map(([kind, re]) => ({ kind, n: (code.match(re) ?? []).length })).filter(x => x.n > 0)
}

/** 0001 carries a placeholder where the login's password goes: replaced in memory with the real one, which is never shown. */
export function withPassword(sql: string, password: string): string {
  if (!sql.includes(PLACEHOLDER)) return sql
  // Quotes in a password would end the SQL string: refused (the generated ones have none).
  if (password.includes("'") || password.includes('\\')) throw new Error('The password may not contain a quote or a backslash.')
  return sql.split(PLACEHOLDER).join(password)
}

const many = (n: number, one: string, more = `${one}s`) => `${n} ${n === 1 ? one : more}`
const kb = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`)

export function reportLines(r: ImportReport): string[] {
  const out = [`The CRM has ${many(r.crm.total, 'email account')} (${r.crm.active} active, ${r.crm.disabled} disabled), ${r.crm.withPassword} with a password, ${many(r.crm.uses, 'use')}, about ${kb(r.crm.bytes)}.`]
  if (r.plan) out.push(`A copy would add ${r.plan.insert}, update ${r.plan.update}, leave ${r.plan.unchanged} as they are${r.plan.goneFromCrm ? `, and flag ${r.plan.goneFromCrm} that are gone from the CRM` : ''}.`)
  else if (r.planNote) out.push(r.planNote)
  if (r.done) out.push(`Written: ${r.done.inserted} new, ${r.done.updated} updated, ${r.done.unchanged} unchanged${r.done.flaggedGone ? `, ${r.done.flaggedGone} flagged as gone from the CRM` : ''} (${many(r.done.batches, 'batch', 'batches')}).`)
  return out
}

export function codebaseReportLines(r: CodebaseImportReport): string[] {
  const c = r.crm
  const out = [
    `The CRM has ${many(c.codebases, 'codebase')} (${c.live} live, ${c.retired} retired), ${c.withEnv} with a .env (${many(c.envVars, 'variable')}: counted, never copied), ${many(c.details, 'detail row')}, ${many(c.platforms, 'platform account')} with ${many(c.links, 'codebase link')}, about ${kb(c.bytes)}.`,
  ]
  if (c.hiddenValues > 0) out.push(`${many(c.hiddenValues, 'link or note')} looked like a secret and will be kept only as "hidden".`)
  if (r.plan) {
    const line = (what: string, p: { insert: number; update: number; unchanged: number; goneFromCrm: number }) =>
      `${what}: a copy would add ${p.insert}, update ${p.update}, leave ${p.unchanged} as they are${p.goneFromCrm ? `, and flag ${p.goneFromCrm} that are gone from the CRM` : ''}.`
    out.push(line('Codebases', r.plan.codebases), line('Platform accounts', r.plan.platforms))
  } else if (r.planNote) out.push(r.planNote)
  if (r.done) {
    const w = (what: string, p: { inserted: number; updated: number; unchanged: number; flaggedGone: number }) => `${what}: ${p.inserted} new, ${p.updated} updated, ${p.unchanged} unchanged${p.flaggedGone ? `, ${p.flaggedGone} flagged as gone` : ''}`
    out.push(`Written: ${w('codebases', r.done.codebases)}; ${w('platform accounts', r.done.platforms)} (${many(r.done.batches, 'batch', 'batches')}).`)
  }
  return out
}

export async function runCli(argv: string[], d: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv
  const flags = new Set(rest.filter(a => a.startsWith('--')))
  const args = rest.filter(a => !a.startsWith('--'))
  const say = d.io.say
  const rnd = d.random ?? randomBytes
  const yes = async (q: string) => (await d.io.ask(`${q} Type yes to go on: `)).trim().toLowerCase() === 'yes'
  const file = (n: string) => path.join(d.dir, n)

  // order o4029: "count platforms": what the Accounts tab shows, as counts (the copy of the platform accounts is part of "copy codebases").
  if (cmd === 'count' && args[0] === 'platforms') {
    if (!d.platformLister) return say('The platform accounts list is not available in this build.'), 1
    const a = await d.platformLister(PERSON)
    if (!a.connected) {
      say(a.message)
      return 1
    }
    const rows = a.accounts
    say(`${many(rows.length, 'platform account')} in the new database (${rows.filter(r => r.disabled).length} disabled); ${rows.filter(r => r.hasPassword).length} with a password stored (not shown, not copied); ${rows.filter(r => r.codebases.length === 0).length} with no codebase; ${rows.filter(r => !r.phone).length} with no phone; ${rows.filter(r => !r.inEmails).length} not in Emails; ${rows.filter(r => r.phone && !r.contactLinked).length} not in Contacts.`)
    return 0
  }

  // orders o0e2a, oc2db: "check codebases", "copy codebases", "count codebases" (the Codebases tab's copy). Same rules as the email ones: check writes nothing, copy shows the counts and asks a typed "yes".
  if ((cmd === 'check' || cmd === 'copy' || cmd === 'count') && args[0] === 'codebases') {
    const importer = d.codebaseImporter
    const lister = d.codebaseLister
    if (cmd === 'count') {
      if (!lister) return say('The codebases list is not available in this build.'), 1
      const a = await lister(PERSON)
      if (!a.connected) {
        say(a.message)
        return 1
      }
      const rows = a.codebases
      const links = rows.reduce((n, r) => n + r.platforms.length, 0)
      const hidden = rows.reduce((n, r) => n + Number(r.repoHidden || r.noteHidden) + r.details.filter(x => x.urlHidden || x.noteHidden).length, 0)
      say(`${many(rows.length, 'codebase')} in the new database (${rows.filter(r => r.retired).length} retired); ${rows.reduce((n, r) => n + r.details.length, 0)} detail rows; ${links} platform links; ${rows.filter(r => r.hasEnv).length} with a .env noted (flag and count only); ${hidden} values kept only as hidden.`)
      return 0
    }
    if (!importer) return say('The codebases copy is not available in this build.'), 1
    let first: CodebaseImportReport
    try {
      first = await importer({ person: PERSON, apply: false })
    } catch (e) {
      say(`Could not check: ${e instanceof Error ? e.message : 'unknown error'}`)
      return 1
    }
    for (const l of codebaseReportLines(first)) say(l)
    if (cmd === 'check') {
      say('Nothing was written anywhere.')
      return 0
    }
    if (!first.plan) {
      say('Not ready to copy yet (see above). Nothing was written.')
      return 1
    }
    const todo = first.plan.codebases.insert + first.plan.codebases.update + first.plan.platforms.insert + first.plan.platforms.update
    if (todo === 0 && first.plan.codebases.goneFromCrm + first.plan.platforms.goneFromCrm === 0) {
      say('Everything is already there and unchanged. Nothing to copy.')
      return 0
    }
    if (!(await yes(`Copy to the new database (${first.plan.codebases.insert + first.plan.platforms.insert} new, ${first.plan.codebases.update + first.plan.platforms.update} updated; no .env and no password is copied; the CRM is only read; nothing is deleted)?`))) {
      say('Nothing was written.')
      return 1
    }
    try {
      for (const l of codebaseReportLines(await importer({ person: PERSON, apply: true }))) say(l)
      say('Done. It is safe to run "copy codebases" again: what is already there is left alone.')
      return 0
    } catch (e) {
      say(`The copy stopped: ${e instanceof Error ? e.message : 'unknown error'}`)
      return 1
    }
  }

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      say(HELP)
      return cmd === undefined ? 1 : 0

    case 'status': {
      const cfg = readAccountsDb(d.dir)
      const key = readAccountsKey(d.dir)
      say(`accounts-db.json + accounts-db.pass: ${cfg.ok ? 'in place and valid' : cfg.bad === null ? 'not made yet' : `a problem: ${BAD_WORDS[cfg.bad]}`}`)
      say(`accounts-db.key: ${key.ok ? 'in place and valid' : key.missing ? 'not made yet' : 'present but not a valid key (one line, 32 random bytes in base64)'}`)
      say(`the database connector (postgres package): ${(await d.packageThere()) ? 'installed' : 'NOT installed'}`)
      say(`the CRM sign-in on this PC: ${d.crmSignedIn() ? 'signed in' : 'not signed in (sign in from Settings › Devices or the CRM page)'}`)
      say('Nothing was changed or contacted.')
      return 0
    }

    case 'files': {
      const have = existsSync(file(CONFIG_FILE)) || existsSync(file(PASS_FILE))
      if (have && !flags.has('--force')) {
        say('accounts-db.json / accounts-db.pass already exist here, so they are kept. Add --force to replace those two (the key is never replaced).')
      } else {
        const ref = (await d.io.ask('The new project\'s reference (20 letters and digits, from its address or Project Settings): ')).trim()
        if (!REF.test(ref)) {
          say('That is not a project reference (20 lower-case letters and digits). Nothing was written.')
          return 1
        }
        const hostAnswer = (await d.io.ask(`The pooler host [${DEFAULT_HOST}]: `)).trim()
        const host = hostAnswer || DEFAULT_HOST
        let password: string
        if (flags.has('--ask')) {
          const first = await d.io.askHidden('A password for the app\'s own login sad_app (at least 16 characters, no quote or backslash): ')
          const again = await d.io.askHidden('Again: ')
          if (first !== again || first.length < 16 || /['\\\s]/.test(first)) {
            say('The two did not match, or it is too short, or it has a space, quote or backslash. Nothing was written.')
            return 1
          }
          password = first
        } else {
          password = rnd(24).toString('base64url')
        }
        const config: AccountsDbConfig = { host, port: 6543, database: 'postgres', user: `sad_app.${ref}`, schema: 'sad' }
        writeFileSync(file(CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
        writeFileSync(file(PASS_FILE), password + '\n', { mode: 0o600 })
        const check = readAccountsDb(d.dir)
        if (!check.ok) {
          say(`The files were written but do not read back as valid: ${check.bad ? BAD_WORDS[check.bad] : 'accounts-db.json is missing'}.`)
          return 1
        }
        say('Made accounts-db.json and accounts-db.pass' + (flags.has('--ask') ? ' (the password you typed is in the file only).' : ' (the password was made for you, is in the file only, and is not shown anywhere).'))
      }
      if (existsSync(file(KEY_FILE))) say('accounts-db.key already exists and is kept: it is never replaced (it would make the stored passwords unreadable).')
      else {
        writeFileSync(file(KEY_FILE), rnd(32).toString('base64') + '\n', { mode: 0o600 })
        say('Made accounts-db.key. KEEP A BACKUP of this file somewhere safe: without it the stored mailbox passwords can never be read again.')
      }
      say(`The files are in ${d.dir}. They are never in git and are never shown.`)
      return 0
    }

    case 'sql': {
      const names = args.map(a => SQL_FILES[a]).filter(Boolean)
      if (names.length === 0 || names.length !== args.length) {
        say('Say which files: sql 0001 0002 0003 (0001 the schema and the app login, 0002 the empty tables, 0003 the right to write the copy). Nothing was run.')
        return 1
      }
      const cfg = readAccountsDb(d.dir)
      if (!cfg.ok) {
        say(`Run "files" first: ${cfg.bad === null ? 'accounts-db.json is not made yet' : BAD_WORDS[cfg.bad]}. Nothing was run.`)
        return 1
      }
      const ref = /^sad_app\.([a-z0-9]{20})$/.exec(cfg.config.user)?.[1]
      if (!ref) {
        say('accounts-db.json names the login without the project reference (sad_app.<reference>), so the project cannot be told. Nothing was run.')
        return 1
      }
      const texts: { name: string; text: string }[] = []
      for (const n of names) {
        let raw: string
        try {
          raw = readFileSync(path.join(d.sqlDir, n), 'utf8')
        } catch {
          say(`${n} is not in ${d.sqlDir}. Nothing was run.`)
          return 1
        }
        texts.push({ name: n, text: raw })
      }
      say(`These files will be run in project ${ref}, as the project's admin login, in this order:`)
      for (const t of texts) say(`  ${t.name}: ${summarise(t.text).map(s => `${s.n} ${s.kind}`).join(', ')}`)
      say('Nothing is deleted or dropped by them (a test keeps that true), and they create no data. The reading is in db/accounts/README.md.')
      if (!(await yes('Run them?'))) {
        say('Nothing was run.')
        return 1
      }
      const adminPassword = await d.io.askHidden(`The project's postgres password (used once, for this SQL only; never stored or shown): `)
      if (!adminPassword) {
        say('No password given. Nothing was run.')
        return 1
      }
      for (const t of texts) {
        try {
          await d.runSql({ host: cfg.config.host, port: 5432, database: cfg.config.database, user: `postgres.${ref}`, password: adminPassword }, withPassword(t.text, cfg.password))
          say(`  ${t.name}: done`)
        } catch (e) {
          const { reason, code } = reasonOf(e)
          say(`  ${t.name}: FAILED (${reason}, ${code}). ${WORDS[reason]} The files before it ran; this one can be run again (it is safe to repeat).`)
          return 1
        }
      }
      say('Done. Next: "check", then "copy".')
      return 0
    }

    case 'check': {
      try {
        for (const l of reportLines(await d.importer({ person: PERSON, apply: false }))) say(l)
        say('Nothing was written anywhere.')
        return 0
      } catch (e) {
        say(`Could not check: ${e instanceof Error ? e.message : 'unknown error'}`)
        return 1
      }
    }

    case 'copy': {
      let first: ImportReport
      try {
        first = await d.importer({ person: PERSON, apply: false })
      } catch (e) {
        say(`Could not check: ${e instanceof Error ? e.message : 'unknown error'}`)
        return 1
      }
      for (const l of reportLines(first)) say(l)
      if (!first.plan) {
        say('Not ready to copy yet (see above). Nothing was written.')
        return 1
      }
      if (first.plan.insert + first.plan.update === 0 && first.plan.goneFromCrm === 0) {
        say('Everything is already there and unchanged. Nothing to copy.')
        return 0
      }
      if (!(await yes(`Copy to the new database (${first.plan.insert} new, ${first.plan.update} updated; passwords encrypted; the CRM is only read; nothing is deleted)?`))) {
        say('Nothing was written.')
        return 1
      }
      try {
        for (const l of reportLines(await d.importer({ person: PERSON, apply: true }))) say(l)
        say('Done. It is safe to run "copy" again: what is already there is left alone.')
        return 0
      } catch (e) {
        say(`The copy stopped: ${e instanceof Error ? e.message : 'unknown error'}`)
        return 1
      }
    }

    case 'count': {
      const a = await d.lister(PERSON)
      if (!a.connected) {
        say(a.message)
        return 1
      }
      const off = a.accounts.filter(x => x.disabled).length
      say(`${many(a.accounts.length, 'email account')} in the new database${off ? `, ${off} switched off` : ''}; ${a.accounts.filter(x => x.hasPassword).length} with a password stored (encrypted, not shown).`)
      return 0
    }

    default:
      say(`Unknown command "${cmd}".`)
      say(HELP)
      return 1
  }
}
