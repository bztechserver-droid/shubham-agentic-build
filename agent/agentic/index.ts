import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENTIC_PREFIX,
  AGENT_MODELS,
  type AgentModel,
  type AgenticEvent,
  type ChatImported,
  type ChatOpened,
  type ClaudeSession,
  type Floor,
  type FloorAgent,
  type FloorPatch,
  type FloorsAnswer,
  type NewAgent,
  type TerminalClientMessage,
} from '../../shared/agentic.ts'
import { apiError, type ApiMount, type MountRequest, type WsSocket } from '../api.ts'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { composeAgentBrief, MCP_SERVER_NAME, writeBrief } from './briefs.ts'
import { claudeJsonPath, prepareClaudeConfig } from './claude-config.ts'
import { createChatPool, type ChatInfo, type ChatPool, type PtySpawn } from './chats.ts'
import { createFloorStore, type FloorStore } from './floors.ts'
import { createMemoryStore, type MemoryStore } from './memory.ts'
import { claudeProjectsDir, copyTranscript, findTranscriptCwd, listSessions, readTranscript, transcriptInfo } from './transcripts.ts'

// F-018: the Agentic Workflow section's backend (agentic-claude-manager's floors, agents and
// their chats, and the tools those chats share), mounted on the agent's local API at /agentic.
//   the page    /agentic/floors..., WebSockets /agentic/events and /agentic/terminal, with
//               x-sad-token like the rest of the API (Vite's proxy adds it)
//   the chats   POST /agentic/mcp/call, with the calling chat's key (x-sad-chat-key) and
//               never the app's token: a chat can reach its floor, not the rest of the API
// State in <state>/agent/agentic: floors.json, memory/<floorId>.jsonl, briefs/<sessionId>.md,
// and mcp.json, the --mcp-config every chat is started with.

/** send_to_chat: one message per sender→target pair every 5 s, at most 6 a minute into one chat. */
const PAIR_COOLDOWN_MS = 5000
const TARGET_WINDOW_MS = 60_000
const TARGET_WINDOW_MAX = 6
/** broadcast_to_chats: one per floor every 10 s. */
const BROADCAST_COOLDOWN_MS = 10_000
const MAX_RELAY_TEXT = 10_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AgenticOptions {
  /** <state>/agent/agentic */
  dir: string
  /** The local API's base URL, http://127.0.0.1:<port>/agent-api (read when a chat starts). */
  apiUrl: () => string
  log?: Logger
  /** Where a floor with no folder of its own works: Documents\shubham-agentic. */
  defaultCodeDir?: string
  /** CLAUDE_CODE_OAUTH_TOKEN as this account has it now (F-007). */
  token?: () => string | null
  /** Tests: a fake node-pty (and a no-op tree kill: its pids are other processes'), a fake claude, and a scratch ~/.claude/projects. */
  spawn?: PtySpawn
  treeKill?: (pid: number) => void
  claude?: string
  projectsDir?: string
  /** Tests: a scratch ~/.claude.json (claude-config.ts). */
  claudeJson?: string
}

export interface Agentic {
  mount: ApiMount
  floors: FloorStore
  chats: ChatPool
  memory: MemoryStore
  /** What a tool call does, for the chat whose key it carries; the answer is the text the chat sees. */
  callTool(key: string, name: string, args: unknown): Promise<string>
  close(): void
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, what: string, max = MAX_RELAY_TEXT) => {
  if (typeof v !== 'string' || !v.trim()) throw apiError(400, `${what} is missing`)
  if (v.length > max) throw apiError(400, `${what} is longer than ${max} characters`)
  return v
}
const json = (v: unknown) => JSON.stringify(v, null, 2)

