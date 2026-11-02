import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../config.ts'

// F-078: the Heartbeat. Every few minutes (5 by default; a setting) the hub looks over every chat on
// every floor with a plain check: no model, no cost. Nothing is said when all is well. When a chat
// stopped with work unfinished the app itself starts it again and nudges it ONCE; and when something is
// for Shubham to know (a chat waiting at a question, a newer build waiting for his Update now, a reply
// that could not be delivered, a chat that ignored its nudge) it wakes the Assistant with one short
// note, which the Assistant turns into one line in the overlay. It never publishes, presses Update now,
// approves, or starts an agent that has no unfinished work, and it cannot loop:
//   - a chat is nudged at most once per beat, once for any one "last words" of its conversation (a chat
//     that does not move gets nothing more), and at most MAX_NUDGES times in NUDGE_WINDOW_MS;
//   - the nudge itself is never "unfinished work", and it opens no order (orders.ts);
//   - a chat Shubham stopped on purpose is left alone until it is opened again;
//   - the Assistant's own chat is never restarted or nudged by it;
//   - each thing told to Shubham is told once until it changes (or REPEAT_MS passes).

export interface HeartbeatSettings {
  enabled: boolean
  /** Minutes between beats. */
  intervalMin: number
}
export const DEFAULT_SETTINGS: HeartbeatSettings = { enabled: true, intervalMin: 5 }
export const MIN_INTERVAL = 1
export const MAX_INTERVAL = 120

/** The first beat after the agent starts: chats the app is bringing back itself have settled by then. */
export const FIRST_BEAT_MS = 2 * 60_000
/** A chat that wrote its last words less than this long ago is not "stopped", just between two steps. */
export const GRACE_MS = 2 * 60_000
/** Conversations older than this are history, not work to carry on. */
export const MAX_AGE_MS = 6 * 3_600_000
export const NUDGE_WINDOW_MS = 6 * 3_600_000
export const MAX_NUDGES = 3
/** A chat waiting at a question is told to Shubham after this long (he may be at it already). */
export const QUESTION_AFTER_MS = 10 * 60_000
/** Something still true is told again after this long, not every beat. */
export const REPEAT_MS = 60 * 60_000
/** Most chats the app starts again in one beat (after an outage there can be many; the rest wait for the next). */
export const MAX_RESTARTS = 5

/** What every nudge starts with: agents' briefs name it, and "unfinished work" never counts it. */
export const NUDGE_PREFIX = '[heartbeat '

export interface Row {
  id: string
  role: 'user' | 'assistant' | string
  text: string
  tools: string[]
  /** ISO time. */
  timestamp: string
}

export interface Unfinished {
  /** In words, for Shubham and for the nudge. */
  why: string
  /** The last row of the conversation: one nudge per value of this. */
  rowId: string
}

/** Words that say the work goes on. Only the end of the last answer is read. */
const STILL =
  /\b(still (working|running|going|in progress|on it|busy)|in progress|working on (it|this|that)|i(?:'|’)?ll (?:continue|keep going|carry on|get back|pick (?:it|this) up)|i will (?:continue|keep going|carry on)|let me continue|continuing (?:with|to)|next,? i(?:'|’)?ll|will continue|to be continued)\b/i

/**
 * The rule for "unfinished work": the conversation's own last words. Pure, so it can be tested.
 *   - an order from the Assistant is open for a chat that is not running (orders.ts);
 *   - the last row is a message nobody answered (a turn cut off before its first word);
 *   - the last row is a step with tool calls and no words (a turn cut off in the middle);
 *   - the last row is an answer whose end says the work goes on ("still working", "I'll continue").
 * Not unfinished: anything that ended on an answer; a conversation older than MAX_AGE_MS or written to
 * less than GRACE_MS ago; our own nudge as the last row.
 */
export function unfinishedWork(rows: readonly Row[], o: { now: number; openOrder: boolean; running: boolean }): Unfinished | null {
  const last = rows[rows.length - 1]
  if (!last) return null
  const at = Date.parse(last.timestamp)
  const age = Number.isNaN(at) ? 0 : o.now - at
  if (age > MAX_AGE_MS) return null
  if (age < GRACE_MS) return null
  if (o.openOrder && !o.running) return { why: 'an order from the Assistant was open', rowId: last.id }
  if (last.role === 'user') {
    if (!last.text.trim()) return null
    if (last.text.trimStart().startsWith(NUDGE_PREFIX)) return null
    return { why: 'the last message to it was never answered', rowId: last.id }
  }
  if (last.role === 'assistant') {
    if (!last.text.trim() && last.tools.length > 0) return { why: 'its last turn was cut off during a step', rowId: last.id }
    if (STILL.test(last.text.slice(-400))) return { why: 'its last words say the work is still going', rowId: last.id }
  }
  return null
}

