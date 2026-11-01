// F-071: speaking to a chat. The browser's own speech recognition (the Web Speech API: Chrome on Android uses the
// phone's Google speech) turns what is said into words; these are the rules around it, apart from the page so they
// are tested without one: what was said so far, the settings, what an error means, and whether the page can listen.

/** The languages offered. English (India) first: it is what this app is spoken in. */
export const VOICE_LANGS = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'mr-IN', label: 'Marathi' },
  { code: 'gu-IN', label: 'Gujarati' },
] as const

export interface VoiceSettings {
  /** The language spoken (a BCP 47 code from VOICE_LANGS). */
  lang: string
  /** Send the message when the person stops speaking, instead of leaving it in the box with Send ready. */
  autoSend: boolean
}

export const DEFAULT_VOICE: VoiceSettings = { lang: 'en-IN', autoSend: false }

export function parseVoice(raw: unknown): VoiceSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_VOICE }
  const r = raw as Record<string, unknown>
  const lang = typeof r.lang === 'string' && VOICE_LANGS.some(l => l.code === r.lang) ? r.lang : DEFAULT_VOICE.lang
  return { lang, autoSend: r.autoSend === true }
}

/** A result list as the browser gives it: each result has alternatives, the first the likeliest. */
export interface ResultsLike {
  length: number
  [i: number]: { isFinal: boolean; 0?: { transcript: string } }
}

/** What has been said so far: the words the recogniser is sure of, and the ones it is still working on. */
export function transcriptOf(results: ResultsLike): { final: string; interim: string } {
  let final = ''
  let interim = ''
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const t = r[0]?.transcript ?? ''
    if (r.isFinal) final += t
    else interim += t
  }
  return { final: final.trim(), interim: interim.trim() }
}

/** What was said, whole: the sure words, and what was still being worked on when it stopped. */
export const spokenOf = (t: { final: string; interim: string }) => [t.final, t.interim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()

/** The words spoken added to what is already in the box, with one space between. */
export function joinSpeech(draft: string, spoken: string): string {
  const s = spoken.trim()
  if (!s) return draft
  const d = draft.replace(/\s+$/, '')
  return d ? `${d} ${s}` : s
}

export type VoiceSupport = 'ok' | 'insecure' | 'unsupported'

/** Whether this page can listen: the browser has speech recognition, and the page is secure (https or localhost). */
export function supportOf(w: { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown; isSecureContext?: boolean }): VoiceSupport {
  if (!w.SpeechRecognition && !w.webkitSpeechRecognition) return 'unsupported'
  return w.isSecureContext === false ? 'insecure' : 'ok'
}

/** A sentence for each way listening can fail; null for the ones that are not a failure (it was stopped on purpose). */
export function voiceError(code: string): string | null {
  switch (code) {
    case 'aborted':
      return null
    case 'not-allowed':
    case 'service-not-allowed':
      return "The microphone is blocked for this page. Allow it in the browser's site settings (the lock beside the address), then tap the mic again."
    case 'no-speech':
      return "Didn't hear anything. Tap the mic and speak."
    case 'audio-capture':
      return 'No microphone was found on this device.'
    case 'network':
      return "Speech recognition needs the internet: the browser sends what you say to Google's speech service. Check the connection."
    case 'language-not-supported':
      return "This browser can't listen in that language. Pick another in Settings › Voice."
    default:
      return `Speech recognition stopped (${code}). Tap the mic to try again.`
  }
}

/**
 * Whether an error is only the engine ending a stretch of listening (it hears nothing for several seconds, or it
 * was stopped): the recording goes on, with a new stretch started at once. Any other error is a real one.
 */
export const voiceKeepsGoing = (code: string) => code === 'no-speech' || code === 'aborted'

/** The longest the microphone is left on with nobody speaking (ms): it is not left open for ever by a phone put down. */
export const VOICE_IDLE_MS = 2 * 60 * 1000

/** The sentence the mic button says when the page can't listen. */
export function voiceWhy(support: VoiceSupport, here: { protocol: string; host: string }, secureAddress = 'https://server.tailc768e5.ts.net:5173'): string | null {
  if (support === 'ok') return null
  if (support === 'unsupported') return 'This browser has no speech recognition. Chrome on Android has it.'
  return `The microphone needs a secure page, and this one is ${here.protocol}//${here.host}. Open the app at ${secureAddress} instead.`
}
