// order ob917 (11 Nov): on a PC the overlay chat is a drawer docked to the RIGHT edge: the app narrows to make room (nothing hidden underneath) instead of the chat floating over
// it. This is the pure part: the two styles, the width rules (min, max, the room the page keeps) and the drag and key steps. The browser part (storage, the viewport, the
// layout) is src/overlay/dock.ts; the drawer itself is in src/overlay/Panel.tsx and the frame that gives the room in src/overlay/OverlayLayout.tsx.

/** 'drawer': docked to the right edge, the app narrows (the default on a computer with a mouse). 'floating': the card over the page, as it always was. */
export type OverlayStyle = 'drawer' | 'floating'

export const parseOverlayStyle = (raw: unknown): OverlayStyle | null => (raw === 'drawer' || raw === 'floating' ? raw : null)

/** What the style is on this device: his choice, else the drawer. (A phone and a narrow window never get the drawer, whatever this says.) */
export const effectiveOverlayStyle = (stored: OverlayStyle | null): OverlayStyle => stored ?? 'drawer'

/** The narrowest the drawer can be made (the chat's composer and tabs still fit). */
export const DOCK_MIN = 340
/** The widest, however wide the screen is. */
export const DOCK_MAX = 720
/** The width before he has dragged it. */
export const DOCK_DEFAULT = 420
/** The room the app keeps for itself: the drawer never takes more than viewport minus this. Under DOCK_MIN + PAGE_MIN the window is too narrow to dock and the floating card is used. */
export const PAGE_MIN = 640
/** A key press on the drag handle moves it by this much; with Shift, by the large step. */
export const DOCK_STEP = 16
export const DOCK_STEP_LARGE = 64

/** The widest the drawer may be in a window this wide: null when the window is too narrow to dock at all. */
export function dockMax(viewport: number): number | null {
  if (!Number.isFinite(viewport)) return null
  const room = Math.min(DOCK_MAX, Math.floor(viewport) - PAGE_MIN)
  return room >= DOCK_MIN ? room : null
}

/** Can the drawer dock here: a window wide enough, and a mouse (the main pointer is not a finger). */
export const canDock = (viewport: number, finePointer: boolean): boolean => finePointer && dockMax(viewport) !== null

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
  return Math.round(Math.min(max, Math.max(DOCK_MIN, stored ?? DOCK_DEFAULT)))
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
  const next = k === 'reset' ? DOCK_DEFAULT : 'to' in k ? k.to : current + k.by
  return Math.round(Math.min(max, Math.max(DOCK_MIN, next)))
}
