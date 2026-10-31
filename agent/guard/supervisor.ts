// F-058: keeps ONE process running, and says what it is doing. The policy is here and nothing else:
// the guard (agent/guard.ts) gives it real processes, a real clock and a real health check, and the
// tests (supervisor.test.ts) give it fakes.
//   start      when nothing is running (and nothing already answers: see adoption)
//   adopt      something that answers although this didn't start it (the old Start.cmd loop, a start
//              by hand from Christopher on 4740): left alone, and watched; started over only if it stops
//   restart    the moment it exits (the exit itself wakes the loop, no waiting for the next look)
//   hung       it runs but doesn't answer: after its boot grace, `hungAfter` failed looks in a row end it
//   backoff    one that dies again and again right after starting waits longer each time (0, 2, 5, 10,
//              20, 30 s), and the count starts over once it has stayed up for a minute
//   update     exit code 75 (the Build page's Update now): run the update step, then start at once
// A look is `tick()`, called about once a second.

export interface Running {
  pid: number
  /** Resolves when the process has exited. */
  exited: Promise<{ code: number | null; signal: string | null }>
  /** Ends it, by exact PID, and resolves once it is gone (or after a limit). */
  stop(): Promise<void>
}

/** Which process answers, for one this supervisor did not start. */
export interface Identity {
  pid?: number
  /** When that process started, in ms since the epoch. */
  startedAt?: number
}

export interface Spec {
  name: string
  /** Starts it. `why` is for the log. */
  start(why: string): Running
  /** Is it answering? Never rejects; a failure is false. An Identity: yes, and this is the process. */
  probe(): Promise<boolean | Identity>
  /** Who answers, when the probe could not say. May be slow; asked once, when something is found already running. */
  find?(): Promise<Identity | null>
  /** A handle on a process this didn't start, so that it is seen to go, and can be ended; null when `id` is not enough. */
  adopt?(id: Identity): Running | null
  /**
   * The exit code the process said it was leaving with (75: update) before it went or while it hangs, as
   * far as anyone can tell (its log), else null. `since`: when it started, in ms; older sayings are not about it.
   */
  intent?(since: number | null): number | null
  /** After a start, this long without an answer is not yet a failure (it is booting). */
  graceMs: number
  /** Failed looks in a row, after the grace, that mean it hangs. */
  hungAfter: number
  /** Run when it exited with `code` and the caller says so (the update step); then it is started again at once. */
  onExit?(code: number | null): Promise<void> | void
  /** Exit codes that mean "update, then start again". */
  updateCodes?: readonly number[]
}

export interface Deps {
  now(): number
  log(message: string): void
}

export type State = 'starting' | 'up' | 'down' | 'backoff' | 'updating' | 'stopped'

export interface Status {
  name: string
  state: State
  pid: number | null
  /** ms since the epoch, when it came to this state. */
  since: number
  startedAt: number | null
  restarts: number
  lastExit: { code: number | null; signal: string | null; at: number } | null
  /** Why the latest start was made. */
  lastWhy: string | null
  /** When the next start may happen (during a backoff), else null. */
  nextTryAt: number | null
  /** It answers, but this didn't start it. */
  adopted: boolean
  /** When it was last seen not answering, while it still is not; null when it answers. */
  downSince: number | null
  /** How long it was away the last time it came back, in ms. */
  lastDowntimeMs: number | null
}

export interface Supervisor {
  tick(): Promise<void>
  status(): Status
  /** End it now and start it again. */
  restart(why: string): Promise<void>
  /** End it and don't start it again. */
  stop(): Promise<void>
  /** Let go without ending anything: the process goes on, and what it does from now on is not this supervisor's concern. */
  release(): void
}

/**
 * Waits before starting again, by how many starts there were in the last minute: the first death
 * is answered at once, each further quick one waits longer. A minute of staying up starts it over.
 */
export const BACKOFF_MS = [0, 2000, 5000, 10_000, 20_000, 30_000]
const STABLE_MS = 60_000
/** A process that has said it is stopping for an update and then stops answering is ended after this many looks, not `hungAfter`. */
export const ANNOUNCED_HUNG_AFTER = 5

