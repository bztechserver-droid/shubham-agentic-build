// F-075: a tool call made while the agent is away (it is restarting for an update) waits for it instead of failing:
// the chat that made it is still running, in the chat host, and its model would otherwise be told "couldn't reach
// the agent" in the middle of its work. Only a connection that was REFUSED is tried again: nothing listened, so
// the call never arrived and cannot be done twice. Any other failure (a reset or a timeout in mid-call, when the
// agent may have done it) is the caller's, as before.

const refusedCode = (e: unknown): boolean => {
  if (typeof e !== 'object' || e === null) return false
  const o = e as { code?: unknown; cause?: unknown; errors?: unknown }
  if (o.code === 'ECONNREFUSED') return true
  if (Array.isArray(o.errors) && o.errors.length > 0 && o.errors.every(refusedCode)) return true
  return o.cause !== undefined && refusedCode(o.cause)
}

/** True when `e` is a fetch that found nothing listening. */
export const isRefused = refusedCode

export interface RetryOptions {
  /** Give up after this long (ms) of waiting. */
  maxWaitMs: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** The pauses between tries; the last repeats. */
  stepsMs?: readonly number[]
}

export async function retryWhileRefused<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  const steps = o.stepsMs?.length ? o.stepsMs : [500, 1000, 2000, 3000]
  const end = now() + o.maxWaitMs
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!refusedCode(e) || now() >= end) throw e
      await sleep(Math.min(steps[Math.min(i, steps.length - 1)], Math.max(0, end - now())))
    }
  }
}
