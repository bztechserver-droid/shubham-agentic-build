import { randomBytes, createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ChatPool, ChatInfo, ChatPoolOptions, StartChat, Viewer, PtyLike, PtySpawn } from '../agentic/chats.ts'
import { loadNodePty } from '../agentic/chats.ts'
import { writeAtomic } from '../config.ts'
import type { ChatState } from '../../shared/agentic.ts'
import type { OpenCodeProvider, OpenCodeStatus } from '../../shared/opencode.ts'
import { OPENCODE_SESSION_RE } from '../../shared/opencode.ts'
import type { ApiCredential } from './crm.ts'
import { findOpenCode, type OpenCodeInstall } from './install.ts'
import { createAdmission, TUI_RESERVATION } from './capacity.ts'
import { startBackend, type Backend, type BackendOptions } from './backend.ts'
import { emitHistory, readHistory } from './history.ts'
import { apiError } from '../api.ts'

export interface PrepareOpenCode extends StartChat { provider: OpenCodeProvider; selectedModel: string; native: string | null; brief: string; mcp?: BackendOptions['mcp'] }
export interface OpenCodePoolOptions {
  dir: string
  toolsUrl: () => string
  shim: string
  credential: (provider: OpenCodeProvider) => Promise<ApiCredential>
  onBind: (sid: string, native: string) => void | Promise<void>
  identity?: () => string | null
  onChange: () => void
  onEnded: NonNullable<ChatPoolOptions['onEnded']>
  find?: () => OpenCodeInstall | null
  backend?: (options: BackendOptions) => Promise<Backend>
  spawn?: PtySpawn
  freeMemory?: () => number
  idleMs?: number
  keep?: (sid: string) => boolean
}
interface Live {
  info: ChatInfo
  key: string
  backend: Backend
  terminal: PtyLike | null
  viewers: Set<Viewer>
  screen: string
  text: string
  draft: boolean
  lastActive: number
  refreshing: boolean
  refreshAgain: boolean
  provider: OpenCodeProvider
  fingerprint: string
  identity: string | null
  pending: { text: string; holdForDraft?: boolean }[]
}
/** The HTTP backend owns status and sends. The PTY is a lazily attached viewer of it. */
export function createOpenCodePool(o: OpenCodePoolOptions) {
  const live = new Map<string, Live>(), starting = new Set<string>(), stopping = new Map<string, Promise<void>>(), admission = createAdmission(o.freeMemory)
  const rootOf = (sid: string) => { if (!/^[0-9a-f-]{36}$/i.test(sid)) throw apiError(400, 'Invalid app conversation id'); return path.join(o.dir, 'chats', sid) }
  const mirror = (sid: string) => path.join(rootOf(sid), 'history.jsonl')
  const install = () => (o.find ?? findOpenCode)()
  const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex')
  let checking = false, stopped = false, lastCheck = Date.now()
  async function refresh(sid: string) {
    const c = live.get(sid); if (!c) return
    if (c.refreshing) { c.refreshAgain = true; return }
    c.refreshing = true
    try {
      do {
        c.refreshAgain = false
        const doc = await c.backend.snapshot()
        const history = readHistory('opencode', doc, c.info.startedAt)
        const rows = emitHistory('claude', history, { id: sid, cwd: c.info.cwd, timestamp: c.info.startedAt }) as string[]
        writeAtomic(mirror(sid), rows.join('\n') + '\n')
        c.text = history.flatMap(m => m.parts.map(p => p.type === 'text' ? `${m.role}: ${p.text}` : `${p.name}: ${p.output}`)).join('\n')
      } while (c.refreshAgain && live.get(sid) === c)
    } catch { /* A disconnect is recovered from the next event/snapshot. No raw provider errors. */ }
    finally { c.refreshing = false }
  }
  function change(sid: string, state: ChatState) { const c = live.get(sid); if (c && c.info.state !== state) { c.info.state = state; c.lastActive = Date.now(); o.onChange() } }
  function event(sid: string, e: any) {
    const c = live.get(sid); if (!c) return
    if (e.properties?.sessionID && e.properties.sessionID !== c.backend.native) return
    if (e.type === 'session.status') change(sid, e.properties?.status?.type === 'idle' ? 'idle' : 'running')
    if (e.type === 'session.idle') change(sid, 'idle')
    if (e.type === 'permission.asked' || e.type === 'question.asked') change(sid, 'question')
    if (e.type === 'session.error') change(sid, 'idle')
    if (e.type === 'reconnect') void c.backend.client.request('/session/status').then(status => change(sid, status[c.backend.native]?.type === 'busy' ? 'running' : 'idle')).catch(() => {})
    if (e.type.startsWith('message.') || e.type === 'session.idle' || e.type === 'reconnect') void refresh(sid)
  }
  function detachTerminal(sid: string, c: Live) {
    const terminal = c.terminal; c.terminal = null
    terminal?.kill(); admission.release(`${sid}:tui`)
  }
  function kill(sid: string, why = 'stopped') {
    const c = live.get(sid); if (!c) return false
    live.delete(sid); detachTerminal(sid, c)
    const finished = why === 'agent-stop' ? c.backend.close().finally(() => { stopping.delete(sid); admission.release(sid) }) : c.backend.abort().catch(() => {}).then(async () => {
      try {
        const history = readHistory('opencode', await c.backend.snapshot(), c.info.startedAt)
        const rows = emitHistory('claude', history, { id: sid, cwd: c.info.cwd, timestamp: c.info.startedAt }) as string[]
        writeAtomic(mirror(sid), rows.join('\n') + '\n')
      } catch { /* Preserve the last successfully mirrored history. */ }
      await c.backend.close()
    }).finally(() => { stopping.delete(sid); admission.release(sid); o.onChange() })
    stopping.set(sid, finished)
    void finished.catch(() => {})
    o.onEnded({ sessionId: sid, floorId: c.info.floorId, agentId: c.info.agentId, engine: 'opencode', cause: why, code: null, startedAt: c.info.startedAt })
    o.onChange(); return true
  }
  const timer = setInterval(() => {
    for (const [sid, c] of live) {
      if (o.identity && c.identity !== o.identity()) { kill(sid, 'crm-sign-out'); continue }
      const queued = c.pending[0]
      if (queued && c.info.state === 'idle' && (!queued.holdForDraft || !c.draft) && pool.type(sid, queued.text, queued.holdForDraft ? { refuseDraft: true } : undefined)) c.pending.shift()
      if (!c.viewers.size && c.info.state === 'idle' && !o.keep?.(sid) && Date.now() - c.lastActive > (o.idleMs ?? 5 * 60_000)) kill(sid, 'idle-reaper')
    }
    if (!checking && Date.now() - lastCheck >= 60_000 && live.size) {
      checking = true; lastCheck = Date.now()
      void (async () => {
        for (const provider of new Set([...live.values()].map(c => c.provider))) {
          try {
            const credential = await o.credential(provider), next = fingerprint(credential.key)
            for (const [sid, c] of live) if (c.provider === provider && c.fingerprint !== next) kill(sid, 'credential-changed')
          } catch (error) {
            // A temporary CRM outage does not revoke an in-memory key. A definitive
            // refusal or ended session does; no fallback to another provider/login.
            const status = (error as { status?: number }).status
            if (status && status >= 400 && status < 500) for (const [sid, c] of live) if (c.provider === provider) kill(sid, 'credential-revoked')
          }
        }
      })().finally(() => { checking = false })
    }
  }, 1000)
  timer.unref()
  const api = {
    rootOf, mirror,
    file(sid: string) { const file = mirror(sid); return existsSync(file) ? file : null },
    install,
    status(): OpenCodeStatus { const found = install(); return { installed: !!found, version: found?.version ?? null, live: admission.count(), limit: 2, state: !found ? 'not-installed' : admission.count() >= 2 ? 'capacity' : 'ready', hint: found ? null : 'The pinned OpenCode 1.19.4 program is not included in this build on this PC.' } },
    async prepare(p: PrepareOpenCode) {
      const sid = p.sessionId
      await stopping.get(sid)
      if (stopped) throw apiError(503, 'The agent is stopping.')
      if (live.has(sid)) return
      if (starting.has(sid)) throw apiError(409, 'OpenCode is already starting this conversation.')
      const found = install(); if (!found) throw apiError(503, 'The pinned OpenCode program is not installed in this build.')
      if (p.native && !OPENCODE_SESSION_RE.test(p.native)) throw apiError(400, 'Invalid OpenCode session binding')
      admission.reserve(sid); starting.add(sid)
      let backend: Backend | null = null
      try {
        const identity = o.identity?.() ?? null
        const credential = await o.credential(p.provider)
        if (stopped) throw apiError(503, 'The agent is stopping.')
        if (o.identity && identity !== o.identity()) throw apiError(401, 'The PC’s CRM sign-in changed while OpenCode was starting.')
        const key = randomBytes(32).toString('hex')
        mkdirSync(rootOf(sid), { recursive: true })
        backend = await (o.backend ?? startBackend)({ install: found, root: rootOf(sid), cwd: p.cwd, credential, model: p.selectedModel, native: p.native, brief: p.brief, toolsUrl: o.toolsUrl(), chatKey: key, shim: o.shim, mcp: p.mcp, event: e => event(sid, e), exited: () => { kill(sid, 'crashed') } })
        if (stopped || (o.identity && identity !== o.identity())) throw apiError(401, 'The agent stopped or its CRM sign-in changed during OpenCode start.')
        const c: Live = { info: { sessionId: sid, floorId: p.floorId, agentId: p.agentId, engine: 'opencode', cwd: p.cwd, state: 'idle', startedAt: new Date().toISOString(), viewers: 0 }, key, backend, terminal: null, viewers: new Set(), screen: '', text: '', draft: false, lastActive: Date.now(), refreshing: false, refreshAgain: false, provider: p.provider, fingerprint: fingerprint(credential.key), identity, pending: [] }
        live.set(sid, c)
        await o.onBind(sid, backend.native)
        await refresh(sid); o.onChange()
      } catch (error) { live.delete(sid); if (backend) await backend.close(); admission.release(sid); throw error }
      finally { starting.delete(sid) }
    },
    async snapshot(sid: string) { const c = live.get(sid); if (!c) throw apiError(409, 'Start the OpenCode conversation on its home PC before exporting it.'); await c.backend.abort(); await refresh(sid); return c.backend.snapshot() },
    async abort(sid: string) { const c = live.get(sid); if (!c) return false; await c.backend.abort(); await refresh(sid); change(sid, 'idle'); return true },
    async settled(sid: string) { await refresh(sid) },
    async waitStopped(sid: string) { await stopping.get(sid) },
    pool: null as unknown as ChatPool,
  }
  const pool: ChatPool = {
    start(p) { const c = live.get(p.sessionId); if (!c) throw new Error('OpenCode backend must be prepared before start'); return c.info },
    info: sid => { const c = live.get(sid); return c ? { ...c.info, viewers: c.viewers.size } : null },
    live: () => [...live.values()].map(c => ({ ...c.info, viewers: c.viewers.size })),
    states: () => Object.fromEntries([...live].map(([sid, c]) => [sid, c.info.state])),
    byKey: key => [...live.values()].find(c => c.key === key)?.info ?? null,
    attach(sid, viewer) {
      const c = live.get(sid); if (!c) return null
      if (!c.terminal) {
        admission.reserve(`${sid}:tui`, TUI_RESERVATION)
        try {
          const loader = o.spawn ? { spawn: o.spawn } : loadNodePty()
          if ('error' in loader) throw new Error(loader.error)
          c.terminal = loader.spawn(c.backend.terminal.executable, c.backend.terminal.args, { cwd: c.info.cwd, env: c.backend.terminal.env, cols: 100, rows: 30 })
          const terminal = c.terminal
          terminal.onData(d => { c.screen = (c.screen + d).slice(-256 * 1024); for (const v of c.viewers) v.send({ t: 'out', d }) })
          terminal.onExit(() => { if (c.terminal === terminal) { c.terminal = null; admission.release(`${sid}:tui`) } })
        } catch (error) { admission.release(`${sid}:tui`); throw error }
      }
      c.viewers.add(viewer); c.lastActive = Date.now()
      if (c.screen) viewer.send({ t: 'out', d: c.screen })
      return () => { c.viewers.delete(viewer); c.lastActive = Date.now(); if (!c.viewers.size) detachTerminal(sid, c) }
    },
    input(sid, data) {
      const c = live.get(sid); if (!c) return false
      c.lastActive = Date.now()
      if (data === '\u001b' || data === '\u0003') { void api.abort(sid).catch(() => {}); return true }
      if (!c.terminal) return false
      c.draft = !/[\r\n]/.test(data); c.terminal.write(data); return true
    },
    resize(sid, cols, rows) { live.get(sid)?.terminal?.resize(cols, rows) },
    read: (sid, lines = 100) => { const c = live.get(sid); return c ? c.text.split('\n').slice(-lines).join('\n') : null },
    screen: sid => { const c = live.get(sid); return c ? c.text.split('\n').slice(-100) : null },
    asking: sid => live.get(sid)?.info.state === 'question',
    drafting: sid => live.get(sid)?.draft ?? false,
    type(sid, text, opt) {
      const c = live.get(sid); if (!c || c.info.state === 'running' || (opt?.refuseDraft && c.draft)) return false
      change(sid, 'running')
      void c.backend.send(text).then(() => refresh(sid)).catch(() => { change(sid, 'idle') })
      return true
    },
    typeWhenReady(sid, text, opt) {
      const c = live.get(sid); if (!c) return
      if (c.pending.length || !pool.type(sid, text, opt?.holdForDraft ? { refuseDraft: true } : undefined)) c.pending.push({ text, holdForDraft: opt?.holdForDraft })
    },
    kill,
    adopt() { throw new Error('OpenCode backends resume from their isolated persisted session, not a hosted PTY.') },
    activity(sid) { const c = live.get(sid); return c ? { state: c.info.state, startedAt: c.info.startedAt, lastOutputAt: c.lastActive, lastActiveAt: c.lastActive, background: c.info.state === 'running' ? 'OpenCode turn' : null } : null },
    press: (sid, data) => pool.input(sid, data),
    closeAll() { stopped = true; clearInterval(timer); for (const sid of live.keys()) kill(sid, 'agent-stop') },
  }
  api.pool = pool
  return api
}