export function supervise(spec: Spec, d: Deps): Supervisor {
  let running: Running | null = null
  let state: State = 'down'
  let since = d.now()
  let startedAt: number | null = null
  let restarts = 0
  let lastExit: Status['lastExit'] = null
  let lastWhy: string | null = null
  let nextTryAt: number | null = null
  let adopted = false
  let downSince: number | null = d.now()
  let lastDowntimeMs: number | null = null
  let failures = 0
  let busy = false
  let stopped = false
  let wake = false
  /** When each recent start happened, for the backoff. */
  let recent: number[] = []
  let firstLook = true
  /** Why the next start is made, when somebody (restart(), the hang check) said. */
  let nextWhy: string | null = null
  /** When the process being watched started, if this didn't start it (for `intent`). */
  let adoptedSince: number | null = null

  /** 75 etc. when the process said it was stopping for an update (and `updateCodes` says that means one). */
  const announced = (since: number | null): number | null => {
    const code = spec.intent?.(since) ?? null
    return code !== null && spec.updateCodes?.includes(code) ? code : null
  }
  /** The update step, then a start at once. */
  async function updateStep(code: number) {
    setState('updating')
    try {
      await spec.onExit?.(code)
    } catch (e) {
      d.log(`${spec.name}: the update step failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    nextTryAt = d.now()
    wake = true
  }

  const setState = (next: State) => {
    if (state === next) return
    state = next
    since = d.now()
  }
  const answered = () => {
    failures = 0
    if (downSince !== null) {
      lastDowntimeMs = d.now() - downSince
      d.log(`${spec.name}: answering again after ${(lastDowntimeMs / 1000).toFixed(1)} s${lastWhy ? ` (${lastWhy})` : ''}`)
      downSince = null
    }
    setState('up')
  }
  const lost = (why: string) => {
    if (downSince === null) downSince = d.now()
    d.log(`${spec.name}: ${why}`)
  }

  function begin(fallback: string) {
    const now = d.now()
    recent = recent.filter(t => now - t < STABLE_MS)
    recent.push(now)
    const why = nextWhy ?? fallback
    nextWhy = null
    lastWhy = why
    adopted = false
    adoptedSince = null
    failures = 0
    nextTryAt = null
    startedAt = now
    setState('starting')
    let proc: Running
    try {
      proc = spec.start(why)
    } catch (e) {
      lost(`could not start: ${e instanceof Error ? e.message : String(e)}`)
      running = null
      scheduleRetry()
      return
    }
    running = proc
    d.log(`${spec.name}: started (pid ${proc.pid}): ${why}`)
    void proc.exited.then(exit => onExit(proc, exit))
  }

  /** Takes hold of a process this didn't start, when it can be found: it is then seen to go, and can be ended. */
  async function watch(answer: true | Identity) {
    if (running || !spec.adopt) return
    let id: Identity | null = typeof answer === 'object' ? answer : null
    if (!id?.pid && spec.find) id = (await spec.find().catch(() => null)) ?? id
    if (!id?.pid) return
    const proc = spec.adopt(id)
    if (!proc) return
    running = proc
    // It was answering before we looked: no boot grace.
    startedAt = null
    adoptedSince = id.startedAt ?? d.now()
    d.log(`${spec.name}: has pid ${proc.pid}`)
    void proc.exited.then(exit => onExit(proc, exit))
  }

  function scheduleRetry() {
    const now = d.now()
    // The starts of the last minute, the one that just ended included: a process that stayed up
    // for a minute is not a crash loop, so it is answered at once.
    recent = recent.filter(t => now - t < STABLE_MS)
    const wait = BACKOFF_MS[Math.min(Math.max(0, recent.length - 1), BACKOFF_MS.length - 1)]
    nextTryAt = now + wait
    setState(wait > 0 ? 'backoff' : 'down')
  }

  async function onExit(proc: Running, exit: { code: number | null; signal: string | null }) {
    if (running !== proc) return
    running = null
    // Seen to go (also a process this didn't start, once there is a handle on it): nothing to count.
    adopted = false
    restarts++
    lastExit = { ...exit, at: d.now() }
    if (stopped) return setState('stopped')
    const since = startedAt ?? adoptedSince
    lost(`exited (${exit.signal ? `signal ${exit.signal}` : exit.code === null ? 'gone, the code is not known' : `code ${exit.code}`})${startedAt ? ` after ${((d.now() - startedAt) / 1000).toFixed(1)} s` : ''}`)
    // The code says so, or (a process this didn't start, or one that had to be ended) its log does.
    const meant = exit.code !== null && spec.updateCodes?.includes(exit.code) ? exit.code : announced(since)
    if (meant !== null && spec.onExit) {
      await updateStep(meant)
    } else {
      scheduleRetry()
      wake = true
    }
    // The exit wakes the loop: no waiting for the next look.
    void tick()
  }

  async function tick() {
    if (busy || stopped) return
    busy = true
    try {
      do {
        wake = false
        await look()
      } while (wake && !stopped)
    } finally {
      busy = false
    }
  }

  async function look() {
    if (!running) {
      if (nextTryAt !== null && d.now() < nextTryAt) return
      // Something answers that this didn't start: leave it be, and watch it.
      const answer = await spec.probe()
      if (answer) {
        if (!adopted) d.log(`${spec.name}: already answering${firstLook ? '' : ' (not started by this guard)'}; watching it`)
        adopted = true
        firstLook = false
        await watch(answer)
        answered()
        return
      }
      firstLook = false
      if (adopted) {
        // It answered before, and no longer does, and there is no handle on it to hear it go. If it
        // said it was stopping for an update, that is what this is: no need to wait out the full count.
        failures++
        const code = announced(adoptedSince)
        const limit = code !== null ? Math.min(spec.hungAfter, ANNOUNCED_HUNG_AFTER) : spec.hungAfter
        lost(`stopped answering (${failures}/${limit}${code !== null ? ', for an update' : ''})`)
        if (failures < limit) return
        adopted = false
        if (code !== null && spec.onExit) return await updateStep(code)
      }
      begin(lastExit === null && restarts === 0 ? 'nothing was running' : 'it was not running')
      return
    }
    // Ours (or adopted with a handle), and running.
    const ok = await spec.probe()
    if (!running) return
    if (ok) return answered()
    const age = startedAt === null ? Infinity : d.now() - startedAt
    if (age < spec.graceMs) return
    failures++
    if (failures === 1) lost('not answering')
    // One that said it was stopping for an update and has stopped answering is on its way out (or stuck on the way): sooner.
    const code = announced(startedAt ?? adoptedSince)
    if (failures < (code !== null ? Math.min(spec.hungAfter, ANNOUNCED_HUNG_AFTER) : spec.hungAfter)) return
    d.log(`${spec.name}: not answering for ${failures} looks in a row; ending pid ${running.pid}`)
    const proc = running
    nextWhy = code !== null ? 'it did not finish stopping for the update' : 'it did not answer'
    await proc.stop()
    // Its exit starts the next one; if the process had no exit to report, do it here.
    if (running === proc) {
      running = null
      restarts++
      lastExit = { code: null, signal: 'killed', at: d.now() }
      scheduleRetry()
      wake = true
    }
  }

  return {
    tick,
    status: () => ({ name: spec.name, state, pid: running?.pid ?? null, since, startedAt, restarts, lastExit, lastWhy, nextTryAt, adopted, downSince, lastDowntimeMs }),
    async restart(why) {
      if (stopped) return
      const proc = running
      nextWhy = why
      if (proc) {
        d.log(`${spec.name}: ${why}; ending pid ${proc.pid}`)
        await proc.stop()
      } else {
        nextTryAt = d.now()
        wake = true
        void tick()
      }
    },
    async stop() {
      stopped = true
      const proc = running
      running = null
      setState('stopped')
      if (proc) await proc.stop()
    },
    release() {
      // Its exit is then nobody's to answer (onExit looks for the process it knows).
      stopped = true
      running = null
      setState('stopped')
    },
  }
}
