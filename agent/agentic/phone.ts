import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { apiError } from '../api.ts'
import { writeAtomic } from '../config.ts'
import { PHONE_SWITCH_OFF_LINE, type PhoneControlStatus, type PhoneSwitch } from '../../shared/phone-control.ts'

// F-082 (hub side): the Assistant's hands on Shubham's phone. The phone app (Chris) holds an accessibility service; this
// module is the other end of its protocol (mobile/docs/HUB-PROTOCOL.md §11). The Assistant and the Mobile agent's chat (F-084 H2;
// index.ts checks who) call phone_screen and phone_control; each becomes one command the phone fetches with a long poll, runs, and
// answers. Every command says who asked, `by`, for the phone's action log and its notification. The commands of both callers share one
// queue, one command in flight and one rate limit per phone.
//
//   phone (device key, like every /voice route):
//     POST /voice/control/state     {armed, reason?, app?, v}   on a change
//     GET  /voice/control/next?wait=25   the long poll that is also the heartbeat -> {cmd:{id, op, args, why, by, deadlineMs}|null, stopped?}
//     POST /voice/control/result    {id, ok, kind?, error?, data?}   up to 2 MiB (a screen with its nodes, a shot)
//     POST /voice/control/progress  {id, waiting:'biometric', summary}   a sensitive action needs his fingerprint: wait longer
//     POST /voice/control/stop      {reason}   his STOP: everything pending ends, control stays off until the phone resumes (resume:true: his tap in Chris)
//   page (app token):  GET /voice/control-status    POST /voice/control-stop (a kill switch that needs no signature: it only takes power away)
//                      POST /voice/control-switch {on}   order oae15: the PC's own switch (voice.ts: ON needs his CRM administrator session)
//
// Order oae15 (Shubham, 14 Nov 2026: "Yes to both, start"): phone control is OFF until he switches it on in the app (Settings › Devices ›
// Phone control); while it is off every phone_screen / phone_control is refused here, and switching it off stops at once whatever the phone is
// doing (a STOP for every phone: the phone turns its own switch off too, so only he can start it again there). A STOP ends only with the
// phone's own resume (resume:true, his tap on the phone), never with a plain armed:true the phone may have sent before it heard of the STOP,
// and it is kept on disk with the switch, so a restart of the hub does not end it either (a phone stopped while it was away hears it when it
// comes back). Who stopped it (the phone, Stop now in the app, the switch going off) is what the Assistant is told.
//
// What the hub guarantees: one command in flight; at most 60 a minute; none unless the phone is armed and was heard from in the last
// 90 s; every command's op and arguments are written to phone-control.jsonl with the result's ok/kind/error and its node count, but
// never a screen's text, a node's text, what was typed (only its length) or a shot. The safety rules about what is on the screen
// (banking, passwords, sending, paying) are the phone's: it sees the screen. A shot is saved as a file the Assistant can look at.

/** Who asked for a command. The caller (index.ts) names it from the chat's identity; a tool's own arguments can never say. */
export const CALLERS = ['assistant', 'mobile'] as const
export type PhoneCaller = (typeof CALLERS)[number]

export const ONLINE_MS = 90_000
export const PICKUP_MS = 10_000
export const COMMAND_MS = 20_000
// Order oae15: his fingerprint is waited for at most 90 s on the phone (ControlRunner.CONFIRM_MS), 100 s here (+ the grace), and the chat's
// tool call gives up after 120 s (mcp-shim.ts CALL_TIMEOUT_MS) from before the pickup (up to PICKUP_MS): so a late yes can never act on the phone
// after the Assistant was told that it failed (phone.test.ts pins the order of the three).
export const BIOMETRIC_MS = 100_000
export const GRACE_MS = 3_000
export const MAX_PER_MIN = 60
export const MAX_RESULT_BYTES = 2 * 1024 * 1024
export const MAX_NODES = 400
export const KEEP_SHOTS = 5
const LOG_TEXT = 200