export interface AgentRef {
  sessionId: string | null
  floorId: string
  floorName: string
  agentId: string
  agentName: string
  /** The overlay Assistant: never restarted or nudged by the heartbeat. */
  assistant: boolean
}

export type ChatNow = 'running' | 'question' | 'idle' | undefined

/** The morning summary: at this local time, or at his first overlay open after MORNING_OPEN_HOUR; once a day. */
export const MORNING_AT = { hour: 7, minute: 30 }
export const MORNING_OPEN_HOUR = 6

export interface HeartbeatDeps {
  now(): number
  /** Every agent on every floor. */
  agents(): AgentRef[]
  stateOf(sessionId: string): ChatNow
  /** The end of the chat's conversation (a few rows), or null when it has none. */
  tail(sessionId: string): Row[] | null
  /** An order from the Assistant is open for this chat (orders.ts). */
  openOrder(sessionId: string): boolean
  /** Starts the chat again where it ran. Resolves to null on success, else why not. */
  restart(floorId: string, agentId: string): Promise<string | null>
  /** Types `text` into the chat once it is at its prompt; false when it is not there. */
  nudge(sessionId: string, text: string): Promise<boolean>
  /** Types `text` into the Assistant's chat, starting it when it is not running; false when it could not. */
  wake(text: string): Promise<boolean>
  /** The newer build waiting for Shubham's Update now, if any. */
  newerBuild(): string | null
  /** Replies the Assistant has not taken (orders.ts). */
  undeliveredReplies(): number
  /** F-074: what was just told to the Assistant, for the phone's background service. */
  news?(items: { kind: FindingKind; text: string; agent?: string; floor?: string }[]): void
  /** F-078 morning summary: the build running now (its version), noted when it changes. */
  currentBuild?(): string | null
  /** What stopped or started again since `sinceMs`, and why, in plain lines (chat-log.ts). */
  overnight?(sinceMs: number): string[]
  /** What waits for Shubham: chats at a question, cards prepared for him, replies undelivered, a newer build, open tasks. */
  waiting?(): Promise<string[]>
  /**
   * F-083: the watchdog (watchdog.ts) looks at every chat on every beat: it starts chats that stopped when they should not
   * have (with its own limits), deals with the one harmless menu, and reports chats that are down, at a prompt or silent.
   * When it is given, it starts the stopped chats and this beat no longer does.
   */
  watch?(): Promise<Finding[]>
  file?: string
  log?: { info(m: string): void; warn(m: string): void }
}

export type FindingKind = 'restarted' | 'nudged' | 'cannot-restart' | 'question' | 'stuck' | 'build' | 'replies' | 'more' | 'menu' | 'down' | 'silent'

export interface Finding {
  kind: FindingKind
  /** Dedupe: told once per key until it changes or REPEAT_MS passes. */
  key: string
  text: string
  /** Something the app already did (or tried), as opposed to something only Shubham can do. */
  did: boolean
  /** The chat it is about, when it is about one. */
  agent?: string
  floor?: string
}

export interface BeatSummary {
  at: number
  /** Everything the check found this time, told or not. */
  findings: { kind: FindingKind; text: string; did: boolean }[]
  /** The Assistant was woken for it. */
  woke: boolean
  /** Chats looked at. */
  chats: number
}

export interface HeartbeatState extends HeartbeatSettings {
  last: BeatSummary | null
  /** When the next beat is due (ms), null while it is off. */
  nextAt: number | null
  now: number
}

interface Saved {
  settings: HeartbeatSettings
  /** Chats Shubham stopped on purpose. */
  stopped: string[]
  nudges: Record<string, { rowId: string; at: number[] }>
  told: Record<string, number>
  last: BeatSummary | null
  /** Builds seen running, newest last (the morning summary says which came in). */
  builds?: { version: string; at: number }[]
  /** The local day (YYYY-MM-DD) the morning summary was last sent. */
  morningDay?: string
}

