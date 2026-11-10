// Public, bounded diagnostics only: no text, credentials, paths or private runtime proofs.
export const DELIVERY_BLOCK_REASONS = [
  'stale-session', 'access-denied', 'owner-required', 'target-unavailable',
  'binding-changed', 'switch-in-progress', 'authorization-revoked', 'agent-closing',
  'runtime-unavailable', 'runtime-mismatch', 'generation-changed', 'pc-control-denied',
  'peer-unreachable', 'peer-delivery-unsupported', 'peer-authorization-unsupported', 'peer-blocked',
  'menu', 'draft', 'unresolved-send', 'composer-unavailable', 'screen-unavailable',
  'input-changed', 'empty-message', 'preflight-failed',
] as const
export type DeliveryBlockReason = typeof DELIVERY_BLOCK_REASONS[number]
export function isDeliveryBlockReason(value: unknown): value is DeliveryBlockReason {
  return typeof value === 'string' && (DELIVERY_BLOCK_REASONS as readonly string[]).includes(value)
}

// Which branch ended a delivery, and when each step happened. For explaining a false "unconfirmed" afterwards from the receipt and the
// log alone: stable codes and milliseconds only. No message text, screen text, paths or credentials. Never shown to the person.
export const DELIVERY_CAUSES = [
  'confirmed',
  'deadline',                   // the whole native budget was spent
  'terminal-input',             // a terminal input frame / approval key / restart /exit reached the chat (its input epoch moved)
  'guard-revoked',              // the binding, generation, access or authorization check failed mid-send
  'authorization-denied',       // the fresh per-input authorization said no
  'menu-appeared',
  'screen-unreadable',
  'not-settled',                // the owned text never showed in two identical frames
  'composer-changed',           // before Enter the box no longer held exactly the owned text
  'box-unreadable-after-enter', // 3 s with no readable input box after Enter
  'text-changed-after-enter',
  'enter-attempts-exhausted',
  'terminal-gone',
  'write-refused',
  'agent-closing',              // the agent/hub was closing while it was pending
  'agent-restarted',            // found pending when the agent started again
  'exception',
] as const
export type DeliveryCause = typeof DELIVERY_CAUSES[number]
export const DELIVERY_MARKS = ['wait-ready', 'paste', 'pasted', 'settled', 'enter-1', 'enter-2', 'enter-3', 'readback-1', 'readback-2', 'readback-3', 'end'] as const
export type DeliveryMark = typeof DELIVERY_MARKS[number]
/** `marks`: [step, milliseconds since the send began], in order, at most one per step per attempt. */
export interface DeliveryDiagnostic { cause: DeliveryCause; marks: [DeliveryMark, number][] }
const MARK_SET: readonly string[] = DELIVERY_MARKS, CAUSE_SET: readonly string[] = DELIVERY_CAUSES
/** Whatever arrives (a file, a peer PC) is cut down to this shape or dropped; it can never carry free text. */
export function cleanDeliveryDiagnostic(raw: unknown): DeliveryDiagnostic | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const { cause, marks } = raw as { cause?: unknown; marks?: unknown }
  if (typeof cause !== 'string' || !CAUSE_SET.includes(cause) || !Array.isArray(marks) || marks.length > 16) return undefined
  const clean: [DeliveryMark, number][] = []
  for (const m of marks) {
    if (!Array.isArray(m) || m.length !== 2 || typeof m[0] !== 'string' || !MARK_SET.includes(m[0]) || typeof m[1] !== 'number' || !Number.isFinite(m[1]) || m[1] < 0 || m[1] > 86_400_000) return undefined
    clean.push([m[0] as DeliveryMark, Math.round(m[1])])
  }
  return { cause: cause as DeliveryCause, marks: clean }
}
export const diagnosticWords = (d: DeliveryDiagnostic) => `cause=${d.cause} ${d.marks.map(([n, ms]) => `${n}=${ms}ms`).join(' ')}`.trim()

export function deliveryBlockWords(reason: DeliveryBlockReason, targetPcName?: string): string {
  const pc = targetPcName ? targetPcName.slice(0, 120) : 'the destination PC'
  switch (reason) {
    case 'peer-delivery-unsupported':
    case 'peer-authorization-unsupported': return `This chat runs on ${pc}, which does not support confirmed delivery (usually an older build). Update that PC. Nothing was typed.`
    case 'peer-unreachable': return `This chat runs on ${pc}, which did not answer the delivery check. Reconnect that PC and try a new send. Nothing was typed.`
    case 'stale-session': return 'The conversation changed before submission. Refresh the destination and review your kept draft before sending again. Nothing was typed.'
    case 'draft': return 'The terminal has an unsent draft. Inspect it before sending another message. Nothing new was typed.'
    case 'menu': return 'The terminal is waiting at a menu or permission prompt. Answer it in the terminal first. Nothing was typed.'
    case 'unresolved-send': return 'An earlier native delivery is still in progress. Check its submission before sending again. Nothing new was typed.'
    case 'access-denied': return 'You no longer have permission to type in this chat. Nothing was typed.'
    case 'owner-required': return 'Only the chat owner can start this stopped chat. Nothing was typed.'
    case 'authorization-revoked': return 'Typing authorization changed before submission. Sign in again and review your draft. Nothing was typed.'
    case 'binding-changed': return 'The chat, engine or computer changed before submission. Refresh the destination and review your draft. Nothing was typed.'
    case 'switch-in-progress': return 'This conversation is changing engines. Wait for it to finish. Nothing was typed.'
    case 'agent-closing': return 'The app is restarting. Wait for it to reconnect before a new send. Nothing was typed.'
    case 'runtime-unavailable':
    case 'target-unavailable': return 'The destination chat is not available yet. Refresh its status before a new send. Nothing was typed.'
    case 'runtime-mismatch':
    case 'generation-changed': return 'The destination terminal restarted or changed execution. Refresh the chat before a new send. Nothing was typed.'
    case 'pc-control-denied': return 'Typing into this PC-control chat is not authorized. Nothing was typed.'
    case 'composer-unavailable':
    case 'screen-unavailable': return 'The current terminal input could not be read safely. Inspect the terminal. Nothing was typed.'
    case 'input-changed': return 'Someone changed the terminal input before submission. Inspect it before a new send. Nothing was typed.'
    case 'empty-message': return 'There was no message text to submit. Nothing was typed.'
    case 'peer-blocked': return 'The destination PC refused this send without reporting a specific reason. Update that PC or inspect its terminal. Nothing was submitted.'
    case 'preflight-failed': return 'The delivery preflight failed before typing. Refresh the destination and review your kept draft.'
  }
}
