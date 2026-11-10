// Order o53af / o0f12 (Shubham: "what Wispr Flow does: a small haptic when dictation starts and when it stops, no start or stop sound"): the app's feedback when a dictation starts and stops,
// kept per device in Settings › Voice › "Dictation feedback". The pure rules are here; the browser side (storage, navigator.vibrate) is src/lib/dictation-feedback.ts.
//
// What the page can and cannot do: it can vibrate (navigator.vibrate, Android Chrome and the installed web app) and it plays no sound of its own, ever. A start beep, when there is one,
// comes from the engine: Chrome's own speech recogniser (Settings › Voice › Engine "Phone (Google)") plays its tone every time it starts, and the page cannot silence it. The PC engine
// (Whisper), the Dictation button and the Assistant's PC mic make no sound at all.

/**
 * 'haptic': a light tick when it starts and a double tick when it stops (his choice, the default). 'sound': the old way: the 8 ms buzz on start it always had and nothing else, so whatever
 * sound the engine makes itself is all there is. 'none': the page does nothing (no vibration).
 */
export type DictationFeedback = 'haptic' | 'sound' | 'none'
export const DICTATION_FEEDBACK: readonly { value: DictationFeedback; label: string }[] = [
  { value: 'haptic', label: 'Small haptic' },
  { value: 'sound', label: 'Sound (the old way)' },
  { value: 'none', label: 'None' },
]
export const DEFAULT_DICTATION_FEEDBACK: DictationFeedback = 'haptic'

export const parseDictationFeedback = (raw: unknown): DictationFeedback => (raw === 'haptic' || raw === 'sound' || raw === 'none' ? raw : DEFAULT_DICTATION_FEEDBACK)

export type FeedbackMoment = 'start' | 'stop'

/** A vibration pattern for navigator.vibrate (milliseconds), or null for none. */
export type Pulse = number | number[] | null

/** One short tick on start; two lighter ticks on stop. Short enough to feel like a key, not a notification. */
export const HAPTIC_START: Pulse = 15
export const HAPTIC_STOP: Pulse = [8, 45, 8]
/** What the mic always did on start before this setting (src/chat/voice.ts, voice-hub.ts). */
export const OLD_START: Pulse = 8

/**
 * What to vibrate for this moment. `reducedMotion` (the person asked their device for less motion) silences the haptic choice; the old way is exactly as it was, and 'none' never
 * vibrates.
 */
export function pulseFor(mode: DictationFeedback, moment: FeedbackMoment, reducedMotion: boolean): Pulse {
  if (mode === 'none') return null
  if (mode === 'sound') return moment === 'start' ? OLD_START : null
  if (reducedMotion) return null
  return moment === 'start' ? HAPTIC_START : HAPTIC_STOP
}
