// order ob917 (11 Nov), widened by o831e/o7315: the overlay chat is a pane docked to the RIGHT edge: the app narrows to make room, and the pane never covers any of it (it is a column BESIDE
// the app). It docks in any window from 660 px wide, whatever the pointer (a computer, a tablet, an unfolded Fold); under that the floating card (or a phone's sheet) is used, as before.
// This is the pure part: the two styles, the width rules (min, max, the room the app keeps) and the drag and key steps. The browser part (storage, the viewport, the layout) is
// src/overlay/dock.ts; the pane itself is in src/overlay/Panel.tsx and the frame that gives the room in src/overlay/OverlayLayout.tsx.

/** 'drawer' (the "right pane" in Settings): docked to the right edge, the app narrows (the default wherever the window is wide enough). 'floating': the card over the page, as it always was. */
export type OverlayStyle = 'drawer' | 'floating'

export const parseOverlayStyle = (raw: unknown): OverlayStyle | null => (raw === 'drawer' || raw === 'floating' ? raw : null)

/** What the style is on this device: his choice, else the drawer. (A phone and a narrow window never get the drawer, whatever this says.) */
export const effectiveOverlayStyle = (stored: OverlayStyle | null): OverlayStyle => stored ?? 'drawer'

/** The narrowest the pane can be made (the composer and the tabs still fit). */
export const DOCK_MIN = 300
/** The widest, however wide the screen is. */
export const DOCK_MAX = 720
/** The width on a big screen before he has dragged it (a smaller screen gets a smaller one: see defaultDockWidth). */
export const DOCK_DEFAULT = 420
/** order o831e/o7315: the room the APP keeps beside the pane (its menu rail or sidebar plus the page): never less than this, so the page is always usable next to the pane and the pane never covers it. */
export const FRAME_MIN = 360
/** On a big screen the app keeps this much (it was the rule of the first drawer). */
export const FRAME_COMFY = 640
/**
 * The narrowest window the pane docks in: the pane's narrowest (DOCK_MIN) beside the app's smallest room (FRAME_MIN) = 660 px. Under it nothing overlaps: the window gets the floating card
 * (or, on a phone under 640, the full-screen sheet) as before. An unfolded Fold is about 673 to 707 px wide in Chrome, so it docks.
 */
export const DOCK_VIEW_MIN = DOCK_MIN + FRAME_MIN
/** A key press on the drag handle moves it by this much; with Shift, by the large step. */
export const DOCK_STEP = 16
export const DOCK_STEP_LARGE = 64

/** The room the app keeps in a window this wide: the window minus the widest pane a window like this allows, between FRAME_MIN and FRAME_COMFY (a small screen lets the app go smaller than a big one). */
export const frameRoom = (viewport: number): number => Math.min(FRAME_COMFY, Math.max(FRAME_MIN, Math.floor(viewport) - DOCK_DEFAULT))

/** The widest the pane may be in a window this wide: null when the window is too narrow to dock at all (the app would be left under FRAME_MIN). */
export function dockMax(viewport: number): number | null {
  if (!Number.isFinite(viewport)) return null
  const room = Math.min(DOCK_MAX, Math.floor(viewport) - frameRoom(viewport))
  return room >= DOCK_MIN ? room : null
}

/** Can the pane dock here: only the window's width decides (a mouse or a finger, a computer, a tablet or an unfolded Fold are all the same). */
export const canDock = (viewport: number): boolean => dockMax(viewport) !== null

/** The width before he has dragged it: 40% of the window, between DOCK_MIN and DOCK_DEFAULT (an unfolded Fold gets about 300, a computer 420). */
export const defaultDockWidth = (viewport: number): number => Math.round(Math.min(DOCK_DEFAULT, Math.max(DOCK_MIN, viewport * 0.4)))

/** A width kept in this browser: a whole number of px, or null (never dragged, or junk). The limits are applied when it is used, because the window can change. */
export function parseDockWidth(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return null
  const n = Number(raw)
  return n > 0 ? n : null
}

/** The width the drawer has in a window this wide (null: it cannot dock): his width, else the default, brought inside the limits. */
export function dockWidth(stored: number | null, viewport: number): number | null {
  const max = dockMax(viewport)
  if (max === null) return null
  return Math.round(Math.min(max, Math.max(DOCK_MIN, stored ?? defaultDockWidth(viewport))))
}

/** Dragging the drawer's left edge: the pointer moving left makes it wider by the same amount. Brought inside the limits. */
export function dragWidth(startWidth: number, startX: number, x: number, viewport: number): number {
  const max = dockMax(viewport) ?? DOCK_MIN
  return Math.round(Math.min(max, Math.max(DOCK_MIN, startWidth + (startX - x))))
}

export type HandleKey = { to: number } | { by: number } | 'reset'

/** What a key does on the focused drag handle: left widens (the edge is on the left), right narrows, Home the narrowest, End the widest, Enter or Space gives back the default width. Anything else: null. */
export function handleKey(key: string, shift: boolean): HandleKey | null {
  const step = shift ? DOCK_STEP_LARGE : DOCK_STEP
  switch (key) {
    case 'ArrowLeft':
      return { by: step }
    case 'ArrowRight':
      return { by: -step }
    case 'Home':
      return { to: DOCK_MIN }
    case 'End':
      return { to: Number.POSITIVE_INFINITY }
    case 'Enter':
    case ' ':
      return 'reset'
    default:
      return null
  }
}

/** The width after a key (the limits applied), or null for a key that is not the handle's. */
export function widthAfterKey(current: number, key: string, shift: boolean, viewport: number): number | null {
  const k = handleKey(key, shift)
  if (!k) return null
  const max = dockMax(viewport) ?? DOCK_MIN
  const next = k === 'reset' ? defaultDockWidth(viewport) : 'to' in k ? k.to : current + k.by
  return Math.round(Math.min(max, Math.max(DOCK_MIN, next)))
}
