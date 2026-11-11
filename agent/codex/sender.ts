import { composer, menuOnScreen, ownedComposerTail } from './screen.ts'
import type { DeliveryBlockReason, DeliveryCause, DeliveryMark } from '../../shared/delivery-reason.ts'

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
/** Diagnostics only: which branch ended a send and when each step happened (ms since it began). Never any text. */
export interface DeliveryReport { result: SendResult; cause: DeliveryCause; marks: [DeliveryMark, number][] }
export interface SenderIO {
  write(data: string): boolean
  lines(): string[]
  /** A non-Codex TUI adapter has already proved its own box/menu boundaries. */
  frame?(lines: string[]): { menu: boolean; composer: { text: string; collapsed: boolean } | null }
  sleep(ms: number): Promise<void>
  /** External keystrokes invalidate paste ownership, even if they empty the composer. */
  interrupted?(): boolean
  /** Which of the two things made interrupted() true (default: a terminal input frame). Diagnostics only. */
  interruptCause?(): 'terminal-input' | 'guard-revoked'
  gone?(): boolean
  /** Fresh authorization for this input only; denial never causes a repaste/retry. */
  beforeInput?(phase: 'paste' | 'submit'): Promise<boolean>
  /** A pre-paste refusal only. Once input starts, failure is uncertain, never retry-safe. */
  onBlocked?(reason: DeliveryBlockReason): void
  /** Called once when the send ends, for sent/unconfirmed/gone and for a refusal that had to be relabelled. Diagnostics only. */
  report?(report: DeliveryReport): void
  /**
   * o655f (Stage 1): true once claude itself said it TOOK this exact text (its UserPromptSubmit hook, 10-110 ms after Enter). That is proof of
   * submission by whoever pressed the Enter, so it ends the send as sent at once, before and instead of any screen reading or input check.
   */
  confirmed?(): boolean
}
export type SendResult = 'sent' | 'blocked' | 'unconfirmed' | 'gone'
export interface SendOptions {
  settleMs?: number
  checkMs?: number
  tries?: number
  maxSettleMs?: number
  /** Entire native transaction budget. Tool callers independently bound their confirmation wait. */
  timeoutMs?: number
  /**
   * F-193: the words are already in the box, typed there by the live mirror (or by him in the terminal): nothing is pasted, the box must
   * hold exactly them, and only the settle, Enter and read-back steps run. A box holding anything else is refused as a draft.
   */
  preTyped?: boolean
}
const normalized = (s: string) => s.replace(/\s+/g, '')

