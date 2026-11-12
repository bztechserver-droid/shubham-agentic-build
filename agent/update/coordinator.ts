import { randomUUID } from 'node:crypto'
import type { AutoUpdateBlocker, AutoUpdateRun, AutoUpdateRunState, AutoUpdateStatus } from '../../shared/approvals.ts'
import type { BuildInfo } from '../../shared/build.ts'
import type { UpdateHold, UpdatePermit } from '../build.ts'
import type { Logger } from '../log.ts'
import { classify, listWithCommandLines, type BusyKind, type ProcRow } from './procs.ts'
import { blockersOf, cannotSee, readReceipt, type ChatSeen, type QuietInputs, type RecoveryReceipt } from './signals.ts'
import type { UpdateState } from './state.ts'

// F-173a: the app applies a newly published build to THIS PC by itself, when it is quiet, if an administrator switched that on.
//
//   - It is an object inside the hub, started by main.ts. It has no route and no tool: nothing a page, a chat or a machine token can
//     call starts it. It makes a permit (build.issuePermit) only after its own checks, and the build spends it once.
//   - Setting off (or no consent record) = it does nothing. Read fresh at every look and again at the commit.
//   - Quiet = agent/update/signals.ts: every input fail-closed. All of it stays true for QUIET_MS (3 min), then a cancelable countdown
//     (10 s), then everything is read AGAIN in the same tick as the commit, after one fresh look at the process table. Anything new = back to waiting.
//   - It never forces and never gives up waiting: after 10 minutes it says "deferred" and keeps looking, less often. At most one automatic
//     update per hour that was settled (took, did not take, unknown).
//   - The record is written before the restart; the new agent settles it by the build it runs (state.ts). A restart is not a result.
//   - The bridge chats are reopened after the restart by Fix other PCS's recovery watcher, not by this: it waits for that watcher's receipt.

export const TIMING = {
  tickMs: 5_000,
  quietMs: 3 * 60_000,
  countdownMs: 10_000,
  deferAfterMs: 10 * 60_000,
  gapMs: 60 * 60_000,
  /** After a commit that was refused. */
  retryMs: 60_000,
  /** How old the process table may be when everything else is quiet. */
  procEveryMs: 30_000,
}

/** What the agent shows of the chats, read-only (agentic/index.ts `quiet`). Every function may throw: that is "unknown" and blocks. */
export interface QuietView {
  ready(): boolean
  chats(): Record<string, ChatSeen>
  drafts(): number
  orders(): number
  deliveries(): number
  bridge(): string[]
}

/** What the coordinator reads. Every function may throw: that is "unknown" and blocks. */
export interface CoordinatorDeps extends QuietView {
  setting(): AutoUpdateStatus
  build(): { info(): BuildInfo; issuePermit(via: UpdatePermit['via'], to: string): UpdatePermit; commitUpdate(p: UpdatePermit, hold?: UpdateHold): unknown }
  /** The bridge's last CRM login check failure (ms), when it can say; absent = not wired. */
  crmFailureAt?(): number | null
  /** Where Fix's recovery receipt is, when configured (SAD_RECOVERY_STATUS); null = not configured. */
  receiptFile: string | null
  /** The process table with command lines. */
  processes?: () => Promise<ProcRow[]>
  state: UpdateState
  log?: Logger
  now?: () => number
  /** The status changed: tell the page. */
  changed?: () => void
  timing?: Partial<typeof TIMING>
  /** Tests: read the receipt another way. */
  readReceipt?: (file: string) => RecoveryReceipt | null
}

export interface Coordinator {
  /** Looks now (a build was found, the setting changed). */
  nudge(): void
  /** The Cancel button: this build is held until another one is published or the setting is changed. */
  cancel(): void
  status(): AutoUpdateRun
  /** Settles what the last run left, once at start, by the build that runs now. */
  start(): void
  /** One look (the timer calls it; exported for tests). */
  tick(): Promise<void>
  close(): void
}