export interface Heartbeat {
  state(): HeartbeatState
  set(patch: Partial<HeartbeatSettings>): HeartbeatState
  /** A beat now, whatever the schedule. */
  beat(): Promise<BeatSummary>
  /** The timer's call: a beat when one is due. */
  tick(): Promise<void>
  /** Shubham stopped this chat on purpose: left alone until it is opened again. */
  stoppedOnPurpose(sessionId: string): void
  /** F-083: did Shubham stop this chat on purpose (and not open it since)? */
  isStopped(sessionId: string): boolean
  opened(sessionId: string): void
  /** The morning summary: sent once a day, when due (the timer) or when he opens the overlay after 06:00 (`atOpen`). True when it was sent now. */
  morning(o?: { atOpen?: boolean }): Promise<boolean>
}

/** The local day as YYYY-MM-DD. */
const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export function validInterval(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_INTERVAL && n <= MAX_INTERVAL ? n : null
}

export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const saved = load(deps.file)
  let nextAt: number | null = saved.settings.enabled ? deps.now() + FIRST_BEAT_MS : null
  let running = false

  const save = () => {
    if (!deps.file) return
    try {
      writeAtomic(deps.file, JSON.stringify(saved, null, 2))
    } catch (e) {
      deps.log?.warn(`heartbeat: could not be saved: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const schedule = () => {
    nextAt = saved.settings.enabled ? deps.now() + saved.settings.intervalMin * 60_000 : null
  }

  async function beat(): Promise<BeatSummary> {
    const now = deps.now()
    const findings: Finding[] = []
    let chats = 0
    let restarts = 0
    let held = 0
    const questionSince = saved.told // reuse: question first-seen times live under 'qs:<sid>'
    const seenQuestion = new Set<string>()

    for (const a of deps.agents()) {
      const sid = a.sessionId
      if (!sid) continue
      chats++
      const st = deps.stateOf(sid)
      const who = `${a.agentName} on ${a.floorName}`

      if (st === 'question') {
        seenQuestion.add(sid)
        const first = questionSince[`qs:${sid}`] ?? now
        questionSince[`qs:${sid}`] = first
        if (now - first >= QUESTION_AFTER_MS && !a.assistant) {
          findings.push({ kind: 'question', key: `question:${sid}`, did: false, agent: a.agentName, floor: a.floorName, text: `${who} has been waiting at a question for ${Math.round((now - first) / 60_000)} min (the Approvals tab has it).` })
        }
        continue
      }
      if (st === 'running') continue
      if (a.assistant) continue
      if (saved.stopped.includes(sid)) continue
      if (st === undefined && deps.watch) continue // F-083: the watchdog starts stopped chats, with its limits

      const rows = deps.tail(sid)
      const u = rows ? unfinishedWork(rows, { now, openOrder: deps.openOrder(sid), running: st !== undefined }) : null

      // A chat that did not pick up its nudge: said once, nothing more is done to it.
      const prior = saved.nudges[sid]
      if (!u && rows && st === 'idle' && prior) {
        const last = rows[rows.length - 1]
        if (last?.role === 'user' && last.text.trimStart().startsWith(NUDGE_PREFIX) && now - Date.parse(last.timestamp) > QUESTION_AFTER_MS) {
          findings.push({ kind: 'stuck', key: `stuck:${sid}:${last.id}`, did: false, agent: a.agentName, floor: a.floorName, text: `${who} did not pick up the nudge (it sits idle after it).` })
        }
        continue
      }
      if (!u) continue

      const mine = saved.nudges[sid] ?? { rowId: '', at: [] }
      const recent = mine.at.filter(t => now - t < NUDGE_WINDOW_MS)
      if (mine.rowId === u.rowId || recent.length >= MAX_NUDGES) continue // already nudged for these last words, or enough for now

      let restartedNow = false
      if (st === undefined) {
        if (restarts >= MAX_RESTARTS) {
          held++
          continue
        }
        restarts++
        const why = await deps.restart(a.floorId, a.agentId).catch(e => (e instanceof Error ? e.message : String(e)))
        if (why) {
          findings.push({ kind: 'cannot-restart', key: `cannot:${sid}:${u.rowId}`, did: true, agent: a.agentName, floor: a.floorName, text: `${who} stopped with work unfinished (${u.why}) and could not be started again: ${why}.` })
          saved.nudges[sid] = { rowId: u.rowId, at: [...recent, now] } // not tried again for these last words
          continue
        }
        restartedNow = true
      }
      const text = `${NUDGE_PREFIX}${hhmm(now)}] The app's check found that your chat had stopped before its work was finished (${u.why}). Carry on from where you left off. If it was already done, or is waiting for Shubham, say so in one line. This is not an order and not from another chat: do not answer it with an acknowledgement.`
      const sent = await deps.nudge(sid, text).catch(() => false)
      saved.nudges[sid] = { rowId: u.rowId, at: [...recent, now] }
      findings.push(
        restartedNow
          ? { kind: 'restarted', key: `restarted:${sid}:${u.rowId}`, did: true, agent: a.agentName, floor: a.floorName, text: `${who} had stopped with work unfinished (${u.why}). The app started it again${sent ? ' and nudged it once to carry on' : ' (the nudge could not be typed yet)'}.` }
          : { kind: 'nudged', key: `nudged:${sid}:${u.rowId}`, did: true, agent: a.agentName, floor: a.floorName, text: `${who} sat idle with work unfinished (${u.why}). The app nudged it once to carry on.` },
      )
    }
    if (deps.watch) {
      try {
        findings.push(...(await deps.watch()))
      } catch (e) {
        deps.log?.warn(`heartbeat: the watchdog failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const k of Object.keys(questionSince)) if (k.startsWith('qs:') && !seenQuestion.has(k.slice(3))) delete questionSince[k]
    if (held > 0) findings.push({ kind: 'more', key: `more:${held}`, did: false, text: `${held} more stopped chat${held === 1 ? '' : 's'} with unfinished work wait for the next beat.` })

    const build = deps.newerBuild()
    if (build) findings.push({ kind: 'build', key: `build:${build}`, did: false, text: `A newer build (${build}) is waiting; only Shubham presses Update now.` })
    const replies = deps.undeliveredReplies()
    if (replies > 0) findings.push({ kind: 'replies', key: `replies:${replies}`, did: false, text: `${replies} agent repl${replies === 1 ? 'y has' : 'ies have'} not reached the Assistant yet.` })

    // Told once each (until it changes or an hour passes); nothing at all when nothing is new.
    const fresh = findings.filter(f => !(f.key in saved.told) || now - saved.told[f.key] >= REPEAT_MS)
    let woke = false
    if (fresh.length > 0) {
      const text = [
        `[heartbeat ${hhmm(now)}] The app's regular check found ${fresh.length === 1 ? 'something' : `${fresh.length} things`}:`,
        ...fresh.map(f => `- ${f.text}`),
        'Give Shubham ONE short plain line about this in the overlay (what the app did, and what is for him). Do not restart, nudge, order, approve or answer anything yourself because of this, and do not reply to this message with an acknowledgement.',
      ].join('\n')
      woke = await deps.wake(text).catch(() => false)
      if (woke) {
        for (const f of fresh) saved.told[f.key] = now
        try {
          deps.news?.(fresh.map(f => ({ kind: f.kind, text: f.text, agent: f.agent, floor: f.floor })))
        } catch {
          // The phone's feed must not stop a beat.
        }
      }
    }
    // Keys that are no longer true are forgotten, so they are told again if they come back.
    const live = new Set(findings.map(f => f.key))
    for (const k of Object.keys(saved.told)) if (!k.startsWith('qs:') && !live.has(k)) delete saved.told[k]

    const summary: BeatSummary = { at: now, findings: findings.map(f => ({ kind: f.kind, text: f.text, did: f.did })), woke, chats }
    saved.last = summary
    schedule()
    save()
    if (findings.length) deps.log?.info(`heartbeat: ${findings.length} finding(s), ${woke ? 'the Assistant was woken' : 'nothing new to tell'}`)
    return summary
  }

  function noteBuild() {
    const v = deps.currentBuild?.()
    if (!v) return
    const list = (saved.builds ??= [])
    if (list[list.length - 1]?.version === v) return
    list.push({ version: v, at: deps.now() })
    if (list.length > 20) list.splice(0, list.length - 20)
    save()
  }

  async function morning(o: { atOpen?: boolean } = {}): Promise<boolean> {
    const now = deps.now()
    const d = new Date(now)
    const today = dayOf(now)
    if (saved.morningDay === today) return false
    const minutes = d.getHours() * 60 + d.getMinutes()
    const due = o.atOpen ? d.getHours() >= MORNING_OPEN_HOUR : minutes >= MORNING_AT.hour * 60 + MORNING_AT.minute
    if (!due) return false
    noteBuild()
    const since = now - 24 * 3_600_000
    const came = (saved.builds ?? []).filter(b => b.at >= since)
    const running = saved.builds?.[saved.builds.length - 1]
    const published = running
      ? [`Running build ${running.version} (since ${hhmm(running.at)}).`, ...(came.length > 1 ? [`Builds that came in since yesterday: ${came.map(b => `${b.version} at ${hhmm(b.at)}`).join(', ')}.`] : [])]
      : ['Which build is running is not known.']
    const overnight = deps.overnight?.(since) ?? []
    const waiting = (await deps.waiting?.().catch(() => [])) ?? []
    const list = (title: string, lines: string[], none: string) => [title, ...(lines.length ? lines : [none]).map(l => `- ${l}`)]
    const text = [
      `[morning summary ${hhmm(now)}] Good morning. This is the app's own daily summary for Shubham. Give him ONE short news item from it, in plain words (a few lines at most). Do not answer this message with an acknowledgement, and do not restart, order or approve anything because of it.`,
      ...list('Published:', published, 'Nothing is known.'),
      ...list('Overnight, what stopped or started again, and why:', overnight, 'Nothing stopped.'),
      ...list('Waiting for him:', waiting, 'Nothing waits.'),
    ].join(String.fromCharCode(10))
    const sent = await deps.wake(text).catch(() => false)
    if (sent) {
      saved.morningDay = today
      save()
      deps.log?.info('heartbeat: the morning summary was sent')
    }
    return sent
  }

  const state = (): HeartbeatState => ({ ...saved.settings, last: saved.last, nextAt, now: deps.now() })

  return {
    state,
    set(patch) {
      if (typeof patch.enabled === 'boolean') saved.settings.enabled = patch.enabled
      const n = validInterval(patch.intervalMin)
      if (n !== null) saved.settings.intervalMin = n
      schedule()
      save()
      return state()
    },
    beat,
    async tick() {
      if (running || !saved.settings.enabled) return
      noteBuild()
      running = true
      try {
        await morning()
        if (nextAt === null || deps.now() < nextAt) return
        await beat()
      } catch (e) {
        deps.log?.warn(`heartbeat: a beat failed: ${e instanceof Error ? e.message : String(e)}`)
        schedule()
      } finally {
        running = false
      }
    },
    morning: o => (saved.settings.enabled ? morning(o) : Promise.resolve(false)),
    isStopped: sid => saved.stopped.includes(sid),
    stoppedOnPurpose(sid) {
      if (!saved.stopped.includes(sid)) {
        saved.stopped.push(sid)
        save()
      }
    },
    opened(sid) {
      const i = saved.stopped.indexOf(sid)
      if (i >= 0) {
        saved.stopped.splice(i, 1)
        save()
      }
    },
  }
}

function load(file: string | undefined): Saved {
  const fresh: Saved = { settings: { ...DEFAULT_SETTINGS }, stopped: [], nudges: {}, told: {}, last: null }
  if (!file || !existsSync(file)) return fresh
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
    const n = validInterval(raw.settings?.intervalMin)
    return {
      settings: { enabled: raw.settings?.enabled !== false, intervalMin: n ?? DEFAULT_SETTINGS.intervalMin },
      stopped: Array.isArray(raw.stopped) ? raw.stopped.filter((s): s is string => typeof s === 'string') : [],
      nudges: raw.nudges && typeof raw.nudges === 'object' ? raw.nudges : {},
      told: raw.told && typeof raw.told === 'object' ? raw.told : {},
      last: raw.last && typeof raw.last === 'object' ? raw.last : null,
      builds: Array.isArray(raw.builds) ? raw.builds.filter(b => b && typeof b.version === 'string' && typeof b.at === 'number') : [],
      morningDay: typeof raw.morningDay === 'string' ? raw.morningDay : undefined,
    }
  } catch {
    return fresh
  }
}
