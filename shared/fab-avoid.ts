// F-070: where the overlay's button may sit by default on a desk without covering a control. On a wide screen the chat composer's
// Send / mic button sits in the lower right corner, exactly where the button's home spot is, and the button (on top) took the click
// (Web's Chrome check, 1280x800). This is the arithmetic: how far up the home spot must move to clear the controls under it.
// A dragged spot is never moved (src/overlay/fab-spot.ts decides); this only picks the default.

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Room kept between the button and a control, in px. */
export const GAP = 12
/** Keep the button this far inside the top of the screen. */
const TOP_EDGE = 8
/** How many controls in a row it may hop over (a stack of them). */
const HOPS = 8

const apart = (f: Box, c: Box, gap: number) => c.right <= f.left - gap || f.right <= c.left - gap || c.bottom <= f.top - gap || f.bottom <= c.top - gap

/**
 * How many px higher than `home` the button must sit so that it keeps `gap` from every box in `controls`, moving up only (the
 * lower right corner stays its place, it goes up the same column). 0 when nothing is under it, and also 0 when it cannot be done
 * inside the screen: then the home spot stays and the button can be dragged by hand, as before.
 */
export function liftClear(home: Box, controls: Box[], gap = GAP): number {
  let lift = 0
  for (let i = 0; i < HOPS; i++) {
    const f: Box = { left: home.left, right: home.right, top: home.top - lift, bottom: home.bottom - lift }
    const under = controls.filter(c => !apart(f, c, gap))
    if (!under.length) return lift
    // Up to just above the highest one in the way.
    const top = Math.min(...under.map(c => c.top))
    lift += f.bottom - (top - gap)
    if (home.top - lift < TOP_EDGE) return 0
  }
  return 0
}
