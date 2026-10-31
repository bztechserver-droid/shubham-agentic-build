import { readFileSync, rmSync } from 'node:fs'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'

// Keeping this PC within reach, and its display on, for Control through the app (F-006, added
// 2026-10-30). Windows keeps one execution state per thread, so both reasons meet here:
//   controlled  someone is controlling this PC: the system and the display stay awake, as
//               RustDesk's WakeLock keeps them for an incoming session (windows.rs:3188-3224)
//   reachable   "Stay reachable for Control" (on by default) while on mains power: the system
//               doesn't fall asleep by itself (in standby Windows pauses the agent and may turn
//               the network off), so the link stays up and Control can come in and wake the
//               display; the display still turns off as usual. A sleep someone chooses (power
//               button, lid, Start › Sleep) ends this hold, as it ends every power request
//               (PowerSetRequest, Remarks). On battery the PC sleeps as Windows likes.
// The power source is read again every 30 s.
//
// So that the power button and the lid don't put it out of reach either (added 2026-10-30, after
// a press of this PC's power button did), "Stay reachable" also has the power plan, plugged in
// only, do nothing for both: the PC then only ever goes dark by its display timeout, which the
// hold keeps short of sleep. (Turning the display off for the button was tried first: on a Modern
// Standby PC that is still a sleep, "Reason: Power Button", 19:04:53.) What a plan had before is
// kept, per plan, in
// <state>/agent/power-buttons.json and put back when "Stay reachable" is turned off, where nobody
// has changed it since; a plan someone changed back after this set it is left as they made it.

export const POWER_POLL_MS = 30_000

/** Windows' numbers for what a power button or lid does (the lid has no 4). */
export const BUTTON_ACTIONS = ['do nothing', 'sleep', 'hibernate', 'shut down', 'turn the display off'] as const

/** Plugged in, these keep a PC reachable: the power button and the lid do nothing. */
export const REACHABLE_BUTTONS = { power: 0, lid: 0 } as const

/**
 * What this app sets, now or before (4, the display off, by the first version): a value still one
 * of these is its own to change again or put back.
 */
const OURS = { power: [0, 4], lid: [0] }
const ours = (b: { power: number; lid: number }) => OURS.power.includes(b.power) && OURS.lid.includes(b.lid)

/** What the power button and the lid do while plugged in, on one power plan. */
export interface PlanButtons {
  scheme: string
  power: number
  lid: number
}

/** The Windows calls this needs (win32.ts), or a stand-in for tests. */
export interface PowerPort {
  holdAwake(system: boolean, display: boolean): void
  onMains(): boolean | null
  /** The active plan's when none is named; null when Windows won't say. */
  buttons?(scheme?: string): PlanButtons | null
  /** False when Windows refused. */
  setButtons?(scheme: string, b: { power: number; lid: number }): boolean
}

export interface PowerStatus {
  /** On mains power now; null when Windows can't tell (then treated as mains). */
  onMains: boolean | null
  /** The app is keeping the system awake now (reachable, or being controlled). */
  awake: boolean
  /** What the power button and lid do while plugged in, on the active plan; null when unknown. */
  buttons: { power: number; lid: number } | null
}

export interface Power {
  status(): PowerStatus
  setReachable(on: boolean): void
  setControlled(on: boolean): void
  /** Lets go of everything (the agent is stopping). The power plan stays as it is. */
  close(): void
}

/** Per plan, what it had before this changed it. */
type Kept = Record<string, { power: number; lid: number }>

const actionName = (n: number) => BUTTON_ACTIONS[n] ?? `action ${n}`
const actions = (b: { power: number; lid: number }) => `power button: ${actionName(b.power)}, lid: ${actionName(b.lid)}`
const same = (a: { power: number; lid: number } | null, b: { power: number; lid: number } | null) => a?.power === b?.power && a?.lid === b?.lid

