import { readFileSync, rmSync } from 'node:fs'
import type { SwitchBy, SwitchRecord, SwitchSubscription } from '../../shared/claude-switch.ts'
import { writeAtomic } from '../config.ts'
import type { SeenCap, SeenCaps } from './choices.ts'

// claude-switch.json: what the app remembers of Claude subscription switches (agent/claude/).
// The log of switches, whether to switch by itself, the last automatic switch (so it never flips
// back and forth), and the caps the app has seen. NOTHING SECRET: a subscription is its id, its
// name and the last four characters of its token; no token, cookie or password is ever written.

export const LOG_KEEP = 100
/** After the app switched by itself it won't again for this long: both subscriptions used up is "stop", not a ping-pong. */
export const AUTO_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** The last automatic switch. The app does not switch back to `from` while it is blocked. */
export interface Episode {
  from: SwitchSubscription
  to: SwitchSubscription
  at: string
  /** `from` ran out of week; it is back at this time (claude's own reset time, else a week after `at`). */
  blockedUntil: string
}

export interface SwitchState {
  version: 1
  /** The CRM user this belongs to: another person signing in starts clean. */
  userId: string | null
  /** Switch by itself when the weekly limit is used up. On, unless the person turned it off. */
  auto: boolean
  /** Newest first. */
  log: SwitchRecord[]
  /** When the app put the person on the subscription they are on, and why. */
  since: { subscriptionId: string; at: string; by: SwitchBy | 'crm' } | null
  episode: Episode | null
  seen: SeenCaps
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const iso = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v))
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function sub(v: unknown): SwitchSubscription | null {
  if (!isObject(v) || !str(v.id) || !str(v.name)) return null
  return { id: v.id, name: v.name, hint: str(v.hint) ? v.hint : null }
}

function record(v: unknown): SwitchRecord | null {
  if (!isObject(v) || !iso(v.at) || (v.by !== 'auto' && v.by !== 'manual') || !str(v.why)) return null
  const from = sub(v.from)
  const to = sub(v.to)
  if (!from || !to) return null
  const names = (x: unknown) => (Array.isArray(x) ? x.filter(str) : [])
  return { at: v.at, by: v.by, from, to, why: v.why, restarted: names(v.restarted), warnings: names(v.warnings) }
}

function seenCap(v: unknown): SeenCap | null {
  if (!isObject(v) || numOrNull(v.percent) === null || !iso(v.at)) return null
  return {
    percent: v.percent as number,
    source: v.source === 'person' ? 'person' : 'default',
    usedPercent: numOrNull(v.usedPercent),
    over: v.over === true,
    weekResetsAt: iso(v.weekResetsAt) ? v.weekResetsAt : null,
    at: v.at,
  }
}

export function emptyState(): SwitchState {
  return { version: 1, userId: null, auto: true, log: [], since: null, episode: null, seen: {} }
}

/** The file, tolerantly: anything unreadable or wrong in it is left out, never thrown. */
export function parseState(raw: unknown): SwitchState {
  const s = emptyState()
  if (!isObject(raw)) return s
  if (str(raw.userId)) s.userId = raw.userId
  if (raw.auto === false) s.auto = false
  if (Array.isArray(raw.log)) s.log = raw.log.map(record).filter((r): r is SwitchRecord => r !== null).slice(0, LOG_KEEP)
  if (isObject(raw.since) && str(raw.since.subscriptionId) && iso(raw.since.at) && (raw.since.by === 'auto' || raw.since.by === 'manual' || raw.since.by === 'crm')) {
    s.since = { subscriptionId: raw.since.subscriptionId, at: raw.since.at, by: raw.since.by }
  }
  if (isObject(raw.episode)) {
    const from = sub(raw.episode.from)
    const to = sub(raw.episode.to)
    if (from && to && iso(raw.episode.at) && iso(raw.episode.blockedUntil)) s.episode = { from, to, at: raw.episode.at, blockedUntil: raw.episode.blockedUntil }
  }
  if (isObject(raw.seen)) {
    for (const [id, v] of Object.entries(raw.seen)) {
      const c = seenCap(v)
      if (c) s.seen[id] = c
    }
  }
  return s
}

export interface SwitchStore {
  /** The state as it is now. Don't change it: use update(). */
  state(): SwitchState
  /** Changes the state and writes it. */
  update(change: (s: SwitchState) => void): SwitchState
  /** Forgets everything, and the file with it (sign-out, or another person signing in). */
  clear(): void
}

/** `file` null: kept in memory only (a test, or a PC with no state folder). Nothing is written until something changes. */
export function openSwitchStore(file: string | null): SwitchStore {
  let state: SwitchState
  try {
    state = file === null ? emptyState() : parseState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    state = emptyState()
  }
  return {
    state: () => state,
    update(change) {
      const next = structuredClone(state)
      change(next)
      next.log = next.log.slice(0, LOG_KEEP)
      if (file !== null) writeAtomic(file, JSON.stringify(next, null, 2) + '\n', 0o600)
      state = next
      return state
    },
    clear() {
      state = emptyState()
      if (file !== null) rmSync(file, { force: true })
    },
  }
}
