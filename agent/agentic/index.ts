import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  AGENTIC_PREFIX,
  AGENTS_OFF_STATUS,
  AGENT_EFFORTS,
  AGENT_MODELS,
  HOME_OFFLINE_STATUS,
  isOrchestratorAgent,
  AGENT_ULTRACODES,
  NO_DEFAULTS,
  type AgentEffort,
  type AgentModel,
  type AgentUltracode,
  type AgenticEvent,
  type AgenticTeam,
  type ChatElsewhere,
  type ChatImported,
  type ChatDefaults,
  type ChatLast,
  type ChatOpened,
  type ChatRun,
  type ChatState,
  type ClaudeSession,
  type Floor,
  type FloorAgent,
  type FloorPatch,
  type FloorsAnswer,
  type NewAgent,
  type DefaultModel,
  type OpenChatRequest,
  type RunsAnswer,
  type TerminalClientMessage,
  type TuneAnswer,
  type TuneRequest,
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
import type { ChatHostLink } from '../chathost/link.ts'
import { createChatFeeds } from './chatview.ts'
import { createUiBridge } from './ui-bridge.ts'
import { mcpConfigFor, readRegistry, strictConfigFor } from './mcp-registry.ts'
import { createOrders, FAST_FROM, phoneUser, scanMessages, type HandoffApi, type Order, type OrderProgress } from './orders.ts'
import { readStatus } from './screen.ts'
import { createHeartbeat, unfinishedWork } from './heartbeat.ts'
import { createWatchdog, readFreeCommitMB } from './watchdog.ts'
import { createChatLog, describeEvents } from './chat-log.ts'
import { createVoice, type AskView } from './voice.ts'
import { spawn } from 'node:child_process'
import { createFastHost, type FastHost, type FastDeps } from './fast-host.ts'
import { namesChoice, namesFor, type NamesChoice } from '../../shared/fast-names.ts'
import { fastHello } from '../../shared/fast.ts'
import { buildBrief, buildSnapshot, type SnapshotInput } from './fast-brief.ts'
import { createFastSession, type FastSession } from './fast.ts'
import { fastDenied } from './fast-tools.ts'
import { readMemory } from './fast-gate.ts'
import { FAST_TOOLS } from './fast-tools-list.ts'
import { librarianEnv } from './librarian.ts'
import { killTree } from '../proc-tree.ts'
import { answerable, createApprovalLog, promptOf } from './approvals.ts'
import { cleanOrigin, createDeviceStore } from './approval-devices.ts'
import { createRecovery as createDeviceRecovery, windowsElevation, type Elevation } from './approval-recovery.ts'
import { createAutoUpdate } from './auto-update.ts'
import type { WaTools } from '../whatsapp/index.ts'
import { waTool } from '../whatsapp/tools.ts'
import type { DevicesAnswer, PublicJwk, RecoveryFinished, RecoveryStarted, SignedKind } from '../../shared/approval-sign.ts'
import { createHash } from 'node:crypto'
import type { AnswerRequest, ApprovalItem, ApprovalsAnswer, CancelRequest, PreparedCard, SendAsMeRequest } from '../../shared/approvals.ts'
import { configuredModel, readFileRun } from './runinfo.ts'
import { createFloorStore, type FloorStore } from './floors.ts'
import { createDefaultsStore, parseDefaults } from './defaults.ts'
import { contentTypeOf, createUploadStore, PIECE_BYTES } from './uploads.ts'
import { ATTACH_MAX_BYTES, isStoredName, safeName, storedName } from '../../shared/attachments.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CONTINUE_TEXT, createRecovery, type Recovery, type Remembered } from './recover.ts'
import { AGENT_API_PREFIX } from '../../shared/agent-api.ts'
import type { ChatOwner, ChatShare } from '../../shared/auth.ts'
import type { Auth } from '../auth/index.ts'
import { authError, OPEN, type Caller } from '../auth/types.ts'
import { createAccess, policyKey, ruleOf, SBSKRRT_OWNER, type Need, type Rule } from './access.ts'
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

/** F-118: tools that reach Shubham's own things (his task list, his phone, his WhatsApp, his screen, the app's memory): the owner of the app's chats only. */
const ADMIN_TOOLS = new Set([
  'task_add',
  'task_list',
  'task_update',
  'ui_screen',
  'ui_control',
  'ui_modules',
  'ui_invoke',
  'phone_screen',
  'phone_control',
  'phone_update',
  'wa_status',
  'wa_chats',
  'wa_read',
  'wa_prepare_send',
  'watchdog_status',
  'memory_read',
  'prepare_send',
])

/** F-124: what a proof needs of the request: who is asking and the browser's headers. */
export interface ProofRequest {
  caller?: Caller
  headers: IncomingMessage['headers']
}

export interface AgenticOptions {
  /** <state>/agent/agentic */
  dir: string
  /** F-118: who is signed in (agent/auth/). Left out (tests), the app is open: every caller may do everything. */
  auth?: Auth
  /** The local API's base URL, http://127.0.0.1:<port>/agent-api (read when a chat starts). */
  apiUrl: () => string
  log?: Logger
  /** Where a floor with no folder of its own works: Documents\shubham-agentic. */
  defaultCodeDir?: string
  /** CLAUDE_CODE_OAUTH_TOKEN as this account has it now (F-007). */
  token?: () => string | null
  /** F-087: the fast Assistant's warm process (fast-host.ts): on or off (default: SAD_FAST_ASSISTANT=1 or <state>/agent/fast-assistant.on; off, nothing exists). */
  fastAssistant?: boolean
  /** F-087: tests: the pieces of the fast host that would start a real claude, replaced. */
  fastHostDeps?: Partial<FastDeps>
  /** F-021: the hub's PCs; left out, this PC is on its own. */
  team?: AgenticTeamLinks
  /** F-097: the hub's end of the Common Drive over the member link: one request from a member PC (agent/drive/link.ts). */
  driveLink?: (from: { id: string; name: string }, body: unknown) => Promise<unknown>
  /** Tests: a fake node-pty (and a no-op tree kill: its pids are other processes'), a fake claude, and a scratch ~/.claude/projects. */
  spawn?: PtySpawn
  treeKill?: (pid: number) => void
  claude?: string
  projectsDir?: string
  /** Tests: a scratch ~/.claude.json (claude-config.ts). */
  claudeJson?: string
  /**
   * F-078 scope fix: chats start with --strict-mcp-config and a config of their own, so a server in the user's ~/.claude.json that the
   * registry keeps back (windows-mcp) reaches only the agents that name it. On; SAD_MCP_STRICT=0 (or false here) is the way it was.
   */
  strictMcp?: boolean
  /** Tests: the pause between the commands a tune types into one chat (F-067; 800 ms). */
  tuneGapMs?: number
  /** Tests: how often a running chat's JSONL is looked at for what to send on (1 s). */
  syncEveryMs?: number
  /**
   * F-051: the memory layer. meaning: the embedding model (main.ts turns it on; left out, search
   * goes by words and nothing is downloaded); start: started with the agent rather than at first
   * use. The rest are for tests.
   */
  memory?: { meaning?: boolean; start?: boolean; embedder?: Embedder; timers?: boolean; claudeArgs?: string[] }
  /** F-078: the heartbeat's timer runs unless this is false (tests) or SAD_HEARTBEAT=0 (the way it was). */
  heartbeat?: boolean
  /** F-083: the watchdog's checks run in the heartbeat's beat unless this is false (tests) or SAD_WATCHDOG=0 (the way it was). */
  watchdog?: boolean
  /** F-083: free commit in MB for the watchdog's memory rule (Windows' own number); tests give theirs. */
  freeCommitMB?: () => Promise<number | null>
  /** F-083: the idle reaper's limits; tests shorten them. */
  idleReapMs?: number
  reapEveryMs?: number
  /** F-078: the newer build waiting for Update now, if there is one (main.ts reads it off the build). */
  newerBuild?: () => string | null
  /** F-074: tests: what stands in for the registered device's signature on a pair code. */
  voiceProof?: (body: unknown, r?: { caller?: Caller; headers: IncomingMessage['headers'] }) => string
  /** F-076 recovery: the Windows administrator prompt that lets a person add an approval device from this PC when none can sign (tests: a fake). */
  recoveryElevation?: Elevation
  /** F-080: the speech service's stream (Whisper on the hub), offered to the phone at /voice/speech with its device key. */
  speech?: (ws: WsSocket) => void
  /** F-078: the build running now (its version), for the morning summary. */
  currentBuild?: () => string | null
  /** F-072: the Assistant's orders get their answers carried back to it by the app (orders.ts). On; SAD_ORDER_REPLIES=0, or an order-replies.off file in this folder, switches it off (the way it was). Tests set it. */
  orderReplies?: boolean
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
  /**
   * F-075: the chats' terminals live in the chat host (agent/chathost/), which outlives this agent: the chats
   * started here run there, the ones the agent before this one left running are taken over at start, and
   * stopping the agent lets go of them instead of ending them. Left out (the default: SAD_CHAT_HOST is off):
   * node-pty in this process, as before.
   */
  chatHost?: ChatHostLink | null
  /** F-079: Shubham's WhatsApp on the hub (agent/whatsapp/), for the overlay Assistant's wa_* tools; null where there is none. */
  whatsapp?: () => WaTools | null
}

export interface Agentic {
  mount: ApiMount
  /** F-074: the phone app's side: pairing and its device key's routes, under /voice (voice.ts). */
  voiceMount: ApiMount
  /** F-097: the paired phone a request's device key belongs to, or null (the Common Drive's phone uploads use it). */
  phoneDeviceOf(headers: MountRequest['headers']): { id: string; name: string } | null
  /** F-087: the fast Assistant's warm process; undefined while the feature is off (the default). */
  fastHost?: FastHost
  /** F-087: hand-offs from the fast Assistant to the Orchestrator (the session in fast.ts uses it). */
  handoff: HandoffApi
  floors: FloorStore
  chats: ChatPool
  memory: MemoryStore
  /** What a tool call does, for the chat whose key it carries; the answer is the text the chat sees. */
  callTool(key: string, name: string, args: unknown): Promise<string>
  /** F-118, for the test that holds the access policy and the route table equal: each route as 'METHOD <regex source>'. */
  routeKeys(): string[]
  /** F-097: a member PC's request to the hub's Common Drive over the link (throws when there is no hub or it can't be reached). */
  driveRequest(body: unknown, timeoutMs?: number): Promise<unknown>
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
  /** F-075: chats in the middle of something (running or asking) on this PC. */
  busyChats(): number
  /** F-075: the chat host changes with an update: the open chats are written down (so the new agent resumes them), then ended in the host. */
  retireChatHost(): Promise<void>
  /**
   * F-079: that a request carries his approval device's signature over `kind` and `fields` (or the old way is switched
   * on): who it was, for a log line; throws 401/403 otherwise. WhatsApp's sends use it (kind 'wa-send').
   */
  humanProof(kind: SignedKind, fields: (string | number | boolean)[], signed: unknown, r?: ProofRequest): string
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
  /** F-067: the hub's defaults for model, effort and ultracode. */
  defaults?: ChatDefaults
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
  // F-062: the effort each chat running here was started with, and when (what its chip says until a /effort changes it).
  const launched = new Map<string, { effort: string; at: string; ultracode: boolean }>()
  const claudeJson = o.claudeJson ?? claudeJsonPath()
  const defaultCodeDir = o.defaultCodeDir ?? path.join(os.homedir(), 'Documents', 'shubham-agentic')
  const briefsDir = path.join(o.dir, 'briefs')
  const mcpConfig = path.join(o.dir, 'mcp.json')
  const heldFile = path.join(o.dir, 'sessions.json')
  const replicaFile = path.join(o.dir, 'replica.json')
  const shim = fileURLToPath(new URL('./mcp-shim.ts', import.meta.url))
  // The shim is named here once; the key it needs comes from the chat's own terminal.
  const appMcpServers = { [MCP_SERVER_NAME]: { type: 'stdio', command: process.execPath, args: [shim] } }
  writeAtomic(mcpConfig, `${json({ mcpServers: appMcpServers })}\n`)
  /** Other MCP servers, given to single agents by name (mcp-registry.ts). */
  const mcpRegistryFile = path.join(o.dir, 'mcp-servers.json')
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

