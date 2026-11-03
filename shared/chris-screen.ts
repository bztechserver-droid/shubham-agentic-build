// F-098: the "Hey Chris" screen, as data and rules. This is the Android Live screen (mobile/src/live, mobile/docs/LIVE-UX.md) in the web
// app so its UI can be tried and improved here before the phone gets it: only the SCREEN, no microphone, no wake word, no hub. The phone's
// orb table, header words, link chip, timeline, ticker and karaoke rules are copied here as pure functions (tested), and the demo scenes
// below fill the screen with what the app would show. Nothing here touches the page.

export type Phase = 'off' | 'starting' | 'hubOnly' | 'paused' | 'busy' | 'armed' | 'waking' | 'listening' | 'hearing' | 'closing' | 'sending' | 'working' | 'speaking' | 'followup' | 'confirm'
export type SpeakKind = 'ack' | 'narration' | 'progress' | 'news' | 'late' | 'answer' | 'error'

export type OrbCore = 'strong' | 'primary' | 'card'
export type OrbRings = 'none' | 'mic' | 'voice'
export type OrbEdge = 'none' | 'idle' | 'warning' | 'error'
export type OrbLoop = 'none' | 'breathe' | 'arc' | 'countdown'
export type OrbTap = 'start' | 'resume' | 'talk' | 'interrupt' | 'endSession' | 'sendNow' | 'details' | 'approval' | null

export interface OrbLook {
  core: OrbCore
  rings: OrbRings
  /** The brass progress arc turns (sending, working). */
  arc: boolean
  edge: OrbEdge
  loop: OrbLoop
  /** The "!" glyph of the error look. */
  bang: boolean
}

export interface OrbState {
  look: OrbLook
  /** The label under the orb. */
  label: string
  tap: OrbTap
  /** Long press 500 ms: "Stop the Assistant", only while working. */
  longPress: 'cancelAsk' | null
  talkback: string
}

export type PauseReason = 'user' | 'charging-only' | 'battery' | 'schedule-off'
export type BusyReason = 'call' | 'other-app' | 'mic-toggle' | 'stuck' | null

export interface Pause {
  reason: PauseReason
  /** ms since 1970, or null. */
  until: number | null
}

/** "15:30" from ms. */
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function pauseLabel(pause: Pause | null): string {
  if (!pause) return 'Paused'
  switch (pause.reason) {
    case 'user':
      return pause.until ? `Paused until ${clock(pause.until)}` : 'Paused'
    case 'charging-only':
      return 'Listening only while charging'
    case 'battery':
      return 'Paused: battery low'
    case 'schedule-off':
      return 'Listening is off'
  }
}

export function busyLabel(busy: BusyReason): string {
  switch (busy) {
    case 'call':
      return 'Mic in use: a call'
    case 'other-app':
      return 'Mic in use by another app'
    case 'mic-toggle':
      return 'The microphone is switched off'
    case 'stuck':
      return 'The microphone stopped'
    default:
      return 'Mic in use'
  }
}

const look = (core: OrbCore, rings: OrbRings = 'none', edge: OrbEdge = 'none', loop: OrbLoop = 'none', arc = false): OrbLook => ({ core, rings, arc, edge, loop, bang: false })

/** Utterances that play while the phase stays WORKING: the rings follow Chris's voice then. */
const WORKING_TALK: readonly SpeakKind[] = ['ack', 'narration', 'progress', 'news', 'late']

