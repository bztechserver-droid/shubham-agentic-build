import { API_MODEL_IDS, costUsd } from '../../shared/api-prices.ts'
import type { FastModel } from '../../shared/fast.ts'
import { ApiFailure, apiWords, runTurn, type FetchLike, type ToolSpec } from './anthropic-api.ts'
import type { BriefContext, FastAsk, FastFrame, FastHost, FastHostState, FastStatus, TurnTiming } from './fast-host.ts'
import type { ModelKeyStore } from './model-key.ts'

// Order o7f34: the API twin of fast-host.ts. The same FastHost interface (so the efficient route's session, its frames and its page are the
// same), but no child process: each question is one streamed call to the Anthropic API with the saved key (model-key.ts), and the tools it
// asks for run in this process (through runTool, the old-app reader's read-only functions). It keeps the last few turns itself, for the brief.
// It is ready while a key is saved; without one it says why, and nothing is sent.

export const NO_KEY_REASON = 'No Anthropic API key is saved. Add one in Settings › Old app reader.'
const HISTORY_KEEP = 6
const HISTORY_CHARS = 600
const TIMINGS_KEEP = 30

export interface ApiHostDeps {
  now(): number
  keys: ModelKeyStore
  /** The brief for a question (the same one the Claude path gives its process, given the turns so far). */
  brief(ctx: BriefContext): string
  tools: ToolSpec[]
  /** Runs one of the tools (read-only, the old app's folder). Its words are the tool's result; a throw is "could not run". */
  runTool(name: string, input: Record<string, unknown>): Promise<string>
  label(name: string): string
  fetch?: FetchLike
  base?: string
  log?: { info(m: string): void; warn(m: string): void }
}

interface Running {
  id: string
  model: FastModel
  ac: AbortController
  emit: (f: FastFrame) => void
  cancelled: boolean
  said: string
}

const gate = () => ({
  startMinAvailMB: 0,
  endBelowAvailMB: 0,
  endAfterS: 0,
  commitBackstopMB: 0,
  availMB: null,
  freeCommitMB: null,
  lowSince: null,
  blocked: null,
})

export function createApiFastHost(deps: ApiHostDeps): FastHost {
  let running: Running | null = null
  let hist: { role: 'user' | 'assistant'; text: string }[] = []
  const owners = new Set<string>()
  const timings: TurnTiming[] = []
  let served = 0
  let errors = 0
  let costTotal = 0
  let lastModel: FastModel = 'haiku'
  let stopped = false

  const keyNow = () => (stopped ? null : deps.keys.use())
  const reasonNow = (): string | null => (stopped ? 'The API path is stopped.' : deps.keys.status().saved ? null : NO_KEY_REASON)
  const stateNow = (): FastHostState => (reasonNow() === null ? 'ready' : 'unavailable')

  function remember(role: 'user' | 'assistant', text: string) {
    hist.push({ role, text: text.slice(0, HISTORY_CHARS) })
    hist = hist.slice(-HISTORY_KEEP)
  }

  function cut(r: Running) {
    r.cancelled = true
    r.ac.abort()
  }

  return {
    async open(who) {
      const why = reasonNow()
      if (why) return { ok: false, reason: why }
      owners.add(who)
      return { ok: true }
    },
    close(who) {
      owners.delete(who)
    },
    ask(turn: FastAsk, emit) {
      const key = keyNow()
      if (!key) return { ok: false, reason: reasonNow() ?? NO_KEY_REASON }
      if (running) cut(running)
      const model: FastModel = turn.model ?? 'haiku'
      lastModel = model
      const ac = new AbortController()
      const r: Running = { id: turn.id, model, ac, emit, cancelled: false, said: '' }
      running = r
      const t0 = deps.now()
      let firstAt: number | null = null
      const system = deps.brief({ history: hist.slice(-HISTORY_KEEP), openOrders: [] })
      remember('user', turn.text)
      void (async () => {
        try {
          const out = await runTurn({
            key,
            base: deps.base,
            fetch: deps.fetch,
            model: API_MODEL_IDS[model],
            system,
            question: turn.text,
            tools: deps.tools,
            signal: ac.signal,
            runTool: deps.runTool,
            label: deps.label,
            onText: t => {
              if (firstAt === null) firstAt = deps.now()
              r.said += t
              emit({ t: 'delta', id: r.id, text: t })
            },
            onTool: (name, label) => emit({ t: 'tool', id: r.id, name, label }),
            onFlush: () => emit({ t: 'flush', id: r.id }),
          })
          const wallMs = deps.now() - t0
          const cost = costUsd(model, out.usage)
          const ttftMs = firstAt === null ? null : firstAt - t0
          served++
          costTotal += cost
          timings.push({ id: r.id, model, ttftMs, wallMs, ms: wallMs, costUsd: cost, at: deps.now() })
          if (timings.length > TIMINGS_KEEP) timings.splice(0, timings.length - TIMINGS_KEEP)
          remember('assistant', out.text)
          deps.log?.info(`api answer ${r.id} (${model}): first word ${ttftMs === null ? 'none' : `${ttftMs} ms`}, done ${wallMs} ms, $${cost.toFixed(4)}, ${out.rounds} round(s)`)
          emit({ t: 'done', id: r.id, text: out.text, ms: wallMs, costUsd: cost, ...(ttftMs === null ? {} : { ttftMs }) })
        } catch (e) {
          if (e instanceof ApiFailure && e.kind === 'aborted') {
            // Cut off (a new question, a stop): the words said so far stand, as a cancelled answer.
            emit({ t: 'done', id: r.id, text: r.said, ms: deps.now() - t0, cancelled: true })
          } else {
            errors++
            const kind = e instanceof ApiFailure ? e.kind : 'unreachable'
            deps.log?.warn(`api answer ${r.id} failed: ${kind}`)
            emit({ t: 'error', id: r.id, status: e instanceof ApiFailure && e.status ? e.status : 503, message: apiWords(kind) })
          }
        } finally {
          if (running === r) running = null
        }
      })()
      return { ok: true }
    },
    deliver() {
      return { ok: false, reason: 'The API answers do not take notes from the Orchestrator.' }
    },
    interrupt(id) {
      if (running && (id === undefined || running.id === id)) cut(running)
    },
    keyOwns() {
      return false
    },
    // F-221 (ob98a): no process and no tool key of its own (keyOwns above): nothing of a cut turn can call the hub.
    stopping() {
      return false
    },
    async tick() {
      // Nothing to watch: no process, no memory.
    },
    state: stateNow,
    status(): FastStatus {
      const reason = reasonNow()
      return {
        state: stopped ? 'off' : reason ? 'unavailable' : 'ready',
        reason,
        model: lastModel,
        pid: null,
        startedAt: null,
        readyMs: null,
        owners: owners.size,
        idleEndsAt: null,
        restarts: 0,
        pending: running ? 1 : 0,
        served,
        errors,
        costUsd: Math.round(costTotal * 1e6) / 1e6,
        lastExit: null,
        gate: gate(),
        timings: [...timings],
      }
    },
    async stop(why) {
      stopped = true
      if (running) cut(running)
      deps.log?.info(`api answers stopped: ${why}`)
    },
  }
}

/** A key this host may use is the one the store holds (checked again per question). */
export const apiKeyPresent = (keys: ModelKeyStore) => keys.status().saved