export function createCoordinator(d: CoordinatorDeps): Coordinator {
  const T = { ...TIMING, ...d.timing }
  const now = d.now ?? Date.now
  const iso = (ms: number) => new Date(ms).toISOString()
  let state: AutoUpdateRunState = 'off'
  let stateSince = now()
  let blockers: AutoUpdateBlocker[] = []
  let to: string | null = null
  /** The build the quiet time and countdown are for. */
  let plannedTo: string | null = null
  let waitingSince: number | null = null
  let quietSince: number | null = null
  let countdownAt: number | null = null
  let notBefore = 0
  /** Cancel: the build (and consent revision) the person held. */
  let held: { to: string; revision: number } | null = null
  let procs: { kinds: BusyKind[] | null; at: number | null } = { kinds: null, at: null }
  let busyTick = false
  let timer: NodeJS.Timeout | null = null
  let closed = false
  let inputsLast: Pick<QuietInputs, 'crmFailureAt'> = { crmFailureAt: d.crmFailureAt ? null : undefined }

  const set = (next: AutoUpdateRunState, why?: string) => {
    if (state === next) return
    state = next
    stateSince = now()
    d.log?.info(`automatic update: ${next}${why ? ` (${why})` : ''}`)
    d.changed?.()
  }
  const setBlockers = (b: AutoUpdateBlocker[]) => {
    const before = JSON.stringify(b.map(x => [x.code, x.count]))
    const same = JSON.stringify(blockers.map(x => [x.code, x.count])) === before
    blockers = b
    if (!same) {
      d.log?.info(`automatic update: waiting${b.length ? ` for ${b.map(x => x.code).join(', ')}` : ''}`)
      d.changed?.()
    }
  }
  const reset = () => {
    quietSince = null
    countdownAt = null
    waitingSince = null
    plannedTo = null
  }

  const safe = <T>(read: () => T): T | null => {
    try {
      return read()
    } catch {
      return null
    }
  }

  async function snapshot(): Promise<void> {
    const list = d.processes ?? (() => listWithCommandLines())
    try {
      const rows = await list()
      procs = { kinds: classify(rows), at: now() }
    } catch {
      procs = { kinds: null, at: null }
    }
  }

  /** Every input, read now, synchronously (the process table is the last one taken, by `snapshot`). */
  function read(running: string | null): QuietInputs {
    const info = safe(() => d.build().info())
    const t = now()
    const bridge = safe(() => d.bridge())
    const receiptRead = d.readReceipt ?? readReceipt
    const crm = d.crmFailureAt ? safe(() => d.crmFailureAt!()) : undefined
    inputsLast = { crmFailureAt: d.crmFailureAt ? (crm ?? null) : undefined }
    return {
      now: t,
      running,
      ready: safe(() => d.ready()),
      chats: safe(() => d.chats()),
      drafts: safe(() => d.drafts()),
      orders: safe(() => d.orders()),
      deliveries: safe(() => d.deliveries()),
      publishing: info ? (info.publish ? info.publish.state === 'running' : false) : null,
      busy: procs.kinds,
      busyAt: procs.at,
      bridge,
      receipt: d.receiptFile ? safe(() => receiptRead(d.receiptFile!)) : null,
      receiptConfigured: d.receiptFile !== null,
      ...(d.crmFailureAt ? { crmFailureAt: crm ?? null } : {}),
    }
  }

  /** The reasons not to start now, besides the quiet ones. Empty = go on. */
  function gates(info: BuildInfo, setting: AutoUpdateStatus): AutoUpdateBlocker[] {
    const out: AutoUpdateBlocker[] = []
    const next = info.update.available?.version ?? null
    if (held && next && (held.to !== next || held.revision !== (setting.consent?.revision ?? 0))) held = null
    if (held && next === held.to) out.push({ code: 'held', label: `you cancelled it for build ${held.to}` })
    if (info.update.hostWait) out.push({ code: 'manual-wait', label: 'an update you started is already waiting for the chats' })
    if (now() < notBefore) out.push({ code: 'retry-later', label: 'the last try was refused; trying again in a moment' })
    const last = d.state.read().last
    if (last && now() - Date.parse(last.resolvedAt) < T.gapMs && last.result !== 'not-started') out.push({ code: 'gap', label: 'the app updated itself less than an hour ago' })
    return out
  }

  async function tick(): Promise<void> {
    if (busyTick || closed) return
    busyTick = true
    try {
      // A commit was made: the app should be gone within moments. If it is still here after 2 minutes the restart did not happen
      // (for example the chat host could not be retired): write that down and look again later. Never a second start meanwhile.
      if (state === 'committing' || state === 'restarting') {
        if (now() - stateSince < 2 * 60_000) return
        d.state.abort('The restart did not happen.')
        notBefore = now() + T.retryMs
        reset()
        setBlockers([{ code: 'refused', label: 'the restart did not happen' }])
        return set('waiting', 'the restart did not happen')
      }
      const setting = safe(() => d.setting())
      const info = safe(() => d.build().info())
      if (!setting?.on) {
        reset()
        setBlockers([])
        to = null
        return set('off')
      }
      if (!info || info.update.state !== 'available' || !info.update.available || !info.update.can) {
        reset()
        setBlockers([])
        to = null
        return set('idle')
      }
      to = info.update.available.version
      const running = info.current?.version ?? null
      // A newer build was published while it waited: the quiet time and the countdown the person saw were for the other one.
      if (plannedTo !== null && plannedTo !== to) {
        quietSince = null
        countdownAt = null
      }
      plannedTo = to
      waitingSince ??= now()
      const extra = gates(info, setting)
      const PROCESS_ONLY = ['stale-processes', 'unknown-processes']
      let found = [...extra, ...blockersOf(read(running))]
      // While something else blocks, the process table is not read (and not named as a reason: it is not the reason).
      const real = found.filter(b => !PROCESS_ONLY.includes(b.code))
      if (real.length) found = real
      // Nothing else in the way: the process table is read (at most every 30 s), and judged with everything else.
      else if (found.every(b => PROCESS_ONLY.includes(b.code))) {
        if (!procs.at || now() - procs.at >= T.procEveryMs) await snapshot()
        found = [...gates(info, setting), ...blockersOf(read(running))]
      }
      if (found.length) {
        quietSince = null
        countdownAt = null
        setBlockers(found)
        return set(now() - waitingSince >= T.deferAfterMs ? 'deferred' : 'waiting')
      }
      quietSince ??= now()
      if (now() - quietSince < T.quietMs) {
        setBlockers([{ code: 'settling', label: `quiet for ${Math.round((now() - quietSince) / 1000)} s; it waits ${Math.round(T.quietMs / 1000)} s to be sure` }])
        return set('waiting')
      }
      if (countdownAt === null) {
        countdownAt = now()
        setBlockers([])
        return set('countdown')
      }
      if (now() - countdownAt < T.countdownMs) return
      await commit(running, to)
    } finally {
      busyTick = false
      d.changed?.()
    }
  }

  /** The commit. After the one fresh look at the process table there is NO await until the permit is spent. */
  async function commit(running: string | null, target: string): Promise<void> {
    await snapshot()
    const look = (): { setting: AutoUpdateStatus | null; found: AutoUpdateBlocker[] } => {
      const setting = safe(() => d.setting())
      const info = safe(() => d.build().info())
      const found = setting?.on && info && info.update.available?.version === target && info.update.can && info.update.state === 'available'
        ? [...gates(info, setting), ...blockersOf(read(running))]
        : [{ code: 'changed', label: 'the setting or the build changed' }]
      return { setting, found }
    }
    const { setting, found } = look()
    if (found.length) {
      quietSince = null
      countdownAt = null
      setBlockers(found)
      return set('waiting', 'a last look found something')
    }
    const consent = setting!.consent!
    const op = { id: randomUUID(), from: running ?? '', to: target, committedAt: iso(now()), consentRevision: consent.revision, consentBy: consent.by }
    try {
      // The record first: if it can't be written, nothing is started.
      d.state.begin(op)
    } catch (e) {
      notBefore = now() + T.retryMs
      setBlockers([{ code: 'record', label: 'the update could not be written down, so it was not started' }])
      d.log?.warn(`automatic update: not started, the record could not be written: ${e instanceof Error ? e.message : String(e)}`)
      return set('waiting')
    }
    set('committing', `build ${running ?? '?'} to ${target}`)
    try {
      const b = d.build()
      // The build looks once more, synchronously, right before it cuts anything (and again while it waits, bounded): a send, a draft, an
      // open order or a busy chat that appeared after this last look makes the restart wait, and then stop, never cut.
      b.commitUpdate(b.issuePermit('auto', target), {
        quiet: () => {
          const again = look().found
          return again.length ? again.map(x => x.label).join('; ') : null
        },
        onAbort: reason => {
          if (closed) return
          d.state.abort(`something became busy at the last moment: ${reason}`)
          notBefore = now() + T.retryMs
          quietSince = null
          countdownAt = null
          setBlockers([{ code: 'refused', label: `something became busy at the last moment (${reason}); nothing was cut` }])
          d.log?.warn(`automatic update: stopped at the last moment, nothing was cut: ${reason}`)
          set('waiting')
          d.changed?.()
        },
      })
      set('restarting')
    } catch (e) {
      d.state.abort(e instanceof Error ? e.message : String(e))
      notBefore = now() + T.retryMs
      quietSince = null
      countdownAt = null
      setBlockers([{ code: 'refused', label: 'the app refused the update this time' }])
      d.log?.warn(`automatic update: refused: ${e instanceof Error ? e.message : String(e)}`)
      set('waiting')
    }
  }

  return {
    nudge() {
      if (!closed) void tick()
    },
    cancel() {
      const info = safe(() => d.build().info())
      const setting = safe(() => d.setting())
      const next = info?.update.available?.version
      if (!next) return
      held = { to: next, revision: setting?.consent?.revision ?? 0 }
      reset()
      d.log?.info(`automatic update: held for build ${next} by a person`)
      void tick()
    },
    start() {
      const running = safe(() => d.build().info().current?.version ?? null) ?? null
      try {
        const settled = d.state.settle(running)
        if (settled) d.log?.info(`automatic update: ${settled.from} to ${settled.to} ${settled.result}${settled.actual ? ` (running ${settled.actual})` : ''}`)
      } catch (e) {
        d.log?.warn(`automatic update: could not settle the last operation: ${e instanceof Error ? e.message : String(e)}`)
      }
      timer = setInterval(() => void tick(), T.tickMs)
      timer.unref()
      void tick()
    },
    status(): AutoUpdateRun {
      const last = safe(() => d.state.read().last)
      return {
        state,
        since: iso(stateSince),
        to,
        waitingSince: waitingSince === null ? null : iso(waitingSince),
        countdownEndsAt: countdownAt === null ? null : iso(countdownAt + T.countdownMs),
        blockers,
        cannotSee: cannotSee(inputsLast),
        last: last ? { id: last.id, from: last.from, to: last.to, committedAt: last.committedAt, resolvedAt: last.resolvedAt, result: last.result, actual: last.actual, note: last.note } : null,
      }
    },
    tick,
    close() {
      closed = true
      if (timer) clearInterval(timer)
    },
  }
}

/** The page's old fields (Last applied, Last held off) from what the coordinator knows, so an older page still says something true. */
export function withRun(base: AutoUpdateStatus, run: AutoUpdateRun | null): AutoUpdateStatus {
  if (!run) return base
  const l = run.last
  return {
    ...base,
    run,
    lastApplied: l && l.result === 'took' ? { at: l.resolvedAt ?? l.committedAt, from: l.from, to: l.to, note: '' } : base.lastApplied,
    lastSkipped: base.on && run.blockers.length && (run.state === 'waiting' || run.state === 'deferred') ? { at: run.since, why: run.blockers.map(b => b.label).join('; ') } : base.lastSkipped,
  }
}