export function orbState(i: { phase: Phase; pause: Pause | null; busy: BusyReason; speakingKind: SpeakKind | null; alertAt: number | null; now: number; quiet?: boolean }): OrbState {
  let s: OrbState
  switch (i.phase) {
    case 'off':
    default:
      s = { look: look('strong', 'none', 'idle'), label: 'Chris is off', tap: 'start', longPress: null, talkback: 'Chris is off. Double tap to start listening.' }
      break
    case 'starting':
      s = { look: look('strong'), label: 'Starting', tap: null, longPress: null, talkback: 'Chris is starting.' }
      break
    case 'hubOnly':
      s = { look: look('strong', 'none', 'idle'), label: 'Tap to turn on', tap: 'start', longPress: null, talkback: 'Chris has no microphone access. Double tap to turn it on.' }
      break
    case 'paused':
      s = { look: look('strong', 'none', 'idle'), label: pauseLabel(i.pause), tap: 'resume', longPress: null, talkback: 'Hey Chris is paused. Double tap to resume.' }
      break
    case 'busy':
      s = { look: look('strong', 'none', 'idle'), label: busyLabel(i.busy), tap: null, longPress: null, talkback: 'A call or another app has the microphone.' }
      break
    case 'armed':
      s = { look: look('strong', 'none', 'none', 'breathe'), label: 'Say “Hey Chris”', tap: 'talk', longPress: null, talkback: 'Chris is ready. Double tap to talk.' }
      break
    case 'waking':
      s = { look: look('primary', 'voice'), label: 'Yes?', tap: 'interrupt', longPress: null, talkback: 'Chris heard you.' }
      break
    case 'listening':
      s = { look: look('primary', 'mic'), label: 'Listening', tap: 'endSession', longPress: null, talkback: 'Listening. Double tap to stop.' }
      break
    case 'hearing':
      s = { look: look('primary', 'mic'), label: 'Listening', tap: 'sendNow', longPress: null, talkback: 'Hearing you. Double tap to send now.' }
      break
    case 'closing':
      s = { look: look('primary', 'mic'), label: 'Got it', tap: 'sendNow', longPress: null, talkback: 'About to send. Double tap to send now.' }
      break
    case 'sending':
      s = { look: look('strong', 'none', 'none', 'arc', true), label: 'Sending', tap: null, longPress: null, talkback: 'Sending.' }
      break
    case 'working': {
      const talking = i.speakingKind !== null && WORKING_TALK.includes(i.speakingKind)
      s = { look: look('strong', talking ? 'voice' : 'none', 'none', 'arc', true), label: 'Thinking', tap: 'details', longPress: 'cancelAsk', talkback: 'Working on it. Double tap for details; double tap and hold to stop it.' }
      break
    }
    case 'speaking':
      s = { look: look('primary', 'voice'), label: 'Speaking', tap: 'interrupt', longPress: null, talkback: 'Chris is speaking. Double tap to interrupt.' }
      break
    case 'followup':
      s = { look: look('primary', 'mic', 'none', 'countdown'), label: 'Anything else?', tap: 'endSession', longPress: null, talkback: 'Still listening. Double tap to end.' }
      break
    case 'confirm':
      s = { look: look('card', 'none', 'warning'), label: 'Needs your approval', tap: 'approval', longPress: null, talkback: 'Waiting for your approval below.' }
      break
  }
  // The error look: an alert newer than 10 s, or Chris saying an error.
  if ((i.alertAt !== null && i.now - i.alertAt < 10_000) || i.speakingKind === 'error') s = { ...s, look: { ...s.look, edge: 'error', bang: true } }
  if (i.quiet && s.look.core === 'primary') s = { ...s, look: { ...s.look, core: 'strong' } }
  return s
}

/** Phases with an open session. */
export const SESSION_PHASES: readonly Phase[] = ['waking', 'listening', 'hearing', 'closing', 'sending', 'working', 'speaking', 'followup', 'confirm']
export const inSession = (p: Phase) => SESSION_PHASES.includes(p)

// --- the link, the route, the header words ----------------------------------------------------------------------------------

export type LinkState = 'up' | 'connecting' | 'down' | 'unpaired' | 'revoked'
export type LinkFailure = 'vpn-off' | 'offline' | 'dns' | 'hub-not-running' | 'tls' | 'origin-refused' | null
export type AssistantState = 'idle' | 'working' | 'waiting' | 'stopped'

