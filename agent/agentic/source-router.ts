import type { AnswerSource } from '../../shared/fast.ts'
import type { FastAsk, FastFrame, FastHost, FastHostState, FastStatus } from './fast-host.ts'

// Order o7f34: which answerer a question of the efficient route (/live) goes to: the Claude login (fast-host.ts, the subscription) or the
// Anthropic API with the saved key (api-host.ts). The page's setting says which one first ("preferred"); a question may name its own
// (`source`, for the compare button); and when the Claude path is down (unavailable or paused) and the fallback is on, the API answers.
// The two hosts keep their own state; this only chooses, follows each question to the host that took it (so Stop reaches it), and
// says on each finished answer which one wrote it.

export type { AnswerSource }

export interface RouterDeps {
  claude: FastHost
  api: FastHost
  preferred(): AnswerSource
  fallback(): boolean
  log?: { info(m: string): void }
}

const FALLBACK_REASON = 'Answering with the API key: the Claude login path is down.'

export function createSourceRouter(d: RouterDeps): FastHost {
  const owner = new Map<string, FastHost>()
  let fellBack = false

  const down = (h: FastHost) => {
    const s: FastHostState = h.state()
    return s === 'unavailable' || s === 'paused'
  }
  /** The host a question goes to now (not yet asked). */
  function choose(source?: AnswerSource): { host: FastHost; source: AnswerSource; fell: boolean } {
    const want = source ?? d.preferred()
    if (want === 'api') return { host: d.api, source: 'api', fell: false }
    if (down(d.claude) && d.fallback() && d.api.state() === 'ready') return { host: d.api, source: 'api', fell: true }
    return { host: d.claude, source: 'subscription', fell: false }
  }
  function noteFallback(on: boolean) {
    if (on === fellBack) return
    fellBack = on
    d.log?.info(on ? 'old-app reader: the Claude path is down; answering with the API key' : 'old-app reader: the Claude path is back; answering with the Claude login')
  }

  return {
    async open(who) {
      const first = d.preferred() === 'api' ? d.api : d.claude
      const second = first === d.api ? d.claude : d.api
      const r = await first.open(who)
      if (r.ok) return r
      if (d.fallback()) {
        const r2 = await second.open(who)
        if (r2.ok) return r2
      }
      return r
    },
    close(who) {
      d.claude.close(who)
      d.api.close(who)
    },
    ask(turn: FastAsk, emit: (f: FastFrame) => void) {
      const c = choose(turn.source)
      noteFallback(c.fell)
      owner.set(turn.id, c.host)
      // Each finished answer says which one wrote it (the page labels it and times it by source).
      const tagged = (f: FastFrame): void => {
        if (f.t === 'done' && !f.cancelled) emit({ ...f, source: c.source } as FastFrame)
        else emit(f)
        if (f.t === 'done' || (f.t === 'error' && f.id === turn.id)) owner.delete(turn.id)
      }
      const r = c.host.ask(turn, tagged)
      if (!r.ok) owner.delete(turn.id)
      return r
    },
    deliver(note, turnId, emit) {
      return d.claude.deliver(note, turnId, emit)
    },
    interrupt(id) {
      if (id !== undefined) {
        owner.get(id)?.interrupt(id)
        return
      }
      d.claude.interrupt()
      d.api.interrupt()
    },
    keyOwns(key) {
      return d.claude.keyOwns(key)
    },
    // F-221 (ob98a): either one still stopping a cut-off turn.
    stopping() {
      return d.claude.stopping() || d.api.stopping()
    },
    async tick() {
      await d.claude.tick()
      await d.api.tick()
    },
    state(): FastHostState {
      const c = choose()
      noteFallback(c.fell)
      return c.fell ? 'ready' : c.host.state()
    },
    status(): FastStatus {
      const c = choose()
      const base = c.host.status()
      if (c.fell) return { ...base, state: 'ready', reason: FALLBACK_REASON, source: 'api' }
      return { ...base, source: c.source }
    },
    async stop(why) {
      await d.claude.stop(why)
      await d.api.stop(why)
    },
  }
}