export const OPS = ['screen', 'tap', 'long_press', 'type', 'scroll', 'swipe', 'back', 'home', 'recents', 'notifications', 'open_app', 'wait'] as const
export type Op = (typeof OPS)[number]
export const KINDS = ['refused', 'declined', 'locked', 'stale', 'failed', 'stopped', 'not-found'] as const
export type Kind = (typeof KINDS)[number]
export const REASONS = ['service-off', 'switch-off', 'stopped', 'locked', 'screen-off'] as const
export type Reason = (typeof REASONS)[number]

const WHY: Record<Reason, string> = {
  'service-off': "Chris's accessibility service is off on the phone (Settings › Accessibility); only Shubham can turn it on",
  'switch-off': "Chris's switch for letting the Assistant control the phone is off; only Shubham can turn it on",
  stopped: 'Shubham pressed STOP on the phone; control stays off until he turns it on again there',
  locked: 'the phone is locked; control works only while it is unlocked',
  'screen-off': "the phone's screen is off",
}

export interface Node {
  id: string
  text: string
  desc: string
  cls: string
  x: number
  y: number
  w: number
  h: number
  /** c clickable, e editable, s scrollable, k checked, F focused, p password (no text), d disabled. */
  f: string
}

export interface ScreenData {
  package: string
  app: string
  title: string
  w: number
  h: number
  nodes: Node[]
  truncated: boolean
  /** Where the shot was saved on this PC, when the phone sent one. */
  shot: string | null
}

export interface PhoneResult {
  ok: boolean
  kind: Kind | null
  error: string
  note: string
  screen: ScreenData | null
  candidates: { app: string; package: string }[]
}

export interface PhoneState {
  id: string
  name: string
  online: boolean
  armed: boolean
  reason: Reason | null
  stopped: boolean
  /** The app in front, or 'blocked'; null while not armed or unknown. */
  app: string | null
  /** Seconds since the phone was last heard from. */
  quietS: number | null
  pending: number
  waiting: string | null
}

export interface LogRow {
  at: number
  device: string
  op: string
  args: Record<string, unknown>
  why: string
  /** Who asked; rows written before F-084 have none (they were the Assistant's). */
  by?: PhoneCaller
  ok: boolean
  kind: string | null
  error: string
  nodes: number | null
}

export interface PhoneTiming {
  online: number
  pickup: number
  command: number
  biometric: number
  grace: number
}

export interface PhoneDeps {
  now(): number
  /** The folder for phone-control.jsonl and the shots; without it nothing is written. */
  dir?: string
  timing?: Partial<PhoneTiming>
  log?: { info(m: string): void; warn(m: string): void }
}

interface Cmd {
  id: string
  op: Op
  args: Record<string, unknown>
  why: string
  by: PhoneCaller
  created: number
  /** Hub clock: when it counts as late. Before pickup it is the pickup limit; after, the phone's time to answer. */
  deadline: number
  picked: boolean
  waiting: string | null
  timer: ReturnType<typeof setTimeout> | null
  resolve(r: PhoneResult): void
}

/** Where a STOP came from: his STOP on the phone, Stop now in the app, or the app's switch going off. */
type StopFrom = 'phone' | 'app' | 'switch'
const STOP_FROM: readonly StopFrom[] = ['phone', 'app', 'switch']