export interface Link {
  state: LinkState
  feed: 'open' | 'connecting' | 'closed'
  failure: LinkFailure
  since: number
  lastOkAt: number | null
  assistant: AssistantState
}

export type DotKind = 'running' | 'waiting' | 'done' | 'idle' | 'error'
export interface ChipState {
  word: string
  dot: DotKind
  bang: boolean
  action: 'pair' | 'reason' | null
}

export const DOWN_GRACE_MS = 3000

export function linkChipState(link: Link, now: number): ChipState {
  switch (link.state) {
    case 'unpaired':
      return { word: 'Not paired', dot: 'error', bang: true, action: 'pair' }
    case 'revoked':
      return { word: 'Pair again', dot: 'error', bang: true, action: 'pair' }
    case 'connecting':
      return { word: 'Connecting', dot: 'running', bang: false, action: null }
    case 'down': {
      if (now - link.since < DOWN_GRACE_MS) return { word: 'Connecting', dot: 'running', bang: false, action: null }
      const offline = link.failure === 'offline' || link.failure === 'vpn-off' || link.failure === 'dns'
      return offline ? { word: 'Offline', dot: 'idle', bang: false, action: 'reason' } : { word: 'Reconnecting…', dot: 'waiting', bang: false, action: 'reason' }
    }
    case 'up':
      return link.feed === 'open' ? { word: 'Live', dot: 'done', bang: false, action: null } : link.feed === 'connecting' ? { word: 'Connecting', dot: 'running', bang: false, action: null } : { word: 'Online', dot: 'done', bang: false, action: null }
  }
}

export interface Route {
  output: 'speaker' | 'bluetooth' | 'wired' | 'earpiece'
  device: string | null
}
export function routeWord(r: Route): { word: string; buds: boolean } {
  switch (r.output) {
    case 'bluetooth':
      return { word: r.device ? `Buds · ${r.device}` : 'Buds', buds: true }
    case 'wired':
      return { word: r.device ? `Headphones · ${r.device}` : 'Headphones', buds: true }
    case 'earpiece':
      return { word: 'Earpiece', buds: false }
    case 'speaker':
      return { word: 'Phone', buds: false }
  }
}

