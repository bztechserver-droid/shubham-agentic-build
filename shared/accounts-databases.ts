// Accounts Databases section (order oba25): exactly two fixed databases, each with a Ping. Pure: the values and the result shape the agent and the page share.

export interface FixedDatabase {
  key: 'crm' | 'other'
  label: string
  /** The Supabase project reference (its public name, not a secret). */
  ref: string
  /** The pooler address the app reaches the database by. */
  host: string
  port: number
  /** The schema the app uses (the other database only). */
  schema: string | null
  /** What a ping checks, in plain words. */
  checks: string
}

export const FIXED_DATABASES: readonly FixedDatabase[] = [
  {
    key: 'crm',
    label: 'CRM database',
    ref: 'rrkizezxewgzouiywixm',
    host: 'aws-1-ap-south-1.pooler.supabase.com',
    port: 6543,
    schema: null,
    checks: 'The pooler port answers, and the project answers over its REST endpoint. This app has no login to the CRM database, so a ping says "reachable (no login)" and never reads its data.',
  },
  {
    key: 'other',
    label: 'Other database (the app\'s)',
    ref: 'ljxqarhtycbsitzlojxy',
    host: 'aws-0-ap-south-1.pooler.supabase.com',
    port: 6543,
    schema: 'sad',
    checks: 'A real login with the app\'s own login (sad_app), then select 1. No data is read.',
  },
]

export type PingState = 'up' | 'down'

export interface PingResult {
  key: 'crm' | 'other'
  state: PingState
  /** Milliseconds the ping took, or null when it did not reach an answer at all. */
  latencyMs: number | null
  /** What was checked, in plain words (never a password, key or address beyond the fixed ones). */
  checked: string
  /** Why it is down, in plain words; null when up. */
  reason: string | null
  /** When the ping ran (ISO time). */
  at: string
}

export interface DatabasesAnswer {
  databases: readonly FixedDatabase[]
  /** The last ping per database (null: not pinged since the agent started). */
  last: Record<'crm' | 'other', PingResult | null>
}

export const isDatabaseKey = (v: unknown): v is 'crm' | 'other' => v === 'crm' || v === 'other'
