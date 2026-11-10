import { composer, menuOnScreen, ownedComposerTail } from './screen.ts'
import type { DeliveryBlockReason } from '../../shared/delivery-reason.ts'

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
export interface SenderIO {
  write(data: string): boolean
  lines(): string[]
  /** A non-Codex TUI adapter has already proved its own box/menu boundaries. */
  frame?(lines: string[]): { menu: boolean; composer: { text: string; collapsed: boolean } | null }
  sleep(ms: number): Promise<void>
  /** External keystrokes invalidate paste ownership, even if they empty the composer. */
  interrupted?(): boolean
  gone?(): boolean
  /** Fresh authorization for this input only; denial never causes a repaste/retry. */
  beforeInput?(phase: 'paste' | 'submit'): Promise<boolean>
  /** A pre-paste refusal only. Once input starts, failure is uncertain, never retry-safe. */
  onBlocked?(reason: DeliveryBlockReason): void
}
export type SendResult = 'sent' | 'blocked' | 'unconfirmed' | 'gone'
export interface SendOptions {
  settleMs?: number
  checkMs?: number
  tries?: number
  maxSettleMs?: number
  /** Entire native transaction budget. Tool callers independently bound their confirmation wait. */
  timeoutMs?: number
}
const normalized = (s: string) => s.replace(/\s+/g, '')

/** Working output alone never proves acceptance. Only submit the owned composer. */
export async function sendToCodex(io: SenderIO, text: string, o: SendOptions = {}): Promise<SendResult> {
  const settleMs = Math.max(1, o.settleMs ?? 2000)
  const checkMs = Math.max(1, o.checkMs ?? 1500)
  const tries = Math.max(1, Math.min(3, o.tries ?? 3))
  const maxSettleMs = o.maxSettleMs ?? Math.min(300_000, Math.max(90_000, Buffer.byteLength(text) * 50))
  const timeoutMs = Math.min(300_000, o.timeoutMs ?? maxSettleMs + 6000)
  const deadline = Date.now() + timeoutMs
  let slept = 0
  const expired = () => Date.now() >= deadline || slept >= timeoutMs
  const sleep = async (ms: number) => { const wait = Math.max(0, Math.min(ms, timeoutMs - slept, deadline - Date.now())); await io.sleep(wait); slept += wait }
  const read = () => { try { return io.lines() } catch { return null } }
  const menu = (lines: string[]) => io.frame ? io.frame(lines).menu : menuOnScreen(lines)
  const input = (lines: string[]) => io.frame ? io.frame(lines).composer : composer(lines)
  const blocked = (reason: DeliveryBlockReason): SendResult => { io.onBlocked?.(reason); return 'blocked' }
  const before = read()
  if (!before) return io.gone?.() ? 'gone' : blocked('screen-unavailable')
  if (menu(before)) return blocked('menu')
  if (io.interrupted?.()) return blocked('input-changed')
  const initial = input(before)
  if (!initial) return blocked('composer-unavailable')
  if (initial.text) return blocked('draft')
  const pasted = text.split(PASTE_END).join('')
  if (!pasted.trim()) return blocked('empty-message')
  if (expired()) return 'unconfirmed'
  if (io.beforeInput && !(await io.beforeInput('paste').catch(() => false))) return blocked('authorization-revoked')
  if (io.interrupted?.() || expired()) return 'unconfirmed'
  if (io.beforeInput) {
    const ready = read(), c = ready && input(ready)
    if (!ready) return blocked('screen-unavailable')
    if (menu(ready)) return blocked('menu')
    if (!c) return blocked('composer-unavailable')
    if (c.text) return blocked('draft')
  }
  if (!io.write(PASTE_START)) return 'gone'
  for (let offset = 0; offset < pasted.length;) {
    if (io.interrupted?.() || expired()) { io.write(PASTE_END); return 'unconfirmed' }
    if (io.beforeInput && !(await io.beforeInput('paste').catch(() => false))) { io.write(PASTE_END); return 'unconfirmed' }
    if (io.interrupted?.() || expired()) { io.write(PASTE_END); return 'unconfirmed' }
    if (io.beforeInput) { const current = read(); if (!current || menu(current)) { io.write(PASTE_END); return 'unconfirmed' } }
    let end = Math.min(offset + 1024, pasted.length)
    if (end < pasted.length && /[\uD800-\uDBFF]/.test(pasted[end - 1])) end--
    if (!io.write(pasted.slice(offset, end))) return 'gone'
    offset = end
    if (offset < pasted.length) await sleep(10)
  }
  if (!io.write(PASTE_END)) return 'gone'
  const expected = normalized(pasted)
  const currentOwned = (lines: string[]) => {
    const full = input(lines)
    if (full && (full.collapsed || normalized(full.text) === expected)) return full
    // Tail recognition requires external-input ownership tracking, never just a footer.
    return !io.frame && io.interrupted ? ownedComposerTail(lines, pasted) : null
  }
  let previous: string | undefined
  let ownedText: string | undefined
  let settled = false
  let attemptedEnter = false
  for (let poll = 0; poll <= Math.ceil(maxSettleMs / settleMs); poll++) {
    await sleep(settleMs)
    if (io.interrupted?.() || expired()) return 'unconfirmed'
    const lines = read()
    if (!lines) return io.gone?.() ? 'gone' : 'unconfirmed'
    if (menu(lines)) return 'unconfirmed'
    const c = currentOwned(lines)
    if (c && previous === c.text) { settled = true; ownedText = c.text; break }
    previous = c?.text
  }
  if (!settled) return 'unconfirmed'
  for (let attempt = 0; attempt < tries; attempt++) {
    if (io.interrupted?.() || expired()) return 'unconfirmed'
    const lines = read()
    if (!lines) return attemptedEnter ? 'unconfirmed' : io.gone?.() ? 'gone' : 'unconfirmed'
    if (menu(lines)) return 'unconfirmed'
    const c = currentOwned(lines)
    if (!c || c.text !== ownedText) return 'unconfirmed'
    if (io.beforeInput && !(await io.beforeInput('submit').catch(() => false))) return 'unconfirmed'
    // Network authorization may have yielded while a person typed or a prompt changed.
    if (io.interrupted?.() || expired()) return 'unconfirmed'
    const fresh = read()
    if (!fresh || menu(fresh) || currentOwned(fresh)?.text !== ownedText) return 'unconfirmed'
    attemptedEnter = true
    if (!io.write('\r')) return 'unconfirmed'
    // Submit redraws can temporarily erase the whole input box. Observe for a
    // bounded window; missing input or running output alone is never acceptance.
    let unchangedOwned = false
    for (let waited = 0; waited < 3000;) {
      const interval = Math.min(checkMs, 3000 - waited)
      await sleep(interval)
      waited += interval
      if (io.interrupted?.() || expired() || io.gone?.()) return 'unconfirmed'
      const after = read()
      if (!after) continue
      if (menu(after)) return 'unconfirmed'
      const next = input(after)
      if (!next) continue
      if (!next.text) return 'sent'
      if ((!next.collapsed && normalized(next.text) !== expected) || next.text !== ownedText) return 'unconfirmed'
      unchangedOwned = true
      break
    }
    // Retry Enter only with the same readable owned text, exactly as before.
    // An absent/clipped/unreadable box never authorizes another Enter.
    if (!unchangedOwned) return 'unconfirmed'
  }
  return 'unconfirmed'
}
