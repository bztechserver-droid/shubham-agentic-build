// order oc7d1: the overlay chat can be MAXIMIZED: it fills the page area of the app (everything below the top bar and above the foot bar), the page behind is switched off while it is, and the same
// button (or Alt+M, or Esc, or the browser's Back) puts it back. This is the pure part: where it may be offered, the box it takes, the words on its button and the Tab-wrap rule of its focus trap.
// The browser side is src/overlay/maximize.ts (the state and the "Remember maximized" setting), the page-area measure is src/overlay/stage-box.ts, the panel is src/overlay/Panel.tsx.

/** The shortcut shown in the button's tooltip. Alt+J opens the overlay, Alt+K is the Assistant's bar, Alt+B the CRM: Alt+M is free. */
export const MAX_SHORTCUT = 'Alt+M'

/** The narrowest window that offers it: under this the chat is already the whole screen (the phone's sheet), so there is nothing to maximize and no button. The app's own phone/desk line. */
export const MAX_MIN_VIEWPORT = 640

export const canMaximize = (viewport: number): boolean => Number.isFinite(viewport) && viewport >= MAX_MIN_VIEWPORT

/** Whether it is maximized now: asked for, the overlay is open, and this window can. (Closing the overlay or a narrow window never leaves a stuck state: it just is not maximized.) */
export const isMaximized = (asked: boolean, open: boolean, viewport: number): boolean => asked && open && canMaximize(viewport)

/** A stored on/off flag: only the exact "1" is on (anything else, or nothing, is off). */
export const parseFlag = (raw: unknown): boolean => raw === '1'

export interface PageRect {
  left: number
  top: number
  bottom: number
}
/** What the app was asked to hand over: the page area's left, top and bottom edge in the window (px). */
export interface Box {
  left: number
  top: number
  /** The gap left under it (the foot bar), in px. The right edge is the window's own. */
  bottom: number
}

/** When the page area cannot be found (it should always be there) the chat takes everything under a standard 56 px top bar. */
export const FALLBACK_BOX: Box = { left: 0, top: 56, bottom: 0 }

/** The box the maximized chat takes: from the page area's left and top to the window's right edge, down to where the page area ends. Never negative, never bigger than the window. */
export function boxOf(page: PageRect | null, windowHeight: number): Box {
  if (!page || ![page.left, page.top, page.bottom, windowHeight].every(Number.isFinite)) return FALLBACK_BOX
  const left = Math.max(0, Math.round(page.left))
  const top = Math.max(0, Math.round(page.top))
  const bottom = Math.max(0, Math.round(windowHeight - page.bottom))
  // A page area with no height (a window being resized) is not a box to fill.
  if (top + bottom >= windowHeight) return FALLBACK_BOX
  return { left, top, bottom }
}

/** The words on the button: it says what a press does, what shortcut does it too, and (restoring) that Esc does as well. */
export function maximizeWords(maximized: boolean): { label: string; title: string } {
  return maximized
    ? { label: 'Restore the chat size', title: `Restore the size (${MAX_SHORTCUT} or Esc)` }
    : { label: 'Maximize the chat', title: `Maximize (${MAX_SHORTCUT})` }
}

/**
 * The focus trap of a maximized chat: with `count` things that can take the focus inside it and the focus on `index` (-1: none of them), where must Tab (or Shift+Tab) go? null: nowhere special, the browser
 * moves on by itself. The ends wrap round, and a focus that is somewhere else (outside it) is brought in.
 */
export function wrapTab(count: number, index: number, shift: boolean): number | null {
  if (count <= 0) return null
  if (index < 0) return shift ? count - 1 : 0
  if (!shift && index === count - 1) return 0
  if (shift && index === 0) return count - 1
  return null
}