/** Working output alone never proves acceptance. Only submit the owned composer. */
export async function sendToCodex(io: SenderIO, text: string, o: SendOptions = {}): Promise<SendResult> {
  const settleMs = Math.max(1, o.settleMs ?? 2000)
  const checkMs = Math.max(1, o.checkMs ?? 1500)
  const tries = Math.max(1, Math.min(3, o.tries ?? 3))
  const maxSettleMs = o.maxSettleMs ?? Math.min(300_000, Math.max(90_000, Buffer.byteLength(text) * 50))
  const timeoutMs = Math.min(300_000, o.timeoutMs ?? maxSettleMs + 6000)
  const started = Date.now()
  const deadline = started + timeoutMs
  let slept = 0
  const expired = () => Date.now() >= deadline || slept >= timeoutMs
  const sleep = async (ms: number) => { const wait = Math.max(0, Math.min(ms, timeoutMs - slept, deadline - Date.now())); await io.sleep(wait); slept += wait }
  const marks: [DeliveryMark, number][] = []
  const mark = (name: DeliveryMark) => { if (marks.length < 16) marks.push([name, Date.now() - started]) }
  const finish = (result: SendResult, cause: DeliveryCause): SendResult => { mark('end'); try { io.report?.({ result, cause, marks }) } catch { /* diagnostics never change a delivery */ } return result }
  const interrupted = () => io.interrupted?.() === true
  const why = (): DeliveryCause => io.interruptCause?.() ?? 'terminal-input'
  const read = () => { try { return io.lines() } catch { return null } }
  const menu = (lines: string[]) => io.frame ? io.frame(lines).menu : menuOnScreen(lines)
  const input = (lines: string[]) => io.frame ? io.frame(lines).composer : composer(lines)
  const blocked = (reason: DeliveryBlockReason): SendResult => { io.onBlocked?.(reason); return 'blocked' }
  // Nothing of the message was typed: a refusal, safe to send again. (Used for the cases that used to be called unconfirmed.)
  const blockedWith = (reason: DeliveryBlockReason, cause: DeliveryCause): SendResult => { io.onBlocked?.(reason); return finish('blocked', cause) }
  const before = read()
  if (!before) return io.gone?.() ? 'gone' : blocked('screen-unavailable')
  if (menu(before)) return blocked('menu')
  if (io.interrupted?.()) return blocked('input-changed')
  const initial = input(before)
  if (!initial) return blocked('composer-unavailable')
  const pasted = text.split(PASTE_END).join('')
  if (o.preTyped) {
    if (!pasted.trim()) return blocked('empty-message')
    if (!initial.text || initial.collapsed || normalized(initial.text) !== normalized(pasted)) return blocked('draft')
    if (expired()) return blockedWith('preflight-failed', 'deadline')
    if (interrupted()) return blockedWith('input-changed', why())
    mark('pasted')
    return submitOwned()
  }
  if (initial.text) return blocked('draft')
  if (!pasted.trim()) return blocked('empty-message')
  if (expired()) return blockedWith('preflight-failed', 'deadline')
  if (io.beforeInput && !(await io.beforeInput('paste').catch(() => false))) return blocked('authorization-revoked')
  if (interrupted()) return blockedWith('input-changed', why())
  if (expired()) return blockedWith('preflight-failed', 'deadline')
  if (io.beforeInput) {
    const ready = read(), c = ready && input(ready)
    if (!ready) return blocked('screen-unavailable')
    if (menu(ready)) return blocked('menu')
    if (!c) return blocked('composer-unavailable')
    if (c.text) return blocked('draft')
  }
  mark('paste')
  if (!io.write(PASTE_START)) return finish('gone', 'write-refused')
  for (let offset = 0; offset < pasted.length;) {
    // Before the first chunk only the paste brackets were written: nothing of the message is in the terminal, so a stop here is a safe refusal.
    const stop = (reason: DeliveryBlockReason, cause: DeliveryCause): SendResult => { io.write(PASTE_END); return offset === 0 ? blockedWith(reason, cause) : finish('unconfirmed', cause) }
    if (interrupted()) return stop('input-changed', why())
    if (expired()) return stop('preflight-failed', 'deadline')
    if (io.beforeInput && !(await io.beforeInput('paste').catch(() => false))) return stop('authorization-revoked', 'authorization-denied')
    if (interrupted()) return stop('input-changed', why())
    if (expired()) return stop('preflight-failed', 'deadline')
    if (io.beforeInput) { const current = read(); if (!current || menu(current)) return stop(!current ? 'screen-unavailable' : 'menu', !current ? 'screen-unreadable' : 'menu-appeared') }
    let end = Math.min(offset + 1024, pasted.length)
    if (end < pasted.length && /[\uD800-\uDBFF]/.test(pasted[end - 1])) end--
    if (!io.write(pasted.slice(offset, end))) return finish('gone', 'write-refused')
    offset = end
    if (offset < pasted.length) await sleep(10)
  }
  if (!io.write(PASTE_END)) return finish('gone', 'write-refused')
  mark('pasted')
  return submitOwned()

  /** From the words in the box (pasted above, or already typed: preTyped) to a confirmed submit: settle, Enter, read back. */
  async function submitOwned(): Promise<SendResult> {
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
    if (io.confirmed?.()) return finish('sent', 'confirmed')
    if (interrupted()) return finish('unconfirmed', why())
    if (expired()) return finish('unconfirmed', 'deadline')
    const lines = read()
    if (!lines) return io.gone?.() ? finish('gone', 'terminal-gone') : finish('unconfirmed', 'screen-unreadable')
    if (menu(lines)) return finish('unconfirmed', 'menu-appeared')
    const c = currentOwned(lines)
    if (c && previous === c.text) { settled = true; ownedText = c.text; mark('settled'); break }
    previous = c?.text
  }
  if (!settled) return finish('unconfirmed', 'not-settled')
  for (let attempt = 0; attempt < tries; attempt++) {
    if (io.confirmed?.()) return finish('sent', 'confirmed')
    if (interrupted()) return finish('unconfirmed', why())
    if (expired()) return finish('unconfirmed', 'deadline')
    const lines = read()
    if (!lines) return attemptedEnter ? finish('unconfirmed', 'screen-unreadable') : io.gone?.() ? finish('gone', 'terminal-gone') : finish('unconfirmed', 'screen-unreadable')
    if (menu(lines)) return finish('unconfirmed', 'menu-appeared')
    const c = currentOwned(lines)
    if (!c || c.text !== ownedText) return finish('unconfirmed', 'composer-changed')
    if (io.beforeInput && !(await io.beforeInput('submit').catch(() => false))) return finish('unconfirmed', 'authorization-denied')
    // Network authorization may have yielded while a person typed or a prompt changed.
    if (interrupted()) return finish('unconfirmed', why())
    if (expired()) return finish('unconfirmed', 'deadline')
    const fresh = read()
    if (!fresh) return finish('unconfirmed', 'screen-unreadable')
    if (menu(fresh)) return finish('unconfirmed', 'menu-appeared')
    if (currentOwned(fresh)?.text !== ownedText) return finish('unconfirmed', 'composer-changed')
    attemptedEnter = true
    mark(`enter-${attempt + 1}` as DeliveryMark)
    if (!io.write('\r')) return finish('unconfirmed', 'write-refused')
    // Submit redraws can temporarily erase the whole input box. Observe for a
    // bounded window; missing input or running output alone is never acceptance.
    let unchangedOwned = false
    for (let waited = 0; waited < 3000;) {
      const interval = Math.min(checkMs, 3000 - waited)
      // With claude's own word available it is looked for every 100 ms (the hook lands within about 110 ms), the box only every checkMs.
      if (io.confirmed) for (let left = interval; left > 0; left -= 100) { await sleep(Math.min(100, left)); if (io.confirmed()) return finish('sent', 'confirmed') }
      else await sleep(interval)
      waited += interval
      if (io.confirmed?.()) return finish('sent', 'confirmed')
      if (interrupted()) return finish('unconfirmed', why())
      if (expired()) return finish('unconfirmed', 'deadline')
      if (io.gone?.()) return finish('unconfirmed', 'terminal-gone')
      const after = read()
      if (!after) continue
      if (menu(after)) return finish('unconfirmed', 'menu-appeared')
      const next = input(after)
      if (!next) continue
      if (!next.text) { mark(`readback-${attempt + 1}` as DeliveryMark); return finish('sent', 'confirmed') }
      if ((!next.collapsed && normalized(next.text) !== expected) || next.text !== ownedText) return finish('unconfirmed', 'text-changed-after-enter')
      unchangedOwned = true
      mark(`readback-${attempt + 1}` as DeliveryMark)
      break
    }
    // Retry Enter only with the same readable owned text, exactly as before.
    // An absent/clipped/unreadable box never authorizes another Enter.
    if (!unchangedOwned) return finish('unconfirmed', 'box-unreadable-after-enter')
  }
  return finish('unconfirmed', 'enter-attempts-exhausted')
  }
}