/** "3 min", "12 s": a span, short. */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`
}

/** The header's presence caption: "Listening", "Thinking · 12 s", "Speaking", "Online · Assistant idle", … */
export function presence(p: { phase: Phase; pause: Pause | null; link: Link; turnSecs: number | null; now: number }): string {
  switch (p.phase) {
    case 'listening':
    case 'hearing':
    case 'closing':
    case 'followup':
    case 'waking':
      return 'Listening'
    case 'sending':
      return 'Sending'
    case 'working':
      return p.turnSecs !== null ? `Thinking · ${p.turnSecs} s` : 'Thinking'
    case 'speaking':
      return 'Speaking'
    case 'confirm':
      return 'Needs your approval'
    case 'paused':
      return pauseLabel(p.pause)
    default:
      break
  }
  const l = p.link
  if (l.state === 'unpaired') return 'Not paired'
  if (l.state === 'revoked') return 'Unpaired'
  if (l.state === 'down') return `Offline · ${spanText(p.now - (l.lastOkAt ?? l.since))}`
  if (l.state === 'connecting') return 'Connecting'
  return l.assistant === 'working' ? 'Online · Assistant working' : l.assistant === 'waiting' ? 'Online · Assistant waiting' : l.assistant === 'stopped' ? 'Online · Assistant asleep' : 'Online · Assistant idle'
}

export interface OfflineReason {
  title: string
  detail: string
  fix: 'tailscale' | 'pair' | 'retry' | null
}

/** The link's state as a reason and a fix; null while it is up. */
export function offlineReason(link: Link, now: number): OfflineReason | null {
  const since = link.lastOkAt ? `Last reached ${spanText(now - link.lastOkAt)} ago.` : ''
  switch (link.state) {
    case 'up':
      return null
    case 'unpaired':
      return { title: 'Not paired', detail: 'Pair Chris with your PC: a code from the web Settings › Pair Chris (Android).', fix: 'pair' }
    case 'revoked':
      return { title: 'Chris was unpaired', detail: 'The PC no longer accepts this phone. Pair again with a new code.', fix: 'pair' }
    default:
      break
  }
  switch (link.failure) {
    case 'vpn-off':
      return { title: 'Tailscale is off on this phone', detail: `Turn Tailscale on (Always-on VPN keeps it on). ${since}`.trim(), fix: 'tailscale' }
    case 'offline':
      return { title: 'This phone is offline', detail: `No network. ${since}`.trim(), fix: null }
    case 'dns':
      return { title: "Can't find your PC", detail: `Is Tailscale on, and is the PC on? ${since}`.trim(), fix: 'tailscale' }
    case 'hub-not-running':
      return { title: "Your PC is on, but the hub isn't running", detail: `Start the app on the PC. ${since}`.trim(), fix: 'retry' }
    case 'tls':
      return { title: "Your PC's certificate was not accepted", detail: since || 'The connection was refused.', fix: 'retry' }
    case 'origin-refused':
      return { title: 'The hub refused the phone', detail: 'Something on the way added an Origin header. Diagnostics › hub shows more.', fix: 'retry' }
    default:
      return { title: "Can't reach your PC", detail: `Chris keeps trying. ${since}`.trim(), fix: 'retry' }
  }
}

// --- a turn: the timeline, the ticker -----------------------------------------------------------------------------------------

export interface Step {
  id: string
  label: string
  ok: boolean
  at: number
  /** The call as the Assistant made it, and what came back (shown on the "What Chris did" sheet). */
  detail?: string
  output?: string
}

export type TurnState = 'sending' | 'queued' | 'working' | 'done' | 'failed' | 'cancelled'

export interface Turn {
  id: string
  via: 'voice' | 'text'
  text: string
  state: TurnState
  times: { heard: number; sent: number | null; accepted: number | null; started: number | null; done: number | null; spokenFrom: number | null; spokenTo: number | null }
  steps: Step[]
  narration: string[]
  status: { text: string; secs: number | null; tokens: string | null } | null
}

type NodeKind = 'done' | 'open' | 'error' | 'spoken' | 'working'
export interface TimelineNode {
  key: string
  label: string
  kind: NodeKind
  at: number | null
}

/** The turn as nodes in order: Heard, Sent, (Queued), Working, one per step, Answer, Spoken. */
export function timelineNodes(t: Turn): TimelineNode[] {
  const out: TimelineNode[] = [{ key: 'heard', label: t.via === 'text' ? 'Typed' : 'Heard', kind: 'done', at: t.times.heard }]
  out.push({ key: 'sent', label: 'Sent', kind: t.times.sent !== null || t.times.accepted !== null ? 'done' : 'open', at: t.times.sent ?? t.times.accepted })
  if (t.state === 'queued') out.push({ key: 'queued', label: 'Queued', kind: 'open', at: t.times.accepted })
  const failed = t.state === 'failed' || t.state === 'cancelled'
  if (t.times.started !== null || t.steps.length || t.state === 'working') out.push({ key: 'working', label: 'Working', kind: t.times.done !== null ? 'done' : failed ? 'error' : 'working', at: t.times.started })
  for (const s of t.steps) out.push({ key: `step:${s.id}`, label: s.label, kind: s.ok ? 'done' : 'error', at: s.at })
  out.push({ key: 'answer', label: failed ? (t.state === 'cancelled' ? 'Cancelled' : 'Not answered') : 'Answer', kind: t.times.done !== null ? 'done' : failed ? 'error' : 'open', at: t.times.done })
  if (t.times.spokenTo !== null || t.times.spokenFrom !== null) out.push({ key: 'spoken', label: 'Spoken', kind: t.times.spokenTo !== null ? 'spoken' : 'open', at: t.times.spokenTo ?? t.times.spokenFrom })
  return out
}

export const MAX_STRIP_STEPS = 8

/** The strip on the cover: many steps fold into the first few and a count. */
export function stripNodes(nodes: TimelineNode[]): (TimelineNode | { key: string; more: number })[] {
  const steps = nodes.filter(n => n.key.startsWith('step:'))
  const shown = steps.length > MAX_STRIP_STEPS ? steps.slice(0, MAX_STRIP_STEPS - 1) : steps
  const extra = steps.length - shown.length
  const out: (TimelineNode | { key: string; more: number })[] = []
  for (const n of nodes) {
    if (n.key.startsWith('step:')) {
      if (shown.includes(n)) out.push(n)
      else if (extra > 0 && !out.some(x => x.key === 'more')) out.push({ key: 'more', more: extra })
    } else out.push(n)
  }
  return out
}

/** "+6.1 s" from the start of the turn. */
export const plusText = (at: number | null, from: number) => (at === null ? '' : `+${Math.max(0, (at - from) / 1000).toFixed(1)} s`)

/** "↓ 1.2k tokens" as given; a bare number gets its arrow and word. */
export function tokensText(tokens: string | null): string | null {
  if (!tokens || !tokens.trim()) return null
  const t = tokens.trim()
  return /^[\d.,]+\s*[kKmM]?$/.test(t) ? `↓ ${t} tokens` : t
}

/** What the ticker's now-line says (status line ⇄ latest step), from the turn and the link. */
export function nowLine(turn: Turn, phase: Phase, assistant: AssistantState, now: number, statusAt: number): { text: string; secs: number | null; tokens: string | null; dot: boolean } {
  const started = turn.times.started ?? turn.times.accepted ?? turn.times.sent ?? turn.times.heard
  const localSecs = Math.max(0, Math.floor((now - started) / 1000))
  const status = turn.status
  if (status) {
    const secs = status.secs === null ? null : status.secs + Math.max(0, Math.floor((now - statusAt) / 1000))
    return { text: status.text, secs, tokens: tokensText(status.tokens), dot: true }
  }
  if (phase === 'sending' || turn.state === 'sending') return { text: 'Sending…', secs: null, tokens: null, dot: true }
  if (turn.state === 'queued' && turn.times.accepted !== null && now - turn.times.accepted > 2000 && assistant === 'working') return { text: 'Waiting for the Assistant to finish something else', secs: null, tokens: null, dot: false }
  if (assistant === 'stopped') return { text: 'Waking the Assistant…', secs: null, tokens: null, dot: true }
  return { text: 'Thinking', secs: localSecs, tokens: null, dot: true }
}

// --- speaking (the karaoke) ----------------------------------------------------------------------------------------------------

export interface Speaking {
  kind: SpeakKind
  text: string
  /** [start, end) of each sentence in `text`. */
  sentences: [number, number][]
}

export interface SpeechPosition {
  /** Which sentence is playing. */
  sentence: number
  /** The word being said (character range in the whole text), or null before the first word. */
  word: [number, number] | null
}

export interface SentenceParts {
  key: string
  said: string
  current: string
  rest: string
}

/** The sentence playing, cut into said / being said / to come. */
export function sentenceParts(sp: Speaking | null, pos: SpeechPosition): SentenceParts | null {
  if (!sp) return null
  const range = sp.sentences[pos.sentence] ?? sp.sentences[sp.sentences.length - 1]
  const [s0, s1] = range ?? [0, sp.text.length]
  const text = sp.text.slice(s0, s1)
  const key = `${pos.sentence}`
  const w = pos.word
  if (!w || w[1] <= s0 || w[0] >= s1) return { key, said: '', current: '', rest: text }
  const a = Math.max(0, w[0] - s0)
  const b = Math.min(text.length, Math.max(a, w[1] - s0))
  return { key, said: text.slice(0, a), current: text.slice(a, b), rest: text.slice(b) }
}

/** Cuts a text into sentences and its words into character ranges, for the demo's karaoke. */
export function sentencesOf(text: string): [number, number][] {
  const out: [number, number][] = []
  const re = /[^.!?]+[.!?]*\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length])
  return out.length ? out : [[0, text.length]]
}

export function wordsOf(text: string): [number, number][] {
  const out: [number, number][] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length])
  return out
}

/** The sentence a word belongs to. */
export const sentenceOfWord = (sentences: [number, number][], word: [number, number]) => {
  const i = sentences.findIndex(([a, b]) => word[0] >= a && word[0] < b)
  return i < 0 ? Math.max(0, sentences.length - 1) : i
}

/** How many sentences there are and which one is playing, for the held answer ("Speaking… 2/4"). */
export const holdText = (sentence: number, total: number) => `Speaking…${total > 1 ? ` ${Math.min(Math.max(1, sentence + 1), Math.max(1, total))}/${total}` : ''}`

/** Keeps the newest words of a long text: the last `max` characters, cut at a space, with "…" in front. */
export function newestWords(text: string, max: number): string {
  if (text.length <= max) return text
  const tail = text.slice(text.length - max)
  const sp = tail.indexOf(' ')
  return `…${sp >= 0 ? tail.slice(sp + 1) : tail}`
}

// --- the conversation's rows ----------------------------------------------------------------------------------------------------

export type Ticks = 'sending' | 'sent' | 'delivered' | 'answered' | 'failed'

export type Row =
  | { k: 'day'; id: string; at: number }
  | { k: 'mine'; id: string; text: string; via: 'voice' | 'phone-text' | 'overlay'; ticks: Ticks; at: number; first: boolean; last: boolean }
  | { k: 'tools'; id: string; tools: { label: string; ok: boolean }[]; running: boolean }
  | { k: 'chris'; id: string; text: string; at: number; first: boolean; last: boolean; held?: boolean }
  | { k: 'reply'; id: string; agent: string; floor: string; text: string }
  | { k: 'beat'; id: string; hhmm: string; items: { agent: string; floor: string | null; what: string }[]; notes: string[] }
  | { k: 'notice'; id: string; text: string; tone: 'approved' | 'stop' | 'error' | 'info' }

/** "Did 3 things · Read Web's chat, …" for a tool pill; "Working…" while running. */
export function toolsSummary(tools: { label: string }[], running: boolean): string {
  if (tools.length === 0) return running ? 'Working…' : 'Did nothing'
  const names = tools.map(t => t.label)
  const head = running ? `Working · ${tools.length} ${tools.length === 1 ? 'thing' : 'things'}` : `Did ${tools.length} ${tools.length === 1 ? 'thing' : 'things'}`
  const shown = names.slice(0, 2).join(', ')
  return `${head} · ${shown}${names.length > 2 ? ', …' : ''}`
}

const FINE = /^(restarted|nudged|resumed|recovered|ok|fine)\b/i
/** A heartbeat item that is fine (a check), or needs a look (the hollow ring). */
export const beatFine = (what: string) => FINE.test(what.trim())

/** "Today", "Yesterday", "Mon 3 Nov". */
export function dayLabel(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  if (d.toDateString() === n.toDateString()) return 'Today'
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return 'Yesterday'
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`}`
}

/**
 * The stage heights (cover): 392 in a session, idle a little more than the phone's 248 (the last exchange's line was cut at 248), and taller still while a
 * card is up (an approval, a question, the offline reason); never more than the area minus 96.
 */
export const STAGE_SESSION = 392
export const STAGE_IDLE = 272
export const STAGE_CARD = 520
export const stageHeight = (session: boolean, area: number, card = false) => Math.max(200, Math.min(card ? STAGE_CARD : session ? STAGE_SESSION : STAGE_IDLE, area - 96))

/** The orb's diameter by layout and width; smaller on the cover while a card is up, so the card has room. */
export const orbSizeFor = (layout: 'cover' | 'inner', width: number, card = false) => (layout === 'inner' ? 200 : card ? 96 : width < 380 ? 136 : 152)