/** Keep all existing consumers (MCP, peer routing, watchdog, terminal) on one interface. */
export function combinePools(base: ChatPool, extra: ChatPool): ChatPool {
  const owner = (sid: string) => extra.info(sid) ? extra : base
  return {
    start: p => (p.engine === 'opencode' ? extra : base).start(p),
    info: sid => owner(sid).info(sid), live: () => [...base.live(), ...extra.live()], states: () => ({ ...base.states(), ...extra.states() }), byKey: key => extra.byKey(key) ?? base.byKey(key),
    attach: (sid, v) => owner(sid).attach(sid, v), input: (sid, d) => owner(sid).input(sid, d), resize: (sid, c, r) => owner(sid).resize(sid, c, r), read: (sid, n) => owner(sid).read(sid, n), screen: sid => owner(sid).screen(sid), asking: sid => owner(sid).asking(sid), drafting: sid => owner(sid).drafting(sid),
    type: (sid, t, opt) => owner(sid).type(sid, t, opt), typeWhenReady: (sid, t, opt) => owner(sid).typeWhenReady(sid, t, opt), kill: (sid, why) => owner(sid).kill(sid, why), waitStopped: sid => base.waitStopped?.(sid) ?? Promise.resolve(), adopt: (a, p, r) => base.adopt(a, p, r), activity: sid => owner(sid).activity(sid), press: (sid, d) => owner(sid).press(sid, d), closeAll() { extra.closeAll(); base.closeAll() },
  }
}