export function createAgentic(o: AgenticOptions): Agentic {
  const log = o.log
  const projectsDir = o.projectsDir ?? claudeProjectsDir()
  const claudeJson = o.claudeJson ?? claudeJsonPath()
  const defaultCodeDir = o.defaultCodeDir ?? path.join(os.homedir(), 'Documents', 'shubham-agentic')
  const briefsDir = path.join(o.dir, 'briefs')
  const mcpConfig = path.join(o.dir, 'mcp.json')
  const shim = fileURLToPath(new URL('./mcp-shim.ts', import.meta.url))
  // The shim is named here once; the key it needs comes from the chat's own terminal.
  writeAtomic(mcpConfig, `${json({ mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: process.execPath, args: [shim] } } })}\n`)

  const events = new Set<WsSocket>()
  const emit = (e: AgenticEvent) => {
    const t = JSON.stringify(e)
    for (const s of events) s.sendText(t)
  }

  const floors = createFloorStore(path.join(o.dir, 'floors.json'), () => emit({ t: 'floors', floors: floors.list() }))
  const memory = createMemoryStore(path.join(o.dir, 'memory'))
  let liveTimer: NodeJS.Timeout | null = null
  const chats = createChatPool({
    toolsUrl: () => `${o.apiUrl()}${AGENTIC_PREFIX}/mcp`,
    mcpConfig,
    log,
    spawn: o.spawn,
    treeKill: o.treeKill,
    claude: o.claude,
    token: o.token,
    onChange: () => {
      // States flip several times a second while a chat paints; the page needs the settled one.
      if (liveTimer) return
      liveTimer = setTimeout(() => {
        liveTimer = null
        emit({ t: 'live', live: chats.states() })
      }, 150)
      liveTimer.unref()
    },
  })

  function floorOf(id: string): Floor {
    const f = floors.get(id)
    if (!f) throw apiError(404, 'No such floor')
    return f
  }

  function agentOf(floor: Floor, id: string): FloorAgent {
    const a = floor.agents.find(x => x.id === id)
    if (!a) throw apiError(404, 'No such agent on this floor')
    return a
  }

  /** The floor's folder, made when it is the default one and missing. */
  function codeDirOf(floor: Floor): string {
    if (!floor.codeDir) {
      mkdirSync(defaultCodeDir, { recursive: true })
      return defaultCodeDir
    }
    if (!existsSync(floor.codeDir) || !statSync(floor.codeDir).isDirectory()) {
      throw apiError(409, `This floor's folder isn't there any more: ${floor.codeDir}. Change it on the Preamble tab.`)
    }
    return floor.codeDir
  }

  /** Its chat, running: started fresh, resumed from its transcript, or as it was. */
  function openChat(floorId: string, agentId: string, size?: { cols?: number; rows?: number }): ChatOpened {
    let floor = floorOf(floorId)
    const agent = agentOf(floor, agentId)
    let sid = agent.sessionId
    if (sid && chats.info(sid)) return { sessionId: sid, started: false, resumed: false }
    let cwd = codeDirOf(floor)
    if (!sid) {
      sid = randomUUID()
      floor = floors.bindSession(floor.id, agent.id, sid)
    }
    let resume = transcriptInfo(cwd, sid, projectsDir).exists
    if (!resume) {
      // Its conversation may be in another folder (the floor's folder changed since): resume it there.
      const elsewhere = findTranscriptCwd(sid, projectsDir)
      if (elsewhere && existsSync(elsewhere)) {
        cwd = elsewhere
        resume = true
      }
    }
    if (!resume && !UUID_RE.test(sid)) throw apiError(400, `"${sid}" has no conversation to resume, and a new chat's id must be a UUID`)
    try {
      const done = prepareClaudeConfig(cwd, claudeJson)
      if (done.length) log?.info(`answered in ${claudeJson} so the chat opens on its prompt: ${done.join(', ')}`)
    } catch (e) {
      log?.warn(`couldn't update ${claudeJson}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const briefPath = writeBrief(briefsDir, sid, composeAgentBrief(floor, agentOf(floor, agentId)))
    chats.start({ sessionId: sid, floorId: floor.id, agentId, cwd, briefPath, model: agent.model, resume, cols: size?.cols, rows: size?.rows })
    return { sessionId: sid, started: true, resumed: resume }
  }

  // ---------------------------------------------------------------------------------------
  // The tools (tools.ts), for the chat whose key came with the call

  const pairLast = new Map<string, number>()
  const targetHits = new Map<string, number[]>()
  const broadcastLast = new Map<string, number>()

  function relayAllowed(from: string, to: string) {
    const t = Date.now()
    const pair = `${from}>${to}`
    if (t - (pairLast.get(pair) ?? 0) < PAIR_COOLDOWN_MS) throw apiError(429, 'You just messaged that chat; give it a few seconds to answer before sending again.')
    const hits = (targetHits.get(to) ?? []).filter(x => t - x < TARGET_WINDOW_MS)
    if (hits.length >= TARGET_WINDOW_MAX) throw apiError(429, 'That chat has had too many messages this minute; wait before sending more.')
    pairLast.set(pair, t)
    targetHits.set(to, [...hits, t])
  }

  function rosterOf(floor: Floor, me: FloorAgent) {
    const byId = new Map(floor.agents.map(a => [a.id, a]))
    const agents = floor.agents.map(a => {
      const live = a.sessionId ? chats.info(a.sessionId) : null
      return {
        name: a.name,
        role: a.role,
        isBoss: a.isBoss,
        reportsTo: a.reportsTo ? (byId.get(a.reportsTo)?.name ?? null) : null,
        status: live ? 'online' : a.sessionId ? 'offline' : 'never opened',
        doing: live ? live.state : null,
        sessionId: live ? a.sessionId : null,
        isYou: a.id === me.id,
      }
    })
    const online = agents.filter(a => a.status === 'online').length
    return { floor: floor.name, total: agents.length, online, offline: agents.length - online, agents }
  }

  /** A live chat on the caller's floor, by the id list_chats gave. */
  function siblingOf(floor: Floor, sid: unknown): ChatInfo {
    if (typeof sid !== 'string' || !sid) throw apiError(400, 'sessionId is missing')
    const c = chats.info(sid)
    if (!c || c.floorId !== floor.id) throw apiError(404, `No running chat ${sid} on your floor; list_chats shows the ones there are`)
    return c
  }

  async function callTool(key: string, name: string, rawArgs: unknown): Promise<string> {
    const me = chats.byKey(key)
    if (!me) throw apiError(401, "This chat's key isn't known: its terminal was closed or the agent restarted. Open the chat from the floor again.")
    const mine = floors.bySession(me.sessionId)
    if (!mine) throw apiError(409, "This chat isn't an agent on a floor any more.")
    const { floor, agent } = mine
    const args = isObject(rawArgs) ? rawArgs : {}
    const tag = `${agent.name}, chat ${me.sessionId.slice(0, 8)}`

    switch (name) {
      case 'list_chats': {
        const byId = new Map(floor.agents.map(a => [a.id, a]))
        const others = chats
          .live()
          .filter(c => c.floorId === floor.id && c.sessionId !== me.sessionId)
          .map(c => ({ sessionId: c.sessionId, agent: byId.get(c.agentId)?.name ?? '?', role: byId.get(c.agentId)?.role ?? '', doing: c.state }))
        return json({ floor: floor.name, you: agent.name, chats: others })
      }
      case 'floor_roster':
        return json(rosterOf(floor, agent))
      case 'read_chat': {
        const c = siblingOf(floor, args.sessionId)
        return chats.read(c.sessionId, typeof args.lines === 'number' ? args.lines : 100) ?? ''
      }
      case 'send_to_chat': {
        const c = siblingOf(floor, args.sessionId)
        if (c.sessionId === me.sessionId) throw apiError(400, "That's your own chat")
        const body = text(args.text, 'text')
        relayAllowed(me.sessionId, c.sessionId)
        if (!chats.type(c.sessionId, `[message from ${tag}] ${body}`)) throw apiError(409, 'That chat stopped before the message reached it')
        log?.info(`${agent.name} → chat ${c.sessionId.slice(0, 8)}: a message`)
        return `Sent to chat ${c.sessionId}.`
      }
      case 'broadcast_to_chats': {
        const body = text(args.text, 'text')
        const t = Date.now()
        if (t - (broadcastLast.get(floor.id) ?? 0) < BROADCAST_COOLDOWN_MS) throw apiError(429, 'This floor just had a broadcast; wait a few seconds.')
        broadcastLast.set(floor.id, t)
        const to = chats.live().filter(c => c.floorId === floor.id && c.sessionId !== me.sessionId)
        for (const c of to) chats.type(c.sessionId, `[broadcast from ${tag}] ${body}`)
        return `Sent to ${to.length} chat${to.length === 1 ? '' : 's'}.`
      }
      case 'memory_save': {
        const entry = memory.save(floor.id, {
          text: text(args.text, 'text'),
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          sessionId: me.sessionId,
          authorName: agent.name,
        })
        emit({ t: 'memory', floorId: floor.id })
        return json({ saved: entry.id })
      }
      case 'memory_search':
        return json({ entries: memory.search(floor.id, typeof args.query === 'string' ? args.query : '', typeof args.limit === 'number' ? args.limit : 10) })
      case 'memory_recent':
        return json({ entries: memory.recent(floor.id, typeof args.limit === 'number' ? args.limit : 10) })
      case 'agent_hire': {
        if (!agent.isBoss) throw apiError(403, "Only the floor's boss can hire; ask them.")
        const model = args.model
        if (model !== undefined && !(AGENT_MODELS as readonly unknown[]).includes(model)) throw apiError(400, 'model is opus, sonnet or haiku')
        const { agent: hired, floor: after } = floors.addAgent(floor.id, {
          name: typeof args.name === 'string' ? args.name : '',
          role: typeof args.role === 'string' ? args.role : '',
          md: typeof args.md === 'string' ? args.md : undefined,
          reportsTo: typeof args.reportsTo === 'string' && args.reportsTo.trim() ? args.reportsTo : agent.id,
          model: model as AgentModel | undefined,
        })
        log?.info(`${agent.name} hired ${hired.name} on ${floor.name}`)
        return json({ hired: hired.name, role: hired.role, total: after.agents.length, note: 'No chat is started yet; the human opens it from the floor.' })
      }
      default:
        throw apiError(404, `No tool called ${name}`)
    }
  }

  // ---------------------------------------------------------------------------------------
  // The page's routes

  function answer(): FloorsAnswer {
    return { floors: floors.list(), live: chats.states(), defaultCodeDir }
  }

  function patchFloor(id: string, body: unknown) {
    if (!isObject(body)) throw apiError(400, 'Expected {name?, globalPrompt?, codeDir?, agents?}')
    const before = floorOf(id)
    if (typeof body.codeDir === 'string' && body.codeDir.trim()) {
      const dir = body.codeDir.trim()
      if (!path.isAbsolute(dir)) throw apiError(400, 'Give the folder as a full path, like C:\\Users\\you\\code')
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw apiError(400, `There is no folder ${dir}`)
    }
    const floor = floors.patch(id, body as FloorPatch)
    // An agent taken off the floor takes its running chat with it.
    const kept = new Set(floor.agents.map(a => a.id))
    for (const a of before.agents) if (!kept.has(a.id) && a.sessionId) chats.kill(a.sessionId)
    return { floor }
  }

  /** This account's Claude Code conversations, each with the agent here it already is, if any. */
  async function sessions(): Promise<ClaudeSession[]> {
    const bound = new Map<string, ClaudeSession['agent']>()
    for (const f of floors.list()) for (const a of f.agents) if (a.sessionId) bound.set(a.sessionId, { floorId: f.id, floorName: f.name, agentId: a.id, name: a.name })
    return (await listSessions(projectsDir)).map(x => ({ ...x, agent: bound.get(x.sessionId) ?? null }))
  }

  /** A copy of a conversation becomes an agent's chat (transcripts.ts says why a copy): a new agent's, or the one named's. */
  async function importChat(floorId: string, body: unknown): Promise<ChatImported> {
    if (!isObject(body) || typeof body.sessionId !== 'string' || !UUID_RE.test(body.sessionId)) throw apiError(400, 'Expected {sessionId, agentId?, name?, role?}')
    const from = body.sessionId
    const intoId = typeof body.agentId === 'string' && body.agentId ? body.agentId : null
    const floor = floorOf(floorId)
    if (intoId) agentOf(floor, intoId)
    const cwd = findTranscriptCwd(from, projectsDir)
    if (!cwd) throw apiError(404, `There is no conversation ${from} on this PC, or it never said which folder it was held in`)
    if (!existsSync(cwd)) throw apiError(409, `That conversation was held in ${cwd}, which isn't there any more`)
    const sid = randomUUID()
    let copy: string
    try {
      copy = (await copyTranscript(from, sid, projectsDir)).file
    } catch (e) {
      throw apiError(500, `Couldn't copy that conversation: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      // Looked up again: the floor may have changed while it copied.
      let agentId = intoId
      if (agentId) {
        const before = agentOf(floorOf(floorId), agentId).sessionId
        if (before) chats.kill(before)
      } else {
        const name = typeof body.name === 'string' ? body.name : ''
        agentId = floors.addAgent(floorId, { name, role: typeof body.role === 'string' ? body.role.trim() : '' }).agent.id
      }
      const after = floors.bindSession(floorId, agentId, sid)
      const agent = agentOf(after, agentId)
      log?.info(`brought a copy of conversation ${from.slice(0, 8)} onto ${after.name} as ${agent.name}'s chat (${sid.slice(0, 8)})`)
      return { floor: after, agent, sessionId: sid, cwd }
    } catch (e) {
      rmSync(copy, { force: true })
      throw e
    }
  }

  type Handler = (m: string[], r: MountRequest) => unknown
  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/floors$/, () => answer()],
    ['POST', /^\/floors$/, (_, r) => ({ floor: floors.create(isObject(r.body) && typeof r.body.name === 'string' ? r.body.name : undefined) })],
    [
      'POST',
      /^\/floors\/reorder$/,
      (_, r) => {
        if (!isObject(r.body) || !Array.isArray(r.body.order) || r.body.order.some(x => typeof x !== 'string')) throw apiError(400, 'Expected {order: [floor ids]}')
        return { floors: floors.reorder(r.body.order as string[]) }
      },
    ],
    ['GET', /^\/sessions$/, async () => ({ sessions: await sessions() })],
    ['PATCH', /^\/floors\/([^/]+)$/, ([id], r) => patchFloor(id, r.body)],
    [
      'DELETE',
      /^\/floors\/([^/]+)$/,
      ([id]) => {
        const f = floorOf(id)
        for (const a of f.agents) if (a.sessionId) chats.kill(a.sessionId)
        floors.remove(id)
        memory.drop(id)
        return { ok: true }
      },
    ],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents$/,
      ([id], r) => {
        const b = isObject(r.body) ? r.body : {}
        if (b.model !== undefined && !(AGENT_MODELS as readonly unknown[]).includes(b.model)) throw apiError(400, 'model is opus, sonnet or haiku')
        return floors.addAgent(id, b as NewAgent)
      },
    ],
    ['POST', /^\/floors\/([^/]+)\/import$/, ([id], r) => importChat(id, r.body)],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/chat$/,
      ([id, agentId], r) => {
        const b = isObject(r.body) ? r.body : {}
        return openChat(id, agentId, { cols: typeof b.cols === 'number' ? b.cols : undefined, rows: typeof b.rows === 'number' ? b.rows : undefined })
      },
    ],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/terminate$/,
      ([id, agentId]) => {
        const a = agentOf(floorOf(id), agentId)
        return { killed: a.sessionId ? chats.kill(a.sessionId) : false }
      },
    ],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/session$/,
      ([id, agentId], r) => {
        if (!isObject(r.body) || typeof r.body.sessionId !== 'string') throw apiError(400, "Expected {sessionId}, '' to unbind")
        const floor = floorOf(id)
        const a = agentOf(floor, agentId)
        const next = r.body.sessionId.trim()
        if (a.sessionId && a.sessionId !== next) chats.kill(a.sessionId)
        const after = floors.bindSession(id, agentId, next || null)
        const cwd = floor.codeDir ?? defaultCodeDir
        return { floor: after, hasTranscript: next ? transcriptInfo(cwd, next, projectsDir).exists || !!findTranscriptCwd(next, projectsDir) : false }
      },
    ],
    [
      'GET',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/messages$/,
      ([id, agentId]) => {
        const floor = floorOf(id)
        const a = agentOf(floor, agentId)
        if (!a.sessionId) return { sessionId: null, messages: [] }
        const cwd = chats.info(a.sessionId)?.cwd ?? findTranscriptCwd(a.sessionId, projectsDir) ?? floor.codeDir ?? defaultCodeDir
        return { sessionId: a.sessionId, messages: readTranscript(cwd, a.sessionId, projectsDir) }
      },
    ],
    [
      'GET',
      /^\/floors\/([^/]+)\/transcripts$/,
      ([id]) => {
        const floor = floorOf(id)
        const out: Record<string, { exists: boolean; bytes: number }> = {}
        for (const a of floor.agents) {
          if (!a.sessionId) continue
          const cwd = chats.info(a.sessionId)?.cwd ?? findTranscriptCwd(a.sessionId, projectsDir) ?? floor.codeDir ?? defaultCodeDir
          const t = transcriptInfo(cwd, a.sessionId, projectsDir)
          out[a.id] = { exists: t.exists, bytes: t.bytes }
        }
        return { transcripts: out }
      },
    ],
    ['GET', /^\/floors\/([^/]+)\/memory$/, ([id], r) => ({ entries: memory.search(floorOf(id).id, r.query.get('q') ?? '', 100) })],
    [
      'POST',
      /^\/floors\/([^/]+)\/memory$/,
      ([id], r) => {
        const b = isObject(r.body) ? r.body : {}
        const entry = memory.save(floorOf(id).id, { text: text(b.text, 'text', 4000), tags: Array.isArray(b.tags) ? (b.tags as string[]) : [] })
        emit({ t: 'memory', floorId: id })
        return { entry }
      },
    ],
    [
      'PATCH',
      /^\/floors\/([^/]+)\/memory\/([^/]+)$/,
      ([id, noteId], r) => {
        const b = isObject(r.body) ? r.body : {}
        const entry = memory.edit(floorOf(id).id, noteId, text(b.text, 'text', 4000))
        emit({ t: 'memory', floorId: id })
        return { entry }
      },
    ],
    [
      'DELETE',
      /^\/floors\/([^/]+)\/memory\/([^/]+)$/,
      ([id, noteId]) => {
        if (!memory.remove(floorOf(id).id, noteId)) throw apiError(404, 'No such note')
        emit({ t: 'memory', floorId: id })
        return { ok: true }
      },
    ],
    [
      'POST',
      /^\/mcp\/call$/,
      async (_, r) => {
        const key = r.headers['x-sad-chat-key']
        if (typeof key !== 'string' || !key) throw apiError(401, 'Missing x-sad-chat-key')
        if (!isObject(r.body) || typeof r.body.name !== 'string') throw apiError(400, 'Expected {name, arguments}')
        return { text: await callTool(key, r.body.name, r.body.arguments) }
      },
    ],
  ]

  // ---------------------------------------------------------------------------------------
  // WebSockets

  function terminal(query: URLSearchParams) {
    const sid = query.get('session') ?? ''
    return (ws: WsSocket) => {
      const detach = chats.attach(sid, { send: m => ws.sendText(JSON.stringify(m)) })
      if (!detach) {
        ws.sendText(JSON.stringify({ t: 'exit', code: null }))
        return ws.close(1000, "That chat isn't running")
      }
      ws.onText(raw => {
        let m: TerminalClientMessage
        try {
          m = JSON.parse(raw) as TerminalClientMessage
        } catch {
          return
        }
        if (m.t === 'in' && typeof m.d === 'string') chats.input(sid, m.d)
        else if (m.t === 'size' && typeof m.cols === 'number' && typeof m.rows === 'number') chats.resize(sid, m.cols, m.rows)
      })
      ws.onClose(detach)
    }
  }

  const mount: ApiMount = {
    prefix: AGENTIC_PREFIX,
    ownAuth: rest => rest === '/mcp/call',
    async http(r) {
      let methodMismatch = false
      for (const [method, pattern, run] of routes) {
        const m = pattern.exec(r.rest)
        if (!m) continue
        if (r.method !== method) {
          methodMismatch = true
          continue
        }
        let params: string[]
        try {
          params = m.slice(1).map(decodeURIComponent)
        } catch {
          throw apiError(400, 'Malformed path')
        }
        return await run(params, r)
      }
      throw apiError(methodMismatch ? 405 : 404, methodMismatch ? `${r.method} is not allowed here` : `No such path: ${AGENTIC_PREFIX}${r.rest}`)
    },
    ws(rest, query) {
      if (rest === '/terminal') return terminal(query)
      if (rest === '/events')
        return ws => {
          events.add(ws)
          ws.onClose(() => events.delete(ws))
          ws.sendText(JSON.stringify({ t: 'floors', floors: floors.list() } satisfies AgenticEvent))
          ws.sendText(JSON.stringify({ t: 'live', live: chats.states() } satisfies AgenticEvent))
        }
      return null
    },
  }

  return {
    mount,
    floors,
    chats,
    memory,
    callTool,
    close() {
      if (liveTimer) clearTimeout(liveTimer)
      chats.closeAll()
      for (const s of events) s.close(1001, 'the agent is stopping')
      events.clear()
    },
  }
}