export function createPower(o: {
  port: PowerPort | null
  reachable: boolean
  log: Logger
  onChange(): void
  pollMs?: number
  /** Where the plans' own power button and lid actions are kept while this has changed them. */
  buttonsFile?: string
}): Power {
  const { port, log } = o
  let reachable = o.reachable
  let controlled = false
  let mains = port?.onMains() ?? null
  let held = { system: false, display: false }

  // Tells whoever made this when the hold changes, but not the first time: it is still being set
  // up then (the agent's own state was half made when this told it once, and it crashed). True
  // when the hold changed.
  function apply(tell = true): boolean {
    if (!port) return false
    const system = controlled || (reachable && mains !== false)
    const display = controlled
    if (system === held.system && display === held.display) return false
    held = { system, display }
    port.holdAwake(system, display)
    log.info(
      display
        ? 'keeping this PC and its display awake while it is controlled'
        : system
          ? 'keeping this PC reachable for Control while it is on mains power (its display may still turn off)'
          : mains === false && reachable
            ? 'on battery: this PC may sleep, and other PCs can’t reach it until it wakes'
            : 'this PC may sleep as Windows likes',
    )
    if (tell) o.onChange()
    return true
  }
  apply(false)

  function loadKept(): Kept {
    if (!o.buttonsFile) return {}
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(o.buttonsFile, 'utf8'))
    } catch {
      return {}
    }
    const kept: Kept = {}
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return kept
    for (const [scheme, v] of Object.entries(raw)) {
      const b = v as { power?: unknown; lid?: unknown } | null
      if (Number.isInteger(b?.power) && Number.isInteger(b?.lid)) kept[scheme] = { power: b!.power as number, lid: b!.lid as number }
    }
    return kept
  }

  function storeKept(kept: Kept) {
    if (!o.buttonsFile) return
    if (Object.keys(kept).length) writeAtomic(o.buttonsFile, `${JSON.stringify(kept, null, 2)}\n`)
    else rmSync(o.buttonsFile, { force: true })
  }

  /** `asked`: just turned on, so set even where someone changed it back since; at a start, not. */
  function keepButtons(asked: boolean) {
    if (!port?.buttons || !port.setButtons) return
    const now = port.buttons()
    if (!now || same(now, REACHABLE_BUTTONS)) return
    const kept = loadKept()
    // At a start, a plan this set before is set again only while it is still as this left it
    // (an earlier version's values); one someone changed since stays theirs.
    if (!asked && kept[now.scheme] && !ours(now)) return
    kept[now.scheme] ??= { power: now.power, lid: now.lid }
    // Kept first: should the change only half happen, turning this off still puts them back.
    storeKept(kept)
    if (port.setButtons(now.scheme, REACHABLE_BUTTONS)) {
      log.info(`plugged in, the power button and the lid now do nothing, so neither puts this PC to sleep and out of reach (they were: ${actions(now)})`)
    } else log.warn('Windows didn’t let the app change what the power button and lid do while plugged in')
  }

  function putButtonsBack() {
    if (!port?.buttons || !port.setButtons) return
    const left: Kept = {}
    for (const [scheme, before] of Object.entries(loadKept())) {
      const now = port.buttons(scheme)
      if (!now) continue
      // Only what is still as this set it: a change someone made since stays.
      const back = {
        power: OURS.power.includes(now.power) ? before.power : now.power,
        lid: OURS.lid.includes(now.lid) ? before.lid : now.lid,
      }
      if (same(back, now)) continue
      if (port.setButtons(scheme, back)) log.info(`the power button and lid are back as they were while plugged in (${actions(back)})`)
      else {
        left[scheme] = before
        log.warn('Windows didn’t let the app put the power button and lid back as they were')
      }
    }
    storeKept(left)
  }

  const readButtons = () => {
    const b = port?.buttons?.() ?? null
    return b && { power: b.power, lid: b.lid }
  }

  if (reachable) keepButtons(false)
  else putButtonsBack()
  let buttons = readButtons()

  /** True when the plan's buttons are not what was last read (changed here, or in Windows). */
  function refreshButtons(): boolean {
    const now = readButtons()
    if (same(now, buttons)) return false
    buttons = now
    return true
  }

  const timer = setInterval(() => {
    const changed = refreshButtons()
    const now = port?.onMains() ?? null
    if (now !== mains) {
      mains = now
      // The power source is news even when the hold stays as it is: told once either way.
      apply(false)
    } else if (!changed) return
    o.onChange()
  }, o.pollMs ?? POWER_POLL_MS)
  timer.unref()

  return {
    status: () => ({ onMains: mains, awake: held.system, buttons }),
    setReachable(on) {
      reachable = on
      if (on) keepButtons(true)
      else putButtonsBack()
      const changed = refreshButtons()
      if (!apply() && changed) o.onChange()
    },
    setControlled(on) {
      controlled = on
      apply()
    },
    close() {
      clearInterval(timer)
      if (port && (held.system || held.display)) port.holdAwake(false, false)
      held = { system: false, display: false }
    },
  }
}
