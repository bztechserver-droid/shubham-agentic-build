// F-120: what letting go means, in the Chats list's pointer drag (src/chat/pointer-drag.ts), once a row or a floor header has been picked up by a 300 ms hold.
// A floor header is also a button that folds the floor. A touch held a little over 300 ms (a slow or firm tap, common on a phone) used to start a drag and swallow the
// click that followed, so the floor did not fold. Now a header held and let go WITHOUT moving is a tap: it folds. A chat row held without moving is still the long press
// (Switch computer, F-064); anything that moved is a drop.

export type Release =
  /** The press was cancelled (Escape, a cancelled touch): nothing happens, the item goes back. */
  | 'cancel'
  /** A floor header held in place: the tap it was meant to be (the click that follows is let through, and folds the floor). */
  | 'tap'
  /** A chat row held in place: the long press. */
  | 'long-press'
  /** Moved: it lands where the line was. */
  | 'drop'

export interface ReleaseInput {
  /** The pointer went up (true) or the press was cancelled (false). */
  commit: boolean
  /** Picked up by its grip, or by a hold on the rest of the row. */
  mode: 'grip' | 'body'
  kind: 'floor' | 'agent'
  /** How far the pointer went from where it went down (px) and how far counts as staying put. */
  moved: number
  slop: number
  /** A long press on a chat is wanted (F-064). */
  hasLongPress: boolean
}

export function releaseOutcome(i: ReleaseInput): Release {
  if (!i.commit) return 'cancel'
  const still = i.mode === 'body' && i.moved <= i.slop
  if (still && i.kind === 'floor') return 'tap'
  if (still && i.kind === 'agent' && i.hasLongPress) return 'long-press'
  return 'drop'
}
