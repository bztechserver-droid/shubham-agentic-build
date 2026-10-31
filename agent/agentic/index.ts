import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  AGENTIC_PREFIX,
  AGENTS_OFF_STATUS,
  AGENT_EFFORTS,
  AGENT_MODELS,
  type AgentEffort,
  type AgentModel,
  type AgenticEvent,
  type AgenticTeam,
  type ChatElsewhere,
  type ChatImported,
  type ChatLast,
  type ChatOpened,
  type ChatState,
  type ClaudeSession,
  type Floor,
  type FloorAgent,
  type FloorPatch,
  type FloorsAnswer,
  type NewAgent,
  type OpenChatRequest,
  type TerminalClientMessage,
} from '../../shared/agentic.ts'
import type { PreviewsAnswer, SayAnswer } from '../../shared/chat.ts'
import type { TasksAnswer, TaskStatus } from '../../shared/tasks.ts'
import type { CrmAnswer, CrmCheck, CrmSessionInfo } from '../../shared/crm.ts'
import type { MemoryKind } from '../../shared/memory.ts'
import { apiError, type ApiMount, type MountRequest, type WsSocket } from '../api.ts'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { composeAgentBrief, MCP_SERVER_NAME, writeBrief } from './briefs.ts'
import { claudeJsonPath, prepareClaudeConfig } from './claude-config.ts'
import { createChatPool, findClaude, type ChatPool, type PtySpawn } from './chats.ts'
import { createChatFeeds } from './chatview.ts'
import { createFloorStore, type FloorStore } from './floors.ts'
import { CONTINUE_TEXT, createRecovery, type Recovery, type Remembered } from './recover.ts'
import { createFileTaskStore, taskId, taskPatch, taskText } from './tasks.ts'
import { checkCrm, createCrmStore, crmAddress, crmMode } from './crm.ts'
import { createCrmProxy } from './crmproxy.ts'
import { createMemoryStore, type MemoryStore } from './memory.ts'
import { noMeaning, type Embedder } from './embedder.ts'
import { createMemoryLayer, type MemoryLayer } from './memory-layer.ts'
import { appendAt, createTail, markOf, NO_FILE, sameMark, settled, type FileMark } from './mirror.ts'
import { answer, pullFrom, readLines, request, servePull, writeLine, type LinkPeer } from './roam.ts'
import {
  claudeProjectsDir,
  copyTranscript,
  encodeProjectPath,
  findTranscript,
  findTranscriptCwd,
  listSessions,
  sessionFiles,
  type SessionFile,
  readTranscriptFile,
  transcriptPath,
} from './transcripts.ts'

// F-018: the Agentic Workflow section's backend (agentic-claude-manager's floors, agents and
// their chats, and the tools those chats share), mounted on the agent's local API at /agentic.
//   the page    /agentic/floors..., WebSockets /agentic/events and /agentic/terminal, with
//               x-sad-token like the rest of the API (Vite's proxy adds it)
//   the chats   POST /agentic/mcp/call, with the calling chat's key (x-sad-chat-key) and
//               never the app's token: a chat can reach its floor, not the rest of the API
// State in <state>/agent/agentic: floors.json, memory/<floorId>.jsonl, briefs/<sessionId>.md,
// and mcp.json, the --mcp-config every chat is started with.
//
// F-021: one session, used from the hub's PCs in turn (agent/SPEC.md › F-021). The hub keeps
// the floors, the memory and who holds each session (sessions.json); a member shows the hub's
// floors (a copy in replica.json, read-only while the hub can't be reached) and forwards every
// change to it. A chat runs on one PC at a time: a member asks the hub for it first (a lease),
// and taking it over stops it where it ran. Each session's JSONL goes to the others as it
// grows ('jsonl' events) and is caught up in the background (pull), so every PC has it.

/** send_to_chat: one message per sender→target pair every 5 s, at most 6 a minute into one chat. */
const PAIR_COOLDOWN_MS = 5000
const TARGET_WINDOW_MS = 60_000
const TARGET_WINDOW_MAX = 6
/** broadcast_to_chats: one per floor every 10 s. */
const BROADCAST_COOLDOWN_MS = 10_000
const MAX_RELAY_TEXT = 10_000
/** F-050: the longest message the chat view types into a chat, and how long a new chat is taken to be at its start questions. */
const MAX_SAY_TEXT = 20_000
const SAY_FRESH_MS = 20_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** F-021: the hub's state to its members at least this often (their catch-up runs off it). */
const STATE_EVERY_MS = 30_000
/** F-021: a member granted a session is taken to be starting it this long before its live list must show it. */
const LEASE_GRACE_MS = 60_000

/** F-021: this PC among the hub's PCs, as the Agents section needs it (main.ts gives it). */
export interface AgenticTeamLinks {
  self(): { id: string; name: string }
  role(): 'hub' | 'member'
  /** A member: its hub, and the link to it now (null while it is down); null with no hub. */
  hub(): { id: string; name: string; link: LinkPeer | null } | null
  /** The hub: the link to a member now, by id. */
  member(id: string): LinkPeer | null
}

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
  /** F-021: the hub's PCs; left out, this PC is on its own. */
  team?: AgenticTeamLinks
  /** Tests: a fake node-pty (and a no-op tree kill: its pids are other processes'), a fake claude, and a scratch ~/.claude/projects. */
  spawn?: PtySpawn
  treeKill?: (pid: number) => void
  claude?: string
  projectsDir?: string
  /** Tests: a scratch ~/.claude.json (claude-config.ts). */
  claudeJson?: string
  /** Tests: how often a running chat's JSONL is looked at for what to send on (1 s). */
  syncEveryMs?: number
  /**
   * F-051: the memory layer. meaning: the embedding model (main.ts turns it on; left out, search
   * goes by words and nothing is downloaded); start: started with the agent rather than at first
   * use. The rest are for tests.
   */
  memory?: { meaning?: boolean; start?: boolean; embedder?: Embedder; timers?: boolean; claudeArgs?: string[] }
  /** Claude subscription failover: how long a chat told /exit gets to end itself before it is stopped the usual way (15 s). Tests shorten it. */
  restartGraceMs?: number
  /**
   * F-058: the chats that were open when the app last stopped come back by themselves (the guard sets
   * SAD_RESUME_CHATS=1, main.ts passes it): each is opened again, resumed, and told to carry on if it
   * was mid-turn. `resumeAfterMs` waits for the API to be up (4 s); `resumeGapMs` spaces the chats out (2 s).
   */
  resumeChats?: boolean
  resumeAfterMs?: number
  resumeGapMs?: number
  /** F-054: this PC's CRM session (crm-session.json, beside the agentic folder); tests give a scratch one. */
  crmSession?: string
}

export interface Agentic {
  mount: ApiMount
  floors: FloorStore
  chats: ChatPool
  memory: MemoryStore
  /** What a tool call does, for the chat whose key it carries; the answer is the text the chat sees. */
  callTool(key: string, name: string, args: unknown): Promise<string>
  /** F-021: an 'agentic' stream another of the hub's PCs opened (meta.from says which). */
  serve(meta: Record<string, unknown>): (stream: Duplex) => void
  /**
   * Claude subscription failover (agent/claude/failover.ts): the agent's chat on this PC stopped and
   * started again on the token in place now, its conversation resumed. true: it is running again.
   * false: it isn't running here, or this PC is a member (the hub holds the session).
   */
  restartChat(sessionId: string): Promise<boolean>
  /**
   * F-058: a chat that was open when the app stopped, opened again (its conversation resumed) and,
   * when `text` is given, told it once it is at its prompt (up to 90 s). true: it is running
   * afterwards; false: it can't be opened here (unknown session, a member PC, held elsewhere, an error).
   * Text goes only to a chat started now, never to one that was running already.
   */
  resumeChat(sessionId: string, text?: string): Promise<boolean>
  close(): void
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, what: string, max = MAX_RELAY_TEXT) => {
  if (typeof v !== 'string' || !v.trim()) throw apiError(400, `${what} is missing`)
  if (v.length > max) throw apiError(400, `${what} is longer than ${max} characters`)
  return v
}
const json = (v: unknown) => JSON.stringify(v, null, 2)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const enc = encodeURIComponent
const isMark = (v: unknown): v is FileMark => isObject(v) && typeof v.bytes === 'number' && typeof v.tail === 'string'

/**
 * F-020: the section switched off (Dev, beside the build that runs the chats): nothing is read
 * or started, and every route says so, so the page can tell "off here" from "not running".
 */
export function agenticOff(): ApiMount {
  return {
    prefix: AGENTIC_PREFIX,
    ownAuth: rest => rest === '/mcp/call',
    http: () =>
      Promise.reject(
        apiError(AGENTS_OFF_STATUS, "Agents are off in Dev: the build runs them, so Dev's chats never mix with its chats. Start Dev with --agents to try them here, apart from the build's"),
      ),
    ws: () => null,
  }
}

/** F-022: copying every conversation of another PC here. */
interface CopyAllState {
  pc: string
  state: 'running' | 'done' | 'failed'
  total: number
  done: number
  copied: number
  bytes: number
  error: string | null
  startedAt: string
}

function readJson(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(v) ? v : {}
  } catch {
    return {}
  }
}

/** F-021, on the hub: who holds each session (the PC running it, or granted it) and where it ran last. */
interface Held {
  holder: string | null
  holderName: string | null
  heldAt: number
  last: ChatLast | null
}

/** F-021, on a member: the hub's floors and sessions as it last said them. */
interface Replica {
  floors: Floor[]
  where: Record<string, { id: string; name: string; state: ChatState }>
  last: Record<string, ChatLast>
  marks: Record<string, FileMark>
}

