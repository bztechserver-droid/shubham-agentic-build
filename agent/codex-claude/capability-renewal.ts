/** The PC's Codex in Claude Code proof (a real Sol/max request plus the Claude harness probe) is accepted for 24 hours. */
export const CAPABILITY_MAX_AGE_MS = 86_400_000
/** It is renewed in the background once it is this old, so opens and running chats never meet an expired proof. */
export const CAPABILITY_RENEW_AFTER_MS = 20 * 3_600_000
/** How often the age is looked at. */
export const CAPABILITY_RENEW_CHECK_MS = 15 * 60_000
const RETRY_MS = [5_000, 15_000, 60_000, 120_000] as const

/** Due once the proof is 20 h old, or when its time cannot be read. Never before. */
export function renewalDue(verifiedAt: unknown, now: number): boolean {
  const at = typeof verifiedAt === 'string' ? Date.parse(verifiedAt) : Number.NaN
  return !Number.isFinite(at) || at > now || now - at >= CAPABILITY_RENEW_AFTER_MS
}

/** Back-off for retrying a failed start-up of the bridge (the chat host not back yet, a slow check): 5 s, 15 s, 1 min, then every 2 min. */
export function initRetryDelay(attempt: number): number {
  return RETRY_MS[Math.min(Math.max(0, Math.trunc(attempt) || 0), RETRY_MS.length - 1)]
}
