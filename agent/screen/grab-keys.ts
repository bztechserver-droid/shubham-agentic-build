// What the keyboard hook does with each key while Control has the focus (F-013), apart from
// Windows, so it can be tested: RustDesk's grab loop (src/keyboard.rs:612-701) on the
// controlling PC. While the window that asked stays in front, a key going down is kept from
// this PC and sent to the page, which sends it on; its going up too. Caps Lock and Num Lock stay
// with this PC (fix #2211 there), and so does input someone's software injected (this agent's
// own, when this PC is controlled too). A key that went down before the grab goes up here too.

import type { GrabbedKey } from '../../shared/agent-api.ts'

/** The hook thread's own messages (grab-worker.ts): WM_APP + 1 and + 2. */
export const GRAB = 0x8001
export const LET_GO = 0x8002


/** One low-level keyboard event (KBDLLHOOKSTRUCT). */
export interface HookEvent {
  vk: number
  scan: number
  flags: number
}

const LLKHF = { EXTENDED: 0x01, INJECTED: 0x10, UP: 0x80 }
const VK_PAUSE = 0x13
const VK_NUMLOCK = 0x90
/** AltGr sends a made-up Left Ctrl with this scan code first (keyboard.rs:643). */
const ALTGR_CTRL = 0x21d
const MODIFIER_VK: Record<number, keyof Omit<GrabbedKey, 'code' | 'down' | 'repeat'>> = {
  0xa0: 'shift',
  0xa1: 'shift',
  0xa2: 'ctrl',
  0xa3: 'ctrl',
  0xa4: 'alt',
  0xa5: 'alt',
  0x5b: 'meta',
  0x5c: 'meta',
}
/** Stay with this PC, as RustDesk lets them through. */
const NOT_TAKEN = new Set(['CapsLock', 'NumLock'])

/** KeyboardEvent.code by Windows scan code (0xE0xx for extended keys): WIN_SCANCODE turned round. */
export function codesByScan(winScancode: Readonly<Record<string, number>>): Map<number, string> {
  const out = new Map<number, string>()
  for (const [code, scan] of Object.entries(winScancode)) if (!out.has(scan)) out.set(scan, code)
  return out
}

/** The KeyboardEvent.code of a hook event, or null when the page couldn't send it on. */
export function codeOf(e: HookEvent, codes: ReadonlyMap<number, string>): string | null {
  if (e.vk === VK_PAUSE) return 'Pause'
  if (e.vk === VK_NUMLOCK) return 'NumLock'
  const scan = e.scan === ALTGR_CTRL ? 0x1d : e.scan & 0xff
  return codes.get((e.flags & LLKHF.EXTENDED ? 0xe000 : 0) | scan) ?? null
}

export interface Decision {
  /** Kept from this PC. */
  take: boolean
  /** For the page. */
  send?: GrabbedKey
  /** The window that asked isn't in front any more: the grab should end. */
  lost?: boolean
}

/**
 * The grab's state for one turn of the hook (from grab to letting go). `injected: 'only'` is for
 * tests: it takes what they inject and leaves real typing alone.
 */
export function createGrabState(codes: ReadonlyMap<number, string>, o: { injected?: 'skip' | 'only' } = {}) {
  const taken = new Set<string>()
  const held = { shift: new Set<number>(), ctrl: new Set<number>(), alt: new Set<number>(), meta: new Set<number>() }
  let lost = false

  return {
    /** `inFront`: the window that asked for the grab is still the one in front. */
    decide(e: HookEvent, inFront: boolean): Decision {
      const up = (e.flags & LLKHF.UP) !== 0
      const mod = MODIFIER_VK[e.vk]
      if (mod) {
        if (up) held[mod].delete(e.vk)
        else held[mod].add(e.vk)
      }
      if (Boolean(e.flags & LLKHF.INJECTED) !== (o.injected === 'only')) return { take: false }
      const code = codeOf(e, codes)
      if (!code || NOT_TAKEN.has(code)) return { take: false }
      const mods = { alt: held.alt.size > 0, ctrl: held.ctrl.size > 0, shift: held.shift.size > 0, meta: held.meta.size > 0 }
      if (up) {
        // One that went down before the grab (or after it ended) goes up on this PC.
        if (!taken.delete(code)) return { take: false }
        return { take: true, send: { code, down: false, repeat: false, ...mods } }
      }
      if (lost) return { take: false }
      if (!inFront) {
        lost = true
        return { take: false, lost: true }
      }
      const repeat = taken.has(code)
      taken.add(code)
      return { take: true, send: { code, down: true, repeat, ...mods } }
    },
    /** Keys taken and not yet up. */
    get held() {
      return [...taken]
    },
  }
}
