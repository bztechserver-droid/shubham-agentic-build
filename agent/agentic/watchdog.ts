import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../config.ts'
import type { ChatEvent } from './chat-log.ts'
import type { AgentRef, ChatNow, Finding } from './heartbeat.ts'
import { NUDGE_PREFIX } from './heartbeat.ts'

// F-083: the hub's watchdog. The heartbeat (heartbeat.ts) calls it on every beat (5 minutes), so it is the app's own
// timer and does not depend on the Assistant's chat being alive. It looks at EVERY chat on EVERY floor, not a list:
//   - a chat that stopped and should not have (it crashed, the app updated or restarted under it, it exited) and has an
//     open order or unfinished work is started again and told what happened. Never one Shubham stopped, never one the
//     idle reaper stopped for true idleness (no open order, no unfinished work: else the reaper and this would take
//     turns for ever), never while F-058 recovery is still reopening chats, never a chat whose home PC is offline (F-064:
//     that is reported). At most MAX_RESTARTS_PER_HOUR per chat, with a longer wait after each, and only while at least
//     MIN_FREE_COMMIT_MB of commit is free: a restart costs memory, and a low-memory crash started the whole night's trouble.
//   - a chat at a menu: never answered, with ONE exception. "Teach auto mode about your environment?" matched exactly
//     (the title, the three options, the footer) is dismissed with the single key 3, "Don't show again". Its setup
//     screen (the same title, "Enter to continue") is never sent a key: the chat is started again, which discards the
//     screen without pressing anything. Every other prompt is the heartbeat's to report; the Assistant's own is reported here.
//   - a chat "running" with no output for SILENT_AFTER_MS is reported, never stopped.
// Every event is one plain line in chat-events.jsonl (chat-log.ts). SAD_WATCHDOG=0 turns this off (the heartbeat goes on).

export const MIN_FREE_COMMIT_MB = 3500
export const MAX_RESTARTS_PER_HOUR = 3
/** Waits after the 1st, 2nd, 3rd restart of a chat inside the hour. */
export const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000]
/** Most chats started again in one beat: the memory is looked at again before each. */
export const MAX_PER_BEAT = 3
/** A chat down (or held down) or at a prompt this long is told to Shubham. */
export const TELL_AFTER_MS = 10 * 60_000
/** A harmless menu is dismissed once it has stood this long (a person may be at it). */
export const DISMISS_AFTER_MS = 2 * 60_000
/** "Running" with no output this long is reported. */
export const SILENT_AFTER_MS = 30 * 60_000
/** Stops older than this are not looked at. */
export const LOOKBACK_MS = 24 * 3_600_000
/** After the key, how long before the screen is read again. */
export const CHECK_AFTER_MS = 2000

// -------------------------------------------------------------------------------------------------------------
// The one menu that may be dismissed

const OFFER_TITLE_RE = /Teach auto mode about your environment\?/i

export type MenuKind = 'none' | 'offer' | 'setup' | 'other'

/**
 * What menu a screen shows, judged only from the part of it from the LAST such title down (older scrollback does not count).
 *   offer: the title AND its three options (1. Yes / 2. Not now / 3. Don't show again) AND a footer "Enter to confirm|select ... Esc to cancel".
 *   setup: the title with "Enter to continue" (the screen "Yes" opens): the same title, so it must never be sent a key.
 *   other: the title with anything else; none: no such title at all (another prompt is the caller's to report).
 * An input box (a rule line) between the title and the end means the menu is gone, so none.
 */
export function classifyMenu(lines: readonly string[]): MenuKind {
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OFFER_TITLE_RE.test(lines[i])) {
      at = i
      break
    }
  }
  if (at < 0) return 'none'
  const seg = lines.slice(at)
  if (seg.some(l => /^\s*[─━]{8,}/.test(l))) return 'none'
  const text = seg.join('\n')
  if (/Enter to continue/i.test(text) || /How you use Claude here/i.test(text) || /Also scan/i.test(text)) return 'setup'
  const offer = /\b1\.\s*Yes\b/i.test(text) && /\b2\.\s*Not now\b/i.test(text) && /\b3\.\s*Don['’]t show again\b/i.test(text) && /Enter to (?:confirm|select)/i.test(text) && /Esc to cancel/i.test(text)
  return offer ? 'offer' : 'other'
}