interface Dev {
  id: string
  name: string
  armed: boolean
  reason: Reason | null
  app: string | null
  /** Any word from the phone (a state, a next, a result): the hub's idea of "online". */
  heard: number
  /** A state was posted since this hub started. */
  stated: boolean
  stopped: boolean
  stopFrom: StopFrom | null
  queue: Cmd[]
  inflight: Cmd | null
  waiter: { give(c: Cmd | null): void; timer: ReturnType<typeof setTimeout> } | null
  sent: number[]
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export type { PhoneSwitch }

export interface PhoneControl {
  /** The phone's calls under /voice/control/ (`rest` after that, e.g. '/next'); undefined when the path is none of these. */
  http(d: { id: string; name: string }, method: string, rest: string, query: URLSearchParams, body: unknown): Promise<unknown> | undefined
  /** The page's two: GET control-status, POST control-stop (`paired`: every paired phone's id, so one away now is stopped when it is back). */
  page(method: string, rest: string, paired?: readonly string[]): unknown
  /** One command for the tools of the Assistant or the Mobile chat (`by`, default the Assistant). Throws for what the hub refuses; a phone's refusal is part of the answer. */
  call(device: string | undefined, op: string, args: Record<string, unknown>, by?: PhoneCaller): Promise<string>
  status(): { devices: PhoneState[]; log: LogRow[]; switch: PhoneSwitch }
  /** Order oae15: the PC's switch for phone control (off until he turns it on). */
  switchState(): PhoneSwitch
  /** Switches it; off stops every phone at once (`paired`: as for control-stop). `by` is who (a person, never a chat). Throws when it cannot be kept on disk (off still holds until a restart). */
  setSwitch(on: boolean, by: string, paired?: readonly string[]): PhoneSwitch
  /** A device was removed: forget it. */
  forget(id: string): void
  close(): void
}

/** The arguments a command may carry, checked and cleaned. Anything else is refused here, so the phone only ever sees these. */
export function cleanArgs(op: string, a: Record<string, unknown>): Record<string, unknown> {
  const num = (k: string, lo: number, hi: number) => {
    const v = a[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw apiError(400, `${op}: ${k} must be a number from ${lo} to ${hi}`)
    return Math.round(v)
  }
  const pick = () => {
    if (typeof a.id === 'string' && a.id.trim()) return { id: a.id.trim().slice(0, 40) }
    if (a.x !== undefined || a.y !== undefined) return { x: num('x', 0, 20000), y: num('y', 0, 20000) }
    throw apiError(400, `${op}: give id (from phone_screen) or x and y`)
  }
  switch (op) {
    case 'screen':
      return { shot: a.shot === true }
    case 'tap':
    case 'long_press':
      return pick()
    case 'type': {
      if (typeof a.text !== 'string' || a.text === '') throw apiError(400, 'type: text is missing')
      if (a.text.length > 2000) throw apiError(400, 'type: text is longer than 2000 characters')
      return { text: a.text, ...(typeof a.id === 'string' && a.id.trim() ? { id: a.id.trim().slice(0, 40) } : {}), clear: a.clear !== false, submit: a.submit === true }
    }
    case 'scroll': {
      if (a.dir !== 'up' && a.dir !== 'down' && a.dir !== 'left' && a.dir !== 'right') throw apiError(400, 'scroll: dir is up, down, left or right')
      return { dir: a.dir, ...(typeof a.id === 'string' && a.id.trim() ? { id: a.id.trim().slice(0, 40) } : {}) }
    }
    case 'swipe':
      return { x1: num('x1', 0, 20000), y1: num('y1', 0, 20000), x2: num('x2', 0, 20000), y2: num('y2', 0, 20000), ms: a.ms === undefined ? 300 : num('ms', 50, 3000) }
    case 'back':
    case 'home':
    case 'recents':
    case 'notifications':
      return {}
    case 'open_app': {
      const name = typeof a.name === 'string' ? a.name.trim().slice(0, 80) : ''
      const pkg = typeof a.package === 'string' ? a.package.trim().slice(0, 200) : ''
      if (!name && !pkg) throw apiError(400, 'open_app: give name or package')
      return pkg ? { package: pkg } : { name }
    }
    case 'wait':
      return { ms: num('ms', 100, 10_000) }
    default:
      throw apiError(400, `No such phone action: ${op}`)
  }
}

export function createPhoneControl(deps: PhoneDeps): PhoneControl {
  const T: PhoneTiming = { online: ONLINE_MS, pickup: PICKUP_MS, command: COMMAND_MS, biometric: BIOMETRIC_MS, grace: GRACE_MS, ...deps.timing }
  const devs = new Map<string, Dev>()
  const rows: LogRow[] = []
  const file = deps.dir ? path.join(deps.dir, 'phone-control.jsonl') : null
  const switchFile = deps.dir ? path.join(deps.dir, 'phone-control-switch.json') : null
  /** The phones under a STOP (by device id), kept with the switch: a hub restart does not end a STOP; only the phone's resume does. */
  const held = new Map<string, StopFrom>()
  let sw: PhoneSwitch = loadSwitch()
  function loadSwitch(): PhoneSwitch {
    if (switchFile && existsSync(switchFile)) {
      try {
        const j = JSON.parse(readFileSync(switchFile, 'utf8')) as Partial<PhoneSwitch> & { stopped?: unknown }
        if (isObject(j.stopped)) {
          for (const [id, from] of Object.entries(j.stopped)) if (STOP_FROM.includes(from as StopFrom)) held.set(id, from as StopFrom)
        }
        if (j && typeof j.on === 'boolean') return { on: j.on, at: typeof j.at === 'number' ? j.at : null, by: text(j.by, 200) }
      } catch {
        deps.log?.warn('phone: the switch file could not be read: phone control stays off')
      }
    }
    // Never switched (or unreadable): off.
    return { on: false, at: null, by: '' }
  }
  /** Writes the switch and the stopped phones (throws when it cannot). */
  function writeSwitchFile() {
    if (!switchFile) return
    mkdirSync(path.dirname(switchFile), { recursive: true })
    writeAtomic(switchFile, `${JSON.stringify({ ...sw, stopped: Object.fromEntries(held) })}\n`)
  }
  /** The same, where a failure must not stop the caller (it is said in the log; the phone stays stopped in memory). */
  function keepHeld() {
    try {
      writeSwitchFile()
    } catch (e) {
      deps.log?.warn(`phone: the stopped phones could not be saved (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  const shots = deps.dir ? path.join(deps.dir, 'phone-shots') : null
  if (shots) {
    // What an earlier run left is not kept.
    try {
      rmSync(shots, { recursive: true, force: true })
    } catch {
      // Not there.
    }
  }

  const dev = (d: { id: string; name: string }): Dev => {
    let x = devs.get(d.id)
    if (!x) {
      // A phone under a STOP from before (this hub's last run, or stopped while it was away) starts stopped.
      const from = held.get(d.id) ?? null
      x = { id: d.id, name: d.name, armed: false, reason: from ? 'stopped' : null, app: null, heard: 0, stated: false, stopped: from !== null, stopFrom: from, queue: [], inflight: null, waiter: null, sent: [] }
      devs.set(d.id, x)
    }
    x.name = d.name
    x.heard = deps.now()
    return x
  }
  const online = (x: Dev) => x.heard > 0 && deps.now() - x.heard < T.online

  function writeLog(r: LogRow) {
    rows.push(r)
    if (rows.length > 200) rows.splice(0, rows.length - 200)
    if (!file) return
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, `${JSON.stringify(r)}\n`)
    } catch (e) {
      deps.log?.warn(`phone: the control log could not be written: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** What is logged of a command's arguments: never the typed words (only how long), never anything from a screen. */
  const logArgs = (op: string, a: Record<string, unknown>) => (op === 'type' ? { ...a, text: undefined, textLength: typeof a.text === 'string' ? a.text.length : 0 } : a)

  const failure = (kind: Kind | null, error: string): PhoneResult => ({ ok: false, kind, error, note: '', screen: null, candidates: [] })

  function finish(x: Dev, c: Cmd, r: PhoneResult) {
    if (c.timer) clearTimeout(c.timer)
    c.timer = null
    if (x.inflight === c) x.inflight = null
    x.queue = x.queue.filter(q => q !== c)
    writeLog({ at: deps.now(), device: x.name, op: c.op, args: logArgs(c.op, c.args), why: c.why, by: c.by, ok: r.ok, kind: r.kind, error: r.error.slice(0, LOG_TEXT), nodes: r.screen ? r.screen.nodes.length : null })
    c.resolve(r)
    pump(x)
  }

  function arm(x: Dev, c: Cmd) {
    if (c.timer) clearTimeout(c.timer)
    const wait = Math.max(0, c.deadline + (c.picked ? T.grace : 0) - deps.now())
    c.timer = setTimeout(() => {
      c.timer = null
      if (deps.now() < c.deadline + (c.picked ? T.grace : 0)) return arm(x, c)
      finish(x, c, failure('failed', c.picked ? 'The phone did not answer in time' : "The phone did not take the command (it is not listening for orders right now)"))
    }, wait)
    c.timer.unref?.()
  }

  /** Hands the next queued command to the phone, if one waits for it and none is out. */
  function pump(x: Dev) {
    if (x.inflight || !x.waiter) return
    while (x.queue.length) {
      const c = x.queue[0]
      if (c.deadline <= deps.now()) {
        // Already late before it started.
        x.queue.shift()
        finish(x, c, failure('failed', 'The command came too late for the phone to run'))
        continue
      }
      x.queue.shift()
      x.inflight = c
      c.picked = true
      const ms = c.op === 'wait' ? int(c.args.ms) + T.command : T.command
      c.deadline = deps.now() + ms
      arm(x, c)
      const w = x.waiter
      x.waiter = null
      clearTimeout(w.timer)
      w.give(c)
      return
    }
  }

  function cancelAll(x: Dev, kind: Kind, error: string) {
    for (const c of [...x.queue]) finish(x, c, failure(kind, error))
    if (x.inflight && kind === 'stopped') finish(x, x.inflight, failure(kind, error))
  }

  // --- the phone's calls ------------------------------------------------------------------------
  function state(x: Dev, b: unknown) {
    if (!isObject(b)) throw apiError(400, 'Expected {armed, reason?, app?, v}')
    const armed = b.armed === true
    const reason = REASONS.includes(b.reason as Reason) ? (b.reason as Reason) : null
    x.stated = true
    x.armed = armed
    const why: Reason = reason ?? 'switch-off'
    x.reason = armed ? null : why
    x.app = armed && typeof b.app === 'string' ? b.app.slice(0, 120) : null
    // He turned it back on at the phone: only the phone's own resume (his tap there) ends a STOP. A plain armed:true may be a state the phone
    // sent before it heard of the STOP (the PC's kill switch, or the switch here going off), so it never undoes one (order oae15).
    if (armed) {
      if (b.resume === true) {
        x.stopped = false
        x.stopFrom = null
        if (held.delete(x.id)) keepHeld()
      }
    } else {
      if (why === 'stopped') {
        x.stopped = true
        x.stopFrom ??= 'phone'
        if (held.get(x.id) !== x.stopFrom) {
          held.set(x.id, x.stopFrom)
          keepHeld()
        }
      }
      cancelAll(x, 'failed', `Not done: ${WHY[why]}`)
    }
    return { ok: true, stopped: x.stopped }
  }

  function next(x: Dev, wait: number): Promise<unknown> {
    // The phone only polls while armed: after a hub restart, that is all the hub knows until a state arrives.
    if (!x.stated && !x.stopped) {
      x.armed = true
      x.reason = null
    }
    if (x.waiter) {
      clearTimeout(x.waiter.timer)
      x.waiter.give(null)
      x.waiter = null
    }
    return new Promise(resolve => {
      const give = (c: Cmd | null) => resolve({ cmd: c ? { id: c.id, op: c.op, args: c.args, why: c.why, by: c.by, deadlineMs: Math.max(0, c.deadline - deps.now() - T.grace) } : null, ...(x.stopped ? { stopped: true } : {}) })
      const timer = setTimeout(
        () => {
          if (x.waiter?.timer === timer) x.waiter = null
          give(null)
        },
        Math.min(25, Math.max(0, wait)) * 1000,
      )
      timer.unref?.()
      x.waiter = { give, timer }
      if (x.armed && !x.stopped) pump(x)
    })
  }

  function screenOf(data: unknown): ScreenData | null {
    if (!isObject(data)) return null
    const raw = Array.isArray(data.nodes) ? data.nodes : []
    const nodes: Node[] = []
    for (const n of raw.slice(0, MAX_NODES)) {
      if (!isObject(n)) continue
      const f = text(n.f, 12)
      nodes.push({ id: text(n.id, 40), text: f.includes('p') ? '' : text(n.text, 300), desc: text(n.desc, 300), cls: text(n.cls, 60), x: int(n.x), y: int(n.y), w: int(n.w), h: int(n.h), f })
    }
    let shot: string | null = null
    if (isObject(data.shot) && typeof data.shot.b64 === 'string' && shots) {
      try {
        mkdirSync(shots, { recursive: true })
        shot = path.join(shots, `shot-${deps.now()}-${randomBytes(2).toString('hex')}.jpg`)
        writeFileSync(shot, Buffer.from(data.shot.b64, 'base64'))
        const files = readdirSync(shots)
          .map(n => ({ n, t: statSync(path.join(shots, n)).mtimeMs }))
          .sort((a, b) => b.t - a.t)
        for (const old of files.slice(KEEP_SHOTS)) rmSync(path.join(shots, old.n), { force: true })
      } catch {
        shot = null
      }
    }
    return { package: text(data.package, 200), app: text(data.app, 120), title: text(data.title, 200), w: int(data.w), h: int(data.h), nodes, truncated: data.truncated === true || raw.length > MAX_NODES, shot }
  }

  function result(x: Dev, b: unknown) {
    if (!isObject(b) || typeof b.id !== 'string') throw apiError(400, 'Expected {id, ok, kind?, error?, data?}')
    const c = x.inflight
    // Late, or for a command the hub gave up on: nothing waits for it.
    if (!c || c.id !== b.id) return { ok: true, ignored: true }
    const data = isObject(b.data) ? b.data : {}
    const inner = isObject(data.screen) ? data.screen : c.op === 'screen' ? data : null
    const candidates = Array.isArray(data.candidates)
      ? data.candidates.flatMap((k): { app: string; package: string }[] => (isObject(k) ? [{ app: text(k.app, 120), package: text(k.package, 200) }] : [])).slice(0, 10)
      : []
    const ok = b.ok === true
    finish(x, c, {
      ok,
      kind: ok ? null : (KINDS.includes(b.kind as Kind) ? (b.kind as Kind) : 'failed'),
      error: text(b.error, 300),
      note: text(data.note, 300),
      screen: screenOf(inner),
      candidates,
    })
    return { ok: true }
  }

  function progress(x: Dev, b: unknown) {
    if (!isObject(b) || typeof b.id !== 'string') throw apiError(400, 'Expected {id, waiting, summary}')
    const c = x.inflight
    if (!c || c.id !== b.id) return { ok: true, ignored: true }
    // A sensitive action waits for his fingerprint or face: longer, and the Assistant is told what for.
    c.waiting = text(b.summary, 300) || 'his fingerprint or face'
    c.deadline = deps.now() + T.biometric
    arm(x, c)
    return { ok: true }
  }

  function stop(x: Dev, why: string, from: StopFrom = 'phone') {
    x.stopped = true
    x.stopFrom = from
    x.armed = false
    x.reason = 'stopped'
    held.set(x.id, from)
    keepHeld()
    cancelAll(x, 'stopped', `Stopped: ${why}`)
    // Order oae15: the phone hears it now (its waiting poll answers stopped:true at once), not up to 25 s later, so a resume it is still
    // retrying cannot undo this STOP.
    if (x.waiter) {
      clearTimeout(x.waiter.timer)
      const w = x.waiter
      x.waiter = null
      w.give(null)
    }
    deps.log?.info(`phone: control stopped on ${x.name} (${why})`)
  }

  /** A STOP from the PC for every phone: the ones in touch at once, and every other paired one (`paired`) when it next is. */
  function stopAll(why: string, from: StopFrom, paired: readonly string[] = []) {
    for (const x of devs.values()) stop(x, why, from)
    let more = false
    for (const id of paired) {
      if (devs.has(id) || held.has(id)) continue
      held.set(id, from)
      more = true
    }
    if (more) keepHeld()
  }

  /** What the Assistant is told about a stopped phone: who stopped it, and that only Shubham starts it again, in Chris. */
  function stoppedLine(x: Dev): string {
    const again = 'it stays off until Shubham turns "Let Chris control my phone" on again in Chris'
    if (x.stopFrom === 'app') return `Not done: phone control was stopped from the app on the PC (Stop now); ${again}.`
    if (x.stopFrom === 'switch') return `Not done: phone control was switched off in the app, which stopped the phone; ${again} (and the app's switch is on).`
    return `Not done: ${WHY.stopped}.`
  }

  function http(d: { id: string; name: string }, method: string, rest: string, query: URLSearchParams, body: unknown): Promise<unknown> | undefined {
    const x = dev(d)
    if (method === 'POST' && rest === '/state') return Promise.resolve(state(x, body))
    if (method === 'GET' && rest === '/next') return next(x, Number(query.get('wait')) || 0)
    if (method === 'POST' && rest === '/result') return Promise.resolve(result(x, body))
    if (method === 'POST' && rest === '/progress') return Promise.resolve(progress(x, body))
    if (method === 'POST' && rest === '/stop') {
      stop(x, text(isObject(body) ? body.reason : '', 80) || 'he pressed STOP on the phone')
      return Promise.resolve({ ok: true })
    }
    return undefined
  }

  // --- the PC's switch (order oae15) ---------------------------------------------------------------
  function setSwitch(on: boolean, by: string, paired: readonly string[] = []): PhoneSwitch {
    sw = { on, at: deps.now(), by: text(by, 200) || 'the app' }
    // Off takes power away at once, before anything else can fail: every phone in touch, and every other paired one when it next is.
    if (!on) stopAll('phone control was switched off in the app', 'switch', paired)
    deps.log?.info(`phone: control switched ${on ? 'ON' : 'off'} on the PC (${sw.by})`)
    if (switchFile) {
      try {
        writeSwitchFile()
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        deps.log?.warn(`phone: the switch could not be saved (${why})`)
        if (on) {
          sw = { on: false, at: deps.now(), by: sw.by }
          throw apiError(500, `Phone control could not be switched on: the setting could not be saved (${why}).`)
        }
        throw apiError(500, `Phone control is off now, but the setting could not be saved (${why}): switch it off again after a restart.`)
      }
    }
    return { ...sw }
  }

  // --- the Assistant's calls ----------------------------------------------------------------------
  function target(sel: string | undefined): Dev {
    const all = [...devs.values()]
    if (!all.length) throw apiError(409, 'No phone has been in touch with the hub yet: Chris must be installed, paired and have its control switched on.')
    const want = sel?.trim().toLowerCase()
    const pool = want ? all.filter(x => x.id === want || x.name.toLowerCase() === want) : all
    if (!pool.length) throw apiError(404, `No phone called ${sel}; the phones are: ${all.map(x => x.name).join(', ')}`)
    const ready = pool.filter(x => online(x) && x.armed && !x.stopped)
    if (ready.length === 1) return ready[0]
    if (ready.length > 1) throw apiError(400, `Several phones are ready (${ready.map(x => x.name).join(', ')}): say which one with device`)
    const x = pool[0]
    if (x.stopped) throw apiError(409, stoppedLine(x))
    if (!online(x)) throw apiError(409, `Not done: ${x.name} has not been in touch with the hub for a while (it is off, out of range or Chris is not running).`)
    throw apiError(409, `Not done: ${WHY[x.reason ?? 'switch-off']}.`)
  }

  function render(s: ScreenData): string {
    const flags: [string, string][] = [['c', 'click'], ['e', 'edit'], ['s', 'scroll'], ['k', 'checked'], ['F', 'focused'], ['p', 'password'], ['d', 'disabled']]
    const lines = [`Phone screen: ${s.app || '(unknown app)'}${s.package ? ` (${s.package})` : ''}${s.title ? `, "${s.title}"` : ''}, ${s.w}x${s.h}${s.truncated ? ' (cut: more is on screen than is listed)' : ''}`]
    for (const n of s.nodes) {
      const fl = flags.filter(([k]) => n.f.includes(k)).map(([, w]) => w)
      lines.push(`${n.id} ${n.cls || 'View'}${n.text ? ` "${n.text}"` : ''}${n.desc ? ` desc="${n.desc}"` : ''} at ${n.x},${n.y} ${n.w}x${n.h}${fl.length ? ` [${fl.join(' ')}]` : ''}`)
    }
    if (!s.nodes.length) lines.push('(nothing readable: a secure screen, or an app that draws without accessibility)')
    if (s.shot) lines.push(`Screenshot saved at ${s.shot} (open it with Read to look).`)
    return lines.join('\n')
  }

  async function call(sel: string | undefined, op: string, rawArgs: Record<string, unknown>, by: PhoneCaller = 'assistant'): Promise<string> {
    if (!(CALLERS as readonly string[]).includes(by)) throw apiError(400, `No such caller: ${String(by)}`)
    if (!(OPS as readonly string[]).includes(op)) throw apiError(400, `No such phone action: ${op}; they are ${OPS.join(', ')}`)
    if (!sw.on) throw apiError(409, PHONE_SWITCH_OFF_LINE)
    const args = cleanArgs(op, rawArgs)
    const x = target(sel)
    const t = deps.now()
    x.sent = x.sent.filter(s => t - s < 60_000)
    if (x.sent.length >= MAX_PER_MIN) throw apiError(429, `Too many phone actions in a minute (${MAX_PER_MIN}); slow down and look at the screen before each step.`)
    x.sent.push(t)
    const why = text(rawArgs.why, 160)
    const r = await new Promise<PhoneResult>(resolve => {
      const c: Cmd = { id: `p${randomBytes(4).toString('hex')}`, op: op as Op, args, why, by, created: t, deadline: t + T.pickup, picked: false, waiting: null, timer: null, resolve }
      x.queue.push(c)
      arm(x, c)
      pump(x)
    })
    if (!r.ok) {
      const lead: Record<string, string> = {
        refused: 'The phone refused (a safety rule of Chris, not a fault)',
        declined: 'Shubham declined, or did not confirm in time',
        locked: 'The phone is locked',
        stale: 'That is from an old screen: read the screen again',
        stopped: 'Shubham stopped it',
        'not-found': 'Not found',
        failed: 'It failed',
      }
      const more = r.candidates.length ? ` Candidates: ${r.candidates.map(k => `${k.app} (${k.package})`).join(', ')}.` : ''
      return `Not done. ${lead[r.kind ?? 'failed']}${r.error ? `: ${r.error}` : ''}.${more}${r.screen ? `\n${render(r.screen)}` : ''}`
    }
    const out = [op === 'screen' ? '' : `Done${r.note ? `: ${r.note}` : ''}.`]
    if (r.screen) out.push(render(r.screen))
    return out.filter(Boolean).join('\n') || 'Done.'
  }

  // --- the page --------------------------------------------------------------------------------
  const view = (x: Dev): PhoneState => ({
    id: x.id,
    name: x.name,
    online: online(x),
    armed: x.armed && !x.stopped && online(x),
    reason: x.armed ? null : x.reason,
    stopped: x.stopped,
    app: x.armed ? x.app : null,
    quietS: x.heard ? Math.round((deps.now() - x.heard) / 1000) : null,
    pending: x.queue.length + (x.inflight ? 1 : 0),
    waiting: x.inflight?.waiting ?? null,
  })

  // The page reads it as shared/phone-control.ts's PhoneControlStatus: the type says when the two drift apart.
  function status(): PhoneControlStatus & { devices: PhoneState[]; log: LogRow[] } {
    return { devices: [...devs.values()].map(view), log: rows.slice(-50).reverse(), switch: { ...sw } }
  }

  return {
    http,
    call,
    status,
    switchState: () => ({ ...sw }),
    setSwitch,
    page(method, rest, paired = []) {
      if (method === 'GET' && rest === '/control-status') return status()
      if (method === 'POST' && rest === '/control-stop') {
        stopAll('stopped from the app on the PC', 'app', paired)
        return status()
      }
      return undefined
    },
    forget(id) {
      const x = devs.get(id)
      if (x) {
        stop(x, 'the phone was removed')
        devs.delete(id)
      }
      if (held.delete(id)) keepHeld()
    },
    close() {
      for (const x of devs.values()) {
        cancelAll(x, 'stopped', 'The hub is stopping')
        if (x.inflight) finish(x, x.inflight, failure('stopped', 'The hub is stopping'))
        if (x.waiter) {
          clearTimeout(x.waiter.timer)
          x.waiter.give(null)
          x.waiter = null
        }
      }
    },
  }
}

/** The last rows of phone-control.jsonl (for tests and the page after a restart). */
export function readControlLog(dir: string, limit = 50): LogRow[] {
  const file = path.join(dir, 'phone-control.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .flatMap((l): LogRow[] => {
      try {
        return [JSON.parse(l) as LogRow]
      } catch {
        return []
      }
    })
}
