// Claude's own "you've hit your limit" row, as this app reads it (Claude subscription failover).
//
// When Anthropic turns a request down for a usage limit, claude (checked against 2.1.260-2.1.316)
// writes ONE synthetic assistant row to the chat's transcript (~/.claude/projects/<cwd>/<id>.jsonl)
// and stops the turn. A real one looks like this (ids shortened):
//
//   {"type":"assistant","uuid":"7d5e…","timestamp":"2026-09-10T10:52:56.206Z",
//    "message":{"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence",
//               "content":[{"type":"text","text":"You've hit your session limit · resets 6:30pm (Asia/Kolkata)"}]},
//    "quotaLimits":{"status":"rejected","resetsAt":1789045200,"rateLimitType":"five_hour", …},
//    "error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429, …}
//
// What each field is worth, and why this reads the way it does:
//   - isApiErrorMessage + quotaLimits.status "rejected" is claude's OWN record that the request
//     was refused for a limit. Text that merely says so is not: the sentence turns up quoted in
//     tool output, in a user's message, in an assistant's explanation, in a test fixture (this
//     very repo has several), and in transcripts of other chats. So only an assistant row that
//     claude marked as an API error can count, and a row that says "allowed_warning" never does.
//   - quotaLimits.rateLimitType names the window: five_hour (the "session" limit, back in hours),
//     seven_day (the weekly limit), seven_day_opus / seven_day_sonnet / seven_day_overage_included
//     (a weekly limit of one model), overage (extra-usage credits). That is the kind; the
//     sentence is only read when a version leaves the field out.
//   - quotaLimits.resetsAt is when that window ends, in epoch seconds.
// Everything else (a 429 that is not a usage limit, a spend cap, a warning, any other row) is not
// a hit: null. Missing one is safe (nothing switches); counting a wrong one is not.

export type LimitKind =
  /** The 5-hour window ("session limit"): back in hours, so it never switches the subscription by itself. */
  | 'session'
  /** The weekly window. */
  | 'weekly'
  /** The weekly limit of one model (Opus, Sonnet, Fable). */
  | 'model'
  /** Anything else claude refused for: extra-usage credits, a spend cap, a window it didn't name. */
  | 'other'

export interface LimitHit {
  kind: LimitKind
  /** quotaLimits.rateLimitType when the row has it: five_hour, seven_day, seven_day_opus, … */
  rateLimitType: string | null
  /** Claude's own name for it, from its sentence: "session limit", "weekly limit", "Opus limit". */
  scope: string | null
  /** When the window ends (ISO), or null when the row doesn't say. */
  resetsAt: string | null
  /** The row's own time (ISO), or null. */
  at: string | null
  /** The row's uuid, so one row is counted once. */
  uuid: string | null
  /** Claude's sentence, for the log. It holds no secret. */
  text: string
}

const TYPES: Record<string, LimitKind> = {
  five_hour: 'session',
  seven_day: 'weekly',
  seven_day_opus: 'model',
  seven_day_sonnet: 'model',
  seven_day_overage_included: 'model',
  overage: 'other',
}

/** "You've hit your session limit · resets 6:30pm (Asia/Kolkata)": anchored, so a quote inside other text never matches. */
const SENTENCE = /^\s*You[’']ve hit your ([^·\n]*?)\s*(?:·|$)/
/** What older claude printed: "Claude AI usage limit reached|1760000000". */
const LEGACY = /^\s*Claude AI usage limit reached\|(\d{9,13})\s*$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The first text block of an assistant message. */
function firstText(message: unknown): string | null {
  if (!isObject(message)) return null
  const c = message.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return null
  for (const b of c) if (isObject(b) && b.type === 'text' && typeof b.text === 'string') return b.text
  return null
}

/** Epoch seconds (or milliseconds) to ISO; null for anything that isn't a plausible time. */
function epochToIso(v: unknown): string | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = n > 1e11 ? n : n * 1000
  if (ms < Date.UTC(2020, 0, 1) || ms > Date.UTC(2100, 0, 1)) return null
  return new Date(ms).toISOString()
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null
}

/** Which kind claude's own words for the limit mean ("5-hour limit", "session limit", "weekly limit", "Opus limit", …). */
export function kindOfScope(scope: string): LimitKind {
  const s = scope.trim().toLowerCase()
  if (/^(5-hour|five-hour|session)\b/.test(s)) return 'session'
  if (/^weekly\b/.test(s)) return 'weekly'
  if (/^(opus|sonnet|fable)\b/.test(s)) return 'model'
  return 'other'
}

/**
 * One transcript row: claude's own usage-limit refusal, or null. `row` is the parsed JSON line.
 */
export function readLimitRow(row: unknown): LimitHit | null {
  if (!isObject(row) || row.type !== 'assistant' || row.isApiErrorMessage !== true) return null
  const text = firstText(row.message)
  const q = isObject(row.quotaLimits) ? row.quotaLimits : null
  const at = isoOrNull(row.timestamp)
  const uuid = typeof row.uuid === 'string' && row.uuid ? row.uuid : null

  if (q) {
    // claude's structured record of the refusal. Only "rejected" is a refusal; a warning is not.
    if (q.status !== 'rejected') return null
    const type = typeof q.rateLimitType === 'string' && q.rateLimitType ? q.rateLimitType : null
    const said = text ? SENTENCE.exec(text) : null
    const scope = said ? said[1].trim() || null : null
    const kind = type !== null && type in TYPES ? TYPES[type] : scope !== null ? kindOfScope(scope) : 'other'
    return { kind, rateLimitType: type, scope, resetsAt: epochToIso(q.resetsAt), at, uuid, text: (text ?? '').trim() }
  }

  if (text === null) return null
  const legacy = LEGACY.exec(text)
  if (legacy) return { kind: 'other', rateLimitType: null, scope: null, resetsAt: epochToIso(legacy[1]), at, uuid, text: text.trim() }
  const said = SENTENCE.exec(text)
  // A sentence on an API-error row of a version without quotaLimits. Only the words before "·" are the scope.
  if (said && (row.error === 'rate_limit' || row.apiErrorStatus === 429)) {
    const scope = said[1].trim() || null
    return { kind: scope === null ? 'other' : kindOfScope(scope), rateLimitType: null, scope, resetsAt: null, at, uuid, text: text.trim() }
  }
  return null
}

/** Is this hit still in force at `now`: its window hasn't ended (one that doesn't say counts for 6 hours after it was written). */
export function inForce(hit: LimitHit, now: number): boolean {
  if (hit.resetsAt !== null) return Date.parse(hit.resetsAt) > now
  return hit.at !== null && now - Date.parse(hit.at) < 6 * 60 * 60 * 1000
}

/** Does this hit say the subscription's weekly allowance is used (so a switch could help for days, not hours)? */
export const isWeeklyLike = (hit: LimitHit) => hit.kind === 'weekly' || hit.kind === 'model'