// -------------------------------------------------------------------------------------------------------------

/** How a stop is told to the chat and to Shubham, from its cause word (chats.ts). */
const CAUSE_WORDS: Record<string, string> = {
  'idle-reaper': 'idle-reaper',
  'agent-stop': 'the app stopped (an update or a restart)',
  crashed: 'it crashed',
  exited: 'it exited',
  ended: 'it ended',
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/** Causes after which a chat may be started again (and only with an open order or unfinished work). Shubham's own stop is never one. */
const RESUMABLE = new Set(['crashed', 'exited', 'ended', 'agent-stop', 'idle-reaper'])

/** The nudge a restarted chat gets: what happened, and that a background job it had running is gone. */
export function nudgeText(o: { now: number; stop: { at: number; cause: string } | null; why: string }): string {
  const what = o.stop
    ? `Your chat was stopped at ${hhmm(o.stop.at)} (${CAUSE_WORDS[o.stop.cause] ?? o.stop.cause}).`
    : 'Your chat was found stopped (the app was restarted or crashed under it).'
  return `${NUDGE_PREFIX}${hhmm(o.now)}] ${what} It had work unfinished (${o.why}). The app started it again. Any background job you had running (a shell, a workflow) was lost: check its state, then carry on from where you left off. If it was already done, or is waiting for Shubham, say so in one line. This is not an order and not from another chat: do not answer it with an acknowledgement.`
}

export interface WatchDeps {
  now(): number
  /** Every agent on every floor. */
  agents(): AgentRef[]
  stateOf(sessionId: string): ChatNow
  /** Chat events (chat-log.ts) since an epoch time, oldest first. */
  events(sinceMs: number): ChatEvent[]
  /** Shubham stopped this chat himself (the heartbeat keeps that list). */
  stoppedOnPurpose(sessionId: string): boolean
  /** Why this chat has work to go on with (an open order, unfinished work), or null. */
  work(sessionId: string): string | null
  /** F-058 recovery is still reopening chats: the watchdog waits. */
  recoveryBusy(): boolean
  /** Free commit in MB, null when it can't be read (then nothing is started: when in doubt, not). */
  freeCommitMB(): Promise<number | null>
  /** Starts the chat on its home PC and types `text` into it once it is at its prompt. Resolves to null, or why not: 'offline: ...' when its home PC is offline. */
  restart(floorId: string, agentId: string, text: string): Promise<string | null>
  /** Ends the chat and opens it again, pressing no key at all (a restart discards a menu's screen). */
  restartClean(sessionId: string): Promise<boolean>
  /** Runs here (the screen can be read and keys sent) and nobody has it open. */
  local(sessionId: string): { watching: boolean } | null
  screen(sessionId: string): string[] | null
  /** Is a menu up right now (chats.asking: reads the live screen, not the guessed state). */
  asking(sessionId: string): boolean
  press(sessionId: string, keys: string): boolean
  activity(sessionId: string): { lastOutputAt: number; background: string | null } | null
  sleep?(ms: number): Promise<void>
  /** One line in the chat log for the pattern and the morning summary. */
  record(e: { sessionId: string; agent: string; floor: string; what: string; cause: string; did: string }): void
  file?: string
  log?: { info(m: string): void; warn(m: string): void }
}

interface Saved {
  /** When each chat was started again by the watchdog (ms), the last hour or so. */
  restarts: Record<string, number[]>
  /** Not before this time (ms). */
  nextTry: Record<string, number>
  /** First seen down with work to go on (ms). */
  downSince: Record<string, number>
  /** First seen at the same menu (ms). */
  menuSince: Record<string, number>
}

export interface WatchState {
  enabled: boolean
  /** Chats down now with work unfinished that the watchdog has not got back yet. */
  down: { agent: string; floor: string; sinceMs: number; why: string }[]
  /** Restarts the watchdog made in the last hour. */
  restartsLastHour: number
}

export interface Watchdog {
  /** One look at every chat; the findings go into the heartbeat's beat. */
  watch(): Promise<Finding[]>
  state(): WatchState
}

export function createWatchdog(deps: WatchDeps): Watchdog {
  const saved = load(deps.file)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  let downNow: WatchState['down'] = []

  const save = () => {
    if (!deps.file) return
    try {
      writeAtomic(deps.file, JSON.stringify(saved, null, 2))
    } catch (e) {
      deps.log?.warn(`watchdog: could not be saved: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** The last stop of a chat since its last start, from the log. */
  function lastStop(sid: string, events: readonly ChatEvent[]): { at: number; cause: string } | null {
    let stop: { at: number; cause: string } | null = null
    for (const e of events) {
      if (e.sessionId !== sid) continue
      if (e.event === 'start') stop = null
      else if (e.event === 'stop') stop = { at: Date.parse(e.at), cause: e.cause }
    }
    return stop
  }

  async function watch(): Promise<Finding[]> {
    const now = deps.now()
    const findings: Finding[] = []
    const events = deps.events(now - LOOKBACK_MS)
    const seenDown = new Set<string>()
    const seenMenu = new Set<string>()
    const nowDown: WatchState['down'] = []
    let started = 0
    let freeMB: number | null | undefined

    for (const a of deps.agents()) {
      const sid = a.sessionId
      if (!sid) continue
      const who = `${a.agentName} on ${a.floorName}`
      const st = deps.stateOf(sid)
      const note = (what: string, cause: string, did: string) => deps.record({ sessionId: sid, agent: a.agentName, floor: a.floorName, what, cause, did })

      if (st !== undefined) {
        // ---- running somewhere: a menu, or silence
        const local = deps.local(sid)
        if (local && deps.asking(sid)) {
          seenMenu.add(sid)
          const first = (saved.menuSince[sid] ??= now)
          const lines = deps.screen(sid) ?? []
          const kind = classifyMenu(lines)
          if (kind === 'setup') {
            // The screen "Yes" opens: no key at all. A restart discards it without pressing anything.
            if (!local.watching && now - first >= DISMISS_AFTER_MS) {
              const ok = await deps.restartClean(sid).catch(() => false)
              note('was at the setup screen of "Teach auto mode about your environment?"', 'menu', ok ? 'started the chat again, pressed nothing' : 'tried to start the chat again, could not')
              findings.push({ kind: 'menu', key: `menu-setup:${sid}:${first}`, did: true, agent: a.agentName, floor: a.floorName, text: `${who} sat at the setup screen of "Teach auto mode about your environment?". ${ok ? 'The app started the chat again (nothing was pressed).' : 'The app could not start it again.'}` })
              delete saved.menuSince[sid]
            }
          } else if (kind === 'offer') {
            if (!local.watching && now - first >= DISMISS_AFTER_MS) {
              const sent = deps.press(sid, '3') // "Don't show again": the digit alone confirms. Never Enter, never Yes.
              await sleep(CHECK_AFTER_MS)
              const gone = sent && !deps.asking(sid)
              if (gone) {
                note('was at the offer "Teach auto mode about your environment?"', 'menu', 'pressed 3 (Don\'t show again); the menu is gone')
                findings.push({ kind: 'menu', key: `menu-offer:${sid}:${first}`, did: true, agent: a.agentName, floor: a.floorName, text: `${who} sat at the offer "Teach auto mode about your environment?". The app chose "Don't show again" and it is gone.` })
              } else {
                const ok = await deps.restartClean(sid).catch(() => false)
                note('was at the offer "Teach auto mode about your environment?"', 'menu', `pressed 3, the menu did not go; ${ok ? 'started the chat again, pressed nothing more' : 'could not start the chat again'}`)
                findings.push({ kind: 'menu', key: `menu-offer:${sid}:${first}`, did: true, agent: a.agentName, floor: a.floorName, text: `${who} sat at the offer "Teach auto mode about your environment?"; the key did not dismiss it, so the app ${ok ? 'started the chat again' : 'tried to start the chat again and could not'}.` })
              }
              delete saved.menuSince[sid]
            }
          } else if (a.assistant && now - first >= TELL_AFTER_MS) {
            // Any other prompt is never answered. The heartbeat tells of every chat's but the Assistant's own.
            const mins = Math.round((now - first) / 60_000)
            note('is waiting at a prompt', 'menu', `told Shubham after ${mins} min; answered nothing`)
            findings.push({ kind: 'menu', key: `menu:${sid}:${first}`, did: false, agent: a.agentName, floor: a.floorName, text: `${who} has been waiting at a prompt for ${mins} min; it needs Shubham's answer on the PC.` })
          }
        }
        if (st === 'running') {
          const act = deps.activity(sid)
          if (act && !act.background) {
            const quiet = now - act.lastOutputAt
            if (quiet >= SILENT_AFTER_MS) {
              const mins = Math.round(quiet / 60_000)
              findings.push({ kind: 'silent', key: `silent:${sid}:${Math.floor(act.lastOutputAt / 60_000)}`, did: false, agent: a.agentName, floor: a.floorName, text: `${who} says it is working but has printed nothing for ${mins} min. The app did not touch it.` })
              note('shows working but prints nothing', 'silent', `told Shubham after ${mins} min; did nothing to it`)
            }
          }
        }
        continue
      }

      // ---- not running anywhere
      if (deps.stoppedOnPurpose(sid)) continue
      const stop = lastStop(sid, events)
      if (stop && !RESUMABLE.has(stop.cause)) continue // stopped by Shubham, or a cause not known as unintended
      const why = deps.work(sid)
      if (!why) continue // true idleness: stays stopped, whoever stopped it
      if (deps.recoveryBusy()) continue // F-058 is reopening the chats; it is not raced
      seenDown.add(sid)
      const first = (saved.downSince[sid] ??= now)
      const held = (reason: string, cause: string) => {
        nowDown.push({ agent: a.agentName, floor: a.floorName, sinceMs: first, why: reason })
        if (now - first >= TELL_AFTER_MS) {
          findings.push({ kind: 'down', key: `down:${sid}:${first}`, did: false, agent: a.agentName, floor: a.floorName, text: `${who} has been down for ${Math.round((now - first) / 60_000)} min with work unfinished (${why}): ${reason}.` })
        }
        if (cause) note('is down with work unfinished', cause, reason)
      }

      const mine = (saved.restarts[sid] ??= []).filter(t => now - t < 3_600_000)
      saved.restarts[sid] = mine
      if (mine.length >= MAX_RESTARTS_PER_HOUR) {
        held(`held: the app already started it ${mine.length} times in the last hour; it waits for Shubham`, 'limit')
        continue
      }
      if ((saved.nextTry[sid] ?? 0) > now) {
        held(`held: waiting ${Math.ceil(((saved.nextTry[sid] ?? 0) - now) / 60_000)} min before it is tried again`, '')
        continue
      }
      if (started >= MAX_PER_BEAT) {
        held('held: others are being started first (the rest next beat)', '')
        continue
      }
      freeMB = await deps.freeCommitMB().catch(() => null)
      if (freeMB === null || freeMB < MIN_FREE_COMMIT_MB) {
        held(`held: memory (${freeMB === null ? 'free commit unknown' : `${(freeMB / 1024).toFixed(1)} GB free commit`}, needs ${(MIN_FREE_COMMIT_MB / 1024).toFixed(1)} GB)`, 'memory')
        continue
      }
      const text = nudgeText({ now, stop, why })
      const failed = await deps.restart(a.floorId, a.agentId, text).catch(e => (e instanceof Error ? e.message : String(e)))
      started++
      saved.restarts[sid] = [...mine, now]
      saved.nextTry[sid] = now + BACKOFF_MS[Math.min(mine.length, BACKOFF_MS.length - 1)]
      const cause = stop ? (CAUSE_WORDS[stop.cause] ?? stop.cause) : 'unknown (no stop was logged)'
      if (failed) {
        if (/^offline:/i.test(failed)) {
          // F-064: its home PC is offline; it is not started here.
          held(failed.replace(/^offline:\s*/i, 'its home PC is offline: '), 'home-offline')
          findings.push({ kind: 'down', key: `home:${sid}`, did: false, agent: a.agentName, floor: a.floorName, text: `${who} is down with work unfinished (${why}) and its home PC is offline, so the app did not start it here.` })
        } else {
          held(`could not be started: ${failed}`, 'restart-failed')
          findings.push({ kind: 'cannot-restart', key: `cannot:${sid}:${first}:${mine.length}`, did: true, agent: a.agentName, floor: a.floorName, text: `${who} stopped (${cause}) with work unfinished (${why}) and the app could not start it again: ${failed}.` })
        }
        continue
      }
      delete saved.downSince[sid]
      note(`had stopped (${cause}) with work unfinished (${why})`, 'watchdog-restart', 'started it again and told it what happened')
      findings.push({ kind: 'restarted', key: `restarted:${sid}:${now}`, did: true, agent: a.agentName, floor: a.floorName, text: `${who} had stopped (${cause}) with work unfinished (${why}). The app started it again and told it that any background job was lost.` })
    }

    // Things no longer true are forgotten.
    for (const k of Object.keys(saved.downSince)) if (!seenDown.has(k)) delete saved.downSince[k]
    for (const k of Object.keys(saved.menuSince)) if (!seenMenu.has(k)) delete saved.menuSince[k]
    for (const k of Object.keys(saved.restarts)) if (!(saved.restarts[k] ?? []).some(t => now - t < 3_600_000) && !seenDown.has(k)) delete saved.restarts[k]
    for (const k of Object.keys(saved.nextTry)) if (saved.nextTry[k] <= now) delete saved.nextTry[k]
    downNow = nowDown
    save()
    return findings
  }

  return {
    watch,
    state: () => ({ enabled: true, down: downNow, restartsLastHour: Object.values(saved.restarts).reduce((n, l) => n + l.filter(t => deps.now() - t < 3_600_000).length, 0) }),
  }
}

function load(file: string | undefined): Saved {
  const fresh: Saved = { restarts: {}, nextTry: {}, downSince: {}, menuSince: {} }
  if (!file || !existsSync(file)) return fresh
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
    const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {})
    return { restarts: obj<number[]>(raw.restarts), nextTry: obj<number>(raw.nextTry), downSince: obj<number>(raw.downSince), menuSince: obj<number>(raw.menuSince) }
  } catch {
    return fresh
  }
}

let memo: { at: number; mb: number | null } | null = null
/** Free commit in MB from the text Windows gave (FreeVirtualMemory, in KB); null when it is not a number. */
export function parseFreeCommitKB(out: string): number | null {
  const kb = Number(String(out).trim())
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null
}
/**
 * Free commit (commit limit minus committed: what a new process can still get) in MB, from Windows; null when it can't be
 * read (not Windows, or the call failed). Read at most once a minute.
 */
export function readFreeCommitMB(): Promise<number | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (memo && Date.now() - memo.at < 60_000) return Promise.resolve(memo.mb)
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory'], { timeout: 15_000, windowsHide: true }, (err, out) => {
      const mb = err ? null : parseFreeCommitKB(String(out))
      memo = { at: Date.now(), mb }
      resolve(mb)
    })
  })
}
