import type { Runner } from '../drive/tailscale.ts'

// F-116: on Linux, `tailscale serve` and `tailscale cert` work only for root or for Tailscale's operator (one user that tailscaled lets change its settings).
// `tailscale status` and `whois`, which the Ports gate needs to know who is asking, work for everyone. So Ports reads `tailscale debug prefs` (allowed for
// any user, nothing changed) and, when this user is not the operator, the page says so in one line with the one command to run once. The app never runs sudo.

export interface TailscaleRights {
  /** One plain sentence for the page. */
  text: string
  /** What to type once, in a terminal on this PC. */
  command: string
}

export const OPERATOR_COMMAND = 'sudo tailscale set --operator=$USER'
export const OPERATOR_TEXT =
  'On Linux, Tailscale lets only its operator share ports, and this PC’s user is not its operator yet. Run this once in a terminal on this PC, then come back:'

/**
 * Null when nothing is missing: not Linux, the agent runs as root, this user is the operator, or Tailscale's settings can't be read (then Tailscale's own error
 * says the rest when a share is tried).
 */
export async function readTailscaleRights(run: Runner, o: { platform: string; user: string; uid: number }): Promise<TailscaleRights | null> {
  if (o.platform !== 'linux' || o.uid === 0) return null
  const r = await run(['debug', 'prefs']).catch(() => null)
  if (!r || r.code !== 0) return null
  let operator: unknown
  try {
    operator = (JSON.parse(r.stdout) as { OperatorUser?: unknown }).OperatorUser
  } catch {
    return null
  }
  if (typeof operator === 'string' && operator === o.user) return null
  return { text: OPERATOR_TEXT, command: OPERATOR_COMMAND }
}
