// order obf5d: swiping the overlay chat's tabs. This file is the gesture's brain, with no DOM and no React: it is fed pointer samples (touch or pen; never a
// mouse, whose drag selects text) and says what the gesture is. The controller that listens to the real events and moves the real panel is src/overlay/swipe-tabs.ts;
// the tests of this file are shared/swipe-tabs.test.ts.
//
//   - Nothing happens until the finger has moved LOCK_PX. Then the direction is locked, once: horizontal only if |dx| > RATIO * |dy|; anything else (a vertical
//     scroll, a diagonal) is handed back to the browser and this gesture is over until the finger lifts. A gesture that locked horizontal stays horizontal.
//   - A horizontal gesture follows the finger. Past the first or last tab it follows with resistance (a small rubber band) and never wraps around.
//   - On release it commits to the next/previous tab when it went far enough (the larger of COMMIT_PX and COMMIT_FRACTION of the width) or was a flick (fast, and at
//     least FLICK_MIN_PX); otherwise it springs back. A cancelled pointer (the browser took the gesture, the app went away) springs back and never commits.
//   - A second finger cancels it.
//
// Direction: finger moving LEFT shows the NEXT tab (dir +1), moving right the previous one (dir -1), as in every tabbed sheet.

export const SWIPE = {
  lockPx: 10,
  ratio: 1.5,
  commitPx: 60,
  commitFraction: 0.25,
  flickMinPx: 24,
  /** px per ms over the last FLICK_WINDOW_MS. */
  flickVelocity: 0.5,
  flickWindowMs: 120,
  /** How much of the finger's travel a rubber band shows, and the most it ever shows. */
  edgeResistance: 0.25,
  edgeMaxPx: 48,
} as const

export type SwipeDir = -1 | 1

export interface PointerSample {
  id: number
  /** PointerEvent.pointerType: only 'touch' and 'pen' start a swipe. */
  type: string
  x: number
  y: number
  /** ms (event.timeStamp). */
  t: number
}

export type SwipeMove =
  | { kind: 'none' }
  /** The gesture just turned out not to be ours (vertical, diagonal): leave it to the browser. */
  | { kind: 'reject' }
  /** Follow the finger by `offset` px (already resisted at an edge). `edge`: there is no tab that way. */
  | { kind: 'drag'; offset: number; dir: SwipeDir; edge: boolean }

export type SwipeEnd =
  | { kind: 'commit'; dir: SwipeDir }
  /** Spring back. `horizontal`: it had been ours, so the click that follows must be swallowed. */
  | { kind: 'cancel'; reason: 'edge' | 'short' | 'rejected' | 'cancelled' | 'none'; horizontal: boolean }

export interface SwipeDeps {
  /** The width of the area the tabs show in, px. */
  width(): number
  /** Is there a tab in that direction? */
  canGo(dir: SwipeDir): boolean
}

export interface Swipe {
  /** A pointer went down. True: this gesture is being followed (touch or pen, nothing else in progress). */
  down(s: PointerSample): boolean
  move(s: PointerSample): SwipeMove
  up(s: PointerSample): SwipeEnd
  /** The browser cancelled the pointer, a second finger came, the selection started, the panel closed. */
  cancel(): SwipeEnd
  /** Is a gesture being followed now? */
  active(): boolean
  /** Has it locked horizontal (it is ours)? */
  horizontal(): boolean
}

const dirOf = (dx: number): SwipeDir => (dx > 0 ? -1 : 1)

export function createSwipe(deps: SwipeDeps): Swipe {
  let phase: 'idle' | 'tracking' | 'horizontal' | 'rejected' = 'idle'
  let id = -1
  let x0 = 0
  let y0 = 0
  let samples: { x: number; t: number }[] = []

  const reset = () => {
    phase = 'idle'
    id = -1
    samples = []
  }
  const push = (s: PointerSample) => {
    samples.push({ x: s.x, t: s.t })
    // Enough history for the flick window, not a list that grows with a long drag.
    if (samples.length > 40) samples.splice(0, samples.length - 40)
  }
  const flick = (dx: number) => {
    if (samples.length < 2 || Math.abs(dx) < SWIPE.flickMinPx) return false
    const b = samples[samples.length - 1]
    // The speed over the LAST FLICK_WINDOW_MS (the earliest sample inside it; if the finger paused and only the last point is inside, the one before it).
    let i = samples.findIndex(p => b.t - p.t <= SWIPE.flickWindowMs)
    if (i < 0 || i >= samples.length - 1) i = samples.length - 2
    const a = samples[i]
    const dt = b.t - a.t
    if (dt <= 0) return false
    const v = (b.x - a.x) / dt
    // Fast enough, and the way the finger ended up going (a flick back the other way is no flick).
    return Math.abs(v) >= SWIPE.flickVelocity && Math.sign(v) === Math.sign(dx)
  }

  return {
    down(s) {
      if (s.type !== 'touch' && s.type !== 'pen') return false
      if (phase !== 'idle') return false
      phase = 'tracking'
      id = s.id
      x0 = s.x
      y0 = s.y
      samples = [{ x: s.x, t: s.t }]
      return true
    },
    move(s) {
      if (phase === 'idle' || s.id !== id || phase === 'rejected') return { kind: 'none' }
      const dx = s.x - x0
      const dy = s.y - y0
      push(s)
      if (phase === 'tracking') {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE.lockPx) return { kind: 'none' }
        if (Math.abs(dx) > SWIPE.ratio * Math.abs(dy)) phase = 'horizontal'
        else {
          phase = 'rejected'
          return { kind: 'reject' }
        }
      }
      const dir = dirOf(dx)
      const edge = dx !== 0 && !deps.canGo(dir)
      const offset = edge ? Math.sign(dx) * Math.min(SWIPE.edgeMaxPx, Math.abs(dx) * SWIPE.edgeResistance) : dx
      return { kind: 'drag', offset, dir, edge }
    },
    up(s) {
      if (phase === 'idle' || s.id !== id) return { kind: 'cancel', reason: 'none', horizontal: false }
      const was = phase
      const dx = s.x - x0
      push(s)
      const isFlick = flick(dx)
      reset()
      if (was !== 'horizontal') return { kind: 'cancel', reason: was === 'rejected' ? 'rejected' : 'none', horizontal: false }
      const dir = dirOf(dx)
      if (dx === 0 || !deps.canGo(dir)) return { kind: 'cancel', reason: 'edge', horizontal: true }
      const far = Math.abs(dx) >= Math.max(SWIPE.commitPx, SWIPE.commitFraction * deps.width())
      return far || isFlick ? { kind: 'commit', dir } : { kind: 'cancel', reason: 'short', horizontal: true }
    },
    cancel() {
      const horizontal = phase === 'horizontal'
      const was = phase
      reset()
      return { kind: 'cancel', reason: was === 'idle' ? 'none' : 'cancelled', horizontal }
    },
    active: () => phase !== 'idle',
    horizontal: () => phase === 'horizontal',
  }
}
