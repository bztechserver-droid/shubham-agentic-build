import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NotConnected } from '../../shared/email-accounts.ts'
import { parseKey } from './accounts-crypto.ts'

// order o4d14: how the agent reaches the NEW Supabase project that holds the Accounts data (db/accounts/README.md). Server-side only: the page never sees a database address, a login or a password.
// Two small files in the agent's state folder, written by Shubham himself: accounts-db.json (where: not secret) and accounts-db.pass (the password of the login sad_app, one line). They are read at the
// moment of use, kept nowhere, never logged, never put in an answer. The login must be sad_app (a login with rights on schema sad only): not the project's postgres login, not a service key, not a public key:
// a file naming any other login is refused. The postgres package is loaded only when it is used, so a PC without it says so instead of failing to start.

export interface AccountsDbConfig {
  host: string
  port: number
  database: string
  user: string
  schema: 'sad'
}

/** Which field is wrong: a name only, never the value (it may sit next to a secret). */
export type BadField = 'file' | 'host' | 'port' | 'database' | 'user' | 'schema' | 'password-file'
export type ConfigRead = { ok: true; config: AccountsDbConfig; password: string } | { ok: false; bad: BadField | null }

export const CONFIG_FILE = 'accounts-db.json'
export const PASS_FILE = 'accounts-db.pass'

const HOST = /^[a-z0-9][a-z0-9.-]{0,120}\.(pooler\.supabase\.com|supabase\.co)$/
const USER = /^sad_app(\.[a-z0-9]{20})?$/
const DATABASE = /^[a-z_][a-z0-9_]{0,62}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads the two files. ok:false with bad:null when there is no config file yet (not set up); with a field name when something in them is wrong. */
export function readAccountsDb(dir: string): ConfigRead {
  let raw: unknown
  try {
    // A file saved by Windows PowerShell or Notepad may start with a byte-order mark: not part of the JSON.
    raw = JSON.parse(readFileSync(path.join(dir, CONFIG_FILE), 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    return { ok: false, bad: (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'file' }
  }
  if (!isObject(raw)) return { ok: false, bad: 'file' }
  const { host, port, database, user, schema } = raw
  if (typeof host !== 'string' || !HOST.test(host)) return { ok: false, bad: 'host' }
  if (port !== 5432 && port !== 6543) return { ok: false, bad: 'port' }
  if (typeof database !== 'string' || !DATABASE.test(database)) return { ok: false, bad: 'database' }
  if (typeof user !== 'string' || !USER.test(user)) return { ok: false, bad: 'user' }
  if (schema !== 'sad') return { ok: false, bad: 'schema' }
  let password: string
  try {
    password = readFileSync(path.join(dir, PASS_FILE), 'utf8').split(/\r?\n/)[0].trim()
  } catch {
    return { ok: false, bad: 'password-file' }
  }
  // A real password is long; a placeholder left from the SQL file is refused here too.
  if (password.length < 12 || password.length > 200 || /\s/.test(password) || password.startsWith('CHANGE-ME')) return { ok: false, bad: 'password-file' }
  return { ok: true, config: { host, port, database, user, schema }, password }
}

export type Row = Record<string, unknown>
/** The tagged template of the postgres package inside a transaction. */
export interface Tx {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<Row[]>
}
export interface AccountsSql {
  begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  end(options?: { timeout?: number }): Promise<void>
}

export class AccountsDbError extends Error {
  readonly reason: NotConnected
  readonly code?: string
  constructor(reason: NotConnected, code?: string) {
    super(reason)
    this.reason = reason
    this.code = code
  }
}

/** The package's name is in a variable so the compiler does not need it installed: it is loaded only when the page is used. */
const PACKAGE = 'postgres'
const loadPackage = (): Promise<unknown> => import(PACKAGE)

/** Opens one short-lived connection (it is ended after each use, so a changed password file is picked up and nothing stays open). */
export async function openAccountsDb(read: { config: AccountsDbConfig; password: string }, load: () => Promise<unknown> = loadPackage): Promise<AccountsSql> {
  let mod: unknown
  try {
    mod = await load()
  } catch {
    throw new AccountsDbError('package-missing')
  }
  const factory = (isObject(mod) && typeof mod.default === 'function' ? mod.default : mod) as (o: Record<string, unknown>) => AccountsSql
  if (typeof factory !== 'function') throw new AccountsDbError('package-missing')
  return factory({
    host: read.config.host,
    port: read.config.port,
    database: read.config.database,
    username: read.config.user,
    password: read.password,
    ssl: 'require',
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    // The pooler (port 6543) is a transaction pooler: no prepared statements.
    prepare: false,
    onnotice: () => {},
    connection: { application_name: 'sad-accounts' },
  })
}

/** Why a failed call failed, in the page's terms. Only a code is ever kept from the error: its message may carry the host, the user or more. */
export function reasonOf(e: unknown): { reason: NotConnected; code: string } {
  if (e instanceof AccountsDbError) return { reason: e.reason, code: e.code ?? e.reason }
  const code = isObject(e) && typeof e.code === 'string' ? e.code.slice(0, 20) : 'error'
  if (code === '28P01' || code === '28000') return { reason: 'login', code }
  if (code === '42P01' || code === '3F000' || code === '42501') return { reason: 'no-tables', code }
  return { reason: 'unreachable', code }
}

export const WORDS: Record<NotConnected, string> = {
  'not-set-up': 'The new database is not connected yet, so nothing is kept anywhere. Two small files on the Server tell the agent where it is (accounts-db.json and accounts-db.pass): db/accounts/README.md says how.',
  'package-missing': 'The database connector (the postgres package) is not installed on the main PC yet. It is added once Shubham says yes.',
  login: 'The new database refused the login. Check the password file (accounts-db.pass) and the login named in accounts-db.json.',
  unreachable: "The new database can't be reached right now. The host or port in accounts-db.json may be wrong, the project may be paused, or the network is down.",
  'no-tables': 'The tables are not there yet (or the login has no right to them): run db/accounts/0001 and 0002 in the new project\'s SQL editor.',
}

export const BAD_WORDS: Record<BadField, string> = {
  file: 'accounts-db.json is not a valid file',
  host: 'the host in accounts-db.json is not a Supabase pooler host',
  port: 'the port in accounts-db.json must be 6543 (or 5432)',
  database: 'the database name in accounts-db.json is not valid',
  user: 'the login in accounts-db.json must be sad_app (or sad_app.<project ref>): no other login is used',
  schema: 'the schema in accounts-db.json must be sad',
  'password-file': 'accounts-db.pass is missing, still the placeholder, or not a single password line',
}

export const KEY_FILE = 'accounts-db.key'

/** The encryption key for the mailbox passwords (accounts-crypto.ts), from its file. Only the copy from the CRM needs it. missing: no such file; otherwise the file is not a key. Never echoes the text. */
export function readAccountsKey(dir: string): { ok: true; key: Buffer } | { ok: false; missing: boolean } {
  let text: string
  try {
    text = readFileSync(path.join(dir, KEY_FILE), 'utf8')
  } catch {
    return { ok: false, missing: true }
  }
  const key = parseKey(text)
  return key ? { ok: true, key } : { ok: false, missing: false }
}
