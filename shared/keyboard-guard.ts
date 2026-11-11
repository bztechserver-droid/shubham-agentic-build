// order o63cd (11 Nov): the dictation button must NOT bring the phone's keyboard back. His phone: the keyboard is put down (the system button, or the keyboard button) while the
// chat input stays focused, and then a press on the dictation button raised the keyboard again. The page's own code never focuses the box or calls show() when dictation
// starts (proved in real Chrome, f-kbdict cdp/run.mjs), so the phone raises it itself; the page cannot stop that, but it can see it (the visual viewport shrinks) and put the keyboard
// down again at once. This is the pure part of that watch: when has the keyboard come up since the press. The browser part is src/lib/keyboard-guard.ts.

/** The visual viewport must lose at least this many CSS px for it to count as a keyboard (the address bar moving is about 56; a keyboard is 200 and more). */
export const KEYBOARD_RISE_PX = 120
/** After the recording is written the guard stays this long (the words going into the box can raise the keyboard on some phones), then lets go. */
export const KEYBOARD_GUARD_TAIL_MS = 1500
/** A phone that raises the keyboard again and again is put down at most this many times per press (then the guard stops rather than fight). */
export const KEYBOARD_MAX_REHIDES = 3

export interface KeyboardWatch {
  /** The tallest visual viewport seen since the press (with the keyboard down it is the whole screen). */
  baseline: number
  rehides: number
}

export const startWatch = (height: number): KeyboardWatch => ({ baseline: height, rehides: 0 })

/**
 * One viewport measurement: true when the keyboard has come up and must be put down again. A pinch zoom (scale not 1) changes the height for other reasons, so it never counts.
 * The baseline follows the viewport upwards (a keyboard that went down makes the room bigger again), so a second rise is seen as well.
 */
export function stepWatch(w: KeyboardWatch, height: number, scale: number): boolean {
  if (!(height > 0) || Math.abs(scale - 1) > 0.01) return false
  if (height > w.baseline) {
    w.baseline = height
    return false
  }
  if (w.baseline - height < KEYBOARD_RISE_PX || w.rehides >= KEYBOARD_MAX_REHIDES) return false
  w.rehides++
  return true
}