export function createAgentic(o: AgenticOptions): Agentic {
  const log = o.log
  const team = o.team
  const projectsDir = o.projectsDir ?? claudeProjectsDir()
  // F-050: the chat view's reading of conversations (chatview.ts): the end of a file, never all of it.
  const chatFeeds = createChatFeeds({ projectsDir, log: o.log, screen: sid => chats.screen(sid) })
  const claudeJson = o.claudeJson ?? claudeJsonPath()
  const defaultCodeDir = o.defaultCodeDir ?? path.join(os.homedir(), 'Documents', 'shubham-agentic')
  const briefsDir = path.join(o.dir, 'briefs')
  const mcpConfig = path.join(o.dir, 'mcp.json')
  const heldFile = path.join(o.dir, 'sessions.json')
  const replicaFile = path.join(o.dir, 'replica.json')
  const shim = fileURLToPath(new URL('./mcp-shim.ts', import.meta.url))
  // The shim is named here once; the key it needs comes from the chat's own terminal.
  writeAtomic(mcpConfig, `${json({ mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: process.execPath, args: [shim] } } })}\n`)
  // F-051: the memory's hook (memory-hook.ts), for every chat's --settings, which claude adds to
  // the user's own settings. One command line, run by claude's shell: both paths quoted, with
  // forward slashes (a folder like "Shubham's Agent" has a space and an apostrophe).
  const hooksFile = path.join(o.dir, 'hooks.json')
  const fwd = (p: string) => p.replace(/\\/g, '/')
  const hookScript = fileURLToPath(new URL('./memory-hook.ts', import.meta.url))
  writeAtomic(hooksFile, `${json({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(hookScript)}"`, timeout: 10 }] }] } })}\n`)

  /** 'alone': no hub (as before F-021); 'hub': it keeps the floors; 'member': it shows its hub's. */
  const mode = (): 'alone' | 'hub' | 'member' => (!team ? 'alone' : team.role() === 'hub' ? 'hub' : team.hub() ? 'member' : 'alone')
  const self = () => team?.self() ?? { id: 'this-pc', name: os.hostname() }

  const events = new Set<WsSocket>()
  const emit = (e: AgenticEvent) => {
    const t = JSON.stringify(e)
    for (const s of events) s.sendText(t)
  }

  const floors = createFloorStore(path.join(o.dir, 'floors.json'), () => {
    if (mode() === 'member') return
    emit({ t: 'floors', floors: floors.list() })
    pushState()
  })
  const memory = createMemoryStore(path.join(o.dir, 'memory'))
  // F-056: the task list (the Tasks tab, and the chats' task tools), kept on the hub like the floors.
  // Behind TaskStore (tasks.ts): a hosted database can take its place without anything else changing.
  const tasks = createFileTaskStore(path.join(o.dir, 'tasks.json'))
  tasks.onChange(() => tasksChanged())

  // F-054: how the CRM page shows the CRM (built into the page, or its website in a frame) and where
  // that website is, kept on the hub, with the last look at that site (for the frame).
  const crm = createCrmStore(path.join(o.dir, 'crm.json'))
  let crmChecked: { url: string; app: string | null; at: number; check: CrmCheck } | null = null
  // The CRM built into the page talks to the CRM's backend through this PC's own session, never the page's.
  const crmProxy = createCrmProxy({ file: o.crmSession ?? path.join(o.dir, '..', 'crm-session.json') })

  // F-051: the memory layer, kept on the hub (or a PC on its own); a member's chats reach it
  // through the hub, as their tool calls do. Started with the agent when main.ts says so, else
  // at first use; meaning (the embedding model) only when main.ts turns it on.
  const layer: MemoryLayer = createMemoryLayer({
    dir: o.dir,
    modelsDir: path.join(o.dir, '..', 'models'),
    notes: id => memory.all(id),
    floors: () => floors.list(),
    transcript: sid => findTranscript(sid, projectsDir),
    projectsDir,
    token: o.token,
    claude: () => o.claude ?? findClaude(),
    log,
    embedder: o.memory?.embedder ?? (o.memory?.meaning ? undefined : noMeaning()),
    timers: o.memory?.timers,
    claudeArgs: o.memory?.claudeArgs,
    active: () => mode() !== 'member',
    live: !!o.memory?.start,
  })
  let layerStarted: Promise<void> | null = null
  /** The memory layer, started (here: this PC keeps the memory). */
  async function memoryLayer(): Promise<MemoryLayer> {
    layerStarted ??= layer.start()
    await layerStarted
    return layer
  }
  /** Switched on (main.ts): the chats get it (recall, the brief's section, memory_read, hits). Off, the Memory tab still can. */
  const memoryOn = !!o.memory?.start
  if (memoryOn && mode() !== 'member') void memoryLayer().catch(e => log?.warn(`memory: couldn't start: ${message(e)}`))
  /** F-051, on a member: the hub's memory section for its chats' briefs, as last fetched. */
  let memberBrief = ''
  function memoryBrief(): string {
    if (mode() !== 'member') return layer.brief()
    const link = team?.hub()?.link
    if (link)
      void request<{ text: string }>(link, 'http', { method: 'GET', rest: '/memory/brief', query: '', body: undefined })
        .then(r => (memberBrief = typeof r?.text === 'string' ? r.text : memberBrief))
        .catch(() => {})
    return memberBrief
  }
  // A member keeps its copy fresh, so a chat started there has the hub's latest.
  const memberBriefTimer = setInterval(() => {
    if (mode() === 'member') memoryBrief()
  }, 5 * 60_000)
  memberBriefTimer.unref()

  // ---------------------------------------------------------------------------------------
  // F-021 state: on the hub, who holds what and its members' live chats; on a member, the copy

  const held = new Map<string, Held>(loadHeld())
  const remote = new Map<string, { name: string; live: Record<string, ChatState> }>()
  const subs = new Map<string, Duplex>()
  let replica: Replica = loadReplica()
  let sub: { token: object; stream: Duplex } | null = null
  let subscribing = false

  function loadHeld(): [string, Held][] {
    try {
      const raw: unknown = JSON.parse(readFileSync(heldFile, 'utf8'))
      if (!isObject(raw)) return []
      return Object.entries(raw).flatMap(([sid, v]) => {
        if (!isObject(v)) return []
        const last = isObject(v.last) && typeof v.last.pc === 'string' && typeof v.last.at === 'string' ? { pc: v.last.pc, at: v.last.at } : null
        // A holder from before a restart is kept: its PC may still be running the chat.
        const holder = typeof v.holder === 'string' ? v.holder : null
        return [[sid, { holder, holderName: typeof v.holderName === 'string' ? v.holderName : null, heldAt: 0, last }] as [string, Held]]
      })
    } catch {
      return []
    }
  }
  const saveHeld = () => writeAtomic(heldFile, `${json(Object.fromEntries([...held].map(([sid, h]) => [sid, { holder: h.holder, holderName: h.holderName, last: h.last }])))}\n`)

  function loadReplica(): Replica {
    try {
      const raw = JSON.parse(readFileSync(replicaFile, 'utf8')) as Partial<Replica>
      return { floors: Array.isArray(raw.floors) ? raw.floors : [], where: {}, last: isObject(raw.last) ? (raw.last as Record<string, ChatLast>) : {}, marks: {} }
    } catch {
      return { floors: [], where: {}, last: {}, marks: {} }
    }
  }
  let replicaTimer: NodeJS.Timeout | null = null
  function saveReplica() {
    if (replicaTimer) return
    replicaTimer = setTimeout(() => {
      replicaTimer = null
      writeAtomic(replicaFile, `${json({ floors: replica.floors, last: replica.last })}\n`)
    }, 500)
    replicaTimer.unref()
  }

  // ---------------------------------------------------------------------------------------
  // Floors, as this PC sees them

  /** The floors: the hub's own, or, on a member, the hub's with this PC's folder as codeDir. */
  function allFloors(): Floor[] {
    if (mode() !== 'member') return floors.list()
    const me = self().id
    return replica.floors.map(f => ({ ...f, codeDir: f.folders?.[me] ?? null }))
  }

  function floorOf(id: string): Floor {
    const f = allFloors().find(x => x.id === id)
    if (!f) throw apiError(404, 'No such floor')
    return f
  }

  function agentOf(floor: Floor, id: string): FloorAgent {
    const a = floor.agents.find(x => x.id === id)
    if (!a) throw apiError(404, 'No such agent on this floor')
    return a
  }

  function bySession(sid: string): { floor: Floor; agent: FloorAgent } | null {
    for (const floor of allFloors()) {
      const agent = floor.agents.find(a => a.sessionId === sid)
      if (agent) return { floor, agent }
    }
    return null
  }

  /** The floor's folder, made when it is the default one and missing. */
  function codeDirOf(floor: Floor): string {
    if (!floor.codeDir) {
      mkdirSync(defaultCodeDir, { recursive: true })
      return defaultCodeDir
    }
    if (!existsSync(floor.codeDir) || !statSync(floor.codeDir).isDirectory()) {
      throw apiError(409, `This floor's folder isn't there${mode() === 'member' ? ' on this PC' : ' any more'}: ${floor.codeDir}. Change it on the Preamble tab.`)
    }
    return floor.codeDir
  }

  /** Where this PC keeps a session's JSONL, whether it has it yet or not. */
  function fileOf(sid: string): string {
    const found = findTranscript(sid, projectsDir)
    if (found) return found
    const at = bySession(sid)
    return transcriptPath(at?.floor.codeDir ?? defaultCodeDir, sid, projectsDir)
  }

  /**
   * Where a chat runs on this PC, and whether there is a conversation to resume: the floor's
   * folder; else the folder the conversation was held in, when it has one here; else (it came
   * from another PC, held in a folder this PC hasn't got) it is moved under the floor's folder.
   */
  function placeForRun(sid: string, folder: string): { cwd: string; resume: boolean } {
    const found = findTranscript(sid, projectsDir)
    if (!found) return { cwd: folder, resume: false }
    const dir = path.dirname(found)
    if (dir === path.join(projectsDir, encodeProjectPath(folder))) return { cwd: folder, resume: true }
    const cwd = findTranscriptCwd(sid, projectsDir)
    if (cwd && existsSync(cwd) && dir === path.join(projectsDir, encodeProjectPath(cwd))) return { cwd, resume: true }
    const to = transcriptPath(folder, sid, projectsDir)
    mkdirSync(path.dirname(to), { recursive: true })
    renameSync(found, to)
    return { cwd: folder, resume: true }
  }

  // ---------------------------------------------------------------------------------------
  // Chats on this PC, and their JSONL to the others

  let liveTimer: NodeJS.Timeout | null = null
  let lastLive = new Set<string>()
  // F-058: the list of open chats the next start will reopen (see resumeAll below).
  let recovery: Recovery | null = null
  let closing = false
  const chats = createChatPool({
    toolsUrl: () => `${o.apiUrl()}${AGENTIC_PREFIX}/mcp`,
    mcpConfig,
    log,
    spawn: o.spawn,
    treeKill: o.treeKill,
    claude: o.claude,
    token: o.token,
    // F-051: recall in every prompt, once the memory layer is on (main.ts).
    settings: o.memory?.start ? hooksFile : undefined,
    onChange: () => {
      noteOpen()
      // A chat that ended lets its session go (after its last write is sent on).
      const now = new Set(Object.keys(chats.states()))
      for (const sid of lastLive) if (!now.has(sid)) void ended(sid)
      lastLive = now
      // States flip several times a second while a chat paints; the page needs the settled one.
      if (liveTimer) return
      liveTimer = setTimeout(() => {
        liveTimer = null
        emit({ t: 'live', live: chats.states() })
        emitWhere()
        if (mode() === 'member' && sub) writeLine(sub.stream, { t: 'live', live: chats.states() })
        pushState()
      }, 150)
      liveTimer.unref()
    },
  })

  const tail = createTail({
    everyMs: o.syncEveryMs,
    onData(sid, from, data) {
      const line = { t: 'jsonl', sid, from, d: data.toString('base64') }
      if (mode() === 'member') {
        if (sub) writeLine(sub.stream, line)
      } else for (const s of subs.values()) writeLine(s, line)
    },
  })

  /** A chat that ended: once its last write is in and sent on, the session is free again. */
  const flushing = new Map<string, Promise<FileMark>>()
  function endFlush(sid: string): Promise<FileMark> {
    let p = flushing.get(sid)
    if (p) return p
    p = (async () => {
      const file = fileOf(sid)
      await settled(file)
      tail.flush(sid)
      tail.untrack(sid)
      return markOf(file)
    })()
    flushing.set(sid, p)
    void p.finally(() => setTimeout(() => flushing.delete(sid), 10_000).unref())
    return p
  }

  async function ended(sid: string) {
    if (!team) return
    const mark = await endFlush(sid).catch(() => markOf(fileOf(sid)))
    if (mode() === 'member') {
      const link = team.hub()?.link
      if (link) await request(link, 'release', { sessionId: sid, mark }).catch(e => log?.warn(`couldn't tell the hub chat ${sid.slice(0, 8)} ended: ${message(e)}`))
    } else release(sid, self())
  }

  /** Starts the agent's chat on this PC (its lease already got). */
  function startHere(floor: Floor, agent: FloorAgent, sid: string, size: OpenChatRequest): boolean {
    const { cwd, resume } = placeForRun(sid, codeDirOf(floor))
    if (!resume && !UUID_RE.test(sid)) throw apiError(400, `"${sid}" has no conversation to resume, and a new chat's id must be a UUID`)
    try {
      const done = prepareClaudeConfig(cwd, claudeJson)
      if (done.length) log?.info(`answered in ${claudeJson} so the chat opens on its prompt: ${done.join(', ')}`)
    } catch (e) {
      log?.warn(`couldn't update ${claudeJson}: ${message(e)}`)
    }
    // F-051: the memory's section (what it is, core.md, the wiki's pages) once the layer is on.
    const briefPath = writeBrief(briefsDir, sid, composeAgentBrief(floor, agent, o.memory?.start ? memoryBrief() : ''))
    chats.start({ sessionId: sid, floorId: floor.id, agentId: agent.id, cwd, briefPath, model: agent.model, effort: agent.effort, resume, cols: size.cols, rows: size.rows })
    if (team) tail.track(sid, fileOf(sid), markOf(fileOf(sid)).bytes)
    return resume
  }

  // ---------------------------------------------------------------------------------------
  // F-021 on the hub: who runs what, holding and letting go, stopping a chat wherever it runs

  /** Every chat running on the hub's PCs, by session. */
  function whereAll(): Record<string, { id: string; name: string; state: ChatState }> {
    const me = self()
    if (mode() === 'member') {
      const out = Object.fromEntries(Object.entries(replica.where).filter(([, w]) => w.id !== me.id))
      for (const [sid, state] of Object.entries(chats.states())) out[sid] = { id: me.id, name: me.name, state }
      return out
    }
    const out: Record<string, { id: string; name: string; state: ChatState }> = {}
    for (const [id, r] of remote) for (const [sid, state] of Object.entries(r.live)) out[sid] = { id, name: r.name, state }
    for (const [sid, state] of Object.entries(chats.states())) out[sid] = { id: me.id, name: me.name, state }
    return out
  }

  function elsewhere(): Record<string, ChatElsewhere> {
    const me = self().id
    return Object.fromEntries(
      Object.entries(whereAll())
        .filter(([, w]) => w.id !== me)
        .map(([sid, w]) => [sid, { pc: w.name, state: w.state }]),
    )
  }

  function lastAll(): Record<string, ChatLast> {
    const running = whereAll()
    if (mode() === 'member') return Object.fromEntries(Object.entries(replica.last).filter(([sid]) => !running[sid]))
    return Object.fromEntries([...held].filter(([sid, h]) => h.last && !running[sid]).map(([sid, h]) => [sid, h.last!]))
  }

  function teamInfo(): AgenticTeam | null {
    const m = mode()
    if (m === 'alone') return null
    if (m === 'hub') return { pc: self().name, role: 'hub', hub: null, reachable: true, pcs: pcs() }
    return { pc: self().name, role: 'member', hub: team!.hub()?.name ?? null, reachable: sub !== null, pcs: pcs() }
  }

  const emitWhere = () => emit({ t: 'where', elsewhere: elsewhere(), last: lastAll(), team: teamInfo() })
  const emitFloors = () => emit({ t: 'floors', floors: allFloors() })

  function hold(sid: string, who: { id: string; name: string }) {
    held.set(sid, { holder: who.id, holderName: who.name, heldAt: Date.now(), last: held.get(sid)?.last ?? null })
    saveHeld()
  }

  /** Lets a session go: what `who` held is free, and ran last there. */
  function release(sid: string, who: { id: string; name: string }) {
    const h = held.get(sid)
    if (h?.holder && h.holder !== who.id) return
    held.set(sid, { holder: null, holderName: null, heldAt: 0, last: { pc: who.name, at: new Date().toISOString() } })
    saveHeld()
    emitWhere()
    pushState()
  }

  /** Brings the hub's copy up to `want` (a member's, where the chat ran) when it isn't there already. */
  async function catchUpFrom(link: LinkPeer, sid: string, want: FileMark) {
    if (!want.bytes) return
    const file = fileOf(sid)
    if (markOf(file).bytes >= want.bytes && sameMark(markOf(file, want.bytes), want)) return
    await pullFrom(link, sid, file)
  }

  /** The hub: stops the session where it runs (here, or on a member, whose last bytes then come here). */
  async function stopAt(id: string, sid: string): Promise<void> {
    if (id === self().id) {
      chats.kill(sid)
      await endFlush(sid)
      release(sid, self())
      return
    }
    const link = team?.member(id) ?? null
    const name = remote.get(id)?.name ?? held.get(sid)?.holderName ?? id
    if (!link) {
      // Out of reach: it is let go, on the asker's say-so (the page warned it may split).
      log?.warn(`took chat ${sid.slice(0, 8)} from ${name}, which can't be reached`)
      release(sid, { id, name })
      return
    }
    const { mark } = await request<{ mark: FileMark }>(link, 'stop', { sessionId: sid }, 20_000)
    await catchUpFrom(link, sid, mark)
    release(sid, { id, name })
  }

  /** Stops a session's chat wherever it runs, not waiting (an agent taken off, a floor deleted). */
  function stopAnywhere(sid: string) {
    if (chats.info(sid)) {
      chats.kill(sid)
      return
    }
    const w = whereAll()[sid]
    if (w && mode() === 'hub') void stopAt(w.id, sid).catch(e => log?.warn(`couldn't stop chat ${sid.slice(0, 8)} on ${w.name}: ${message(e)}`))
  }

  /**
   * The hub: the session for `who`, taken over when it runs (or is held) elsewhere. Throws 409
   * when it is elsewhere and `takeOver` wasn't asked. Answers where it was taken from.
   */
  async function lease(sid: string, who: { id: string; name: string }, takeOver: boolean, agentName: string): Promise<string | undefined> {
    const there = whereAll()[sid]
    const h = held.get(sid)
    let from: { id: string; name: string } | null = null
    if (there && there.id !== who.id) from = { id: there.id, name: there.name }
    else if (h?.holder && h.holder !== who.id && (h.holder !== self().id || chats.info(sid))) {
      const reachable = h.holder === self().id || !!team?.member(h.holder)
      // Granted to a member that hasn't shown it running: starting, unless it is long past that.
      if (!reachable || Date.now() - h.heldAt < LEASE_GRACE_MS || remote.get(h.holder)?.live[sid]) from = { id: h.holder, name: h.holderName ?? h.holder }
    }
    if (from) {
      if (!takeOver) throw apiError(409, `${agentName}'s chat is running on ${from.name}. Take it over to run it here; it stops there first.`)
      await stopAt(from.id, sid)
    }
    hold(sid, who)
    return from?.name
  }

  // ---------------------------------------------------------------------------------------
  // F-021 on the hub: its members' standing streams

  let pushTimer: NodeJS.Timeout | null = null
  function pushState() {
    if (mode() !== 'hub' || !subs.size || pushTimer) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      const state = { t: 'state', floors: floors.list(), where: whereAll(), last: lastAll(), marks: marksHere() }
      for (const s of subs.values()) writeLine(s, state)
    }, 150)
    pushTimer.unref()
  }

  /** The marks of every floor session this PC has a copy of. */
  function marksHere(): Record<string, FileMark> {
    const out: Record<string, FileMark> = {}
    for (const f of allFloors())
      for (const a of f.agents) {
        if (!a.sessionId) continue
        const found = findTranscript(a.sessionId, projectsDir)
        if (found) out[a.sessionId] = markOf(found)
      }
    return out
  }

  /** Catch-up, one at a time: a copy brought up to the far end's in the background. */
  const pulling = new Set<string>()
  let pulls: Promise<void> = Promise.resolve()
  function backfill(link: LinkPeer, sid: string) {
    if (pulling.has(sid) || chats.info(sid)) return
    pulling.add(sid)
    pulls = pulls
      .then(async () => {
        // Started here meanwhile: this PC writes it now.
        if (chats.info(sid)) return
        const m = await pullFrom(link, sid, fileOf(sid))
        log?.info(`chat ${sid.slice(0, 8)}: copy brought up from ${link.name} (${m.bytes} bytes)`)
      })
      .catch(e => log?.warn(`couldn't bring chat ${sid.slice(0, 8)} up from ${link.name}: ${message(e)}`))
      .finally(() => pulling.delete(sid))
  }

  function onSubscribe(from: { id: string; name: string }, stream: Duplex) {
    subs.get(from.id)?.destroy()
    subs.set(from.id, stream)
    remote.set(from.id, { name: from.name, live: {} })
    log?.info(`${from.name} is following the floors`)
    const link = () => team?.member(from.id) ?? null
    readLines(stream, raw => {
      if (!isObject(raw) || subs.get(from.id) !== stream) return
      if ((raw.t === 'hello' || raw.t === 'live') && isObject(raw.live)) {
        const live = Object.fromEntries(Object.entries(raw.live).filter((e): e is [string, ChatState] => typeof e[1] === 'string'))
        remote.set(from.id, { name: from.name, live })
        // What it held and no longer runs (it stopped, or restarted): let go.
        for (const [sid, h] of held) if (h.holder === from.id && !live[sid] && Date.now() - h.heldAt > LEASE_GRACE_MS) release(sid, from)
        emitWhere()
        pushState()
      }
      if ((raw.t === 'hello' || raw.t === 'marks') && isObject(raw.marks)) {
        const l = link()
        for (const [sid, m] of Object.entries(raw.marks)) {
          if (!isMark(m) || chats.info(sid)) continue
          const h = held.get(sid)
          if (h?.holder && h.holder !== from.id) continue
          if (m.bytes > markOf(fileOf(sid)).bytes && l) backfill(l, sid)
        }
      }
      if (raw.t === 'jsonl' && typeof raw.sid === 'string' && typeof raw.from === 'number' && typeof raw.d === 'string') {
        // Only from the PC running it (or granted it, starting), and never into a copy this PC writes.
        if (chats.info(raw.sid) || (held.get(raw.sid)?.holder !== from.id && remote.get(from.id)?.live[raw.sid] === undefined)) return
        const data = Buffer.from(raw.d, 'base64')
        const r = appendAt(fileOf(raw.sid), raw.from, data)
        if (r === 'ok') {
          for (const [id, s] of subs) if (id !== from.id) writeLine(s, raw)
        } else {
          const l = link()
          if (l) backfill(l, raw.sid)
        }
      }
    })
    const gone = () => {
      if (subs.get(from.id) !== stream) return
      subs.delete(from.id)
      remote.delete(from.id)
      log?.info(`${from.name} stopped following the floors`)
      emitWhere()
      pushState()
    }
    stream.on('close', gone)
    stream.on('error', gone)
    pushState()
  }

  // ---------------------------------------------------------------------------------------
  // F-021 on a member: its standing stream to the hub, and what comes on it

  function needHub(): LinkPeer {
    const h = team?.hub()
    if (!h) throw apiError(409, 'This PC has no hub')
    if (!h.link || !sub) throw apiError(503, `${h.name} (the hub) can't be reached right now, so floors are read-only here and no chat can start. Chats running here go on.`)
    return h.link
  }

  function memberTick() {
    if (mode() !== 'member') {
      if (sub) dropSub()
      return
    }
    const link = team!.hub()?.link ?? null
    if (sub && (!link || sub.token !== link.token)) dropSub()
    if (!link || sub || subscribing) return
    subscribing = true
    link.open({ op: 'subscribe' }).then(
      stream => {
        subscribing = false
        sub = { token: link.token, stream }
        writeLine(stream, { t: 'hello', live: chats.states(), marks: marksHere() })
        readLines(stream, raw => onHubEvent(link, raw))
        const gone = () => {
          if (sub?.stream !== stream) return
          sub = null
          emitWhere()
        }
        stream.on('close', gone)
        stream.on('error', gone)
        log?.info(`following ${link.name}'s floors`)
        emitWhere()
      },
      (e: unknown) => {
        subscribing = false
        log?.debug(`couldn't follow ${link.name}'s floors yet: ${message(e)}`)
      },
    )
  }

  function dropSub() {
    const s = sub
    sub = null
    s?.stream.destroy()
    emitWhere()
  }

  function onHubEvent(link: LinkPeer, raw: unknown) {
    if (!isObject(raw)) return
    if (raw.t === 'state' && Array.isArray(raw.floors)) {
      replica = {
        floors: raw.floors as Floor[],
        where: isObject(raw.where) ? (raw.where as Replica['where']) : {},
        last: isObject(raw.last) ? (raw.last as Record<string, ChatLast>) : {},
        marks: isObject(raw.marks) ? (raw.marks as Record<string, FileMark>) : {},
      }
      saveReplica()
      emitFloors()
      emitWhere()
      // Every copy here brought up to the hub's, unless this PC runs it (then it writes it).
      for (const [sid, theirs] of Object.entries(replica.marks)) {
        if (!isMark(theirs) || chats.info(sid)) continue
        const mine = markOf(fileOf(sid))
        if (mine.bytes < theirs.bytes || (mine.bytes === theirs.bytes && mine.tail !== theirs.tail)) backfill(link, sid)
      }
    } else if (raw.t === 'jsonl' && typeof raw.sid === 'string' && typeof raw.from === 'number' && typeof raw.d === 'string') {
      if (chats.info(raw.sid)) return
      // A gap or a fork is left to catch-up.
      appendAt(fileOf(raw.sid), raw.from, Buffer.from(raw.d, 'base64'))
    } else if (raw.t === 'memory' && typeof raw.floorId === 'string') {
      emit({ t: 'memory', floorId: raw.floorId })
    } else if (raw.t === 'tasks') {
      // F-056: the hub's task list changed; this PC's page asks the hub for it again.
      emit({ t: 'tasks' })
    }
  }

  /** On a member: the agent's chat started here, the hub granting it (taken over from where it ran, when asked). */
  async function openOnMember(floorId: string, agentId: string, req: OpenChatRequest): Promise<ChatOpened> {
    const link = needHub()
    const floor = floorOf(floorId)
    const agent = agentOf(floor, agentId)
    let sid = agent.sessionId
    if (sid && chats.info(sid)) return { sessionId: sid, started: false, resumed: false }
    if (!sid) {
      sid = randomUUID()
      const r = await request<{ floor: Floor }>(link, 'http', { method: 'POST', rest: `/floors/${enc(floorId)}/agents/${enc(agentId)}/session`, body: { sessionId: sid } })
      replica.floors = replica.floors.map(f => (f.id === r.floor.id ? r.floor : f))
    }
    const granted = await request<{ mark: FileMark; tookOverFrom: string | null }>(link, 'lease', { sessionId: sid, takeOver: req.takeOver === true }, 45_000)
    try {
      // This PC's copy brought up to the hub's first, unless it already has all of it.
      const file = fileOf(sid)
      const mark = isMark(granted.mark) ? granted.mark : NO_FILE
      if (mark.bytes && !(markOf(file).bytes >= mark.bytes && sameMark(markOf(file, mark.bytes), mark))) await pullFrom(link, sid, file)
      const now = floorOf(floorId)
      const resumed = startHere(now, agentOf(now, agentId), sid, req)
      return { sessionId: sid, started: true, resumed, ...(granted.tookOverFrom ? { tookOverFrom: granted.tookOverFrom } : {}) }
    } catch (e) {
      void request(link, 'release', { sessionId: sid, mark: markOf(fileOf(sid)) }).catch(() => {})
      throw e
    }
  }

  const memberTimer = team ? setInterval(memberTick, 1000) : null
  memberTimer?.unref()
  const stateTimer = team
    ? setInterval(() => {
        if (mode() === 'hub') pushState()
        else if (mode() === 'member' && sub) writeLine(sub.stream, { t: 'marks', marks: marksHere() })
      }, STATE_EVERY_MS)
    : null
  stateTimer?.unref()
  if (team) setImmediate(memberTick)

  // ---------------------------------------------------------------------------------------
  // Opening an agent's chat

  /** Its chat, running here: started fresh, resumed from its transcript, taken over, or as it was. */
  async function openChat(floorId: string, agentId: string, req: OpenChatRequest): Promise<ChatOpened> {
    if (mode() === 'member') return openOnMember(floorId, agentId, req)
    let floor = floorOf(floorId)
    const agent = agentOf(floor, agentId)
    let sid = agent.sessionId
    if (sid && chats.info(sid)) return { sessionId: sid, started: false, resumed: false }
    if (!sid) {
      sid = randomUUID()
      floor = floors.bindSession(floor.id, agent.id, sid)
    }
    const tookOverFrom = mode() === 'hub' ? await lease(sid, self(), req.takeOver === true, agent.name) : undefined
    try {
      const now = floorOf(floorId)
      const resumed = startHere(now, agentOf(now, agentId), sid, req)
      return { sessionId: sid, started: true, resumed, ...(tookOverFrom ? { tookOverFrom } : {}) }
    } catch (e) {
      if (mode() === 'hub') release(sid, self())
      throw e
    }
  }

  /**
   * Claude subscription failover (agent/claude/failover.ts): the chat stopped and started again, its
   * conversation resumed, on the token in place now (chats.start reads it afresh). It is stopped
   * gently first: a chat sitting at its prompt is told /exit and ends itself, so no process is
   * killed; only one that has not ended after `restartGraceMs` is stopped the way the app stops one
   * (stopAt: chats.kill, its last write sent on, the session let go). Then it is opened the way
   * openChat opens it. A member PC does not: the hub holds the session, so it is restarted there.
   */
  async function restartChat(sid: string): Promise<boolean> {
    if (mode() === 'member') return false
    const at = floors.bySession(sid)
    if (!at || !chats.info(sid)) return false
    if (chats.info(sid)?.state === 'idle' && chats.type(sid, '/exit')) {
      const until = Date.now() + (o.restartGraceMs ?? 15_000)
      while (chats.info(sid) && Date.now() < until) await new Promise(r => setTimeout(r, 200))
    }
    await stopAt(self().id, sid)
    // Opened again the way F-058 brings chats back after a crash (resumeChat, below): one way to open a chat again.
    return await resumeChat(sid)
  }

  // ---------------------------------------------------------------------------------------
  // F-058: the chats that were open when the app stopped come back (recover.ts)

  async function resumeChat(sid: string, text?: string): Promise<boolean> {
    if (team?.role() === 'member') return false
    const at = floors.bySession(sid)
    if (!at) return false
    try {
      const opened = await openChat(at.floor.id, at.agent.id, {})
      if (opened.started && text) chats.typeWhenReady(sid, text)
      return opened.started || chats.info(sid) !== null
    } catch (e) {
      log?.warn(`couldn't reopen chat ${sid.slice(0, 8)}: ${message(e)}`)
      return false
    }
  }

  /** The chats open now, written down for the next start. */
  function noteOpen() {
    if (!recovery) return
    const open: Remembered[] = []
    for (const [sid, state] of Object.entries(chats.states())) {
      const info = chats.info(sid)
      if (info) open.push({ sessionId: sid, floorId: info.floorId, agentId: info.agentId, state })
    }
    recovery.note(open)
  }

  let resumeTimer: NodeJS.Timeout | null = null
  if (o.resumeChats && team?.role() !== 'member') {
    const mine = createRecovery(path.join(o.dir, 'open-chats.json'), { log })
    recovery = mine
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      void (async () => {
        const list = mine.pending
        if (list.length) log?.info(`recovery: reopening ${list.length} chat${list.length === 1 ? '' : 's'} that ${list.length === 1 ? 'was' : 'were'} open when the app stopped`)
        let n = 0
        for (const r of list) {
          if (closing) return
          if (chats.info(r.sessionId)) continue
          const carryOn = r.state === 'running' || r.state === 'question'
          const ok = await resumeChat(r.sessionId, carryOn ? CONTINUE_TEXT : undefined)
          log?.info(`recovery: chat ${r.sessionId.slice(0, 8)} ${ok ? `reopened${carryOn ? ', told to carry on' : ''}` : 'could not be reopened'}`)
          if (++n < list.length) await new Promise(res => setTimeout(res, o.resumeGapMs ?? 2000))
        }
        if (closing) return
        // The list is used: from now on it follows the chats.
        mine.arm()
        noteOpen()
      })()
    }, o.resumeAfterMs ?? 4000)
    resumeTimer.unref()
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
    const where = whereAll()
    const agents = floor.agents.map(a => {
      const live = a.sessionId ? where[a.sessionId] : undefined
      return {
        name: a.name,
        role: a.role,
        isBoss: a.isBoss,
        reportsTo: a.reportsTo ? (byId.get(a.reportsTo)?.name ?? null) : null,
        status: live ? 'online' : a.sessionId ? 'offline' : 'never opened',
        doing: live ? live.state : null,
        pc: live ? live.name : null,
        sessionId: live ? a.sessionId : null,
        isYou: a.id === me.id,
      }
    })
    const online = agents.filter(a => a.status === 'online').length
    return { floor: floor.name, total: agents.length, online, offline: agents.length - online, agents }
  }

  /** A running chat on the caller's floor (on any of the hub's PCs), by the id list_chats gave. */
  function siblingOf(floor: Floor, sid: unknown): { sessionId: string; id: string } {
    if (typeof sid !== 'string' || !sid) throw apiError(400, 'sessionId is missing')
    const w = whereAll()[sid]
    if (!w || bySession(sid)?.floor.id !== floor.id) throw apiError(404, `No running chat ${sid} on your floor; list_chats shows the ones there are`)
    return { sessionId: sid, id: w.id }
  }

  /** F-029: a running chat anywhere in the app (any floor, any PC). */
  function anyChat(sid: unknown): { sessionId: string; id: string } {
    if (typeof sid !== 'string' || !sid) throw apiError(400, 'sessionId is missing')
    const w = whereAll()[sid]
    if (!w) throw apiError(404, `No running chat ${sid}; app_chats shows which are running`)
    return { sessionId: sid, id: w.id }
  }

  /** F-029: an agent by its floor's and its own name (or ids). */
  function findAgent(floorRef: unknown, agentRef: unknown): { floor: Floor; agent: FloorAgent } {
    const want = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
    const fw = want(floorRef)
    const f = floors.list().find(x => x.id === floorRef || x.name.trim().toLowerCase() === fw)
    if (!f) throw apiError(404, `No floor called ${String(floorRef)}`)
    const aw = want(agentRef)
    const a = f.agents.find(x => x.id === agentRef || x.name.trim().toLowerCase() === aw)
    if (!a) throw apiError(404, `No agent called ${String(agentRef)} on ${f.name}`)
    return { floor: f, agent: a }
  }

  async function readChat(c: { sessionId: string; id: string }, lines: number): Promise<string> {
    if (c.id === self().id) return chats.read(c.sessionId, lines) ?? ''
    const link = team?.member(c.id)
    if (!link) throw apiError(409, "That chat's PC can't be reached right now")
    return request<string>(link, 'read', { sessionId: c.sessionId, lines })
  }

  async function typeInto(c: { sessionId: string; id: string }, body: string): Promise<boolean> {
    if (c.id === self().id) return chats.type(c.sessionId, body)
    const link = team?.member(c.id)
    if (!link) return false
    return request<boolean>(link, 'type', { sessionId: c.sessionId, text: body }).catch(() => false)
  }

  async function callTool(key: string, name: string, rawArgs: unknown): Promise<string> {
    const me = chats.byKey(key)
    if (!me) throw apiError(401, "This chat's key isn't known: its terminal was closed or the agent restarted. Open the chat from the floor again.")
    if (mode() === 'member') return request<string>(needHub(), 'tool', { sessionId: me.sessionId, name, arguments: rawArgs })
    return toolFor(me.sessionId, name, rawArgs)
  }

  /** A tool call from the chat `sid` (running here, or on a member that passed it on). */
  async function toolFor(sid: string, name: string, rawArgs: unknown): Promise<string> {
    const mine = floors.bySession(sid)
    if (!mine) throw apiError(409, "This chat isn't an agent on a floor any more.")
    const { floor, agent } = mine
    const args = isObject(rawArgs) ? rawArgs : {}
    const tag = `${agent.name}, chat ${sid.slice(0, 8)}`

    switch (name) {
      // F-029: the whole app.
      case 'app_chats': {
        const where = whereAll()
        const last = lastAll()
        const rows = floors.list().flatMap(f =>
          f.agents.map(a => {
            const w = a.sessionId ? where[a.sessionId] : undefined
            return {
              floor: f.name,
              agent: a.name,
              role: a.role,
              isBoss: a.isBoss,
              sessionId: a.sessionId,
              status: w ? 'running' : a.sessionId ? 'not running' : 'never opened',
              doing: w?.state ?? null,
              pc: w?.name ?? null,
              lastOn: !w && a.sessionId ? (last[a.sessionId]?.pc ?? null) : null,
              isYou: a.sessionId === sid,
            }
          }),
        )
        return json({ you: `${agent.name} on ${floor.name}`, pcs: pcs().map(p => p.name), chats: rows })
      }
      case 'app_read_chat': {
        const target = anyChat(args.sessionId)
        return readChat(target, typeof args.lines === 'number' ? Math.min(500, args.lines) : 100)
      }
      case 'app_read_conversation': {
        if (typeof args.sessionId !== 'string' || !args.sessionId) throw apiError(400, 'sessionId is missing')
        const file = findTranscript(args.sessionId, projectsDir)
        if (!file) throw apiError(404, `There is no conversation ${args.sessionId} on the hub`)
        const n = typeof args.last === 'number' ? Math.max(1, Math.min(200, args.last)) : 20
        return json(readTranscriptFile(file).slice(-n).map(m => ({ role: m.role, at: m.timestamp, text: m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text, tools: m.tools })))
      }
      case 'app_send_to_chat': {
        const target = anyChat(args.sessionId)
        if (target.sessionId === sid) throw apiError(400, "That's your own chat")
        const body = text(args.text, 'text')
        relayAllowed(sid, target.sessionId)
        if (!(await typeInto(target, `[message from ${agent.name} on ${floor.name}, chat ${sid.slice(0, 8)}] ${body}`))) throw apiError(409, 'That chat stopped before the message reached it')
        log?.info(`${agent.name} → chat ${target.sessionId.slice(0, 8)} (another floor or PC): a message`)
        return `Sent to chat ${target.sessionId}.`
      }
      case 'app_open_chat': {
        const { floor: f, agent: a } = findAgent(args.floor, args.agent)
        const pcName = typeof args.pc === 'string' && args.pc.trim() ? args.pc.trim().toLowerCase() : null
        const pc = pcName ? pcs().find(p => p.name.toLowerCase() === pcName || p.id === args.pc) : null
        if (pcName && !pc) throw apiError(404, `No PC called ${String(args.pc)} within reach; app_chats lists them`)
        const opened =
          pc && !pc.here
            ? await request<ChatOpened>(peerOf(pc.id), 'open', { floorId: f.id, agentId: a.id }, 60_000)
            : await openChat(f.id, a.id, { takeOver: args.takeOver === true })
        return json({ ...opened, agent: a.name, floor: f.name, pc: pc?.name ?? self().name })
      }
      case 'app_set_effort': {
        // F-049: kept on the agent (its chat starts with --effort every time) and, when its chat
        // is running and waiting, typed into it as /effort, which sets this session's at once.
        const { floor: f, agent: a } = findAgent(args.floor, args.agent)
        const raw = typeof args.level === 'string' ? args.level.trim().toLowerCase() : ''
        const level = (raw === 'default' ? '' : raw) as AgentEffort
        if (!(AGENT_EFFORTS as readonly string[]).includes(level)) throw apiError(400, 'level is low, medium, high, xhigh, max, or default')
        floors.patch(f.id, { agents: f.agents.map(x => (x.id === a.id ? { ...x, effort: level } : x)) })
        const w = a.sessionId ? whereAll()[a.sessionId] : undefined
        const kept = level ? `${a.name} on ${f.name} starts on ${level} effort from now on` : `${a.name} on ${f.name} starts on the CLI's own effort from now on`
        if (!w || !a.sessionId) return `${kept}; its chat isn't running, so that is when it next starts.`
        if (!level) return `${kept}; its running chat keeps the effort it has until it starts again.`
        if (a.sessionId === sid) return `${kept}. This is your own chat: it keeps its effort until it starts again (type /effort ${level} in it to change it now).`
        if (w.state === 'running') return `${kept}. Its chat is working right now, so it keeps its effort until it starts again; ask again once it is waiting to set it at once.`
        if (!(await typeInto({ sessionId: a.sessionId, id: w.id }, `/effort ${level}`))) return `${kept}; its chat stopped before it could be set now.`
        log?.info(`${agent.name} set ${a.name}'s effort to ${level}`)
        return `${kept}, and its running chat (on ${w.name}) is on ${level} now: /effort ${level} was typed into it.`
      }
      case 'app_stop_chat': {
        const target = anyChat(args.sessionId)
        if (target.sessionId === sid) throw apiError(400, "That's your own chat")
        stopAnywhere(target.sessionId)
        return `Stopping chat ${target.sessionId}.`
      }
      case 'list_chats': {
        const byId = new Map(floor.agents.map(a => [a.id, a]))
        const others = Object.entries(whereAll())
          .filter(([s]) => s !== sid)
          .map(([s, w]) => ({ s, w, at: floors.bySession(s) }))
          .filter(x => x.at?.floor.id === floor.id)
          .map(({ s, w, at }) => ({ sessionId: s, agent: at!.agent.name, role: byId.get(at!.agent.id)?.role ?? '', doing: w.state, pc: w.name }))
        return json({ floor: floor.name, you: agent.name, chats: others })
      }
      case 'floor_roster':
        return json(rosterOf(floor, agent))
      case 'read_chat': {
        const c = siblingOf(floor, args.sessionId)
        return readChat(c, typeof args.lines === 'number' ? args.lines : 100)
      }
      case 'send_to_chat': {
        const c = siblingOf(floor, args.sessionId)
        if (c.sessionId === sid) throw apiError(400, "That's your own chat")
        const body = text(args.text, 'text')
        relayAllowed(sid, c.sessionId)
        if (!(await typeInto(c, `[message from ${tag}] ${body}`))) throw apiError(409, 'That chat stopped before the message reached it')
        log?.info(`${agent.name} → chat ${c.sessionId.slice(0, 8)}: a message`)
        return `Sent to chat ${c.sessionId}.`
      }
      case 'broadcast_to_chats': {
        const body = text(args.text, 'text')
        const t = Date.now()
        if (t - (broadcastLast.get(floor.id) ?? 0) < BROADCAST_COOLDOWN_MS) throw apiError(429, 'This floor just had a broadcast; wait a few seconds.')
        broadcastLast.set(floor.id, t)
        const to = Object.entries(whereAll())
          .filter(([s]) => s !== sid && floors.bySession(s)?.floor.id === floor.id)
          .map(([s, w]) => ({ sessionId: s, id: w.id }))
        await Promise.all(to.map(c => typeInto(c, `[broadcast from ${tag}] ${body}`)))
        return `Sent to ${to.length} chat${to.length === 1 ? '' : 's'}.`
      }
      case 'memory_save': {
        const entry = memory.save(floor.id, {
          text: text(args.text, 'text'),
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          sessionId: sid,
          authorName: agent.name,
        })
        memoryChanged(floor.id)
        return json({ saved: entry.id })
      }
      case 'memory_search': {
        const query = typeof args.query === 'string' ? args.query : ''
        const limit = typeof args.limit === 'number' ? args.limit : 10
        const entries = memory.search(floor.id, query, limit)
        // F-051: the floor's notes by keyword as before, and hits from all of the memory beside
        // them once the layer is switched on (until then, the answer is exactly as it was).
        if (args.mode === 'keyword' || !memoryOn) return json({ entries })
        const hits = query.trim() ? await (await memoryLayer()).search(query, { limit, excludeSession: sid }) : []
        return json({ entries, hits })
      }
      case 'memory_recent':
        return json({ entries: memory.recent(floor.id, typeof args.limit === 'number' ? args.limit : 10) })
      case 'memory_read':
        if (!memoryOn) throw apiError(409, "The app's memory (F-051) isn't switched on yet; memory_search finds the floor's notes.")
        return (await memoryLayer()).read(typeof args.ref === 'string' ? args.ref : '')
      // F-051: not a tool the chats see: a member's /mcp/recall, passed to the hub (or this PC's own).
      case 'memory_recall':
        return memoryOn ? (await memoryLayer()).recall({ sessionId: sid, prompt: typeof args.prompt === 'string' ? args.prompt : '' }) : ''
      // F-056: the app's one task list (the Tasks tab), for every chat.
      case 'task_add': {
        const body = taskText(args.text)
        // The same task added twice within minutes (a retry, a chat repeating itself) is the one that is there.
        const same = (await tasks.list({ status: 'open', limit: 100 })).find(t => t.text === body && Date.now() - Date.parse(t.createdAt) < 10 * 60_000)
        if (same) return json({ id: same.id, note: 'That task is already on the list.' })
        const task = await tasks.add({ text: body, by: { kind: 'agent', name: agent.name, floor: floor.name } })
        return json({ added: task.id, text: task.text })
      }
      case 'task_list': {
        const s = args.status
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 30
        const list = await tasks.list({ status: s === 'done' || s === 'all' ? s : 'open', query: typeof args.query === 'string' ? args.query : undefined, limit })
        return json({
          tasks: list.map(t => ({ id: t.id, text: t.text, done: t.done, added: t.createdAt, by: t.by.kind === 'agent' ? `${t.by.name ?? 'an agent'}${t.by.floor ? ` on ${t.by.floor}` : ''}` : 'Shubham' })),
          counts: await tasks.counts(),
        })
      }
      case 'task_update': {
        const id = typeof args.id === 'string' ? args.id : ''
        if (!id) throw apiError(400, 'id is missing: task_list gives it')
        const patch = taskPatch({
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.done !== undefined ? { done: args.done } : {}),
          ...(args.delete === true ? { deleted: true } : {}),
        })
        const task = await tasks.update(id, patch)
        return json({ id: task.id, text: task.text, done: task.done, deleted: task.deletedAt !== null })
      }
      case 'agent_hire': {
        if (!agent.isBoss) throw apiError(403, "Only the floor's boss can hire; ask them.")
        const model = args.model
        if (model !== undefined && !(AGENT_MODELS as readonly unknown[]).includes(model)) throw apiError(400, 'model is opus, sonnet or haiku')
        // F-049: hired onto an effort, as on a model.
        const effort = args.effort
        if (effort !== undefined && !(AGENT_EFFORTS as readonly unknown[]).includes(effort)) throw apiError(400, 'effort is low, medium, high, xhigh or max')
        const { agent: hired, floor: after } = floors.addAgent(floor.id, {
          name: typeof args.name === 'string' ? args.name : '',
          role: typeof args.role === 'string' ? args.role : '',
          md: typeof args.md === 'string' ? args.md : undefined,
          reportsTo: typeof args.reportsTo === 'string' && args.reportsTo.trim() ? args.reportsTo : agent.id,
          model: model as AgentModel | undefined,
          effort: effort as AgentEffort | undefined,
        })
        log?.info(`${agent.name} hired ${hired.name} on ${floor.name}`)
        return json({ hired: hired.name, role: hired.role, effort: hired.effort || 'inherit', total: after.agents.length, note: 'No chat is started yet; the human opens it from the floor.' })
      }
      default:
        throw apiError(404, `No tool called ${name}`)
    }
  }

  /** F-056: the task list changed: every page here, and every member's, is told to ask for it again. */
  function tasksChanged() {
    emit({ t: 'tasks' })
    for (const s of subs.values()) writeLine(s, { t: 'tasks' })
  }

  /** F-056: the list the Tasks tab shows (also what the chats' task_list reads). */
  async function answerTasks(query: URLSearchParams): Promise<TasksAnswer> {
    const s = query.get('status')
    const status: TaskStatus = s === 'open' || s === 'done' ? s : 'all'
    const limit = Number(query.get('limit'))
    return { tasks: await tasks.list({ status, query: query.get('q') ?? undefined, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined }), counts: await tasks.counts() }
  }

  /**
   * F-054: the CRM's address and what this PC found when it asked that site, kept 30 seconds
   * (`fresh` asks again). `origin` is the page's own, to read a frame-ancestors list against.
   */
  async function answerCrm(query: URLSearchParams, fresh = false): Promise<CrmAnswer> {
    const { url, mode } = crm.get()
    // Built into the page, there is no site to look at: the address matters only for the frame.
    if (!url || mode !== 'frame') return { mode, url, check: null }
    let app: string | null = null
    try {
      const u = new URL(query.get('origin') ?? '')
      if (u.protocol === 'https:' || u.protocol === 'http:') app = u.origin
    } catch {
      // No origin, or not one: the list can only be judged without it.
    }
    const now = Date.now()
    if (!fresh && crmChecked && crmChecked.url === url && crmChecked.app === app && now - crmChecked.at < 30_000) return { mode, url, check: crmChecked.check }
    const check = await checkCrm(url, { app })
    crmChecked = { url, app, at: now, check }
    return { mode, url, check }
  }

  function memoryChanged(floorId: string) {
    emit({ t: 'memory', floorId })
    for (const s of subs.values()) writeLine(s, { t: 'memory', floorId })
    // F-051: searched at once (once the layer has started).
    layer.notesChanged(floorId)
  }

  // ---------------------------------------------------------------------------------------
  // The page's routes

  function answerFloors(): FloorsAnswer {
    return { floors: allFloors(), live: chats.states(), elsewhere: elsewhere(), last: lastAll(), team: teamInfo(), defaultCodeDir }
  }

  function patchFloor(id: string, body: unknown) {
    if (!isObject(body)) throw apiError(400, 'Expected {name?, globalPrompt?, codeDir?, agents?}')
    const before = floorOf(id)
    if (typeof body.codeDir === 'string' && body.codeDir.trim()) checkFolder(body.codeDir)
    const floor = floors.patch(id, body as FloorPatch)
    // An agent taken off the floor takes its running chat with it, wherever it runs.
    const kept = new Set(floor.agents.map(a => a.id))
    for (const a of before.agents) if (!kept.has(a.id) && a.sessionId) stopAnywhere(a.sessionId)
    return { floor }
  }

  function checkFolder(raw: string) {
    const dir = raw.trim()
    if (!path.isAbsolute(dir)) throw apiError(400, 'Give the folder as a full path, like C:\\Users\\you\\code')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw apiError(400, `There is no folder ${dir}${mode() === 'member' ? ' on this PC' : ''}`)
  }

  // ---------------------------------------------------------------------------------------
  // F-022: Claude conversations on the hub's other PCs: listed, brought onto a floor, copied here

  /** Which PC each conversation copied here came from (origins.json); one not in it is this PC's own. */
  const originsFile = path.join(o.dir, 'origins.json')
  const origins = new Map<string, string>(Object.entries(readJson(originsFile)).filter((e): e is [string, string] => typeof e[1] === 'string'))
  let originsTimer: NodeJS.Timeout | null = null
  function setOrigin(sid: string, pc: string) {
    if (origins.get(sid) === pc) return
    origins.set(sid, pc)
    if (originsTimer) return
    originsTimer = setTimeout(() => {
      originsTimer = null
      writeAtomic(originsFile, `${json(Object.fromEntries(origins))}\n`)
    }, 1000)
    originsTimer.unref()
  }

  /** The PCs whose conversations this one can reach now: itself, and those linked (the hub's members, or a member's hub). */
  function pcs(): { id: string; name: string; here: boolean }[] {
    const me = self()
    const out = [{ ...me, here: true }]
    if (mode() === 'hub') for (const [id, r] of remote) out.push({ id, name: r.name, here: false })
    else if (mode() === 'member' && sub) {
      const h = team!.hub()
      if (h) out.push({ id: h.id, name: h.name, here: false })
    }
    return out
  }

  /** The link to another PC of the hub's, by id. */
  function peerOf(pc: string): LinkPeer {
    const link = mode() === 'hub' ? team?.member(pc) : mode() === 'member' && team?.hub()?.id === pc ? (team.hub()?.link ?? null) : null
    if (!link) throw apiError(503, "That PC can't be reached right now")
    return link
  }

  const pageOf = (q: URLSearchParams | Record<string, unknown>) => {
    const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : typeof q[k] === 'string' || typeof q[k] === 'number' ? String(q[k]) : null)
    return { q: get('q') ?? '', limit: Number(get('limit')) || 60, offset: Number(get('offset')) || 0 }
  }

  /** This PC's own conversations, each saying which PC it belongs to (its own, or the one it was copied from). */
  async function ownSessions(page: { q: string; limit: number; offset: number }) {
    const found = await listSessions(projectsDir, page)
    return { sessions: found.sessions.map(x => ({ ...x, pc: origins.get(x.sessionId) ?? self().name })), total: found.total }
  }

  /** This PC's (or, with `pc`, another's) Claude Code conversations, each with the agent here it already is, if any. */
  async function sessions(query: URLSearchParams) {
    const pc = query.get('pc')
    const page = pageOf(query)
    const there = pc && pc !== self().id
    const found = there ? await request<{ sessions: Omit<ClaudeSession, 'agent'>[]; total: number }>(peerOf(pc), 'sessions', page, 60_000) : await ownSessions(page)
    const bound = new Map<string, ClaudeSession['agent']>()
    if (!there) for (const f of allFloors()) for (const a of f.agents) if (a.sessionId) bound.set(a.sessionId, { floorId: f.id, floorName: f.name, agentId: a.id, name: a.name })
    const copied = new Set(there ? found.sessions.filter(x => findTranscript(x.sessionId, projectsDir)).map(x => x.sessionId) : [])
    return {
      sessions: found.sessions.map(x => ({ ...x, agent: bound.get(x.sessionId) ?? null, ...(there ? { here: copied.has(x.sessionId) } : {}) })),
      total: found.total,
      pcs: pcs(),
    }
  }

  /** Another PC's conversation, brought here (into the same project folder name) or brought up to date. */
  async function fetchFrom(pc: string, sid: string): Promise<string> {
    const link = peerOf(pc)
    const [one] = (await request<{ files: SessionFile[] }>(link, 'session-files', { sessionId: sid })).files
    if (!one) throw apiError(404, `${link.name} has no conversation ${sid}`)
    const file = findTranscript(sid, projectsDir) ?? path.join(projectsDir, one.dir, `${sid}.jsonl`)
    if (markOf(file).bytes < one.bytes) await pullFrom(link, sid, file)
    setOrigin(sid, link.name)
    return file
  }

  /** Copy all: every conversation on another PC that this one hasn't got (or has less of), one at a time. */
  let copyAll: CopyAllState | null = null
  function startCopyAll(pc: string): CopyAllState {
    if (copyAll?.state === 'running') throw apiError(409, `Already copying from ${copyAll.pc}`)
    const link = peerOf(pc)
    const job: CopyAllState = { pc: link.name, state: 'running', total: 0, done: 0, copied: 0, bytes: 0, error: null, startedAt: new Date().toISOString() }
    copyAll = job
    void (async () => {
      try {
        const { files } = await request<{ files: SessionFile[] }>(link, 'session-files', {}, 120_000)
        job.total = files.length
        for (const f of files) {
          if (!chats.info(f.sessionId)) {
            const mine = findTranscript(f.sessionId, projectsDir)
            const file = mine ?? path.join(projectsDir, f.dir, `${f.sessionId}.jsonl`)
            const had = markOf(file).bytes
            if (had < f.bytes) {
              try {
                const m = await pullFrom(peerOf(pc), f.sessionId, file)
                job.copied++
                job.bytes += Math.max(0, m.bytes - had)
                // A floor's session (F-021) is every PC's; any other first came from there.
                if (!mine && !bySession(f.sessionId)) setOrigin(f.sessionId, link.name)
              } catch (e) {
                log?.warn(`copy all from ${link.name}: ${f.sessionId.slice(0, 8)} not copied: ${message(e)}`)
              }
            }
          }
          job.done++
        }
        job.state = 'done'
        log?.info(`copied ${job.copied} of ${job.total} conversations from ${link.name} (${Math.round(job.bytes / 1e6)} MB)`)
      } catch (e) {
        job.state = 'failed'
        job.error = message(e)
      }
    })()
    return job
  }

  /** A copy of a conversation becomes an agent's chat (transcripts.ts says why a copy): a new agent's, or the one named's. */
  async function importChat(floorId: string, body: unknown): Promise<ChatImported> {
    if (!isObject(body) || typeof body.sessionId !== 'string' || !UUID_RE.test(body.sessionId)) throw apiError(400, 'Expected {sessionId, agentId?, name?, role?}')
    const from = body.sessionId
    const intoId = typeof body.agentId === 'string' && body.agentId ? body.agentId : null
    const floor = floorOf(floorId)
    if (intoId) agentOf(floor, intoId)
    const link = mode() === 'member' ? needHub() : null
    // F-022: from another PC: brought here first.
    const pc = typeof body.pc === 'string' && body.pc && body.pc !== self().id ? body.pc : null
    if (pc) await fetchFrom(pc, from)
    let cwd = findTranscriptCwd(from, projectsDir)
    let intoDir: string | undefined
    if (!cwd || !existsSync(cwd)) {
      // Held in a folder this PC hasn't got (one copied from another PC): its copy goes under the floor's folder here.
      if (!cwd && !findTranscript(from, projectsDir)) throw apiError(404, `There is no conversation ${from} on this PC`)
      if (cwd && !origins.has(from) && !pc) throw apiError(409, `That conversation was held in ${cwd}, which isn't there any more`)
      cwd = codeDirOf(floor)
      intoDir = path.join(projectsDir, encodeProjectPath(cwd))
    }
    const sid = randomUUID()
    let copy: string
    try {
      copy = (await copyTranscript(from, sid, projectsDir, intoDir)).file
    } catch (e) {
      throw apiError(500, `Couldn't copy that conversation: ${message(e)}`)
    }
    try {
      let agentId = intoId
      let after: Floor
      const name = typeof body.name === 'string' ? body.name : ''
      const role = typeof body.role === 'string' ? body.role.trim() : ''
      if (link) {
        // The hub keeps the floors: it seats the copy, and then brings its own copy over (marks).
        if (!agentId) agentId = (await request<{ agent: FloorAgent }>(link, 'http', { method: 'POST', rest: `/floors/${enc(floorId)}/agents`, body: { name, role } })).agent.id
        after = (await request<{ floor: Floor }>(link, 'http', { method: 'POST', rest: `/floors/${enc(floorId)}/agents/${enc(agentId)}/session`, body: { sessionId: sid } })).floor
        replica.floors = replica.floors.map(f => (f.id === after.id ? after : f))
        if (sub) writeLine(sub.stream, { t: 'marks', marks: { [sid]: markOf(copy) } })
        after = floorOf(floorId)
      } else {
        // Looked up again: the floor may have changed while it copied.
        if (agentId) {
          const before = agentOf(floorOf(floorId), agentId).sessionId
          if (before) stopAnywhere(before)
        } else agentId = floors.addAgent(floorId, { name, role }).agent.id
        after = floors.bindSession(floorId, agentId, sid)
      }
      const agent = agentOf(after, agentId)
      log?.info(`brought a copy of conversation ${from.slice(0, 8)} onto ${after.name} as ${agent.name}'s chat (${sid.slice(0, 8)})`)
      return { floor: after, agent, sessionId: sid, cwd }
    } catch (e) {
      rmSync(copy, { force: true })
      throw e
    }
  }

  const openRequest = (b: unknown): OpenChatRequest => {
    const r = isObject(b) ? b : {}
    return { cols: typeof r.cols === 'number' ? r.cols : undefined, rows: typeof r.rows === 'number' ? r.rows : undefined, takeOver: r.takeOver === true }
  }

  type Handler = (m: string[], r: MountRequest) => unknown
  /** `local`: a member answers it itself; the rest it passes to its hub, which keeps the floors. */
  const routes: [string, RegExp, Handler, 'local'?][] = [
    ['GET', /^\/floors$/, () => answerFloors(), 'local'],
    ['GET', /^\/sessions$/, (_, r) => sessions(r.query), 'local'],
    ['GET', /^\/sessions\/copy-all$/, () => ({ job: copyAll }), 'local'],
    [
      'POST',
      /^\/sessions\/copy-all$/,
      (_, r) => {
        if (!isObject(r.body) || typeof r.body.pc !== 'string') throw apiError(400, 'Expected {pc}')
        return { job: startCopyAll(r.body.pc) }
      },
      'local',
    ],
    ['POST', /^\/floors$/, (_, r) => ({ floor: floors.create(isObject(r.body) && typeof r.body.name === 'string' ? r.body.name : undefined) })],
    [
      'POST',
      /^\/floors\/reorder$/,
      (_, r) => {
        if (!isObject(r.body) || !Array.isArray(r.body.order) || r.body.order.some(x => typeof x !== 'string')) throw apiError(400, 'Expected {order: [floor ids]}')
        return { floors: floors.reorder(r.body.order as string[]) }
      },
    ],
    ['PATCH', /^\/floors\/([^/]+)$/, ([id], r) => patchFloor(id, r.body)],
    [
      'DELETE',
      /^\/floors\/([^/]+)$/,
      ([id]) => {
        const f = floorOf(id)
        for (const a of f.agents) if (a.sessionId) stopAnywhere(a.sessionId)
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
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/move$/,
      ([id, agentId], r) => {
        // F-033: dragged: reordered on its floor, or onto another (its chat goes on as it is).
        const b = isObject(r.body) ? r.body : {}
        const to = typeof b.floorId === 'string' && b.floorId ? b.floorId : id
        return floors.moveAgent(id, agentId, to, typeof b.before === 'string' ? b.before : null)
      },
    ],
    ['POST', /^\/floors\/([^/]+)\/import$/, ([id], r) => importChat(id, r.body), 'local'],
    ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/chat$/, ([id, agentId], r) => openChat(id, agentId, openRequest(r.body)), 'local'],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/run-on$/,
      async ([id, agentId], r) => {
        // F-025, Run on: the chat moved to the PC named (taken over there, from wherever it runs).
        const pc = isObject(r.body) && typeof r.body.pc === 'string' ? r.body.pc : ''
        if (!pc || pc === self().id) return openChat(id, agentId, { takeOver: true })
        const link = peerOf(pc)
        return { ...(await request<ChatOpened>(link, 'open', { floorId: id, agentId }, 60_000)), on: link.name }
      },
      'local',
    ],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/terminate$/,
      ([id, agentId]) => {
        const a = agentOf(floorOf(id), agentId)
        if (!a.sessionId) return { killed: false }
        if (chats.info(a.sessionId)) return { killed: chats.kill(a.sessionId) }
        const running = !!whereAll()[a.sessionId]
        stopAnywhere(a.sessionId)
        return { killed: running }
      },
    ],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/restart$/,
      async ([id, agentId]) => {
        // Claude subscription failover: this agent's chat, running on the hub, stopped gently (told /exit) and started
        // again on the token in place now, its conversation resumed (restartChat above). A member's call goes to the hub.
        const a = agentOf(floorOf(id), agentId)
        if (!a.sessionId || !chats.info(a.sessionId)) return { sessionId: a.sessionId, restarted: false }
        return { sessionId: a.sessionId, restarted: await restartChat(a.sessionId) }
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
        if (a.sessionId && a.sessionId !== next) stopAnywhere(a.sessionId)
        const after = floors.bindSession(id, agentId, next || null)
        return { floor: after, hasTranscript: next ? !!findTranscript(next, projectsDir) : false }
      },
    ],
    [
      'GET',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/messages$/,
      ([id, agentId]) => {
        const a = agentOf(floorOf(id), agentId)
        if (!a.sessionId) return { sessionId: null, messages: [] }
        const file = findTranscript(a.sessionId, projectsDir)
        return { sessionId: a.sessionId, messages: file ? readTranscriptFile(file) : [] }
      },
      'local',
    ],
    [
      'GET',
      /^\/floors\/([^/]+)\/transcripts$/,
      ([id]) => {
        const out: Record<string, { exists: boolean; bytes: number }> = {}
        for (const a of floorOf(id).agents) {
          if (!a.sessionId) continue
          const file = findTranscript(a.sessionId, projectsDir)
          out[a.id] = file ? { exists: true, bytes: statSync(file).size } : { exists: false, bytes: 0 }
        }
        return { transcripts: out }
      },
      'local',
    ],
    // F-056: the task list. The hub keeps it, so a member passes these on (no `local`), like the floors.
    ['GET', /^\/tasks$/, (_, r) => answerTasks(r.query)],
    [
      'POST',
      /^\/tasks$/,
      async (_, r) => {
        const body = isObject(r.body) ? r.body : {}
        return { task: await tasks.add({ text: taskText(body.text), id: taskId(body.id), by: { kind: 'you', name: null, floor: null } }) }
      },
    ],
    ['PATCH', /^\/tasks\/([^/]+)$/, async ([id], r) => ({ task: await tasks.update(id, taskPatch(r.body)) })],
    ['DELETE', /^\/tasks\/([^/]+)$/, async ([id]) => ({ task: await tasks.update(id, { deleted: true }) })],
    // F-054: where the CRM's website is, and whether it can be shown. The hub keeps it; a member passes these on.
    ['GET', /^\/crm$/, (_, r) => answerCrm(r.query, r.query.get('fresh') === '1')],
    [
      'PATCH',
      /^\/crm$/,
      async (_, r) => {
        if (!isObject(r.body) || (!('url' in r.body) && !('mode' in r.body))) throw apiError(400, 'Expected {url?, mode?}')
        crm.set({
          ...('url' in r.body ? { url: crmAddress(r.body.url) } : {}),
          ...('mode' in r.body ? { mode: crmMode(r.body.mode) } : {}),
        })
        crmChecked = null
        return answerCrm(r.query, true)
      },
    ],
    // Whether the CRM is signed in on THIS PC (the session is per PC, as Devices signs in): never the session itself.
    ['GET', /^\/crm\/session$/, (): CrmSessionInfo => crmProxy.session(), 'local'],
    // F-050: the chat view. History pages and previews read this PC's copy of a conversation.
    [
      'GET',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/chat$/,
      ([id, agentId], r) => {
        const a = agentOf(floorOf(id), agentId)
        const before = Number(r.query.get('before'))
        if (!a.sessionId || !Number.isFinite(before)) return { items: [], before: null }
        return chatFeeds.history(a.sessionId, before, Number(r.query.get('limit')) || undefined)
      },
      'local',
    ],
    [
      'GET',
      /^\/previews$/,
      (): PreviewsAnswer => {
        const previews: PreviewsAnswer['previews'] = {}
        for (const f of allFloors()) {
          for (const a of f.agents) {
            const p = a.sessionId ? chatFeeds.preview(a.sessionId) : null
            if (p) previews[a.id] = p
          }
        }
        return { previews }
      },
      'local',
    ],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/say$/,
      async ([id, agentId], r): Promise<SayAnswer> => {
        // A message typed to the agent the way the terminal does it (a paste, then Enter); a chat
        // that isn't running is started or picked back up first, and the message follows once it is ready.
        const body = text(isObject(r.body) ? r.body.text : undefined, 'text', MAX_SAY_TEXT)
        const agent = agentOf(floorOf(id), agentId)
        const at = agent.sessionId ? whereAll()[agent.sessionId] : undefined
        if (agent.sessionId && at) {
          const fresh = at.id === self().id && Date.now() - Date.parse(chats.info(agent.sessionId)?.startedAt ?? '') < SAY_FRESH_MS
          // Just started, it may still be at claude's own questions (trust this folder...): wait for the prompt.
          if (fresh) chats.typeWhenReady(agent.sessionId, body)
          else if (!(await typeInto({ sessionId: agent.sessionId, id: at.id }, body))) throw apiError(409, `${agent.name}'s chat on ${at.name} can't be typed into right now`)
          return { ok: true, started: false }
        }
        const opened = await openChat(id, agentId, {})
        chats.typeWhenReady(opened.sessionId, body)
        return { ok: true, started: true }
      },
      'local',
    ],
    ['GET', /^\/floors\/([^/]+)\/memory$/, ([id], r) => ({ entries: memory.search(floorOf(id).id, r.query.get('q') ?? '', 100) })],
    [
      'POST',
      /^\/floors\/([^/]+)\/memory$/,
      ([id], r) => {
        const b = isObject(r.body) ? r.body : {}
        const entry = memory.save(floorOf(id).id, { text: text(b.text, 'text', 4000), tags: Array.isArray(b.tags) ? (b.tags as string[]) : [] })
        memoryChanged(id)
        return { entry }
      },
    ],
    [
      'PATCH',
      /^\/floors\/([^/]+)\/memory\/([^/]+)$/,
      ([id, noteId], r) => {
        const b = isObject(r.body) ? r.body : {}
        const entry = memory.edit(floorOf(id).id, noteId, text(b.text, 'text', 4000))
        memoryChanged(id)
        return { entry }
      },
    ],
    [
      'DELETE',
      /^\/floors\/([^/]+)\/memory\/([^/]+)$/,
      ([id, noteId]) => {
        if (!memory.remove(floorOf(id).id, noteId)) throw apiError(404, 'No such note')
        memoryChanged(id)
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
      'local',
    ],
    // F-051: the memory's hook (memory-hook.ts) for a chat's prompt, with that chat's key, as /mcp/call.
    [
      'POST',
      /^\/mcp\/recall$/,
      async (_, r) => {
        const key = r.headers['x-sad-chat-key']
        if (typeof key !== 'string' || !key) throw apiError(401, 'Missing x-sad-chat-key')
        if (!isObject(r.body) || typeof r.body.prompt !== 'string') throw apiError(400, 'Expected {prompt}')
        return { text: await callTool(key, 'memory_recall', { prompt: r.body.prompt.slice(0, 20_000) }) }
      },
      'local',
    ],
    // F-051: the memory layer for the page (the Memory tab); a member's go to the hub, which keeps it.
    ['GET', /^\/memory\/status$/, async () => (await memoryLayer()).status()],
    [
      'GET',
      /^\/memory\/search$/,
      async (_, r) => {
        const kinds = (r.query.get('kinds') ?? '').split(',').filter((k): k is MemoryKind => k === 'wiki' || k === 'note' || k === 'turn')
        const limit = Number(r.query.get('limit')) || 20
        return { hits: await (await memoryLayer()).search(r.query.get('q') ?? '', { limit, kinds }) }
      },
    ],
    ['GET', /^\/memory\/wiki$/, async () => ({ pages: (await memoryLayer()).pages() })],
    [
      'GET',
      /^\/memory\/page$/,
      async (_, r) => {
        const page = (await memoryLayer()).page(r.query.get('path') ?? '')
        if (!page) throw apiError(404, 'No such page in the wiki')
        return { page }
      },
    ],
    ['GET', /^\/memory\/read$/, async (_, r) => ({ text: (await memoryLayer()).read(r.query.get('ref') ?? '') })],
    ['GET', /^\/memory\/brief$/, async () => ({ text: (await memoryLayer()).brief() })],
    [
      'POST',
      /^\/memory\/compile$/,
      async (_, r) => {
        const b = isObject(r.body) ? r.body : {}
        return { run: (await memoryLayer()).compile(b.mode === 'tidy' ? 'tidy' : 'ingest', 'now') }
      },
    ],
    ['PATCH', /^\/memory\/settings$/, async (_, r) => ({ settings: (await memoryLayer()).setSettings(r.body) })],
  ]

  /** Runs the route `rest` names; `forward` (a member) passes a non-local one to its hub instead. */
  async function route(r: MountRequest, forward?: (r: MountRequest) => Promise<unknown>): Promise<unknown> {
    let methodMismatch = false
    for (const [method, pattern, run, where] of routes) {
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
      if (forward && where !== 'local') return await forward(r)
      return await run(params, r)
    }
    throw apiError(methodMismatch ? 405 : 404, methodMismatch ? `${r.method} is not allowed here` : `No such path: ${AGENTIC_PREFIX}${r.rest}`)
  }

  /** A member's change, passed to the hub; its own folder for a floor becomes `folderFor` (checked here, where it is). */
  async function toHub(r: MountRequest): Promise<unknown> {
    const link = needHub()
    let body = r.body
    if (r.method === 'PATCH' && /^\/floors\/[^/]+$/.test(r.rest) && isObject(body) && body.codeDir !== undefined) {
      const { codeDir, ...rest } = body
      if (typeof codeDir === 'string' && codeDir.trim()) checkFolder(codeDir)
      body = { ...rest, folderFor: { id: self().id, dir: typeof codeDir === 'string' && codeDir.trim() ? codeDir.trim() : null } }
    }
    const value = await request<unknown>(link, 'http', { method: r.method, rest: r.rest, query: r.query.toString(), body })
    // What the hub answers about a floor is in the next state push too; it is on screen now.
    const floor = isObject(value) && isObject(value.floor) ? (value.floor as unknown as Floor) : null
    if (!floor) return value
    replica.floors = replica.floors.some(f => f.id === floor.id) ? replica.floors.map(f => (f.id === floor.id ? floor : f)) : [floor, ...replica.floors]
    emitFloors()
    // As this PC sees it: its own folder as codeDir.
    return { ...(value as Record<string, unknown>), floor: allFloors().find(f => f.id === floor.id) ?? floor }
  }

  /** The hub: a member's page change, run here as its own page's would be. */
  function fromMember(from: { id: string; name: string }, raw: unknown): Promise<unknown> {
    if (!isObject(raw) || typeof raw.method !== 'string' || typeof raw.rest !== 'string') throw apiError(400, 'Expected {method, rest, body}')
    if (raw.rest === '/mcp/call') throw apiError(403, 'Tool calls come as tool')
    const body = raw.body
    if (isObject(body) && isObject(body.folderFor) && body.folderFor.id !== from.id) throw apiError(403, "A PC sets only its own folder for a floor")
    if (isObject(body) && body.codeDir !== undefined) throw apiError(403, "The hub's own folder is set on the hub")
    return route({ method: raw.method, rest: raw.rest, query: new URLSearchParams(typeof raw.query === 'string' ? raw.query : ''), body, headers: {} })
  }

  // ---------------------------------------------------------------------------------------
  // F-021: what the other PCs ask of this one

  function serve(meta: Record<string, unknown>): (stream: Duplex) => void {
    const from = isObject(meta.from) && typeof meta.from.id === 'string' && typeof meta.from.name === 'string' ? { id: meta.from.id, name: meta.from.name } : null
    if (!from) throw new Error('which PC is asking?')
    const op = meta.op
    const m = mode()
    if (m === 'hub') {
      switch (op) {
        case 'subscribe':
          return stream => onSubscribe(from, stream)
        case 'http':
          return answer(body => fromMember(from, body))
        case 'lease':
          return answer(async raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string') throw apiError(400, 'Expected {sessionId, takeOver}')
            const at = floors.bySession(raw.sessionId)
            if (!at) throw apiError(404, "That chat isn't an agent's on a floor")
            const tookOverFrom = (await lease(raw.sessionId, from, raw.takeOver === true, at.agent.name)) ?? null
            return { mark: markOf(fileOf(raw.sessionId)), tookOverFrom }
          })
        case 'release':
          return answer(async raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string') throw apiError(400, 'Expected {sessionId, mark}')
            const link = team?.member(from.id)
            if (link && isMark(raw.mark)) await catchUpFrom(link, raw.sessionId, raw.mark).catch(e => log?.warn(`couldn't bring chat ${String(raw.sessionId).slice(0, 8)} up from ${from.name}: ${message(e)}`))
            release(raw.sessionId, from)
            return { ok: true }
          })
        case 'tool':
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.name !== 'string') throw apiError(400, 'Expected {sessionId, name, arguments}')
            // Only for a chat that PC holds: a member speaks for its own chats.
            if (held.get(raw.sessionId)?.holder !== from.id && remote.get(from.id)?.live[raw.sessionId] === undefined) throw apiError(403, `${from.name} isn't running that chat`)
            return toolFor(raw.sessionId, raw.name, raw.arguments)
          })
        case 'sessions':
          return answer(raw => ownSessions(pageOf(isObject(raw) ? raw : {})))
        case 'session-files':
          return answer(async raw => {
            const files = await sessionFiles(projectsDir)
            return { files: isObject(raw) && typeof raw.sessionId === 'string' ? files.filter(f => f.sessionId === raw.sessionId) : files }
          })
        case 'terminal':
          return serveTerminal
        case 'open':
          // F-025: another PC's Run on, for this one: the chat taken over here.
          return answer(raw => {
            if (!isObject(raw) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string') throw apiError(400, 'Expected {floorId, agentId}')
            return openChat(raw.floorId, raw.agentId, { takeOver: true })
          })
        case 'pull':
          return servePull(sid => findTranscript(sid, projectsDir))
      }
    } else if (m === 'member' && from.id === team!.hub()?.id) {
      switch (op) {
        case 'stop':
          return answer(async raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string') throw apiError(400, 'Expected {sessionId}')
            if (chats.info(raw.sessionId)) chats.kill(raw.sessionId)
            const mark = flushing.has(raw.sessionId) ? await endFlush(raw.sessionId) : markOf(fileOf(raw.sessionId))
            return { mark }
          })
        case 'read':
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string') throw apiError(400, 'Expected {sessionId, lines}')
            const t = chats.read(raw.sessionId, typeof raw.lines === 'number' ? raw.lines : 100)
            if (t === null) throw apiError(404, "That chat isn't running here")
            return t
          })
        case 'type':
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.text !== 'string') throw apiError(400, 'Expected {sessionId, text}')
            return chats.type(raw.sessionId, raw.text)
          })
        case 'sessions':
          return answer(raw => ownSessions(pageOf(isObject(raw) ? raw : {})))
        case 'session-files':
          return answer(async raw => {
            const files = await sessionFiles(projectsDir)
            return { files: isObject(raw) && typeof raw.sessionId === 'string' ? files.filter(f => f.sessionId === raw.sessionId) : files }
          })
        case 'terminal':
          return serveTerminal
        case 'open':
          // F-025: another PC's Run on, for this one: the chat taken over here.
          return answer(raw => {
            if (!isObject(raw) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string') throw apiError(400, 'Expected {floorId, agentId}')
            return openChat(raw.floorId, raw.agentId, { takeOver: true })
          })
        case 'pull':
          return servePull(sid => findTranscript(sid, projectsDir))
      }
    }
    throw new Error(`this PC doesn't do ${String(op)}`)
  }

  // ---------------------------------------------------------------------------------------
  // WebSockets

  function terminal(query: URLSearchParams) {
    const sid = query.get('session') ?? ''
    return (ws: WsSocket) => {
      const detach = chats.attach(sid, { send: m => ws.sendText(JSON.stringify(m)) })
      // F-023: running on another of the hub's PCs: its terminal, used from here over the link.
      if (!detach && remoteTerminal(sid, ws)) return
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

  /** F-050: the chat view's feed for one session (chatview.ts): the end of its conversation, then what it grows by. */
  function chatSocket(query: URLSearchParams) {
    const sid = query.get('session') ?? ''
    return (ws: WsSocket) => {
      if (!UUID_RE.test(sid)) return ws.close(1008, 'Expected ?session=<the chat id>')
      const detach = chatFeeds.attach(sid, m => ws.sendText(JSON.stringify(m)))
      ws.onText(() => {})
      ws.onClose(detach)
    }
  }

  /**
   * F-023, Use here: a chat that runs on another PC, its terminal on this PC's page. The link
   * carries the same messages the page's socket does, one JSON line each; it keeps running
   * there, and what is typed here goes to it. False when it isn't running on a PC within reach.
   */
  function remoteTerminal(sid: string, ws: WsSocket): boolean {
    const w = whereAll()[sid]
    if (!w || w.id === self().id) return false
    let link: LinkPeer
    try {
      link = peerOf(w.id)
    } catch {
      return false
    }
    let stream: Duplex | null = null
    let closed = false
    const early: string[] = []
    ws.onText(raw => {
      if (stream) relayLine(stream, raw)
      else early.push(raw)
    })
    ws.onClose(() => {
      closed = true
      stream?.destroy()
    })
    link.open({ op: 'terminal' }).then(
      s => {
        if (closed) return void s.destroy()
        stream = s
        writeLine(s, { sessionId: sid })
        for (const raw of early.splice(0)) relayLine(s, raw)
        readLines(s, m => ws.sendText(JSON.stringify(m)))
        s.on('close', () => !closed && ws.close(1000, `The link to ${link.name} closed`))
      },
      (e: unknown) => {
        ws.sendText(JSON.stringify({ t: 'exit', code: null }))
        ws.close(1000, `${link.name} didn't open it: ${message(e)}`)
      },
    )
    log?.info(`chat ${sid.slice(0, 8)}: used here, running on ${link.name}`)
    return true
  }

  /** A page's terminal message on to the link; one that isn't JSON is dropped, as the local socket drops it. */
  function relayLine(stream: Duplex, raw: string) {
    try {
      writeLine(stream, JSON.parse(raw))
    } catch {
      // Not a message.
    }
  }

  /** F-023: the far end of Use here: this PC's chat, viewed and typed into from another PC's page. */
  function serveTerminal(stream: Duplex) {
    let sid: string | null = null
    let detach: (() => void) | null = null
    readLines(stream, raw => {
      if (!isObject(raw)) return
      if (sid === null) {
        sid = typeof raw.sessionId === 'string' ? raw.sessionId : ''
        detach = chats.attach(sid, { send: m => void writeLine(stream, m) })
        if (!detach) {
          writeLine(stream, { t: 'exit', code: null })
          stream.end()
        }
        return
      }
      if (raw.t === 'in' && typeof raw.d === 'string') chats.input(sid, raw.d)
      else if (raw.t === 'size' && typeof raw.cols === 'number' && typeof raw.rows === 'number') chats.resize(sid, raw.cols, raw.rows)
    })
    stream.on('close', () => detach?.())
  }

  const mount: ApiMount = {
    prefix: AGENTIC_PREFIX,
    // The chats' own routes: their key, never the app's token, and never from a page (api.ts).
    ownAuth: rest => rest === '/mcp/call' || rest === '/mcp/recall',
    // F-054: the built-in CRM's calls to the CRM's backend, with this PC's CRM session (never passed to the hub).
    raw: (rest, url) => (rest.startsWith('/crm-proxy/') ? (req, res) => crmProxy.handle(req, res, rest.slice('/crm-proxy/'.length), url.search) : null),
    http: r => route(r, mode() === 'member' ? toHub : undefined),
    ws(rest, query) {
      if (rest === '/terminal') return terminal(query)
      if (rest === '/chat') return chatSocket(query)
      if (rest === '/events')
        return ws => {
          events.add(ws)
          ws.onClose(() => events.delete(ws))
          ws.sendText(JSON.stringify({ t: 'floors', floors: allFloors() } satisfies AgenticEvent))
          ws.sendText(JSON.stringify({ t: 'live', live: chats.states() } satisfies AgenticEvent))
          ws.sendText(JSON.stringify({ t: 'where', elsewhere: elsewhere(), last: lastAll(), team: teamInfo() } satisfies AgenticEvent))
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
    serve,
    restartChat,
    resumeChat,
    close() {
      // The chats are about to be closed with the app: what is open now is what the next start reopens.
      closing = true
      recovery?.freeze()
      if (resumeTimer) clearTimeout(resumeTimer)
      if (liveTimer) clearTimeout(liveTimer)
      if (pushTimer) clearTimeout(pushTimer)
      if (replicaTimer) clearTimeout(replicaTimer)
      if (originsTimer) clearTimeout(originsTimer)
      if (memberTimer) clearInterval(memberTimer)
      if (stateTimer) clearInterval(stateTimer)
      tail.close()
      chatFeeds.close()
      clearInterval(memberBriefTimer)
      layer.close()
      chats.closeAll()
      sub?.stream.destroy()
      sub = null
      for (const s of subs.values()) s.destroy()
      subs.clear()
      for (const s of events) s.close(1001, 'the agent is stopping')
      events.clear()
    },
  }
}