  // F-118: every events socket with its caller: what it is sent is what that person may see.
  const events = new Map<WsSocket, Caller>()
  const access = createAccess(o.auth)
  // F-070: the screens the overlay assistant can drive (ui-bridge.ts).
  const ui = createUiBridge()
  /** One event as this caller may see it, as text; null when it is not theirs at all. */
  function eventFor(e: AgenticEvent, c: Caller): string | null {
    if (e.t === 'tasks') return access.isAdmin(c) ? JSON.stringify(e) : null
    if (e.t === 'auth') return JSON.stringify(e)
    if (e.t === 'memory') {
      const f = allFloors().find(x => x.id === e.floorId)
      return f && access.floorSeen(c, f) ? JSON.stringify(e) : null
    }
    if (e.t === 'floors') return JSON.stringify({ t: 'floors', floors: access.scope(c, e.floors) } satisfies AgenticEvent)
    const seen = access.visible(c, allFloors())
    if (seen === null) return JSON.stringify(e)
    const mine = <T>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([sid]) => seen.has(sid)))
    if (e.t === 'live') return JSON.stringify({ t: 'live', live: mine(e.live) } satisfies AgenticEvent)
    if (e.t === 'where') return JSON.stringify({ ...e, elsewhere: mine(e.elsewhere), last: mine(e.last) } satisfies AgenticEvent)
    return JSON.stringify(e)
  }
  // F-118: the terminal and chat sockets that are open, with who holds each: closed when their person loses sight of the chat.
  const viewers = new Set<{ ws: WsSocket; caller: Caller; sid: string }>()
  function watch(sid: string, caller: Caller, ws: WsSocket) {
    const entry = { ws, caller, sid }
    viewers.add(entry)
    ws.onClose(() => viewers.delete(entry))
  }
  function recheckSockets() {
    for (const e of [...viewers]) {
      const at = bySession(e.sid)
      if (at && access.rights(e.caller, at.agent) === null) {
        viewers.delete(e)
        e.ws.close(4403, "That chat isn't yours any more")
      }
    }
  }
  const emit = (e: AgenticEvent) => {
    if (e.t === 'floors') recheckSockets()
    // Callers with the same rights get the same text: made once.
    const made = new Map<string, string | null>()
    for (const [s, c] of events) {
      const key = c.person ? c.person.id : '*'
      if (!made.has(key)) made.set(key, eventFor(e, c))
      const t = made.get(key)
      if (t) s.sendText(t)
    }
  }

  const floors = createFloorStore(path.join(o.dir, 'floors.json'), () => {
    if (mode() === 'member') return
    emit({ t: 'floors', floors: floors.list() })
    pushState()
  })
  // F-118: every floor and chat that has no owner is sbskrrt's (the one-time move; it is idempotent, so a chat some older path
  // made without an owner is covered at the next start too). A member keeps no floors of its own: this changes nothing there.
  if (o.auth) {
    const moved = floors.assignUnowned(SBSKRRT_OWNER)
    if (moved) log?.info(`F-118: ${moved} floors and chats had no owner; they are sbskrrt's now`)
    if (!o.auth.migrated()) o.auth.markMigrated()
  }
  // F-067: what "Default" means for a chat's model, effort and ultracode, kept on the hub (a member gets a copy with the state).
  const chatDefaults = createDefaultsStore(path.join(o.dir, 'chat-defaults.json'), () => {
    if (mode() !== 'member') pushState()
  })
  const defaultsNow = (): ChatDefaults => (mode() === 'member' ? (replica.defaults ?? NO_DEFAULTS) : chatDefaults.get())
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
      return { floors: Array.isArray(raw.floors) ? raw.floors : [], defaults: parseDefaults(raw.defaults), where: {}, last: isObject(raw.last) ? (raw.last as Record<string, ChatLast>) : {}, marks: {} }
    } catch {
      return { floors: [], where: {}, last: {}, marks: {} }
    }
  }
  let replicaTimer: NodeJS.Timeout | null = null
  function saveReplica() {
    if (replicaTimer) return
    replicaTimer = setTimeout(() => {
      replicaTimer = null
      writeAtomic(replicaFile, `${json({ floors: replica.floors, defaults: replica.defaults, last: replica.last })}\n`)
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
  // F-069: the files sent to the chats that run on this PC (the page's photos, pictures and files).
  const uploads = createUploadStore(path.join(o.dir, 'uploads'))
  uploads.prune()
  // F-078: every chat that stops or starts, and why (chat-log.ts): the pattern Shubham is told in the morning.
  const chatLog = createChatLog(path.join(o.dir, 'chat-events.jsonl'))
  /** Why the next start of a chat is happening, when it is not the usual (the heartbeat starting it again). */
  const startCause = new Map<string, string>()
  const chats = createChatPool({
    addDirs: [uploads.dir],
    // F-083: a chat with an open order or unfinished work is never ended for being idle.
    keep: sid => workOf(sid) !== null,
    idleReapMs: o.idleReapMs,
    reapEveryMs: o.reapEveryMs,
    onEnded: e => {
      const at = bySession(e.sessionId)
      chatLog.append({ event: 'stop', sessionId: e.sessionId, agent: at?.agent.name ?? '?', floor: at?.floor.name ?? '?', cause: e.cause, code: e.code, ranMin: Math.max(0, Math.round((Date.now() - Date.parse(e.startedAt)) / 60_000)) })
    },
    toolsUrl: () => `${o.apiUrl()}${AGENTIC_PREFIX}/mcp`,
    mcpConfig,
    log,
    spawn: o.chatHost?.spawn ?? o.spawn,
    // In the host, the host ends a chat's processes (by exact PID); nothing here is theirs to end.
    treeKill: o.chatHost ? () => {} : o.treeKill,
    keepOnClose: !!o.chatHost,
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

  // F-075: the chats the agent before this one left running in the chat host are taken over at once.
  const adopted: Promise<void> = o.chatHost
    ? o.chatHost
        .adopt(chats)
        .then(r => {
          if (r.adopted.length || r.ended.length) log?.info(`chat host: took over ${r.adopted.length} running chat${r.adopted.length === 1 ? '' : 's'}${r.ended.length ? `; ${r.ended.length} ended while no agent was there` : ''}`)
        })
        .catch(e => void log?.warn(`chat host: could not take over its chats: ${message(e)}`))
    : Promise.resolve()
  // The host is lost (it died): the chats that ran in it end. Noted first; reopened (resumed) when a host is back.
  let lostWithHost: Array<{ sid: string; state: ChatState }> = []
  o.chatHost?.onLost(why => {
    lostWithHost = Object.entries(chats.states()).map(([sid, state]) => ({ sid, state }))
    log?.error(`the chat host is gone (${why}): ${lostWithHost.length} chat(s) ended with it; they are reopened when a host is back`)
  })
  o.chatHost?.onBack(() => {
    const list = lostWithHost
    lostWithHost = []
    void (async () => {
      for (const r of list) {
        if (closing || chats.info(r.sid)) continue
        const ok = await resumeChat(r.sid, r.state === 'running' || r.state === 'question' ? CONTINUE_TEXT : undefined)
        log?.info(`chat host: chat ${r.sid.slice(0, 8)} ${ok ? 'reopened after the host was lost' : 'could not be reopened'}`)
        await new Promise(res => setTimeout(res, o.resumeGapMs ?? 2000))
      }
    })()
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
    const briefPath = writeBrief(briefsDir, sid, composeAgentBrief(floor, agent, o.memory?.start ? memoryBrief() : '', orderReplies()))
    // F-067: an agent set to Default gets Settings › Chats' model, effort and ultracode.
    const dflt = defaultsNow()
    const effort = agent.effort || dflt.effort
    const ultracode = agent.ultracode ? agent.ultracode === 'on' : dflt.ultracode
    // Per-agent MCP servers (mcp-registry.ts): only what this agent was given, else the shared file as ever.
    // F-078 scope fix: with the strict way (the default) the chat's file is its own and lists the servers by name in the log (never their values).
    let mcp: string
    let strictMcp = false
    if (o.strictMcp ?? process.env.SAD_MCP_STRICT !== '0') {
      try {
        const built = strictConfigFor(o.dir, sid, appMcpServers, mcpRegistryFile, claudeJson, cwd, agent.mcpServers)
        mcp = built.file
        strictMcp = true
        log?.info(`chat ${sid.slice(0, 8)}: MCP servers ${built.names.join(', ')}`)
      } catch (e) {
        log?.warn(`couldn't write chat ${sid.slice(0, 8)}'s MCP file, starting it the old way: ${message(e)}`)
        mcp = mcpConfigFor(o.dir, sid, appMcpServers, readRegistry(mcpRegistryFile), agent.mcpServers, mcpConfig)
      }
    } else {
      mcp = mcpConfigFor(o.dir, sid, appMcpServers, readRegistry(mcpRegistryFile), agent.mcpServers, mcpConfig)
    }
    chats.start({ sessionId: sid, floorId: floor.id, agentId: agent.id, cwd, briefPath, mcpConfig: mcp, strictMcp, model: agent.model || dflt.model, effort, resume, cols: size.cols, rows: size.rows })
    launched.set(sid, { effort, at: new Date().toISOString(), ultracode })
    heartbeat.opened(sid)
    chatLog.append({ event: 'start', sessionId: sid, agent: agent.name, floor: floor.name, cause: startCause.get(sid) ?? (resume ? 'resumed' : 'new') })
    startCause.delete(sid)
    // Ultracode is claude's own mode, on for the session only: asked for once its prompt is up (`/effort ultracode`).
    if (ultracode) chats.typeWhenReady(sid, '/effort ultracode')
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
    // F-064: the first PC to run a chat is its home (a chat that has one keeps it, however it is run later).
    const at = floors.bySession(sid)
    if (at && !at.agent.homePc) floors.setHome(at.floor.id, at.agent.id, who)
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
    heartbeat.stoppedOnPurpose(sid)
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
      const state = { t: 'state', floors: floors.list(), defaults: chatDefaults.get(), where: whereAll(), last: lastAll(), marks: marksHere() }
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
        defaults: parseDefaults(raw.defaults),
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
    const atHome = await resumeAtHome(floor, agent, sid, req)
    if (atHome) return atHome
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

  /** F-064: this PC's name for a PC's id (the hub's own, a member's, or the name the agent kept). */
  const homeName = (agent: FloorAgent, id: string) => (id === self().id ? self().name : (remote.get(id)?.name ?? (team?.hub()?.id === id ? team.hub()!.name : null) ?? agent.homePcName ?? id))

  /**
   * F-064: a chat that isn't running is resumed on its HOME PC, whichever PC the click, the message
   * or the app starting again came from. Nothing to do here (null) when this PC is its home, it has
   * none yet, or it was asked for here (`here`: the home is offline and Shubham chose to start it
   * here, or the hub has already chosen). A chat that is running anywhere is the take-over question
   * as before (the caller's 409, or `takeOver`). When the home can't be reached the answer is 424,
   * naming it (the page offers here).
   */
  async function resumeAtHome(floor: Floor, agent: FloorAgent, sid: string | null, req: OpenChatRequest): Promise<ChatOpened | null> {
    if (req.here || mode() === 'alone') return null
    const home = agent.homePc
    if (!home || home === self().id) return null
    const name = homeName(agent, home)
    // Running somewhere already (at its home, or started elsewhere): that is the take-over question, as before.
    if (sid && whereAll()[sid]) return null
    const offline = () => apiError(HOME_OFFLINE_STATUS, `${name} is offline, and ${agent.name}'s chat lives there. Start it on this PC instead? Its home stays ${name}.`)
    if (mode() === 'hub') {
      const link = team?.member(home) ?? null
      if (!link) throw offline()
      return { ...(await request<ChatOpened>(link, 'open', { floorId: floor.id, agentId: agent.id, text: req.say }, 60_000)), on: name }
    }
    // A member reaches every other PC through the hub, which does the same for it (the run-on route).
    if (!team?.hub()?.link || !sub) throw offline()
    const via = await request<ChatOpened>(needHub(), 'http', { method: 'POST', rest: `/floors/${enc(floor.id)}/agents/${enc(agent.id)}/run-on`, body: { pc: home, say: req.say } }, 60_000).catch((e: unknown) => {
      throw (e as { status?: unknown }).status === HOME_OFFLINE_STATUS ? offline() : e
    })
    return { ...via, on: name }
  }

  /** Its chat, running here: started fresh, resumed from its transcript, taken over, or as it was. */
  async function openChat(floorId: string, agentId: string, req: OpenChatRequest): Promise<ChatOpened> {
    if (mode() === 'member') return openOnMember(floorId, agentId, req)
    let floor = floorOf(floorId)
    const agent = agentOf(floor, agentId)
    let sid = agent.sessionId
    if (sid && chats.info(sid)) return { sessionId: sid, started: false, resumed: false }
    const atHome = await resumeAtHome(floor, agent, sid, req)
    if (atHome) return atHome
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
    // The same draft rule as every message to a chat: /exit pasted after Shubham's unsent words would be sent WITH them, and a
    // chat stopped under them would lose them. A real draft: nothing is typed, nothing is stopped, 409. (A grey suggestion is not one.)
    if (hasDraft(sid)) throw apiError(409, `${at.agent.name}'s chat has unsent text in its box; nothing was typed and it was not restarted.`)
    if (chats.info(sid)?.state === 'idle' && chats.type(sid, '/exit', { refuseDraft: true })) {
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
      // Here: it was open on this PC when the app stopped (or needs its token again), so it comes back on this PC.
      const opened = await openChat(at.floor.id, at.agent.id, { here: true })
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
  /** F-083: false from the start until recovery has reopened its list (or when there is none to wait for: true at once). */
  let recoveryDone = !o.resumeChats || team?.role() === 'member'
  if (o.resumeChats && team?.role() !== 'member') {
    const mine = createRecovery(path.join(o.dir, 'open-chats.json'), { log })
    recovery = mine
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      void (async () => {
        // The chats still running in the chat host are the pool's by now; only the others are reopened.
        await adopted
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
        recoveryDone = true
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

  /** Counts a message against the cooldowns; returns what takes it back (a message the chat refused because of a draft starts no cooldown). */
  function relayAllowed(from: string, to: string): () => void {
    const t = Date.now()
    const pair = `${from}>${to}`
    const pairBefore = pairLast.get(pair)
    if (t - (pairBefore ?? 0) < PAIR_COOLDOWN_MS) throw apiError(429, 'You just messaged that chat; give it a few seconds to answer before sending again.')
    const before = targetHits.get(to) ?? []
    const hits = before.filter(x => t - x < TARGET_WINDOW_MS)
    if (hits.length >= TARGET_WINDOW_MAX) throw apiError(429, 'That chat has had too many messages this minute; wait before sending more.')
    pairLast.set(pair, t)
    targetHits.set(to, [...hits, t])
    return () => {
      if (pairBefore === undefined) pairLast.delete(pair)
      else pairLast.set(pair, pairBefore)
      targetHits.set(to, hits)
    }
  }
  /** typeInto for a message that counted against the cooldowns: if the chat refuses it (409, his draft) the count is taken back. */
  const typeIntoOrUndo = (undo: () => void, c: { sessionId: string; id: string }, body: string) =>
    typeInto(c, body).catch(e => {
      undo()
      throw e
    })

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

  /**
   * What the chat's screen shows right now, as lines of text (not its scroll-back: that still holds menus long gone). This PC's chat: its
   * screen model; another PC's: that PC's, over the link. Null when the screen can't be had (an older PC that has no such request).
   */
  async function screenOf(c: { sessionId: string; id: string }): Promise<string | null> {
    if (c.id === self().id) return chats.screen(c.sessionId)?.join('\n') ?? null
    const link = team?.member(c.id)
    if (!link) return null
    return request<string>(link, 'screen', { sessionId: c.sessionId }).catch(() => null)
  }

  // The one key a Cancel button presses (the member PC's 'keys' request takes it, and digits, nothing else).
  const ESC_KEY = String.fromCharCode(27)

  /**
   * What a waiting chat asks, off its live screen only: options come from the menu drawn now, never from older text above a newer
   * footer. Where the screen can't be had, the scroll-back gives the words around it but no buttons (nothing is pressed from stale text).
   */
  async function promptOfChat(c: { sessionId: string; id: string }) {
    const screen = await screenOf(c)
    if (screen !== null) return promptOf(screen)
    const p = promptOf(await readChat(c, 60).catch(() => ''))
    return { ...p, menu: null, cancellable: false }
  }

  /** M1: a chat waiting at a permission prompt or a menu is never typed into (Enter would pick the highlighted option). The words for a person or an agent. */
  // On this PC the screen decides (a phantom guess from plain words is put right); on another PC the state it reports.
  const atPrompt = (sessionId: string) => (chats.info(sessionId) ? chats.asking(sessionId) : whereAll()[sessionId]?.state === 'question')
  const promptWords = (sessionId: string) => `${floors.bySession(sessionId)?.agent.name ?? 'That agent'}'s chat is waiting at a prompt (Approvals tab); nothing was typed. Try again once it is answered.`

  // A draft: unsent text in a chat's idle input box (Shubham is typing there). A message pasted now would join it and one Enter would
  // send both. Messages from agents and the app wait or are refused; his own say() from the chat view is his text joining his draft.
  // Known only for chats on this PC (their screens); another PC's chats are typed into as before.
  const hasDraft = (sessionId: string) => (chats.info(sessionId) ? chats.drafting(sessionId) : false)
  const draftWords = (sessionId: string) => `${floors.bySession(sessionId)?.agent.name ?? 'That agent'}'s chat has unsent text in its box; try again shortly.`

  /**
   * Types `body` into a chat here or on a member PC. `human`: Shubham's own words (the chat view's say, a setting he changed): they may join
   * his draft. Every other caller (an agent's message, a broadcast, a nudge, an order's reply) never does: on his unsent text nothing is
   * typed and it throws 409. A chat on a member PC reports its draft back, because only that PC knows its screen.
   */
  async function typeInto(c: { sessionId: string; id: string }, body: string, opt: { human?: boolean } = {}): Promise<boolean> {
    const refuseDraft = opt.human !== true
    if (c.id === self().id) return chats.type(c.sessionId, body, refuseDraft ? { refuseDraft: true } : undefined)
    const link = team?.member(c.id)
    if (!link) return false
    const r = await request<boolean | 'draft'>(link, 'type', { sessionId: c.sessionId, text: body, ...(refuseDraft ? { refuseDraft: true } : {}) }).catch(() => false)
    if (r === 'draft') throw apiError(409, draftWords(c.sessionId))
    return r === true
  }

  // F-076: what was answered and sent as the person (viewable), and the cards the assistant prepared (never sent by it).
  const approvalLog = createApprovalLog(path.join(o.dir, 'approvals.jsonl'))
  // The phones (browsers) whose signature an approval or a send needs: registered once, here on the hub.
  const approvalDevices = createDeviceStore(path.join(o.dir, 'approval-devices.json'))
  // F-081: the switch the guard's night-watch reads (auto-update.json in this folder).
  const autoUpdate = createAutoUpdate(path.join(o.dir, 'auto-update.json'))
  const prepared = new Map<string, PreparedCard>()
  const PREPARED_MAX = 20
  // F-072: the orders the overlay Assistant gives, and the replies that come back to it (orders.ts).
  // Only the hub keeps them: a member's tool calls are run by the hub (callTool).
  // F-087: where a hand-off's answer and progress go (the fast Assistant's session registers them: handoff.listen below).
  const fastLinks: { onReturn?: (order: Order, text: string) => Promise<boolean>; onProgress?: (p: OrderProgress) => void } = {}
  const orders = createOrders({
    now: Date.now,
    file: path.join(o.dir, 'orders.json'),
    log,
    stateOf: sid => whereAll()[sid]?.state,
    progress: p => fastLinks.onProgress?.(p),
    words: sid => readStatus(chats.screen(sid) ?? [])?.text,
    interrupt: sid => {
      if (!chats.info(sid)) return false
      chats.input(sid, String.fromCharCode(27))
      return true
    },
    scan: (sid, id) => {
      const file = findTranscript(sid, projectsDir)
      return file ? scanMessages(readTranscriptFile(file), id) : { started: false, answer: '' }
    },
    deliver: async (assistantSid, body, order) => {
      // F-087: the fast Assistant is a process, not a chat: its answer goes to the session (nothing is typed anywhere).
      if (order.from === FAST_FROM) return fastLinks.onReturn ? fastLinks.onReturn(order, body).catch(() => false) : false
      const w = whereAll()[assistantSid]
      // M1: typing ends with Enter, which would pick the highlighted option of a prompt nobody answered: kept, and tried again later.
      if (w && (atPrompt(assistantSid) || hasDraft(assistantSid))) return false
      return w ? typeInto({ sessionId: assistantSid, id: w.id }, body).catch(() => false) : false
    },
  })
  function orderReplies(): boolean {
    return o.orderReplies ?? !(process.env.SAD_ORDER_REPLIES === '0' || existsSync(path.join(o.dir, 'order-replies.off')))
  }
  const ordersTimer = setInterval(() => void orders.tick(), 1000)
  ordersTimer.unref?.()

  // F-078: the heartbeat (heartbeat.ts): a plain check of every chat every few minutes; it starts a stopped
  // chat that has unfinished work, nudges it once, and wakes the Assistant only when there is news.
  const TRANSCRIPT_MAX_AGE_MS = 6 * 3_600_000
  const agentRefs = () =>
    floors.list().flatMap(f => f.agents.map(a => ({ sessionId: a.sessionId, floorId: f.id, floorName: f.name, agentId: a.id, agentName: a.name, assistant: isOrchestratorAgent(f.name, a) })))
  const tailOf = (sid: string) => {
    const file = findTranscript(sid, projectsDir)
    // A conversation not written to for hours is history: not even read.
    if (!file || Date.now() - statSync(file).mtimeMs > TRANSCRIPT_MAX_AGE_MS) return null
    return readTranscriptFile(file)
      .slice(-3)
      .map(m => ({ id: m.id, role: m.role, text: m.text, tools: m.tools, timestamp: m.timestamp ?? '' }))
  }
  /**
   * F-083: why this chat has work to go on with, or null: an order from the Assistant is open for it, or its own last words
   * say it is unfinished (heartbeat.ts). The idle reaper keeps such a chat, and the watchdog starts such a chat again.
   */
  function workOf(sid: string): string | null {
    if (orders.list().some(x => x.to.sessionId === sid)) return 'an order from the Assistant is open'
    try {
      const rows = tailOf(sid)
      return rows ? (unfinishedWork(rows, { now: Date.now(), openOrder: false, running: false })?.why ?? null) : null
    } catch {
      return null
    }
  }
  const startedAtMs = Date.now()
  // F-083: the watchdog (watchdog.ts) is called by each beat of the heartbeat, so it needs no chat to be alive.
  const watchdogOn = o.watchdog ?? process.env.SAD_WATCHDOG !== '0'
  const watchdog = createWatchdog({
    now: Date.now,
    file: path.join(o.dir, 'watchdog.json'),
    log,
    agents: agentRefs,
    stateOf: sid => whereAll()[sid]?.state,
    events: since => chatLog.since(since),
    stoppedOnPurpose: sid => heartbeat.isStopped(sid),
    work: workOf,
    // F-058 recovery reopens the chats after an update first; the watchdog never races it (and does not wait for ever).
    recoveryBusy: () => closing || (!recoveryDone && Date.now() - startedAtMs < 10 * 60_000),
    freeCommitMB: o.freeCommitMB ?? readFreeCommitMB,
    restart: async (floorId, agentId, text) => {
      try {
        const sid = floors.list().find(f => f.id === floorId)?.agents.find(a => a.id === agentId)?.sessionId
        if (sid) startCause.set(sid, 'watchdog')
        // On its home PC (F-064); offline: it is not started here, that is reported.
        const opened = await openChat(floorId, agentId, { say: text })
        if (!opened.on) chats.typeWhenReady(opened.sessionId, text, { holdForDraft: true })
        return null
      } catch (e) {
        return (e as { status?: unknown }).status === HOME_OFFLINE_STATUS ? `offline: ${message(e)}` : message(e)
      }
    },
    // Nothing is pressed: the chat is ended and opened again from its conversation, which discards the menu on its screen.
    restartClean: async sid => {
      if (mode() === 'member' || !floors.bySession(sid)) return false
      startCause.set(sid, 'watchdog')
      await stopAt(self().id, sid)
      return await resumeChat(sid)
    },
    local: sid => {
      const i = chats.info(sid)
      return i ? { watching: i.viewers > 0 } : null
    },
    screen: sid => chats.screen(sid),
    asking: sid => chats.asking(sid),
    press: (sid, keys) => chats.press(sid, keys),
    activity: sid => chats.activity(sid),
    record: e => chatLog.append({ event: 'watch', sessionId: e.sessionId, agent: e.agent, floor: e.floor, cause: e.cause, what: e.what, did: e.did }),
  })
  const heartbeat = createHeartbeat({
    now: Date.now,
    file: path.join(o.dir, 'heartbeat.json'),
    log,
    agents: agentRefs,
    stateOf: sid => whereAll()[sid]?.state,
    tail: tailOf,
    watch: watchdogOn ? () => watchdog.watch() : undefined,
    openOrder: sid => orders.list().some(x => x.to.sessionId === sid),
    restart: async (floorId, agentId) => {
      try {
        const sid = floors.list().find(f => f.id === floorId)?.agents.find(a => a.id === agentId)?.sessionId
        if (sid) startCause.set(sid, 'heartbeat')
        await openChat(floorId, agentId, {})
        return null
      } catch (e) {
        return message(e)
      }
    },
    nudge: async (sid, body) => {
      const w = whereAll()[sid]
      if (w && w.id !== self().id) return typeInto({ sessionId: sid, id: w.id }, body).catch(() => false)
      chats.typeWhenReady(sid, body, { holdForDraft: true })
      return true
    },
    wake: body => tellAssistant(body),
    news: items => {
      // F-083: no phone push between 23:00 and 07:00 for what the watchdog found; it is in the morning summary (chat-events.jsonl).
      const h = new Date().getHours()
      const quiet = h >= 23 || h < 7
      const shown = quiet ? items.filter(i => !['menu', 'down', 'silent'].includes(i.kind)) : items
      if (shown.length) voice.beat(shown.map(i => i.text).join(' '), shown.filter(i => i.agent).map(i => ({ floor: i.floor ?? '', agent: i.agent ?? '', what: i.kind })))
    },
    newerBuild: () => o.newerBuild?.() ?? null,
    currentBuild: () => o.currentBuild?.() ?? null,
    overnight: since => describeEvents(chatLog.since(since)),
    waiting: async () => {
      const lines: string[] = []
      const where = whereAll()
      const asking = floors.list().flatMap(f => f.agents.filter(a => a.sessionId && where[a.sessionId]?.state === 'question').map(a => `${a.name} on ${f.name}`))
      if (asking.length) lines.push(`${asking.length} chat${asking.length === 1 ? '' : 's'} waiting at a question (the Approvals tab): ${asking.join(', ')}.`)
      if (prepared.size) lines.push(`${prepared.size} card${prepared.size === 1 ? ' is' : 's are'} prepared for you in the Send tab.`)
      const replies = orders.list().filter(x => x.pending).length
      if (replies) lines.push(`${replies} agent repl${replies === 1 ? 'y has' : 'ies have'} not reached the Assistant yet.`)
      const nb = o.newerBuild?.()
      if (nb) lines.push(`A newer build (${nb}) is waiting; only you press Update now.`)
      const open = (await tasks.counts()).open
      if (open) lines.push(`${open} open task${open === 1 ? '' : 's'} on your list.`)
      return lines
    },
    undeliveredReplies: () => orders.list().filter(x => x.pending).length,
  })
  /** F-083: what the overlay and the Assistant's watchdog_status tool show: it runs, the beat's times, what the last look found. */
  function watchdogView() {
    const hb = heartbeat.state()
    const w = watchdog.state()
    return {
      enabled: watchdogOn && hb.enabled,
      intervalMin: hb.intervalMin,
      lastBeatAt: hb.last?.at ?? null,
      nextBeatAt: hb.nextAt,
      chatsLooked: hb.last?.chats ?? 0,
      found: (hb.last?.findings ?? []).map(f => ({ kind: f.kind, text: f.text, did: f.did })),
      downNow: w.down.map(d => ({ agent: d.agent, floor: d.floor, downMin: Math.round((Date.now() - d.sinceMs) / 60_000), why: d.why })),
      restartsLastHour: w.restartsLastHour,
      // F-087: the fast Assistant's process (null while the feature is off): state, why, pid, memory numbers, turns served, cost.
      fast: fastHost?.status() ?? null,
      summary: !watchdogOn ? 'The watchdog is off (SAD_WATCHDOG=0).' : !hb.enabled ? 'The heartbeat is off, so the watchdog does not look.' : w.down.length ? `${w.down.length} chat${w.down.length === 1 ? ' is' : 's are'} down: ${w.down.map(d => d.agent).join(', ')}.` : hb.last ? `All chats looked at ${new Date(hb.last.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}: ${hb.last.findings.length ? `${hb.last.findings.length} thing${hb.last.findings.length === 1 ? '' : 's'} found.` : 'all well.'}` : 'No look yet since the app started.',
    }
  }

  const assistantAt = () =>
    floors
      .list()
      .flatMap(f => f.agents.map(a => ({ f, a })))
      .find(x => isOrchestratorAgent(x.f.name, x.a)) ?? null

  /** Types `body` into the Assistant's chat, starting it first when it is not running (the heartbeat and the phone's asks). */
  async function tellAssistant(body: string): Promise<boolean> {
    const at = assistantAt()
    if (!at) return false
    const sid = at.a.sessionId
    const w = sid ? whereAll()[sid] : undefined
    // M1 (a safety hole Mobile found): a line typed while the Assistant waits at a permission prompt or a menu ends with Enter,
    // which would pick the highlighted option: an approval nobody tapped. Phone asks get a 409, the heartbeat tries again next beat.
    if (w && sid && atPrompt(sid)) throw apiError(409, 'The Assistant is waiting for an answer on the PC')
    // His draft in the Assistant's box: the heartbeat and the morning summary try again later; a phone ask is told to.
    if (w && sid && hasDraft(sid)) throw apiError(409, "Shubham has unsent text in the Assistant's box on the PC; try again shortly")
    if (sid && w) return typeInto({ sessionId: sid, id: w.id }, body)
    try {
      const opened = await openChat(at.f.id, at.a.id, {})
      chats.typeWhenReady(opened.sessionId, body)
      return true
    } catch {
      return false
    }
  }

  // F-087: hand-offs from the fast Assistant to the Orchestrator (orders.ts has the order, its progress and its return). The same safe typing as
  // every message to a chat: a chat at a prompt or with Shubham's unsent text is a 409 at once, nothing is typed, no retry loop.
  const handoffTimes: number[] = []
  const HANDOFFS_PER_MIN = 6
  const HANDOFF_MAX = 4000
  const handoff: HandoffApi = {
    async handOff(text, origin, sender = 'the Assistant') {
      if (mode() === 'member') return { ok: false, status: 409, reason: 'Hand-offs are made on the hub.' }
      const clean = text.replace(/\s+/g, ' ').trim()
      if (!clean) return { ok: false, status: 400, reason: 'There is nothing to hand off.' }
      if (clean.length > HANDOFF_MAX) return { ok: false, status: 413, reason: `That is longer than ${HANDOFF_MAX} characters.` }
      const now = Date.now()
      while (handoffTimes.length && now - handoffTimes[0] > 60_000) handoffTimes.shift()
      if (handoffTimes.length >= HANDOFFS_PER_MIN) return { ok: false, status: 429, reason: 'Too many hand-offs this minute. Wait a little.' }
      const at = assistantAt()
      if (!at) return { ok: false, status: 409, reason: 'There is no Orchestrator chat on this PC.' }
      const who = at.a.name
      const sid = at.a.sessionId
      const running = sid ? whereAll()[sid] : undefined
      const id = orders.plan(FAST_FROM, sid ?? 'orchestrator', clean)
      if (!id) return { ok: false, status: 400, reason: 'That is not something to hand off.' }
      const line = `[message from ${sender}, ${orders.marker(id)}] ${clean}`
      if (sid && running) {
        if (atPrompt(sid)) return { ok: false, status: 409, reason: `${who} is waiting for an answer on the PC.` }
        if (hasDraft(sid)) return { ok: false, status: 409, reason: `Shubham has unsent text in ${who}'s box on the PC; try again shortly.` }
        if (!(await typeInto({ sessionId: sid, id: running.id }, line).catch(() => false))) return { ok: false, status: 409, reason: `${who} could not take it right now.` }
        orders.open(id, FAST_FROM, { sessionId: sid, agent: who, floor: at.f.name }, clean, { kind: 'handoff', origin })
        handoffTimes.push(now)
        return { ok: true, orderId: id, phase: 'typed' }
      }
      // Not running: started, and the message is typed when it is ready (held back from a draft, as for every message). The order waits as 'queued'.
      let opened: ChatOpened
      try {
        opened = await openChat(at.f.id, at.a.id, {})
      } catch (e) {
        return { ok: false, status: 503, reason: `${who} could not be started: ${message(e)}` }
      }
      chats.typeWhenReady(opened.sessionId, line, { holdForDraft: true })
      orders.open(id, FAST_FROM, { sessionId: opened.sessionId, agent: who, floor: at.f.name }, clean, { kind: 'handoff', origin, queued: true })
      handoffTimes.push(now)
      return { ok: true, orderId: id, phase: 'queued' }
    },
    status(orderId) {
      const od = orders.get(orderId)
      if (!od) return { orderId, open: false }
      const st = whereAll()[od.to.sessionId]?.state
      const age = Date.now() - od.at
      const phase = od.queued ? 'queued' : st === 'question' ? 'waiting-you' : st === 'running' ? (age > 15 * 60_000 ? 'slow' : 'working') : 'typed'
      return { orderId, open: true, phase, sec: Math.round(age / 1000), gist: od.gist, ...(st === 'running' ? { words: readStatus(chats.screen(od.to.sessionId) ?? [])?.text } : {}) }
    },
    cancel: id => orders.cancel(id),
    listen(l) {
      fastLinks.onReturn = l.onReturn
      fastLinks.onProgress = l.onProgress
    },
  }

  // F-074: the hub's side of "Hey Chris" (voice.ts): pairing with a device key, asks to the Assistant,
  // what the phone's background service reads. A conversation file is read again only when it changed.
  const messageCache = new Map<string, { sig: string; msgs: ReturnType<typeof readTranscriptFile> }>()
  const messagesOf = (file: string) => {
    const st = statSync(file)
    const sig = `${st.mtimeMs}:${st.size}`
    const hit = messageCache.get(file)
    if (hit?.sig === sig) return hit.msgs
    const msgs = readTranscriptFile(file)
    messageCache.set(file, { sig, msgs })
    return msgs
  }
  const voice = createVoice({
    now: Date.now,
    file: path.join(o.dir, 'voice-devices.json'),
    speech: o.speech,
    fast: () => fastSession?.socket('phone') ?? null,
    fastInfo: () => fastHello(!!fastHost, fastHost?.state(), fastHost?.status().model),
    names: () => fastNames,
    orderAsk: id => orderAsk(id),
    log,
    assistant: () => {
      const sid = assistantAt()?.a.sessionId ?? null
      // A 'question' guessed from plain words is put right before the phone is told it is waiting.
      if (sid && whereAll()[sid]) atPrompt(sid)
      return assistantAt() ? { sessionId: sid, state: sid ? whereAll()[sid]?.state : undefined } : null
    },
    say: body => tellAssistant(body),
    proof:
      o.voiceProof ??
      ((body, r) => {
        // F-122: no signature, but a browser signed in as sbskrrt (unless Settings says approval devices only): given the code too.
        const signed = isObject(body) && body.sig !== undefined && body.sig !== null
        const by = signed ? null : ownerCodeBy(r)
        if (by) {
          deviceLog('A pair code for the phone app was made', by)
          return by
        }
        // Strict, like Automatic updates ON: a registered approval device's signature over kind 'pair', never the unsigned old way.
        if (approvalDevices.count() === 0) throw apiError(403, 'No approval device is registered yet. Register your phone in Settings › Approval device first.')
        const name = approvalDevices.verify('pair', [], isObject(body) ? body.sig : undefined).name
        deviceLog('A pair code for the phone app was made', `device "${name}"`)
        return `device "${name}"`
      }),
    feed: send => {
      const sid = assistantAt()?.a.sessionId
      return sid ? chatFeeds.attach(sid, send) : () => {}
    },
    history: (before, limit) => {
      const sid = assistantAt()?.a.sessionId
      return sid ? chatFeeds.history(sid, before, limit) : { items: [], before: null }
    },
    scan: (sid, id) => {
      const file = findTranscript(sid, projectsDir)
      return file ? scanMessages(messagesOf(file), id, 'ask') : { started: false, answer: '' }
    },
    interrupt: async () => {
      const sid = assistantAt()?.a.sessionId
      if (!sid || !chats.info(sid)) return false
      chats.input(sid, String.fromCharCode(27))
      return true
    },
  })
  // F-087: the fast Assistant's warm process. Dark: nothing exists unless SAD_FAST_ASSISTANT=1 or <state>/agent/fast-assistant.on is there, and
  // only on the hub. The session around it (sockets, brief, tools) is fast.ts; this is the process, its supervision and its memory rules.
  // F-086: "What the chats are called" as the hub keeps it (the words the Assistant speaks follow it; default old). Set from the page; Chris reads it in hello.
  const fastNamesFile = path.join(o.dir, 'fast-names.json')
  let fastNames: NamesChoice = (() => {
    try {
      return namesChoice((JSON.parse(readFileSync(fastNamesFile, 'utf8')) as { choice?: unknown }).choice)
    } catch {
      return 'old'
    }
  })()
  const FAST_LABELS: Record<string, string> = { ui_control: 'Opening that', ui_screen: 'Looking at the screen', app_chats: 'Checking the chats', floor_roster: 'Checking the floor', app_read_chat: 'Reading that chat', app_read_conversation: 'Reading that chat', memory_search: 'Searching', memory_read: 'Searching', memory_recent: 'Searching', task_list: 'Checking your tasks', task_add: 'Adding a task', watchdog_status: 'Checking the chats', approvals_waiting: 'Checking Approvals', hand_off: 'Asking', order_status: 'Checking on it' }
  let fastSession: FastSession | undefined
  /** Orders the Orchestrator's stop ended: GET /voice/ask/<orderId> says "It was stopped." (the order itself is gone once its reply is delivered). */
  const cancelledOrders = new Set<string>()
  /** The answers of handed-off orders, kept an hour for GET /voice/ask/<orderId> (the order itself is gone once its reply is delivered). */
  const orderAnswers = new Map<string, { text: string; at: number; cancelled: boolean }>()
  function orderAsk(id: string): AskView | null {
    for (const [k, v] of orderAnswers) if (Date.now() - v.at > 3_600_000) orderAnswers.delete(k)
    const a = orderAnswers.get(id)
    if (a) return a.cancelled ? { askId: id, state: 'error', error: 'It was stopped.' } : { askId: id, state: 'done', speak: a.text }
    const st = handoff.status(id)
    if (!st.open) return null
    if (st.phase === 'queued') return { askId: id, state: 'queued' }
    return { askId: id, state: 'working', ...(st.words ? { status: { text: st.words, secs: st.sec ?? null, tokens: null } } : {}) }
  }
  /** The host's context (its last turns as role/text) into the brief's pairs. */
  function fastBriefContext(ctx: { history: { role: 'user' | 'assistant'; text: string }[]; openOrders: string[] }) {
    const history: { user: string; assistant: string }[] = []
    for (const h of ctx.history) {
      if (h.role === 'user') history.push({ user: h.text, assistant: '' })
      else if (history.length && !history[history.length - 1].assistant) history[history.length - 1].assistant = h.text
    }
    return { history, openOrders: ctx.openOrders }
  }
  /** What the hub knows right now, for the Assistant's next turn (put in front of it only when it changed). */
  async function fastSnapshot(): Promise<string> {
    const where = whereAll()
    const agents = floors.list().flatMap(f => f.agents.map(a => ({ floor: f.name, name: a.name, role: a.role, state: a.sessionId ? (where[a.sessionId]?.state ?? 'not running') : 'never opened' })))
    const approvals = floors.list().flatMap(f => f.agents.flatMap(a => (a.sessionId && where[a.sessionId]?.state === 'question' ? [{ floor: f.name, agent: a.name }] : [])))
    const open = await tasks.list({ status: 'open', limit: 4 }).catch(() => [])
    const count = (await tasks.counts().catch(() => ({ open: 0 }))).open
    const phones = voice.phone.status().devices.map(d => ({ name: d.name, online: d.online, armed: d.armed }))
    const orders = (fastSession?.openOrderIds() ?? []).map(id => `${id}: ${handoff.status(id).phase ?? 'open'}`)
    const input: SnapshotInput = { agents, approvals, tasks: { open: count, first: open.map(t => t.text) }, phones, build: o.currentBuild?.() ?? null, orders }
    return buildSnapshot(input, namesFor(fastNames))
  }
  const fastOn = o.fastAssistant ?? (process.env.SAD_FAST_ASSISTANT === '1' || existsSync(path.join(o.dir, '..', 'fast-assistant.on')))
  const fastHost: FastHost | undefined =
    fastOn && mode() !== 'member'
      ? createFastHost({
          now: Date.now,
          spawn: (file, args, so) => spawn(file, args, { cwd: so.cwd, env: so.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }),
          claude: () => {
            const c = o.claude ?? findClaude()
            if (!c) return null
            return /\.cmd$/i.test(c) ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/c', c] : [c]
          },
          env: () => librarianEnv(process.env, o.token?.() ?? null),
          dir: path.join(o.dir, 'fast'),
          toolsUrl: () => `${o.apiUrl()}${AGENTIC_PREFIX}/mcp`,
          shim,
          node: process.execPath,
          tools: () => FAST_TOOLS.map(t => `mcp__${MCP_SERVER_NAME}__${t.name}`),
          brief: ctx => buildBrief(fastBriefContext(ctx), namesFor(fastNames)),
          names: () => fastNames,
          toolLabel: name => FAST_LABELS[name] ?? 'One moment',
          onState: st => fastSession?.hostState(st),
          context: () => (fastSession?.openOrderIds() ?? []).map(id => `${id}: ${handoff.status(id).gist ?? 'handed over'}`),
          memory: readMemory,
          kill: async (pid, startedAt) => {
            await killTree(pid, { since: startedAt })
          },
          log: o.log?.child('fast'),
          ...o.fastHostDeps,
        })
      : undefined
  // F-086/F-087: the session around the host (owners, the two sockets, hand-off routing); null host = the Assistant is off and its sockets are refused.
  fastSession = createFastSession({ host: fastHost ?? null, snapshot: fastSnapshot, names: () => namesFor(fastNames), log: o.log?.child?.('fast') ?? o.log })
  handoff.listen({
    onReturn: async (order, reply) => {
      // The reply arrives as '[reply from <name> on <floor> to order <id>] <answer>': the answer is what is shown and told.
      const text = reply.replace(/^\[reply from [^\]]*\]\s*/, '')
      if (order.cancelled) cancelledOrders.add(order.id)
      orderAnswers.set(order.id, { text, at: Date.now(), cancelled: order.cancelled === true })
      return fastSession!.answered(order.id, order.gist, text, order.cancelled === true) === 'told'
    },
    onProgress: p => fastSession!.progress(p.orderId, p.phase, p.sec, p.words),
  })
  const voiceTimer = setInterval(() => {
    if (mode() !== 'member') voice.tick()
    void fastHost?.tick()
  }, 1000)
  voiceTimer.unref?.()

  const heartbeatOn = o.heartbeat ?? process.env.SAD_HEARTBEAT !== '0'
  const heartbeatTimer = setInterval(() => {
    if (heartbeatOn && mode() !== 'member' && !closing) void heartbeat.tick()
  }, 15_000)
  heartbeatTimer.unref?.()

  /** The id of the order a message from `agent` to `toSid` is, or null when it is none (not the Assistant's, or an acknowledgement or a reply). */
  function orderFrom(floor: Floor, agent: FloorAgent, sid: string, toSid: string, body: string): string | null {
    if (!orderReplies() || mode() === 'member' || !isOrchestratorAgent(floor.name, agent)) return null
    const target = bySession(toSid)
    if (!target || isOrchestratorAgent(target.floor.name, target.agent)) return null
    return orders.plan(sid, toSid, body)
  }
  function openOrder(id: string, fromSid: string, toSid: string, body: string) {
    const target = bySession(toSid)
    if (target) orders.open(id, fromSid, { sessionId: toSid, agent: target.agent.name, floor: target.floor.name }, body)
  }

  /** F-086/F-087: a call from the fast Assistant's process. Its list is fast-tools.ts and is checked here, by the key, at every call. */
  async function fastCall(name: string, rawArgs: unknown): Promise<string> {
    const names = namesFor(fastNames)
    const denied = fastDenied(name, rawArgs, names)
    if (denied) throw apiError(403, denied)
    const args = isObject(rawArgs) ? rawArgs : {}
    switch (name) {
      case 'hand_off': {
        const text = typeof args.text === 'string' ? args.text : ''
        const origin = fastSession?.currentOrigin() ?? null
        const r = await handoff.handOff(text, { kind: origin?.kind ?? 'web', ...(origin ? { client: origin.clientId, askId: origin.askId } : {}) }, names.fast)
        if (!r.ok) return json({ ok: false, reason: r.reason, note: 'Nothing was handed over. Tell him why in one sentence; do not try again yourself.' })
        if (origin) fastSession?.handedOff(r.orderId, origin, `Asked ${names.big.replace(/^the /, 'the ')}: ${handoff.status(r.orderId).gist ?? text.slice(0, 80)}`)
        return json({ ok: true, orderId: r.orderId, phase: r.phase, note: `Handed to ${names.big}. Tell him in one short sentence that you have asked and will come back with the answer; do not say it is done.` })
      }
      case 'order_status': {
        const id = typeof args.orderId === 'string' ? args.orderId : ''
        const ids = id ? [id] : (fastSession?.openOrderIds() ?? [])
        return json({ orders: ids.map(i => (cancelledOrders.has(i) ? { orderId: i, open: false, phase: 'cancelled' } : handoff.status(i))) })
      }
      case 'approvals_waiting': {
        const where = whereAll()
        const waiting = floors.list().flatMap(f => f.agents.flatMap(a => (a.sessionId && where[a.sessionId]?.state === 'question' ? [{ agent: a.name, floor: f.name }] : [])))
        return json({ count: waiting.length, waiting, note: 'He answers these himself in Approvals; you cannot.' })
      }
      default: {
        // The reads and task_add: run as an agent that belongs to the Orchestrator's floor (its memory, its floor's roster), under the Assistant's own name.
        const at = assistantAt()
        if (!at) throw apiError(409, 'There is no Orchestrator chat on this PC yet.')
        const agent = { ...at.a, id: 'fast-assistant', name: names.fastName, role: 'Fast assistant', isBoss: false, sessionId: null } as unknown as FloorAgent
        return toolFor('', name, rawArgs, { floor: at.f, agent })
      }
    }
  }

  async function callTool(key: string, name: string, rawArgs: unknown): Promise<string> {
    if (fastHost?.keyOwns(key)) return fastCall(name, rawArgs)
    const me = chats.byKey(key)
    if (!me) throw apiError(401, "This chat's key isn't known: its terminal was closed or the agent restarted. Open the chat from the floor again.")
    if (mode() === 'member') return request<string>(needHub(), 'tool', { sessionId: me.sessionId, name, arguments: rawArgs })
    return toolFor(me.sessionId, name, rawArgs)
  }

  /** A tool call from the chat `sid` (running here, or on a member that passed it on). */
  async function toolFor(sid: string, name: string, rawArgs: unknown, as?: { floor: Floor; agent: FloorAgent }): Promise<string> {
    const mine = as ?? floors.bySession(sid)
    if (!mine) throw apiError(409, "This chat isn't an agent on a floor any more.")
    const { floor, agent } = mine
    const args = isObject(rawArgs) ? rawArgs : {}
    const tag = `${agent.name}, chat ${sid.slice(0, 8)}`
    // F-118: a chat does what its OWNER may. The owner of the app (every chat there was before) is unchanged.
    const me = access.asChat(agent)
    const toolWhere = `tool ${name}`
    if (ADMIN_TOOLS.has(name) && !access.isAdmin(me)) {
      o.auth?.deny(me, 403, 'admin-only', toolWhere, sid)
      throw authError(403, 'That tool is for the owner of this app.', 'admin-only')
    }
    /** The agent that holds chat `sessionId`, and whether `me` has this much on it (a chat on no floor is the owner of the app's). */
    const mayOn = (sessionId: unknown, need: Need) => {
      const at = typeof sessionId === 'string' ? bySession(sessionId) : null
      if (at) return access.needChat(me, at.agent, need, toolWhere)
      if (!access.isAdmin(me)) throw authError(403, "That chat isn't yours.", 'not-yours')
    }

    switch (name) {
      // F-029: the whole app.
      case 'app_chats': {
        const where = whereAll()
        const last = lastAll()
        const rows = floors.list().flatMap(f =>
          f.agents.filter(a => access.rights(me, a) !== null).map(a => {
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
        mayOn(target.sessionId, 'view')
        return readChat(target, typeof args.lines === 'number' ? Math.min(500, args.lines) : 100)
      }
      case 'app_read_conversation': {
        if (typeof args.sessionId !== 'string' || !args.sessionId) throw apiError(400, 'sessionId is missing')
        mayOn(args.sessionId, 'view')
        const file = findTranscript(args.sessionId, projectsDir)
        if (!file) throw apiError(404, `There is no conversation ${args.sessionId} on the hub`)
        const n = typeof args.last === 'number' ? Math.max(1, Math.min(200, args.last)) : 20
        return json(readTranscriptFile(file).slice(-n).map(m => ({ role: m.role, at: m.timestamp, text: m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text, tools: m.tools })))
      }
      case 'app_send_to_chat': {
        const target = anyChat(args.sessionId)
        if (target.sessionId === sid) throw apiError(400, "That's your own chat")
        mayOn(target.sessionId, 'type')
        const body = text(args.text, 'text')
        // M1: first, so a refusal starts no cooldown and opens no order.
        if (atPrompt(target.sessionId)) throw apiError(409, promptWords(target.sessionId))
        if (hasDraft(target.sessionId)) throw apiError(409, draftWords(target.sessionId))
        const undo = relayAllowed(sid, target.sessionId)
        // F-072: an order from the Assistant is recorded, and its answer comes back by itself.
        const order = orderFrom(floor, agent, sid, target.sessionId, body)
        if (!(await typeIntoOrUndo(undo, target, `[message from ${agent.name} on ${floor.name}, chat ${sid.slice(0, 8)}${order ? `, ${orders.marker(order)}` : ''}] ${body}`))) throw apiError(409, atPrompt(target.sessionId) ? promptWords(target.sessionId) : 'That chat stopped before the message reached it')
        if (order) openOrder(order, sid, target.sessionId, body)
        log?.info(`${agent.name} → chat ${target.sessionId.slice(0, 8)} (another floor or PC): a message`)
        return order ? `Sent to chat ${target.sessionId} as order ${order}. Its answer at the end of its turn comes back to you here by itself ("[reply from ...]"): do not wait for it, and do not ask it to answer.` : `Sent to chat ${target.sessionId}.`
      }
      case 'app_open_chat': {
        const { floor: f, agent: a } = findAgent(args.floor, args.agent)
        access.needChat(me, a, 'owner', toolWhere)
        const pcName = typeof args.pc === 'string' && args.pc.trim() ? args.pc.trim().toLowerCase() : null
        const pc = pcName ? pcs().find(p => p.name.toLowerCase() === pcName || p.id === args.pc) : null
        if (pcName && !pc) throw apiError(404, `No PC called ${String(args.pc)} within reach; app_chats lists them`)
        const opened =
          pc && !pc.here
            ? await request<ChatOpened>(peerOf(pc.id), 'open', { floorId: f.id, agentId: a.id }, 60_000)
            : await openChat(f.id, a.id, { takeOver: args.takeOver === true })
        return json({ ...opened, agent: a.name, floor: f.name, pc: pc?.name ?? self().name })
      }
      case 'prepare_send': {
        // F-076: only the overlay Assistant, and only a proposal: nothing is typed anywhere. Shubham sees the card and sends it with his own tap.
        if (!isOrchestratorAgent(floor.name, agent)) throw apiError(403, 'Only the overlay assistant prepares cards for Shubham to send.')
        const card = prepareCard(args.floor, args.agent, args.text, args.why)
        log?.info(`${agent.name} prepared a card for ${card.agentName} on ${card.floorName}`)
        return `Prepared for Shubham: "${card.text.slice(0, 120)}" to ${card.agentName} on ${card.floorName}. It is on his Send tab; only his own tap sends it.`
      }
      case 'app_set_effort': {
        // F-049: kept on the agent (its chat starts with --effort every time) and, when its chat
        // is running and waiting, typed into it as /effort, which sets this session's at once.
        const { floor: f, agent: a } = findAgent(args.floor, args.agent)
        access.needChat(me, a, 'owner', toolWhere)
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
        if (atPrompt(a.sessionId)) return `${kept}. ${promptWords(a.sessionId)}`
        if (!(await typeInto({ sessionId: a.sessionId, id: w.id }, `/effort ${level}`, { human: true }))) return `${kept}; its chat stopped before it could be set now.`
        log?.info(`${agent.name} set ${a.name}'s effort to ${level}`)
        return `${kept}, and its running chat (on ${w.name}) is on ${level} now: /effort ${level} was typed into it.`
      }
      case 'app_stop_chat': {
        const target = anyChat(args.sessionId)
        if (target.sessionId === sid) throw apiError(400, "That's your own chat")
        mayOn(target.sessionId, 'owner')
        stopAnywhere(target.sessionId)
        return `Stopping chat ${target.sessionId}.`
      }
      case 'list_chats': {
        const byId = new Map(floor.agents.map(a => [a.id, a]))
        const others = Object.entries(whereAll())
          .filter(([s]) => s !== sid)
          .map(([s, w]) => ({ s, w, at: floors.bySession(s) }))
          .filter(x => x.at?.floor.id === floor.id && access.rights(me, x.at.agent) !== null)
          .map(({ s, w, at }) => ({ sessionId: s, agent: at!.agent.name, role: byId.get(at!.agent.id)?.role ?? '', doing: w.state, pc: w.name }))
        return json({ floor: floor.name, you: agent.name, chats: others })
      }
      case 'floor_roster':
        return json(rosterOf({ ...floor, agents: floor.agents.filter(a => a.id === agent.id || access.rights(me, a) !== null) }, agent))
      case 'watchdog_status':
        return json(watchdogView())
      // F-085: the Update button's push, from the PC. The overlay assistant and the Mobile chat (floor Final), as for the phone's hands.
      case 'phone_update': {
        if (!phoneUser(floor.name, agent)) {
          throw apiError(403, "Only the overlay assistant and the Mobile chat can ask Shubham's phone to update.")
        }
        if (mode() === 'member') throw apiError(409, 'The phone is reached through the hub; ask from the hub.')
        return json(await voice.updatePhones())
      }
      case 'read_chat': {
        const c = siblingOf(floor, args.sessionId)
        mayOn(c.sessionId, 'view')
        return readChat(c, typeof args.lines === 'number' ? args.lines : 100)
      }
      case 'send_to_chat': {
        const c = siblingOf(floor, args.sessionId)
        if (c.sessionId === sid) throw apiError(400, "That's your own chat")
        mayOn(c.sessionId, 'type')
        const body = text(args.text, 'text')
        // M1: first, so a refusal starts no cooldown and opens no order.
        if (atPrompt(c.sessionId)) throw apiError(409, promptWords(c.sessionId))
        if (hasDraft(c.sessionId)) throw apiError(409, draftWords(c.sessionId))
        const undo = relayAllowed(sid, c.sessionId)
        const order = orderFrom(floor, agent, sid, c.sessionId, body)
        if (!(await typeIntoOrUndo(undo, c, `[message from ${tag}${order ? `, ${orders.marker(order)}` : ''}] ${body}`))) throw apiError(409, atPrompt(c.sessionId) ? promptWords(c.sessionId) : 'That chat stopped before the message reached it')
        if (order) openOrder(order, sid, c.sessionId, body)
        log?.info(`${agent.name} → chat ${c.sessionId.slice(0, 8)}: a message`)
        return order ? `Sent to chat ${c.sessionId} as order ${order}. Its answer at the end of its turn comes back to you here by itself ("[reply from ...]"): do not wait for it, and do not ask it to answer.` : `Sent to chat ${c.sessionId}.`
      }
      case 'broadcast_to_chats': {
        const body = text(args.text, 'text')
        const t = Date.now()
        if (t - (broadcastLast.get(floor.id) ?? 0) < BROADCAST_COOLDOWN_MS) throw apiError(429, 'This floor just had a broadcast; wait a few seconds.')
        broadcastLast.set(floor.id, t)
        const all = Object.entries(whereAll())
          .filter(([s]) => s !== sid && floors.bySession(s)?.floor.id === floor.id)
          .filter(([s]) => {
            const at = floors.bySession(s)
            const r = at ? access.rights(me, at.agent) : null
            return !at || (r !== null && r.can !== 'view')
          })
          .map(([s, w]) => ({ sessionId: s, id: w.id, asking: atPrompt(s), drafting: hasDraft(s) }))
        // M1: a chat at a prompt is skipped, not pressed Enter on. A chat with his unsent text in its box is skipped too.
        const to = all.filter(c => !c.asking && !c.drafting)
        const skipped = all.filter(c => c.asking)
        const drafts = all.filter(c => !c.asking && c.drafting)
        // A chat on a member PC reports a draft back (409): it is counted with the skipped ones.
        const refused = (await Promise.all(to.map(c => typeInto(c, `[broadcast from ${tag}] ${body}`).then(() => null, () => c)))).filter((c): c is NonNullable<typeof c> => c !== null)
        if (refused.length) {
          drafts.push(...refused)
          to.splice(0, to.length, ...to.filter(c => !refused.includes(c)))
        }
        const nameOf = (c: { sessionId: string }) => floors.bySession(c.sessionId)?.agent.name ?? c.sessionId.slice(0, 8)
        return `Sent to ${to.length} chat${to.length === 1 ? '' : 's'}.${skipped.length ? ` Skipped ${skipped.length} waiting at a prompt (Approvals tab): ${skipped.map(nameOf).join(', ')}.` : ''}${drafts.length ? ` Skipped ${drafts.length} with unsent text in the box (try again shortly): ${drafts.map(nameOf).join(', ')}.` : ''}`
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
        if (args.mode === 'keyword' || !memoryOn || !access.isAdmin(me)) return json({ entries })
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
        return memoryOn && access.isAdmin(me) ? (await memoryLayer()).recall({ sessionId: sid, prompt: typeof args.prompt === 'string' ? args.prompt : '' }) : ''
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
      // F-070: the overlay assistant's hands. Only that agent: nobody else moves Shubham's screen.
      case 'ui_screen':
      case 'ui_control':
      case 'ui_modules':
      case 'ui_invoke': {
        if (!isOrchestratorAgent(floor.name, agent)) throw apiError(403, "Only the overlay assistant moves Shubham's screen; ask it (it is the sparkle button in the app).")
        const out = await ui.call(
          name === 'ui_screen' ? 'screen' : name === 'ui_modules' ? 'modules' : name === 'ui_invoke' ? 'invoke' : typeof args.action === 'string' ? args.action : '',
          args,
        )
        return typeof out === 'string' ? out : json(out)
      }
      // F-082: the overlay assistant's hands on the phone; F-084 H2: the Mobile agent's chat (floor Final) too, nobody else. The hub
      // (phone.ts) carries the phone's own answers. Who asked is taken from the chat's identity (phoneUser), never from an argument, and goes
      // with the command to the phone's action log and notification.
      case 'phone_screen':
      case 'phone_control': {
        const by = phoneUser(floor.name, agent)
        if (!by) throw apiError(403, "Only the overlay assistant and the Mobile agent use Shubham's phone; ask the Assistant (it is the sparkle button in the app).")
        if (mode() === 'member') throw apiError(409, 'The phone is reached through the hub; ask from the hub.')
        const device = typeof args.device === 'string' ? args.device : undefined
        const op = name === 'phone_screen' ? 'screen' : typeof args.action === 'string' ? args.action : ''
        return voice.phone.call(device, op, args, by)
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
        }, access.ownerOf(me))
        log?.info(`${agent.name} hired ${hired.name} on ${floor.name}`)
        return json({ hired: hired.name, role: hired.role, effort: hired.effort || 'inherit', total: after.agents.length, note: 'No chat is started yet; the human opens it from the floor.' })
      }
      // F-079: Shubham's WhatsApp. Only the overlay assistant, and it only reads and drafts (agent/whatsapp/tools.ts).
      case 'wa_status':
      case 'wa_chats':
      case 'wa_read':
      case 'wa_prepare_send': {
        if (!isOrchestratorAgent(floor.name, agent)) throw apiError(403, "Only the overlay assistant uses Shubham's WhatsApp; ask it (it is the sparkle button in the app).")
        const wa = o.whatsapp?.()
        if (!wa) throw apiError(409, "WhatsApp isn't on in this app: it runs on the hub.")
        return waTool(wa, name, args)
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

  /** The floors, live states and the rest as one caller may see them (F-118): their own and the shared ones, or all for sbskrrt. */
  function answerFloors(c: Caller = OPEN, scope?: string | null): FloorsAnswer {
    const want = scope === 'mine' || scope === 'shared' || scope === 'all' ? scope : undefined
    const all = allFloors()
    const seen = access.visible(c, all)
    const mine = <T>(m: Record<string, T>) => (seen ? Object.fromEntries(Object.entries(m).filter(([sid]) => seen.has(sid))) : m)
    return { floors: access.scope(c, all, want), live: mine(chats.states()), elsewhere: mine(elsewhere()), last: mine(lastAll()), team: teamInfo(), defaultCodeDir }
  }

  /** F-118: replaces who a chat is shared with. People are named by CRM id; their names are the CRM's, from the sign-in directory. */
  function shareChat(floorId: string, agentId: string, body: unknown) {
    if (!isObject(body) || !Array.isArray(body.users)) throw apiError(400, "Expected {users: [{id, can: 'view' | 'type'}]}")
    if (body.users.length > 64) throw apiError(400, 'At most 64 people')
    const known = new Map((o.auth?.directory() ?? []).map(u => [u.id, u]))
    const list: ChatShare[] = []
    for (const u of body.users) {
      if (!isObject(u) || typeof u.id !== 'string' || !u.id) throw apiError(400, 'Each person is {id, can}')
      if (u.can !== 'view' && u.can !== 'type') throw apiError(400, "can is 'view' or 'type'")
      const who = known.get(u.id.toLowerCase())
      if (!who && o.auth) throw apiError(404, `Nobody with id ${u.id.slice(0, 40)} in the CRM's member list`)
      list.push({ id: u.id.toLowerCase(), username: who?.username ?? '', name: who?.name ?? '', can: u.can })
    }
    const floor = floors.setShare(floorId, agentId, list)
    log?.info(`chat ${(agentOf(floor, agentId).sessionId ?? '-').slice(0, 8)} is shared with ${list.map(x => `${x.username || x.id.slice(0, 8)} (${x.can})`).join(', ') || 'nobody'}`)
    return { agent: agentOf(floor, agentId) }
  }

  function patchFloor(id: string, body: unknown, as?: ChatOwner) {
    if (!isObject(body)) throw apiError(400, 'Expected {name?, globalPrompt?, codeDir?, agents?}')
    const before = floorOf(id)
    if (typeof body.codeDir === 'string' && body.codeDir.trim()) checkFolder(body.codeDir)
    const floor = floors.patch(id, body as FloorPatch, as)
    // An agent taken off the floor takes its running chat with it, wherever it runs.
    const kept = new Set(floor.agents.map(a => a.id))
    for (const a of before.agents) if (!kept.has(a.id) && a.sessionId) stopAnywhere(a.sessionId)
    return { floor }
  }

  // ---------------------------------------------------------------------------------------
  // F-069: the files sent to a chat. The page sends one to the PC it is on; that PC passes it to the PC the
  // chat runs on (or, if it is not running, lives on) a megabyte at a time through the hub, where claude is
  // told to read it by its path. One already sent is fetched the same way for its thumbnail.

  /** The PC a file for this agent's chat goes to: where it runs, else where it lives (its home), else this one. */
  function attachTarget(agent: FloorAgent): { id: string; name: string } {
    const w = agent.sessionId ? whereAll()[agent.sessionId] : undefined
    if (w) return { id: w.id, name: w.name }
    if (agent.homePc && agent.homePc !== self().id) {
      const home = pcs().find(p => p.id === agent.homePc)
      if (!home) throw apiError(HOME_OFFLINE_STATUS, `${agent.homePcName ?? 'Its PC'} is offline, and ${agent.name}'s chat lives there, so a file can't be sent to it now`)
      return { id: home.id, name: home.name }
    }
    return { id: self().id, name: self().name }
  }

  /** Where the pieces of a file for `to` are sent from this PC: straight to it, or (a member) through the hub. */
  function attachLink(to: string): LinkPeer {
    return mode() === 'member' ? needHub() : peerOf(to)
  }

  async function deliverFile(to: { id: string; name: string }, file: string, bytes: Buffer): Promise<string> {
    const n = Math.max(1, Math.ceil(bytes.length / PIECE_BYTES))
    if (to.id === self().id) {
      for (let i = 0; i < n; i++) uploads.put(file, i, n, bytes.subarray(i * PIECE_BYTES, (i + 1) * PIECE_BYTES))
      return uploads.pathOf(file)
    }
    const link = attachLink(to.id)
    let where = ''
    for (let i = 0; i < n; i++) {
      const data = bytes.subarray(i * PIECE_BYTES, (i + 1) * PIECE_BYTES).toString('base64')
      const r = await request<{ done: boolean; path?: string }>(link, 'attach-put', { to: to.id, file, i, n, data }, 60_000).catch((e: unknown) => {
        throw apiError(503, `${to.name} can't take the file now: ${message(e)}`)
      })
      if (r.path) where = r.path
    }
    return where
  }

  /** A piece of a file arriving over the link: kept here, or (the hub, for another PC) passed on. */
  async function attachPutPeer(raw: unknown): Promise<{ done: boolean; path?: string }> {
    if (!isObject(raw) || typeof raw.file !== 'string' || typeof raw.data !== 'string' || typeof raw.i !== 'number' || typeof raw.n !== 'number') throw apiError(400, 'Expected {file, i, n, data}')
    if (typeof raw.to === 'string' && raw.to !== self().id) {
      if (mode() !== 'hub') throw apiError(403, 'Only the hub passes files on')
      return request(peerOf(raw.to), 'attach-put', raw, 60_000)
    }
    if (!isStoredName(raw.file)) throw apiError(400, 'That is not a name this PC keeps files under')
    const done = uploads.put(raw.file, raw.i, raw.n, Buffer.from(raw.data, 'base64'))
    return done ? { done, path: uploads.pathOf(raw.file) } : { done }
  }

  async function attachGetPeer(raw: unknown): Promise<{ data: string; size: number }> {
    if (!isObject(raw) || typeof raw.file !== 'string' || typeof raw.offset !== 'number') throw apiError(400, 'Expected {file, offset}')
    if (typeof raw.to === 'string' && raw.to !== self().id) {
      if (mode() !== 'hub') throw apiError(403, 'Only the hub passes files on')
      return request(peerOf(raw.to), 'attach-get', raw, 60_000)
    }
    const size = uploads.size(raw.file)
    if (size === null) throw apiError(404, "That file isn't here")
    return { data: uploads.read(raw.file, raw.offset, PIECE_BYTES).toString('base64'), size }
  }

  async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > max) throw apiError(413, `A file may be ${Math.round(max / 1024 / 1024)} MB at most`)
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }

  const reply = (res: ServerResponse, status: number, data: unknown) => {
    const body = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  /** POST …/agents/:id/attach?name=photo.jpg, the file as the body: kept on the chat's PC; answers where. */
  async function attachUpload(req: IncomingMessage, res: ServerResponse, floorId: string, agentId: string, url: URL) {
    if (req.method !== 'POST') throw apiError(405, 'POST the file')
    const agent = agentOf(floorOf(floorId), agentId)
    const bytes = await readBody(req, ATTACH_MAX_BYTES)
    if (!bytes.length) throw apiError(400, 'That file is empty')
    const name = safeName(url.searchParams.get('name') ?? 'file')
    const to = attachTarget(agent)
    const file = storedName(name)
    const where = await deliverFile(to, file, bytes)
    log?.info(`a file for ${agent.name}'s chat (${bytes.length} bytes) kept on ${to.name}`)
    reply(res, 200, { file, path: where, name, size: bytes.length, pc: to.name })
  }

  /** GET …/agents/:id/attachment/:file: a file sent to that chat: from this PC, else from the PC the chat is on. */
  async function attachDownload(req: IncomingMessage, res: ServerResponse, floorId: string, agentId: string, file: string) {
    if (req.method !== 'GET') throw apiError(405, 'GET the file')
    if (!isStoredName(file)) throw apiError(400, 'That is not a name this PC keeps files under')
    const agent = agentOf(floorOf(floorId), agentId)
    const { type, inline } = contentTypeOf(file)
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'private, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.replace(/^[^-]+-[^-]+-/, '').replace(/"/g, '')}"`,
    }
    const size = uploads.size(file)
    if (size !== null) {
      res.writeHead(200, { ...headers, 'Content-Length': size })
      createReadStream(uploads.pathOf(file)).pipe(res)
      return
    }
    // Not here: the PC the chat runs on, or lives on, may have it.
    const w = agent.sessionId ? whereAll()[agent.sessionId] : undefined
    const holders = [w?.id, agent.homePc].filter((id, i, all): id is string => !!id && id !== self().id && all.indexOf(id) === i)
    for (const id of holders) {
      let link: LinkPeer
      try {
        link = attachLink(id)
      } catch {
        continue
      }
      try {
        const parts: Buffer[] = []
        let total = 0
        for (;;) {
          const r = await request<{ data: string; size: number }>(link, 'attach-get', { to: id, file, offset: total }, 60_000)
          const buf = Buffer.from(r.data, 'base64')
          parts.push(buf)
          total += buf.length
          if (!buf.length || total >= r.size) break
        }
        res.writeHead(200, { ...headers, 'Content-Length': total })
        res.end(Buffer.concat(parts))
        return
      } catch {
        // That PC hasn't got it (or can't be reached): the next.
      }
    }
    throw apiError(404, "That file isn't on this PC or the one the chat is on")
  }

  // ---------------------------------------------------------------------------------------
  // F-076: approvals and send-as-me. Human-only: these routes take the page's own request; a request that carries
  // a chat's key (what an agent's tools use) is refused here, and no MCP tool answers a prompt or sends as the person.

  function humanOnly(r: MountRequest) {
    if (r.headers['x-sad-chat-key'] !== undefined) throw apiError(403, "Only the person's own taps answer a prompt or send as them: this is not for a chat.")
  }
  const byOf = (r: MountRequest) => `the app (${String(r.headers['user-agent'] ?? 'a browser').replace(/\s+/g, ' ').slice(0, 90)})`

  /**
   * The proof an approval or a send carries: the signature of a registered approval device over exactly what was asked.
   * Without one it is refused, unless the old way is switched on in Settings (off to start with). Says who it was, for the log.
   */
  function humanProof(kind: SignedKind, fields: (string | number | boolean)[], signed: unknown, r?: ProofRequest): string {
    if (signed !== undefined && signed !== null) return `device "${approvalDevices.verify(kind, fields, signed).name}"`
    // F-124: "Sign-in is enough": a browser signed in as sbskrrt (a real F-118 session; the unsigned open app never counts) stands in for the device.
    const signedIn = ownerCodeBy(r, false)
    if (signedIn) return signedIn
    if (approvalDevices.unsignedAllowed()) return 'an unsigned request (the old way, switched on in Settings)'
    if (approvalDevices.count() === 0) throw apiError(403, 'No approval device is registered yet. Open Settings › Approval device on your phone and register it.')
    throw apiError(401, 'This needs a signature from a registered approval device (your phone). Open it there.')
  }

  /**
   * F-081: Apply new builds automatically when quiet. Turning it ON needs the signature of a registered approval device
   * (never the old unsigned way: this one is about his machine restarting by itself); turning it off needs nothing.
   */
  function setAutoUpdate(raw: unknown, by: string, r?: ProofRequest) {
    if (!isObject(raw) || typeof raw.on !== 'boolean') throw apiError(400, 'Expected {on, sig}')
    let who = 'a tap (off needs no signature)'
    if (raw.on) {
      // F-124: a signed-in sbskrrt may switch it on without a device when Sign-in is enough; never the unsigned old way.
      const signedIn = raw.sig !== undefined && raw.sig !== null ? null : ownerCodeBy(r, false)
      if (signedIn) who = signedIn
      else {
        if (approvalDevices.count() === 0) throw apiError(403, 'No approval device is registered yet. Register your phone in Settings › Approval device first.')
        who = `device "${approvalDevices.verify('autoupdate', [true], raw.sig).name}"`
      }
    }
    const st = autoUpdate.set(raw.on, `${who} via ${by}`)
    deviceLog(`Automatic updates when quiet switched ${raw.on ? 'ON' : 'off'}`, `${who} via ${by}`)
    log?.info(`automatic updates when quiet: ${raw.on ? 'on' : 'off'}`)
    return st
  }

  const devicesAnswer = (): DevicesAnswer => ({ devices: approvalDevices.list(), unsignedAllowed: approvalDevices.unsignedAllowed(), bootstrap: approvalDevices.count() === 0 })

  const deviceLog = (detail: string, by: string) => approvalLog.add({ kind: 'device', floor: '', agent: '', pc: self().name, sessionId: '', detail, by })

  /**
   * F-122: the other way to be given a code (to add an approval device, or to pair Chris): a browser SIGNED IN as the owner of the app
   * (sbskrrt, F-118's session), on any device, unless Settings turned it off ("approval devices only"). A registered device's signature
   * is tried first and works exactly as before. "Unsigned, acting as sbskrrt" at sign-in level off does NOT count (as with Publish): it must
   * be a real session, since every tailnet device can open the Server's page. Says who and from where, for the log; null when it does not apply.
   */
  function ownerCodeBy(r: ProofRequest | undefined, browser = true): string | null {
    const c = r?.caller
    if (!r || !o.auth || !o.auth.signInEnough() || c?.person?.canSeeAll !== true) return null
    const login = r.headers['x-sad-via-login']
    const where = c.via === 'tailnet' ? `over the tailnet${typeof login === 'string' && login ? ` as ${login.slice(0, 80)}` : ''}` : 'on this PC'
    return `${c.person.username} (${c.person.id.slice(0, 8)}) signed in, ${where}${browser ? `, ${byOf(r as MountRequest)}` : ''}`
  }

  /** A one-time code to add a device: the first one needs nothing (there is nobody to sign); after that, a registered device's signature, or (F-122) sbskrrt signed in. */
  function deviceCode(raw: unknown, r?: MountRequest) {
    const body = isObject(raw) ? raw : {}
    let who = 'the first device (nobody to sign yet)'
    if (approvalDevices.count() > 0) who = `${humanProof('code', [], body.sig, r)}${r ? ` via ${byOf(r)}` : ''}`
    // The person and the device are logged, never the code.
    deviceLog('A code to add an approval device was made', who)
    recoveryCode = null
    return approvalDevices.newCode()
  }

  // Recovery from this PC (order o4a52): when no registered device can sign, a Windows administrator prompt on this PC lets ONE new device register.
  // agent/agentic/approval-recovery.ts has the why and the checks; these are its routes. Every step goes in the approvals log.
  const deviceRecovery = createDeviceRecovery({ elevation: o.recoveryElevation ?? windowsElevation(), note: (detail, by) => deviceLog(detail, by) })
  /** The code the last accepted recovery gave: a registration with it is logged as "after a Windows administrator prompt". */
  let recoveryCode: string | null = null

  const recoverStart = (by: string): RecoveryStarted => deviceRecovery.start(by)

  async function recoverFinish(by: string, body: unknown): Promise<RecoveryFinished> {
    await deviceRecovery.finish(by, isObject(body) ? body.ticket : undefined)
    const c = approvalDevices.newCode()
    recoveryCode = c.code
    return { ...c, ...devicesAnswer() }
  }

  /** The page address from the Origin header, unless it is the remote gate's own loopback value (the gate rewrites the header, so it says nothing about the page). */
  function headerOrigin(h: string | string[] | undefined): string | undefined {
    const o1 = cleanOrigin(Array.isArray(h) ? h[0] : h)
    if (!o1) return undefined
    const u = new URL(o1)
    return u.hostname === '127.0.0.1' && u.port === '4740' ? undefined : o1
  }

  function deviceRegister(raw: unknown, by: string, header?: string | string[]) {
    if (!isObject(raw)) throw apiError(400, 'Expected {name, jwk, code}')
    // The page says where it is (location.origin): the gate rewrites the Origin header, so the header is only a fallback. Information only.
    const origin = cleanOrigin(raw.origin) ?? headerOrigin(header)
    const viaRecovery = recoveryCode !== null && raw.code === recoveryCode
    const d = approvalDevices.register(raw.name, raw.jwk as PublicJwk, raw.code, origin)
    if (viaRecovery) recoveryCode = null
    deviceLog(`Approval device registered: ${d.name} (${d.id})${d.origin ? ` from ${d.origin}` : ''}`, viaRecovery ? `${by} after a Windows administrator prompt` : by)
    log?.info(`approval device registered: ${d.name}`)
    return { device: d, ...devicesAnswer() }
  }

  function deviceRemove(raw: unknown, by: string, r?: ProofRequest) {
    if (!isObject(raw) || typeof raw.device !== 'string') throw apiError(400, 'Expected {device, sig}')
    const who = humanProof('remove', [raw.device], raw.sig, r)
    if (!approvalDevices.remove(raw.device)) throw apiError(404, 'No such approval device')
    deviceLog(`Approval device removed: ${raw.device}`, `${who} via ${by}`)
    return devicesAnswer()
  }

  /** The old way (requests with no signature) on or off. Changing it needs a registered device's signature, once there is one. */
  function deviceUnsigned(raw: unknown, by: string, r?: ProofRequest) {
    if (!isObject(raw) || typeof raw.on !== 'boolean') throw apiError(400, 'Expected {on, sig}')
    const who = approvalDevices.count() > 0 ? humanProof('unsigned', [raw.on], raw.sig, r) : 'nobody (no device is registered)'
    approvalDevices.setUnsignedAllowed(raw.on)
    deviceLog(`Unsigned approvals ${raw.on ? 'switched ON (the old way)' : 'switched off'}`, `${who} via ${by}`)
    return devicesAnswer()
  }

  /** A message typed to the agent the way the terminal does it (a paste, then Enter); a chat that isn't running is started or picked back up first, and the message follows once it is ready. */
  async function sayTo(id: string, agentId: string, body: string): Promise<SayAnswer> {
    const agent = agentOf(floorOf(id), agentId)
    const at = agent.sessionId ? whereAll()[agent.sessionId] : undefined
    if (agent.sessionId && at) {
      const fresh = at.id === self().id && Date.now() - Date.parse(chats.info(agent.sessionId)?.startedAt ?? '') < SAY_FRESH_MS
      // Just started, it may still be at claude's own questions (trust this folder...): wait for the prompt.
      if (fresh) chats.typeWhenReady(agent.sessionId, body)
      else if (atPrompt(agent.sessionId)) throw apiError(409, promptWords(agent.sessionId))
      else if (!(await typeInto({ sessionId: agent.sessionId, id: at.id }, body, { human: true }))) throw apiError(409, atPrompt(agent.sessionId) ? promptWords(agent.sessionId) : `${agent.name}'s chat on ${at.name} can't be typed into right now`)
      return { ok: true, started: false }
    }
    // F-064: a chat that lives on another PC is started there, and that PC types the message once it is up.
    const opened = await openChat(id, agentId, { say: body })
    if (!opened.on) chats.typeWhenReady(opened.sessionId, body)
    return { ok: true, started: true }
  }

  /** The keys of a numbered choice, into a chat anywhere (this PC's, or through the link). */
  async function typeKeys(c: { sessionId: string; id: string }, data: string): Promise<boolean> {
    if (c.id === self().id) return chats.input(c.sessionId, data)
    const link = team?.member(c.id)
    if (!link) return false
    return request<boolean>(link, 'keys', { sessionId: c.sessionId, data }).catch(() => false)
  }

  /** Every chat waiting at a prompt, on every floor and PC, with what its screen says. */
  async function listApprovals(): Promise<ApprovalsAnswer> {
    const where = whereAll()
    const waiting = floors.list().flatMap(f => f.agents.flatMap(a => (a.sessionId && where[a.sessionId]?.state === 'question' ? [{ f, a, w: where[a.sessionId], sid: a.sessionId }] : [])))
    const items = await Promise.all(
      waiting.map(async ({ f, a, w, sid }): Promise<ApprovalItem> => {
        const p = await promptOfChat({ sessionId: sid, id: w.id })
        return { sessionId: sid, floorId: f.id, floorName: f.name, agentId: a.id, agentName: a.name, pc: w.name, state: w.state, menu: p.menu, context: p.context, id: p.id, answerable: answerable(p.menu), cancellable: p.cancellable }
      }),
    )
    return { items, prepared: [...prepared.values()].sort((x, y) => y.at.localeCompare(x.at)) }
  }

  /** His tap on option n of the prompt he was shown: typed into that chat exactly as pressing it there. Refused when the prompt has changed since. */
  async function answerApproval(raw: unknown, by: string, r?: ProofRequest) {
    if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.id !== 'string' || typeof raw.n !== 'number') throw apiError(400, 'Expected {sessionId, id, n}')
    const req = raw as unknown as AnswerRequest
    // A registered device signed exactly this prompt and option (or the old way is on): before anything is looked at or typed.
    by = `${humanProof('answer', [req.sessionId, req.id, req.n], req.sig, r)} via ${by}`
    const at = floors.bySession(req.sessionId)
    const w = whereAll()[req.sessionId]
    if (!at || !w) throw apiError(404, "That chat isn't running any more")
    if (w.state !== 'question') throw apiError(409, 'That chat is no longer waiting at a prompt; look again.')
    const p = await promptOfChat({ sessionId: req.sessionId, id: w.id })
    if (!answerable(p.menu)) throw apiError(409, 'That prompt can only be answered in the chat itself.')
    if (p.id !== req.id) throw apiError(409, 'That prompt has changed since you looked at it; look again.')
    const option = p.menu!.options.find(x => x.n === req.n)
    if (!option) throw apiError(400, `The prompt has no option ${req.n}`)
    if (!(await typeKeys({ sessionId: req.sessionId, id: w.id }, String(req.n)))) throw apiError(409, `${at.agent.name}'s chat on ${w.name} can't be answered right now`)
    const detail = `${p.menu!.question || 'A prompt'} → ${option.n}. ${option.label}${p.context ? ` | ${p.context.split('\n').slice(-3).join(' / ')}` : ''}`
    approvalLog.add({ kind: 'answer', floor: at.floor.name, agent: at.agent.name, pc: w.name, sessionId: req.sessionId, detail, by })
    log?.info(`approved for ${at.agent.name} on ${at.floor.name}: option ${option.n}`)
    return { ok: true, answered: `${option.n}. ${option.label}`, agent: at.agent.name, floor: at.floor.name }
  }

  /**
   * His tap on Cancel (Esc) for the prompt he was shown: one Escape key into that chat, only while its screen still shows the same prompt
   * and its footer says "Esc to cancel". Signed like an answer. On a permission prompt Esc means No.
   */
  async function cancelApproval(raw: unknown, by: string, r?: ProofRequest) {
    if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.id !== 'string') throw apiError(400, 'Expected {sessionId, id}')
    const req = raw as unknown as CancelRequest
    by = `${humanProof('cancel', [req.sessionId, req.id], req.sig, r)} via ${by}`
    const at = floors.bySession(req.sessionId)
    const w = whereAll()[req.sessionId]
    if (!at || !w) throw apiError(404, "That chat isn't running any more")
    if (w.state !== 'question') throw apiError(409, 'That chat is no longer waiting at a prompt; look again.')
    const p = await promptOfChat({ sessionId: req.sessionId, id: w.id })
    if (!p.cancellable) throw apiError(409, 'That prompt has no "Esc to cancel"; answer it in the chat itself.')
    if (p.id !== req.id) throw apiError(409, 'That prompt has changed since you looked at it; look again.')
    if (!(await typeKeys({ sessionId: req.sessionId, id: w.id }, ESC_KEY))) throw apiError(409, `${at.agent.name}'s chat on ${w.name} can't be cancelled right now`)
    const detail = `${p.menu?.question || 'A prompt'} → Esc (cancel)${p.context ? ` | ${p.context.split('\n').slice(-3).join(' / ')}` : ''}`
    approvalLog.add({ kind: 'answer', floor: at.floor.name, agent: at.agent.name, pc: w.name, sessionId: req.sessionId, detail, by })
    log?.info(`cancelled (Esc) for ${at.agent.name} on ${at.floor.name}`)
    return { ok: true, agent: at.agent.name, floor: at.floor.name }
  }

  /** His own words, into a chosen agent's chat as plain input: no "[message from ...]", as if typed there. */
  async function sendAsMe(raw: unknown, by: string, rq?: ProofRequest) {
    if (!isObject(raw) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string') throw apiError(400, 'Expected {floorId, agentId, text}')
    const req = raw as unknown as SendAsMeRequest
    const body = text(req.text, 'text', MAX_SAY_TEXT)
    // A registered device signed exactly this target and these words (or the old way is on).
    by = `${humanProof('send', [req.floorId, req.agentId, createHash('sha256').update(body, 'utf8').digest('hex'), typeof req.card === 'string' ? req.card : ''], req.sig, rq)} via ${by}`
    const at = agentOf(floorOf(req.floorId), req.agentId)
    const floor = floorOf(req.floorId)
    const r = await sayTo(req.floorId, req.agentId, body)
    const w = at.sessionId ? whereAll()[at.sessionId] : undefined
    approvalLog.add({ kind: 'send', floor: floor.name, agent: at.name, pc: w?.name ?? self().name, sessionId: at.sessionId ?? '', detail: body, by })
    if (typeof req.card === 'string') prepared.delete(req.card)
    log?.info(`sent as the person to ${at.name} on ${floor.name}`)
    return { ...r, agent: at.name, floor: floor.name }
  }

  /** The assistant's proposal: stored, shown to the person, never sent by anything but his tap. */
  function prepareCard(floorRef: unknown, agentRef: unknown, textArg: unknown, why: unknown): PreparedCard {
    const { floor: f, agent: a } = findAgent(floorRef, agentRef)
    const card: PreparedCard = {
      id: randomUUID(),
      floorId: f.id,
      floorName: f.name,
      agentId: a.id,
      agentName: a.name,
      text: text(textArg, 'text', MAX_SAY_TEXT),
      why: typeof why === 'string' ? why.trim().slice(0, 300) : '',
      at: new Date().toISOString(),
    }
    prepared.set(card.id, card)
    while (prepared.size > PREPARED_MAX) prepared.delete(prepared.keys().next().value as string)
    emit({ t: 'floors', floors: allFloors() })
    return card
  }

  /** F-067: pauses between the commands typed into one chat, so claude has taken the first before the next arrives. */
  const TUNE_GAP_MS = o.tuneGapMs ?? 800

  /**
   * F-067: changes an agent's model, effort and/or ultracode (kept on the agent: its chat starts with them every time)
   * and, when its chat runs and is waiting for the person, types the commands that change them in that chat now
   * (`/model`, `/effort`, `/effort ultracode`). A chat that is working, or at a question, or stopped, takes
   * them at its next start; the answer says which.
   */
  async function tuneAgent(floorId: string, agentId: string, raw: unknown): Promise<TuneAnswer> {
    if (!isObject(raw)) throw apiError(400, 'Expected {model?, effort?, ultracode?}')
    const req: TuneRequest = {}
    if (raw.model !== undefined) {
      if (!(AGENT_MODELS as readonly unknown[]).includes(raw.model)) throw apiError(400, 'model is opus, sonnet, haiku, or "" for the default')
      req.model = raw.model as AgentModel
    }
    if (raw.effort !== undefined) {
      if (!(AGENT_EFFORTS as readonly unknown[]).includes(raw.effort)) throw apiError(400, 'effort is low, medium, high, xhigh, max, or "" for the default')
      req.effort = raw.effort as AgentEffort
    }
    if (raw.ultracode !== undefined) {
      if (!(AGENT_ULTRACODES as readonly unknown[]).includes(raw.ultracode)) throw apiError(400, 'ultracode is "on", "off", or "" for the default')
      req.ultracode = raw.ultracode as AgentUltracode
    }
    if (req.model === undefined && req.effort === undefined && req.ultracode === undefined) throw apiError(400, 'Nothing to change: give model, effort or ultracode')
    const before = floorOf(floorId)
    const a = agentOf(before, agentId)
    const model = req.model ?? a.model
    const effort = req.effort ?? a.effort
    const ultracode = req.ultracode ?? a.ultracode
    const floor = floors.patch(before.id, { agents: before.agents.map(x => (x.id === a.id ? { ...x, model, effort, ultracode } : x)) })

    const d = defaultsNow()
    const effUltra = ultracode ? ultracode === 'on' : d.ultracode
    // What to type: a /effort level turns ultracode off, so with ultracode wanted it is asked for again after one.
    const commands: string[] = []
    if (req.model !== undefined) commands.push(`/model ${model || d.model || 'default'}`)
    if (req.effort !== undefined) {
      commands.push(`/effort ${effort || d.effort || 'auto'}`)
      if (effUltra) commands.push('/effort ultracode')
    } else if (req.ultracode !== undefined) commands.push(effUltra ? '/effort ultracode' : '/effort ultracode off')
    const what = [req.model !== undefined && 'model', req.effort !== undefined && 'effort', req.ultracode !== undefined && 'ultracode'].filter(Boolean).join(' and ')

    const w = a.sessionId ? whereAll()[a.sessionId] : undefined
    if (!w || !a.sessionId) return { floor, applied: 'next', detail: `${a.name}'s ${what} is kept; its chat isn't running, so it applies when the chat next starts.` }
    if (w.state === 'running') return { floor, applied: 'next', detail: `${a.name}'s ${what} is kept; its chat is working right now, so it applies at its next start. Change it again once the chat is waiting to apply it at once.` }
    if (w.state === 'question') return { floor, applied: 'next', detail: `${a.name}'s ${what} is kept; its chat is at a question, so it applies at its next start. Answer it, then change it again to apply it at once.` }
    for (const [i, c] of commands.entries()) {
      if (i > 0) await new Promise(r => setTimeout(r, TUNE_GAP_MS))
      if (!(await typeInto({ sessionId: a.sessionId, id: w.id }, c, { human: true }))) return { floor, applied: 'next', detail: `${a.name}'s ${what} is kept; its chat stopped before it could be set now, so it applies at its next start.` }
    }
    log?.info(`${a.name}: ${commands.join(', ')}`)
    return { floor, applied: 'now', detail: `${a.name}'s ${what} is set in its running chat (on ${w.name}) now: ${commands.join(', ')} ${commands.length > 1 ? 'were' : 'was'} typed into it.` }
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
  async function importChat(floorId: string, body: unknown, as?: ChatOwner): Promise<ChatImported> {
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
        } else agentId = floors.addAgent(floorId, { name, role }, as).agent.id
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
    return { cols: typeof r.cols === 'number' ? r.cols : undefined, rows: typeof r.rows === 'number' ? r.rows : undefined, takeOver: r.takeOver === true, here: r.here === true }
  }

  type Handler = (m: string[], r: MountRequest) => unknown
  /** `local`: a member answers it itself; the rest it passes to its hub, which keeps the floors. */
  const routes: [string, RegExp, Handler, 'local'?][] = [
    // F-083: the watchdog: whether it runs, the heartbeat's last and next beat, and the chats it holds down now.
    ['GET', /^\/watchdog$/, () => watchdogView()],
    // F-086: "What the chats are called": old (the big chat is the Assistant, the fast one Quick) or new (Orchestrator / Assistant). The page sets it; the Assistant's words follow.
    ['GET', /^\/fast\/names$/, () => ({ choice: fastNames })],
    [
      'POST',
      /^\/fast\/names$/,
      (_p, r) => {
        const choice = isObject(r.body) ? r.body.choice : undefined
        if (choice !== 'old' && choice !== 'new') throw apiError(400, "choice is 'old' or 'new'")
        fastNames = choice
        writeAtomic(fastNamesFile, JSON.stringify({ choice }))
        return { choice: fastNames }
      },
      'local',
    ],
    // F-078: the heartbeat's setting and its last and next beat (the overlay shows them); a beat now.
    ['GET', /^\/heartbeat$/, () => heartbeat.state()],
    // F-078: the overlay was opened: the morning summary goes now when it is the first time after 06:00 today.
    ['POST', /^\/heartbeat\/morning$/, async () => ({ sent: await heartbeat.morning({ atOpen: true }) })],
    [
      'PATCH',
      /^\/heartbeat$/,
      (_, r) => {
        if (!isObject(r.body)) throw apiError(400, 'Expected {enabled?, intervalMin?}')
        if (r.body.intervalMin !== undefined && !Number.isInteger(r.body.intervalMin)) throw apiError(400, 'intervalMin is a whole number of minutes (1 to 120)')
        return heartbeat.set({ enabled: typeof r.body.enabled === 'boolean' ? r.body.enabled : undefined, intervalMin: typeof r.body.intervalMin === 'number' ? r.body.intervalMin : undefined })
      },
    ],
    ['POST', /^\/heartbeat\/beat$/, async () => {
        await heartbeat.beat()
        return heartbeat.state()
      }],
    ['GET', /^\/floors$/, (_, r) => answerFloors(callerOf(r), r.query.get('scope')), 'local'],
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
    ['POST', /^\/floors$/, (_, r) => ({ floor: floors.create(isObject(r.body) && typeof r.body.name === 'string' ? r.body.name : undefined, access.ownerOf(callerOf(r))) })],
    [
      'POST',
      /^\/floors\/reorder$/,
      (_, r) => {
        if (!isObject(r.body) || !Array.isArray(r.body.order) || r.body.order.some(x => typeof x !== 'string')) throw apiError(400, 'Expected {order: [floor ids]}')
        return { floors: floors.reorder(r.body.order as string[]) }
      },
    ],
    ['PATCH', /^\/floors\/([^/]+)$/, ([id], r) => patchFloor(id, r.body, access.ownerOf(callerOf(r)))],
    [
      // F-067: Settings › Chats: what an agent set to Default gets. Read from this PC's copy; changed on the hub.
      'GET',
      /^\/defaults$/,
      () => ({ defaults: defaultsNow() }),
      'local',
    ],
    ['PUT', /^\/defaults$/, (_, r) => ({ defaults: chatDefaults.set(r.body) })],
    // F-067: the long-press menu: an agent's model, effort and ultracode, applied now to a chat that waits.
    ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/tune$/, ([id, agentId], r) => tuneAgent(id, agentId, r.body)],
    // F-076: human-only. Answer a waiting chat's prompt from one place; say something as the person. Never a chat's key (it has no route here).
    ['GET', /^\/approvals$/, (_, r) => (humanOnly(r), listApprovals())],
    ['POST', /^\/approvals\/answer$/, (_, r) => (humanOnly(r), answerApproval(r.body, byOf(r), r))],
    ['POST', /^\/approvals\/cancel$/, (_, r) => (humanOnly(r), cancelApproval(r.body, byOf(r), r))],
    ['POST', /^\/send-as-me$/, (_, r) => (humanOnly(r), sendAsMe(r.body, byOf(r), r))],
    ['GET', /^\/auto-update$/, (_, r) => (humanOnly(r), autoUpdate.read())],
    ['POST', /^\/auto-update$/, (_, r) => (humanOnly(r), setAutoUpdate(r.body, byOf(r), r))],
    ['GET', /^\/approvals\/devices$/, (_, r) => (humanOnly(r), devicesAnswer())],
    ['POST', /^\/approvals\/devices\/code$/, (_, r) => (humanOnly(r), deviceCode(r.body, r))],
    ['POST', /^\/approvals\/devices\/register$/, (_, r) => (humanOnly(r), deviceRegister(r.body, byOf(r), r.headers.origin))],
    ['GET', /^\/approvals\/devices\/recover$/, (_, r) => (humanOnly(r), deviceRecovery.status())],
    ['POST', /^\/approvals\/devices\/recover\/start$/, (_, r) => (humanOnly(r), recoverStart(byOf(r)))],
    ['POST', /^\/approvals\/devices\/recover\/finish$/, (_, r) => (humanOnly(r), recoverFinish(byOf(r), r.body))],
    ['POST', /^\/approvals\/devices\/remove$/, (_, r) => (humanOnly(r), deviceRemove(r.body, byOf(r), r))],
    ['POST', /^\/approvals\/devices\/unsigned$/, (_, r) => (humanOnly(r), deviceUnsigned(r.body, byOf(r), r))],
    ['GET', /^\/approvals\/log$/, (_, r) => (humanOnly(r), { entries: approvalLog.list(Math.min(500, Number(r.query.get('limit')) || 100)) })],
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
        return floors.addAgent(id, b as NewAgent, access.ownerOf(callerOf(r)))
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
    [
      // F-118: who a chat is shared with: the whole list, each person 'view' or 'type'. The owner's or sbskrrt's (the rule says so).
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/share$/,
      ([id, agentId], r) => shareChat(id, agentId, r.body),
    ],
    ['POST', /^\/floors\/([^/]+)\/import$/, ([id], r) => importChat(id, r.body, access.ownerOf(callerOf(r))), 'local'],
    ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/chat$/, ([id, agentId], r) => openChat(id, agentId, openRequest(r.body)), 'local'],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/run-on$/,
      async ([id, agentId], r) => {
        // F-025, Run on; F-064, Switch computer: the chat moved to the PC named (taken over there, from wherever it
        // runs), and that PC is its home from then on. A member asks the hub, which can reach every PC.
        const pc = (isObject(r.body) && typeof r.body.pc === 'string' ? r.body.pc : '') || self().id
        // A message to type once it is up (a message sent to a stopped chat that lives on another PC).
        const say = isObject(r.body) && typeof r.body.say === 'string' ? r.body.say.slice(0, MAX_SAY_TEXT) : undefined
        if (mode() === 'member') return await request<ChatOpened>(needHub(), 'http', { method: 'POST', rest: `/floors/${enc(id)}/agents/${enc(agentId)}/run-on`, body: { pc, say } }, 60_000)
        const agent = agentOf(floorOf(id), agentId)
        let opened: ChatOpened
        let name = self().name
        if (pc === self().id) {
          opened = await openChat(id, agentId, { takeOver: true, here: true })
          if (say && opened.started) chats.typeWhenReady(opened.sessionId, say)
        } else {
          const link = mode() === 'hub' ? (team?.member(pc) ?? null) : null
          if (!link) throw apiError(HOME_OFFLINE_STATUS, `${homeName(agent, pc)} can't be reached right now, so ${agent.name}'s chat can't move there.`)
          name = link.name
          opened = { ...(await request<ChatOpened>(link, 'open', { floorId: id, agentId, text: say }, 60_000)), on: link.name }
        }
        if (mode() === 'hub') floors.setHome(id, agentId, { id: pc, name })
        return opened
      },
      'local',
    ],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/terminate$/,
      ([id, agentId]) => {
        const a = agentOf(floorOf(id), agentId)
        if (!a.sessionId) return { killed: false }
        heartbeat.stoppedOnPurpose(a.sessionId) // F-078: his own stop: the heartbeat leaves it alone
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
      ([id], r) => {
        const out: Record<string, { exists: boolean; bytes: number }> = {}
        const seen = access.visible(callerOf(r), allFloors())
        for (const a of floorOf(id).agents) {
          if (!a.sessionId || (seen && !seen.has(a.sessionId))) continue
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
      (_, r): PreviewsAnswer => {
        const previews: PreviewsAnswer['previews'] = {}
        const seen = access.visible(callerOf(r), allFloors())
        for (const f of allFloors()) {
          for (const a of f.agents) {
            if (seen && (!a.sessionId || !seen.has(a.sessionId))) continue
            const p = a.sessionId ? chatFeeds.preview(a.sessionId) : null
            if (p) previews[a.id] = p
          }
        }
        return { previews }
      },
      'local',
    ],
    [
      // F-062: what each chat really runs on (its conversation file says), for the chips on every chat.
      'GET',
      /^\/runs$/,
      (_, r): RunsAnswer => {
        const live = chats.states()
        const runs: Record<string, ChatRun> = {}
        let inherited: { model: string; mtimeMs: number } | null = null
        const seen = access.visible(callerOf(r), allFloors())
        for (const f of allFloors()) {
          for (const a of f.agents) {
            if (seen && (!a.sessionId || !seen.has(a.sessionId))) continue
            const file = a.sessionId ? findTranscript(a.sessionId, projectsDir) : null
            const r = file ? readFileRun(file) : null
            const l = a.sessionId && live[a.sessionId] !== undefined ? launched.get(a.sessionId) : undefined
            if (!r && !l) continue
            runs[a.id] = {
              model: r?.model ?? null,
              effort: r?.effort ?? null,
              effortAt: r?.effortAt ?? null,
              launchedEffort: l?.effort ?? null,
              startedAt: l?.at ?? null,
              ultracode: r?.ultracode ?? null,
              ultracodeAt: r?.ultracodeAt ?? null,
              launchedUltracode: l?.ultracode ?? null,
            }
            // A chat that chose its own model shows what the CLI chose: the newest of them says what the default is.
            if (!a.model && !defaultsNow().model && r?.model && (!inherited || r.mtimeMs > inherited.mtimeMs)) inherited = { model: r.model, mtimeMs: r.mtimeMs }
          }
        }
        const defaultModel: DefaultModel | null = configuredModel() ?? (inherited ? { model: inherited.model, from: 'a chat that inherited it' } : null)
        return { runs, defaultModel, defaults: defaultsNow() }
      },
      'local',
    ],
    [
      'POST',
      /^\/floors\/([^/]+)\/agents\/([^/]+)\/say$/,
      ([id, agentId], r): Promise<SayAnswer> => {
        const body = text(isObject(r.body) ? r.body.text : undefined, 'text', MAX_SAY_TEXT)
        // F-118: typing into a chat that is running is for whoever may type; starting a stopped one is the owner's.
        const a = agentOf(floorOf(id), agentId)
        if (!(a.sessionId && whereAll()[a.sessionId]) && access.rights(callerOf(r), a)?.can !== 'owner') {
          access.deny(callerOf(r), `POST say`, a.sessionId)
          throw authError(403, 'That chat is not running, and only its owner can start it.', 'not-yours')
        }
        return sayTo(id, agentId, body)
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

  const callerOf = (r: MountRequest): Caller => r.caller ?? OPEN

  /** F-118: what a route's rule needs of its caller, checked before anything runs. A route with no rule is for the owner of the app. */
  function checkRule(rule: Rule | undefined, params: string[], r: MountRequest) {
    const c = callerOf(r)
    const where = `${r.method} ${AGENT_API_PREFIX}${AGENTIC_PREFIX}${r.rest}`
    if (rule === undefined || rule.kind === 'owner') {
      if (access.isAdmin(c)) return
      o.auth?.deny(c, 403, 'admin-only', where)
      throw authError(403, 'This is for the owner of this app.', 'admin-only')
    }
    switch (rule.kind) {
      case 'signed':
      case 'create':
      case 'self':
        return
      case 'floor':
        return access.needFloor(c, floorOf(params[rule.floor]), rule.need, where)
      case 'chat': {
        const f = floorOf(params[rule.floor])
        return access.needChat(c, agentOf(f, params[rule.agent]), rule.need, where)
      }
      case 'move': {
        const f = floorOf(params[rule.floor])
        access.needChat(c, agentOf(f, params[rule.agent]), 'owner', where)
        access.needFloor(c, f, 'manage', where)
        const to = isObject(r.body) && typeof r.body.floorId === 'string' && r.body.floorId ? r.body.floorId : f.id
        if (to !== f.id) access.needFloor(c, floorOf(to), 'manage', where)
      }
    }
  }

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
      checkRule(ruleOf(method, pattern), params, r)
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
    const value = await request<unknown>(link, 'http', { method: r.method, rest: r.rest, query: r.query.toString(), body, by: callerOf(r).person })
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
    // F-118: the person the member's page signed in (a member speaks for its own pages, as for its own chats); nobody: the open app.
    const by = isObject(raw.by) && typeof raw.by.id === 'string' && raw.by.id ? raw.by : null
    const id = by ? String(by.id).toLowerCase().slice(0, 64) : ''
    const caller: Caller = by
      ? { person: { id, username: String(by.username ?? '').slice(0, 80), name: String(by.name ?? '').slice(0, 120), canSeeAll: (o.auth?.admins() ?? []).includes(id) }, via: 'local', sid: null }
      : OPEN
    return route({ method: raw.method, rest: raw.rest, query: new URLSearchParams(typeof raw.query === 'string' ? raw.query : ''), body, headers: {}, caller })
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
          return stream => serveTerminal(stream, from)
        case 'attach-put':
          return answer(raw => attachPutPeer(raw))
        case 'attach-get':
          return answer(raw => attachGetPeer(raw))
        case 'drive':
          // F-097: a member PC's sync folder asks the Common Drive for a file, a list, a piece (agent/drive/link.ts).
          return answer(raw => (o.driveLink ? o.driveLink(from, raw) : Promise.reject(apiError(404, 'The Common Drive is not on this PC'))))
        case 'open':
          // F-025: another PC's Run on, for this one: the chat taken over here.
          return answer(raw => {
            if (!isObject(raw) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string') throw apiError(400, 'Expected {floorId, agentId}')
            return openChat(raw.floorId, raw.agentId, { takeOver: true, here: true }).then(opened => {
              if (opened.started && typeof raw.text === 'string' && raw.text) chats.typeWhenReady(opened.sessionId, raw.text.slice(0, MAX_SAY_TEXT))
              return opened
            })
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
        case 'screen':
          // What its screen shows now (Approvals reads a prompt from this, not from the scroll-back).
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string') throw apiError(400, 'Expected {sessionId}')
            const lines = chats.screen(raw.sessionId)
            if (lines === null) throw apiError(404, "That chat isn't running here")
            return lines.join('\n')
          })
        case 'type':
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.text !== 'string') throw apiError(400, 'Expected {sessionId, text}')
            // A caller that is not the person typing (an agent's message, a broadcast, a nudge) asks for the draft check: this PC knows its own screens.
            if (raw.refuseDraft === true && chats.drafting(raw.sessionId)) return 'draft'
            return chats.type(raw.sessionId, raw.text, raw.refuseDraft === true ? { refuseDraft: true } : undefined)
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
        case 'attach-put':
          return answer(raw => attachPutPeer(raw))
        case 'attach-get':
          return answer(raw => attachGetPeer(raw))
        case 'keys':
          // F-076: the hub answering a prompt in a chat that runs here: one or two digits (a numbered choice), or the one Esc key of a Cancel button; nothing else.
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.data !== 'string' || !(/^\d{1,2}$/.test(raw.data) || raw.data === ESC_KEY)) throw apiError(400, 'Expected {sessionId, data: a number or Esc}')
            return chats.input(raw.sessionId, raw.data)
          })
        case 'open':
          // F-025: another PC's Run on, for this one: the chat taken over here.
          return answer(raw => {
            if (!isObject(raw) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string') throw apiError(400, 'Expected {floorId, agentId}')
            return openChat(raw.floorId, raw.agentId, { takeOver: true, here: true }).then(opened => {
              if (opened.started && typeof raw.text === 'string' && raw.text) chats.typeWhenReady(opened.sessionId, raw.text.slice(0, MAX_SAY_TEXT))
              return opened
            })
          })
        case 'pull':
          return servePull(sid => findTranscript(sid, projectsDir))
      }
    }
    throw new Error(`this PC doesn't do ${String(op)}`)
  }

  // ---------------------------------------------------------------------------------------
  // WebSockets

  function terminal(query: URLSearchParams, caller: Caller) {
    const sid = query.get('session') ?? ''
    // F-118: a person who may only view gets the screen and nothing they send reaches the chat (not keys, not a resize).
    // It is asked again at every key: a share changed to 'view' while the socket is open takes typing away at once.
    const typing = () => {
      const at = bySession(sid)
      return !at || access.rights(caller, at.agent)?.can !== 'view'
    }
    return (ws: WsSocket) => {
      const detach = chats.attach(sid, { send: m => ws.sendText(JSON.stringify(m)) })
      // F-023: running on another of the hub's PCs: its terminal, used from here over the link.
      if (!detach && remoteTerminal(sid, ws, typing)) return
      if (!detach) {
        ws.sendText(JSON.stringify({ t: 'exit', code: null }))
        return ws.close(1000, "That chat isn't running")
      }
      ws.onText(raw => {
        if (!typing()) return
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
  function remoteTerminal(sid: string, ws: WsSocket, typing: () => boolean = () => true): boolean {
    const w = whereAll()[sid]
    if (!w || w.id === self().id) return false
    let link: LinkPeer
    try {
      // F-116 (5 Nov): a member reaches only its hub, so a chat on ANOTHER member is asked of the hub, which relays it (serveTerminal).
      // Before, peerOf threw here and the page got "exit": the "running on <PC> … Use here" panel, again and again.
      link = mode() === 'member' && team?.hub()?.id !== w.id ? hubLink() : peerOf(w.id)
    } catch {
      return false
    }
    let stream: Duplex | null = null
    let closed = false
    const early: string[] = []
    ws.onText(raw => {
      if (!typing()) return
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
    log?.info(`chat ${sid.slice(0, 8)}: used here, running on ${w.name}${link.name !== w.name ? ` (through ${link.name})` : ''}`)
    return true
  }

  /** The link to the hub (a member's only way to the other PCs); throws when there is none. */
  function hubLink(): LinkPeer {
    const link = team?.hub()?.link ?? null
    if (!link) throw apiError(503, "The hub can't be reached right now")
    return link
  }

  /** A page's terminal message on to the link; one that isn't JSON is dropped, as the local socket drops it. */
  function relayLine(stream: Duplex, raw: string) {
    try {
      writeLine(stream, JSON.parse(raw))
    } catch {
      // Not a message.
    }
  }

  /**
   * F-023: the far end of Use here: this PC's chat, viewed and typed into from another PC's page.
   * F-116: on the hub, `from` (the member asking) may want a chat that runs on another member: the hub opens that one's terminal
   * and relays it, line for line, both ways (a member reaches only its hub). Never back to the PC that asked.
   */
  function serveTerminal(stream: Duplex, from?: { id: string; name: string }) {
    let sid: string | null = null
    let detach: (() => void) | null = null
    let relay: Duplex | null = null
    let early: Record<string, unknown>[] | null = null
    const ended = () => {
      writeLine(stream, { t: 'exit', code: null })
      stream.end()
    }
    readLines(stream, raw => {
      if (!isObject(raw)) return
      if (sid === null) {
        sid = typeof raw.sessionId === 'string' ? raw.sessionId : ''
        detach = chats.attach(sid, { send: m => void writeLine(stream, m) })
        if (detach) return
        const w = from && mode() === 'hub' ? whereAll()[sid] : undefined
        const link = w && w.id !== self().id && w.id !== from!.id ? (team?.member(w.id) ?? null) : null
        if (!link) return ended()
        early = []
        const asked = sid
        link.open({ op: 'terminal' }).then(
          s => {
            if (stream.destroyed) return void s.destroy()
            relay = s
            writeLine(s, { sessionId: asked })
            for (const m of early!.splice(0)) writeLine(s, m)
            readLines(s, m => void writeLine(stream, m))
            s.on('close', () => stream.end())
            s.on('error', () => stream.destroy())
          },
          () => ended(),
        )
        log?.info(`chat ${asked.slice(0, 8)}: ${from!.name} uses it through this hub, running on ${w!.name}`)
        return
      }
      if (early !== null) {
        if (relay) writeLine(relay, raw)
        else early.push(raw)
        return
      }
      if (raw.t === 'in' && typeof raw.d === 'string') chats.input(sid, raw.d)
      else if (raw.t === 'size' && typeof raw.cols === 'number' && typeof raw.rows === 'number') chats.resize(sid, raw.cols, raw.rows)
    })
    stream.on('close', () => {
      detach?.()
      relay?.destroy()
    })
  }

  const mount: ApiMount = {
    prefix: AGENTIC_PREFIX,
    // F-118: this mount decides by person (policy in access.ts); every other mount is for the owner of the app.
    scoped: true,
    // The chats' own routes: their key, never the app's token, and never from a page (api.ts).
    ownAuth: rest => rest === '/mcp/call' || rest === '/mcp/recall',
    // F-054: the built-in CRM's calls to the CRM's backend, with this PC's CRM session (never passed to the hub).
    raw: (rest, url) => {
      if (rest.startsWith('/crm-proxy/')) {
        return (req, res, caller) => {
          // The built-in CRM runs on this PC's own CRM session: the owner's.
          if (!access.isAdmin(caller ?? OPEN)) throw authError(403, 'The CRM page is for the owner of this app.', 'admin-only')
          return crmProxy.handle(req, res, rest.slice('/crm-proxy/'.length), url.search)
        }
      }
      // F-069: a file sent to a chat (the body is the file), and one already sent, for its thumbnail.
      const up = /^\/floors\/([^/]+)\/agents\/([^/]+)\/attach$/.exec(rest)
      if (up)
        return (req, res, caller) => {
          // F-118: a file into a chat is typing into it.
          access.needChat(caller ?? OPEN, agentOf(floorOf(decodeURIComponent(up[1])), decodeURIComponent(up[2])), 'type', 'POST attach')
          return attachUpload(req, res, decodeURIComponent(up[1]), decodeURIComponent(up[2]), url)
        }
      const down = /^\/floors\/([^/]+)\/agents\/([^/]+)\/attachment\/([^/]+)$/.exec(rest)
      if (down)
        return (req, res, caller) => {
          access.needChat(caller ?? OPEN, agentOf(floorOf(decodeURIComponent(down[1])), decodeURIComponent(down[2])), 'view', 'GET attachment')
          return attachDownload(req, res, decodeURIComponent(down[1]), decodeURIComponent(down[2]), decodeURIComponent(down[3]))
        }
      return null
    },
    http: r => route(r, mode() === 'member' ? toHub : undefined),
    // F-118: who may have this socket, decided before it is accepted (a chat they may not see is a 403).
    wsAllow(rest, query, caller) {
      const where = `WS ${AGENT_API_PREFIX}${AGENTIC_PREFIX}${rest}`
      if (rest === '/terminal' || rest === '/chat') {
        const at = bySession(query.get('session') ?? '')
        if (at) access.needChat(caller, at.agent, 'view', where)
        else if (!access.isAdmin(caller)) {
          access.deny(caller, where)
          throw authError(403, "That chat isn't yours.", 'not-yours')
        }
        return
      }
      if (rest === '/ui' || rest === '/fast') {
        if (!access.isAdmin(caller)) {
          o.auth?.deny(caller, 403, 'admin-only', where)
          throw authError(403, 'This is for the owner of this app.', 'admin-only')
        }
      }
    },
    ws(rest, query) {
      if (rest === '/terminal')
        return (ws, caller) => {
          watch(query.get('session') ?? '', caller ?? OPEN, ws)
          terminal(query, caller ?? OPEN)(ws)
        }
      if (rest === '/chat')
        return (ws, caller) => {
          watch(query.get('session') ?? '', caller ?? OPEN, ws)
          chatSocket(query)(ws)
        }
      if (rest === '/ui') return ui.socket()
      // F-086/F-087: the fast Assistant's stream for the web page (shared/fast.ts); no host = off = no such socket.
      if (rest === '/fast') return fastSession?.socket('web') ?? null
      if (rest === '/events')
        return (ws, caller) => {
          const c = caller ?? OPEN
          events.set(ws, c)
          ws.onClose(() => events.delete(ws))
          // F-118: what this person may see, from the first message on.
          for (const e of [
            { t: 'floors', floors: allFloors() },
            { t: 'live', live: chats.states() },
            { t: 'where', elsewhere: elsewhere(), last: lastAll(), team: teamInfo() },
          ] satisfies AgenticEvent[]) {
            const text = eventFor(e, c)
            if (text) ws.sendText(text)
          }
        }
      return null
    },
  }

  return {
    mount,
    voiceMount: voice.mount,
    phoneDeviceOf: headers => voice.deviceOf(headers),
    fastHost,
    handoff,
    floors,
    chats,
    memory,
    callTool,
    routeKeys: () => routes.map(([m, p]) => policyKey(m, p)),
    driveRequest: async (body, timeoutMs) => request<unknown>(needHub(), 'drive', body, timeoutMs ?? 30_000),
    serve,
    restartChat,
    resumeChat,
    busyChats: () => Object.values(chats.states()).filter(st => st === 'running' || st === 'question').length,
    async retireChatHost() {
      // Written down first: ending them would otherwise empty the list.
      recovery?.freeze()
      await o.chatHost?.shutdown(true)
    },
    humanProof,
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
      // F-075: let go of the chat host (its chats go on).
      o.chatHost?.close()
      sub?.stream.destroy()
      sub = null
      for (const s of subs.values()) s.destroy()
      subs.clear()
      for (const s of events.keys()) s.close(1001, 'the agent is stopping')
      ui.close()
      voice.close()
      fastSession?.close()
      void fastHost?.stop('the app is stopping')
      clearInterval(ordersTimer)
      clearInterval(heartbeatTimer)
      clearInterval(voiceTimer)
      events.clear()
    },
  }
}
