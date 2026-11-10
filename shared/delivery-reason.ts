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
