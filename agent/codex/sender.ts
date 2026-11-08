import { composer, menuOnScreen, ownedComposerTail } from './screen.ts'

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
export interface SenderIO {
  write(data: string): boolean
  lines(): string[]
  sleep(ms: number): Promise<void>
  /** External keystrokes invalidate paste ownership, even if they empty the composer. */
  interrupted?(): boolean
  gone?(): boolean
  /** Fresh authorization for this input only; denial never causes a repaste/retry. */
  beforeInput?(phase: 'paste' | 'submit'): Promise<boolean>
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
  const checkMs = o.checkMs ?? 1500
  const tries = Math.max(1, Math.min(3, o.tries ?? 3))
  const maxSettleMs = o.maxSettleMs ?? Math.min(300_000, Math.max(90_000, Buffer.byteLength(text) * 50))
  const timeoutMs = Math.min(300_000, o.timeoutMs ?? maxSettleMs + 6000)
  const deadline = Date.now() + timeoutMs
  let slept = 0
  const expired = () => Date.now() >= deadline || slept >= timeoutMs
  const sleep = async (ms: number) => { const wait = Math.max(0, Math.min(ms, timeoutMs - slept, deadline - Date.now())); await io.sleep(wait); slept += wait }
  const read = () => { try { return io.lines() } catch { return null } }
  const before = read()
  if (!before) return io.gone?.() ? 'gone' : 'blocked'
  if (menuOnScreen(before) || io.interrupted?.()) return 'blocked'
  const initial = composer(before)
  if (!initial || initial.text) return 'blocked'
  const pasted = text.split(PASTE_END).join('')
  if (!pasted.trim()) return 'blocked'
  if (expired()) return 'unconfirmed'
  if (io.beforeInput && !(await io.beforeInput('paste').catch(() => false))) return 'blocked'
  if (io.interrupted?.() || expired()) return 'unconfirmed'
  if (io.beforeInput) {
    const ready = read(), c = ready && composer(ready)
    if (!ready || menuOnScreen(ready) || !c || c.text) return 'blocked'
  }
  if (!io.write(PASTE_START)) return 'gone'
  for (let offset = 0; offset < pasted.length;) {
    if (io.interrupted?.() || expired()) { io.write(PASTE_END); return 'unconfirmed' }
    if (io.beforeInput && !(await io.beforeInput('paste').catch(() => false))) { io.write(PASTE_END); return 'unconfirmed' }
    if (io.interrupted?.() || expired()) { io.write(PASTE_END); return 'unconfirmed' }
    if (io.beforeInput) { const current = read(); if (!current || menuOnScreen(current)) { io.write(PASTE_END); return 'unconfirmed' } }
    let end = Math.min(offset + 1024, pasted.length)
    if (end < pasted.length && /[\uD800-\uDBFF]/.test(pasted[end - 1])) end--
    if (!io.write(pasted.slice(offset, end))) return 'gone'
    offset = end
    if (offset < pasted.length) await sleep(10)
  }
  if (!io.write(PASTE_END)) return 'gone'
  const expected = normalized(pasted)
  const currentOwned = (lines: string[]) => {
    const full = composer(lines)
    if (full && (full.collapsed || normalized(full.text) === expected)) return full
    // Tail recognition requires external-input ownership tracking, never just a footer.
    return io.interrupted ? ownedComposerTail(lines, pasted) : null
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
    if (menuOnScreen(lines)) return 'blocked'
    const c = currentOwned(lines)
    if (c && previous === c.text) { settled = true; ownedText = c.text; break }
    previous = c?.text
  }
  if (!settled) return 'unconfirmed'
  for (let attempt = 0; attempt < tries; attempt++) {
    if (io.interrupted?.() || expired()) return 'unconfirmed'
    const lines = read()
    if (!lines) return attemptedEnter ? 'unconfirmed' : io.gone?.() ? 'gone' : 'unconfirmed'
    if (menuOnScreen(lines)) return attemptedEnter ? 'unconfirmed' : 'blocked'
    const c = currentOwned(lines)
    if (!c || c.text !== ownedText) return 'unconfirmed'
    if (io.beforeInput && !(await io.beforeInput('submit').catch(() => false))) return 'unconfirmed'
    // Network authorization may have yielded while a person typed or a prompt changed.
    if (io.interrupted?.() || expired()) return 'unconfirmed'
    const fresh = read()
    if (!fresh || menuOnScreen(fresh) || currentOwned(fresh)?.text !== ownedText) return 'unconfirmed'
    attemptedEnter = true
    if (!io.write('\r')) return 'unconfirmed'
    await sleep(checkMs)
    if (io.interrupted?.() || expired()) return 'unconfirmed'
    const after = read()
    if (!after) return 'unconfirmed'
    if (menuOnScreen(after)) return 'unconfirmed'
    const next = composer(after)
    if (next && !next.text) return 'sent'
    // A clipped suffix can also be the newly submitted message in history. Without the
    // current prompt glyph after Enter, its commit is ambiguous: never press Enter again.
    if (!next || (!next.collapsed && normalized(next.text) !== expected) || next.text !== ownedText) return 'unconfirmed'
  }
  return 'unconfirmed'
}
