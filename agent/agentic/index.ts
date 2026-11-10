import { requireCrmHuman, describeHuman, createPromptActions, APPROVAL_GRANT_MS, isNativeApprovalCommit, nativeApprovalSnapshot, type NativeApprovalProof, type NativeApprovalSnapshot, type NativeApprovalCommit } from './human-session.ts'
import { createPcControlStore, isPcControl, immutablePcControl, pcControlError, pcControlRevision, assertPcControlExpected, checkedPcControlNamespace, type PcControlKnownDevice } from './pc-control.ts'
import type { PcControlAnswer, PcControlWorkspace, PcControlCapability, PcControlSlot } from '../../shared/pc-control.ts'
import { executionIdentityOf, requireLegacyExecution, requireRunningEngine, engineUpdateRequired, type RuntimeEngine } from './runtime-engine.ts'
import { requireMessageExecution } from './message-execution.ts'
import { assertExecutionCAS, normalizeExecution, snapshotAgentExecution, type ExecutionIdentity } from '../../shared/chat-execution.ts'
import { createExecutionService } from './execution-service.ts'
import { executionLaunchCwd } from './execution-launch.ts'
import { chatExecutionActor } from './execution-chat-actor.ts'
import type { ExecutionIntentScope } from './execution-intents.ts'
import { loadSession } from '../claude/index.ts'
import { sourceHash } from './switch-fence.ts'
import { forkClaudeExecution, forkNativeCodexExecution } from '../codex-claude/fork.ts'
import { executionHttpError, executionIntentId, requireExecutionCapabilityQuery, requireExecutionOpenRequest,
  requireExecutionSelectionRequest, type ExecutionCapabilityReply } from '../../shared/chat-execution-http.ts'
import { prepareConversation, type PreparedConversation } from '../opencode/switch.ts'
import { interchange } from '../opencode/backend.ts'
import { createOpenCodePool, combinePools, type OpenCodePoolOptions } from '../opencode/pool.ts'
import type { OpenCodeProvider } from '../../shared/opencode.ts'
import { openCodeSelection } from '../../shared/opencode.ts'
import type { OpenCodeCredential } from '../opencode/crm.ts'
import { freeModel } from '../opencode/free-model.ts'
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
import type { PreviewsAnswer, SayAnswer, SayRequest, DeliveryReceipt } from '../../shared/chat.ts'
import { deliveryBlockWords, isDeliveryBlockReason, type DeliveryBlockReason } from '../../shared/delivery-reason.ts'
import { createDeliveryReceipts } from './delivery-receipts.ts'
import { createHumanInputGrants, type HumanInputPhase } from './human-delivery.ts'
import type { TasksAnswer, TaskStatus } from '../../shared/tasks.ts'
import type { CrmAnswer, CrmCheck, CrmSessionInfo } from '../../shared/crm.ts'
import type { MemoryKind } from '../../shared/memory.ts'
import { apiError, type ApiMount, type MountRequest, type WsSocket } from '../api.ts'
import { writeAtomic } from '../config.ts'
import type { Logger } from '../log.ts'
import { composeAgentBrief, MCP_SERVER_NAME, writeBrief } from './briefs.ts'
import { claudeJsonPath, prepareClaudeConfig } from './claude-config.ts'
import { createChatPool, findClaude, type ChatPool, type ChatPoolOptions, type PtySpawn } from './chats.ts'
import { ownBridgeChat } from './bridge-stop.ts'
import type { ChatHostLink } from '../chathost/link.ts'
import { createChatFeeds } from './chatview.ts'
import { createUiBridge } from './ui-bridge.ts'
import { chosen, mcpConfigFor, readRegistry, strictConfigFor } from './mcp-registry.ts'
import { createOrders, FAST_FROM, phoneUser, scanMessages, type HandoffApi, type Order, type OrderProgress } from './orders.ts'
import { readStatus } from './screen.ts'
import { createHeartbeat, unfinishedWork } from './heartbeat.ts'
import { createWatchdog, readFreeCommitMB } from './watchdog.ts'
import { createChatLog, describeEvents } from './chat-log.ts'
import { createVoice, type AskView } from './voice.ts'
import { spawn, spawnSync } from 'node:child_process'
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
import type { Elevation } from './approval-recovery.ts'
import { createAutoUpdate } from './auto-update.ts'
import type { WaTools } from '../whatsapp/index.ts'
import { waTool } from '../whatsapp/tools.ts'
import type { SignedKind } from '../../shared/approval-sign.ts'
import { createHash } from 'node:crypto'
import type { AnswerRequest, ApprovalItem, ApprovalsAnswer, CancelRequest, PreparedCard, SendAsMeRequest } from '../../shared/approvals.ts'
import { configuredModel, readFileRun } from './runinfo.ts'
import { createFloorStore, assertCodexThreadAvailable, type FloorStore } from './floors.ts'
import { createOfflineSettings, OFFLINE_AFTER_MS } from './offline.ts'
import { CODEX_EFFORTS, CODEX_MODEL_MAX, engineOf, type AgentEngine, type CodexEffort, type CodexStatus } from '../../shared/codex.ts'
import type { CodexManager } from '../codex/index.ts'
import { parseVersion } from '../codex/find.ts'
import { dependencyReport } from './dependencies.ts'
import type { DependenciesAnswer, DependencyPc, DependencyReport } from '../../shared/dependencies.ts'
import { profileName, removeProfile, sweepProfiles, writeProfile, type McpServerToml } from '../codex/home.ts'
import { CODEX_FORMAT, discoverThread, findRollout } from '../codex/rollout.ts'
import { watchForThread } from '../codex/discovery.ts'
import { switchConversationComplete } from '../codex/complete-conversion.ts'
import { createConversionProgress } from './conversion-progress.ts'
import { claudeFileContext, conversationCwd, conversationLines, convertClaude } from '../codex/from-claude.ts'
import { toClaude } from '../codex/to-claude.ts'
import { createSwitchFences } from './switch-fence.ts'
import { validatePreparedConversation, type ConversationBinding } from './prepared-conversation.ts'
import type { SendOptions } from '../codex/sender.ts'
import { CLAUDE_FORMAT } from './chatview.ts'
import type { AdoptStatus, OfflineChats } from '../../shared/agentic.ts'
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
import { savedViewsRequest } from './views.ts'
import { createMemoryStore, type MemoryStore } from './memory.ts'
import { createCrmFilesModule, type CrmFilesModule, type CrmFilesModuleOptions } from '../crm-files/index.ts'
import { noMeaning, type Embedder } from './embedder.ts'
import { createMemoryLayer, type MemoryLayer } from './memory-layer.ts'
import { appendAt, createTail, markOf, NO_FILE, sameMark, settled, type FileMark } from './mirror.ts'
import { answer, pullFrom as pullTranscriptFrom, readLines, request, servePull, writeLine, type LinkPeer } from './roam.ts'
import {
  claudeProjectsDir,
  copyTranscript,
  encodeProjectPath,
  findTranscript as findClaudeTranscript,
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

/** F-127: tools that live on the Server only: a chat of a floor made on a member PC while the Server was away has no use of them. */
const NEEDS_SERVER = new Set([
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
  /** Canonical self + registered devices, including offline devices. Never starts chats. */
  pcControlDevices?: () => Array<{ id: string; name: string; online: boolean }>
  /** <state>/agent/agentic */
  dir: string
  /** F-134: Codex on this PC (the CRM's Codex login, the home, the chats). Left out (tests, older callers): agents set to Codex are refused with a plain sentence. */
  openCodeCredential?: (provider: OpenCodeProvider) => Promise<OpenCodeCredential>
  openCodeIdentity?: () => string | null
  openCodeFind?: OpenCodePoolOptions['find']
  openCodeBackend?: OpenCodePoolOptions['backend']
  openCodeFreeMemory?: () => number
  codex?: CodexManager | null
  /** F-134, tests: shorter waits for the sender of a Codex chat. */
  codexSend?: SendOptions
  /** F-138: the Claude credential the CRM handed out (claude/index.ts credentialEnv): exactly one of CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY. Left out (tests), `token` applies as before. */
  credential?: () => { name: string; value: string } | null
  /** F-127, tests: how long the Server must be out of reach before new chats are made here (default 20 s). */
  offlineAfterMs?: number
  /** F-127, tests: how long after a failed joining it is tried again (default 30 s). */
  adoptRetryMs?: number
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
  /** @deprecated Inert compatibility input. Human actions always use the real CRM cookie session, never an injected proof. */
  voiceProof?: (body: unknown, r?: { caller?: Caller; headers: IncomingMessage['headers'] }) => string
  /** @deprecated Inert compatibility input: approval-device enrollment/recovery is retired; no elevation is run. */
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
  /** F-126: this PC's way to mount the CRM files (Linux brings its own: loopback WebDAV + gvfs). Left out on Windows, where crm-fs.exe through WinFsp is used. */
  crmFilesMountDriver?: CrmFilesModuleOptions['mountDriver']
}

export interface Agentic {
  /** F-126: the CRM files (agent/crm-files/): the tree and its changes, the page's routes, this PC's mount. */
  crmFiles: CrmFilesModule
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
  /** Separately audited profile routes: explicit per-chat owner rules live in this module. */
  executionRouteKeys(): string[]
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
  /** F-134: a newer Codex login was put in place while Codex chats were running: each is restarted (its conversation resumes), one after the other. */
  restartCodexChats(): void
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
   * F158: current CRM-session human for an audit line; admin-only for pairing/auto-update/WhatsApp.
   * Legacy fields/signature arguments are ignored, never a second authorization path.
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
  pcControl?: PcControlAnswer
  engineSwitchContinuity?: FloorsAnswer['engineSwitchContinuity']
  floors: Floor[]
  /** F-067: the hub's defaults for model, effort and ultracode. */
  defaults?: ChatDefaults
  where: Record<string, { id: string; name: string; state: ChatState }>
  last: Record<string, ChatLast>
  marks: Record<string, FileMark>
}

export function createAgentic(o: AgenticOptions): Agentic {
  const approvalNativeRuntimes = new Map<string, { fingerprint: string; generation: string }>()
  const log = o.log
  const team = o.team
  const projectsDir = o.projectsDir ?? claudeProjectsDir()
  // F-050: the chat view's reading of conversations (chatview.ts): the end of a file, never all of it.
  const chatFeeds = createChatFeeds({
    projectsDir,
    log: o.log,
    screen: sid => chats.screen(sid),
    // F-134: a Codex chat's conversation is its rollout file, read in Codex's format.
    fileOf: sid => isOpenCode(sid) ? openCode.file(sid) : codexRollout(sid),
    formatOf: sid => (isCodexSession(sid) ? CODEX_FORMAT : CLAUDE_FORMAT),
  })
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
    if (e.t === 'pc-control') return JSON.stringify({ t: 'pc-control', answer: scopePcControl(e.answer, c) } satisfies AgenticEvent)
    if (e.t === 'floors') return JSON.stringify({ t: 'floors', floors: access.scope(c, e.floors.filter(f => !isPcControl(f))) } satisfies AgenticEvent)
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
      const key = JSON.stringify(c)
      if (!made.has(key)) made.set(key, eventFor(e, c))
      const t = made.get(key)
      if (t) s.sendText(t)
    }
  }

  let executionService: ReturnType<typeof createExecutionService> | null = null
  const executionAuthority = {
    assertCurrent: (request: import('./floors.ts').FloorExecutionCommit) => {
      if (!executionService) throw executionHttpError('execution-capability-required', 'selection')
      executionService.authority.assertCurrent(request)
    },
    persist: (file: string, text: string) => {
      if (!executionService) throw executionHttpError('execution-capability-required', 'selection')
      executionService.authority.persist(file, text)
    },
  }
  const hubFloors = createFloorStore(path.join(o.dir, 'floors.json'), () => {
    if (mode() === 'member') return
    emit({ t: 'floors', floors: hubFloors.list() })
    pushState()
  }, { executionAuthority, defaultEngine: () => defaultsNow().engine ?? '', executionDefaults: () => defaultsNow(), switchConversation: carryConversation, validateCodexThread: (f, a, t) => assertCodexThreadAvailable(allFloors(), f, a, t) })
  // F-127: a member's OWN floors, made while the Server could not be reached (floors-local.json). The same store, and 'alone' mode's code, run them. The facade
  // below is the one `floors` every handler already uses: a member's is the local one (it keeps no copy of the Server's floors in a store: that is the replica),
  // the hub's and a PC alone's is the usual one.
  const localFloors = createFloorStore(path.join(o.dir, 'floors-local.json'), () => {
    if (mode() === 'member') emitFloors()
  }, { executionAuthority, defaultEngine: () => defaultsNow().engine ?? '', executionDefaults: () => defaultsNow(), switchConversation: carryConversation, validateCodexThread: (f, a, t) => assertCodexThreadAvailable(allFloors(), f, a, t) })
  const offlineSettings = createOfflineSettings(path.join(o.dir, 'offline.json'))
  const controlFloors = createPcControlStore(path.join(o.dir, 'pc-control.json'), () => { emitFloors(); if (mode() !== 'member') pushState() }, { switchConversation: carryConversation, validateCodexThread: (f, a, t) => assertCodexThreadAvailable(allFloors(), f, a, t) })
  const pickFloors = () => (mode() === 'member' ? localFloors : hubFloors)
  const storeFor = (id: string) => controlFloors.store.get(id) ? controlFloors.store : pickFloors()
  const controlExecutionUnverified = () => {
    const store = controlFloors.store
    // An older store that cannot report profile-aware ownership cannot authorize credential cleanup.
    return !('hasUnverifiedExecution' in store) || typeof store.hasUnverifiedExecution !== 'function' || store.hasUnverifiedExecution() !== false
  }
  const floors: FloorStore = {
    hasUnverifiedExecution: () => pickFloors().hasUnverifiedExecution() || controlExecutionUnverified(),
    executionState: (f, a) => {
      if (isPcControl(floorOf(f))) throw immutablePcControl()
      return pickFloors().executionState(f, a)
    },
    commitExecution: request => {
      if (isPcControl(floorOf(request.floorId))) throw immutablePcControl()
      return pickFloors().commitExecution(request)
    },
    list: () => mode() === 'member' ? allFloors() : checkedPcControlNamespace([...pickFloors().list(), ...controlFloors.store.list()]),
    get: id => storeFor(id).get(id) ?? (mode() === 'member' ? replica.floors.find(f => f.id === id && isPcControl(f)) ?? null : null),
    create: (name, as) => pickFloors().create(name, as),
    validatePatch: (id, p, as) => storeFor(id).validatePatch(id, p, as),
    setOpenCodeSession: (f, a, n) => storeFor(f).setOpenCodeSession(f, a, n),
    patch: (id, p, as) => storeFor(id).patch(id, p, as),
    setShare: (f, a, l) => storeFor(f).setShare(f, a, l),
    assignUnowned: owner => pickFloors().assignUnowned(owner),
    adopt: (raw, from) => hubFloors.adopt(raw, from),
    remove: id => storeFor(id).remove(id),
    reorder: order => pickFloors().reorder(order),
    moveAgent: (from, agent, to, before) => storeFor(from).moveAgent(from, agent, to, before),
    addAgent: (f, req, as) => storeFor(f).addAgent(f, req, as),
    bindSession: (f, a, s) => storeFor(f).bindSession(f, a, s),
    setCodexThread: (f, a, t) => storeFor(f).setCodexThread(f, a, t),
    setHome: (f, a, h) => storeFor(f).setHome(f, a, h),
    bySession: sid => bySession(sid),
  }
  // F-118: every floor and chat that has no owner is sbskrrt's (the one-time move; it is idempotent, so a chat some older path
  // made without an owner is covered at the next start too). A member keeps no floors of its own: this changes nothing there.
  if (o.auth) {
    try {
      const moved = hubFloors.assignUnowned(SBSKRRT_OWNER)
      if (moved) log?.info(`F-118: ${moved} floors and chats had no owner; they are sbskrrt's now`)
      if (!o.auth.migrated()) o.auth.markMigrated()
    } catch (error) {
      if (!['execution-invalid', 'execution-intent-uncertain'].includes(String((error as { code?: unknown }).code))) throw error
      log?.warn('Execution metadata is quarantined. Floor bytes and ownership migration remain unchanged.')
    }
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
  // F-126: the CRM's files in this app, and this PC's mount of them (the drive comes back by itself if it was on).
  const crmFiles = createCrmFilesModule({ dir: o.dir, proxy: crmProxy, root: path.resolve(import.meta.dirname, '..', '..'), mountDriver: o.crmFilesMountDriver, log: o.log })
  void crmFiles.resume().catch(() => undefined)

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
  // F-127: when this member lost its Server (null while it has it), and the debounce after which new chats are made here.
  let downSince: number | null = null
  const offlineAfter = o.offlineAfterMs ?? OFFLINE_AFTER_MS
  const offlineActive = () => mode() === 'member' && offlineSettings.on() && sub === null && downSince !== null && Date.now() - downSince >= offlineAfter
  /** F-127: new floors and chats on this PC use this PC's own Claude sign-in (F-007); without one they are refused, plainly, before anything is made. */
  function needClaudeHere() {
    if (o.token && !o.token()) throw Object.assign(apiError(409, "Sign in to Claude on this PC first (Settings › Devices): new chats made here while the Server is down use this PC's own Claude sign-in."), { code: 'no-claude' })
  }

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
    const theirs = replica.floors.map(f => ({ ...f, codeDir: f.folders?.[me] ?? null }))
    // F-127: this PC's own floors the Server does not have yet (once it has one, it is the Server's: the copy here is dropped from the list).
    const have = new Set(theirs.map(f => f.id))
    const mine = localFloors.list().filter(f => !have.has(f.id)).map(f => ({ ...f, local: true }))
    return checkedPcControlNamespace([...mine, ...theirs])
  }

  /** F-127: a floor made on this PC that the Server does not have yet (it is run here, whatever the link says). */
  const isLocalFloor = (id: string) => mode() === 'member' && localFloors.get(id) !== null && !replica.floors.some(f => f.id === id)
  const isLocalSession = (sid: string) => mode() === 'member' && localFloors.bySession(sid) !== null && !replica.floors.some(f => f.agents.some(a => a.sessionId === sid))

  function floorOf(id: string): Floor {
    const f = allFloors().find(x => x.id === id)
    if (!f) { pickFloors().get(id); throw apiError(404, 'No such floor') }
    return f
  }

  function agentOf(floor: Floor, id: string): FloorAgent {
    const a = floor.agents.find(x => x.id === id)
    if (!a) throw apiError(404, 'No such agent on this floor')
    return a
  }

  function bySession(sid: string): { floor: Floor; agent: FloorAgent } | null {
    // A quarantined persisted profile must not become an unbound legacy-Claude session.
    pickFloors().bySession(sid)
    for (const floor of allFloors()) {
      const agent = floor.agents.find(a => a.sessionId === sid)
      if (agent) return { floor, agent }
    }
    return null
  }

  const validTransferSid = (id: string) => /^[0-9a-zA-Z-]{8,64}$/.test(id)
  const sameControlId = (a: string | null | undefined, b: string) => a === b || (typeof a === 'string' && UUID_RE.test(a) && UUID_RE.test(b) && a.toLowerCase() === b.toLowerCase())
  const controlBindingMatches = (a: Floor['agents'][number], id: string) =>
    [a.sessionId,a.codexThread,a.opencodeSession].some(v => sameControlId(v,id)) ||
    !!a.conversationHistory?.some(h => [h.sessionId,h.codexThread,h.opencodeSession].some(v => sameControlId(v,id)))
  // Protected UUID aliases cannot bypass exact-key leases or conversion fences.
  const validMirrorSid = (id: string) => validTransferSid(id) && !(UUID_RE.test(id) && id !== id.toLowerCase() && controlPinnedPc(id))
  function controlPinnedPc(id: string): string | null {
    return allFloors().filter(isPcControl).find(f => sameControlId(f.id,id) || f.agents.some(a =>
      sameControlId(a.id,id) || controlBindingMatches(a,id)))?.targetPcId ?? null
  }
  const controlAlias = (id: string) => controlPinnedPc(id) !== null

  /** Captured before I/O and rechecked by the writer after every async transfer boundary. */
  function controlTransferGuard(peer: LinkPeer, sid: string): () => void {
    const execution = bySession(sid)
    if (execution) requireLegacyExecution(execution.agent, defaultsNow())
    if (!validMirrorSid(sid)) throw apiError(400, 'Expected a canonical session id')
    const proof = () => {
      const pin = controlPinnedPc(sid)
      if (!pin) return null
      const floor = allFloors().filter(isPcControl).find(f => f.agents.some(a => controlBindingMatches(a,sid)))
      const agent = floor?.agents.find(a => controlBindingMatches(a,sid))
      if (!floor || !agent) throw immutablePcControl()
      const hub = team?.hub()
      const mirrorFromHub = mode() === 'member' && pin === self().id && peer.id === hub?.id && peer.token === hub.link?.token && !chats.info(sid)
      if (peer.id !== pin && !mirrorFromHub) throw pcControlError('pc-control-wrong-device', 'Only the pinned PC can supply this managed conversation.')
      const current = mode() === 'member' ? hub?.link : team?.member(peer.id)
      if (!current || current.token !== peer.token) throw pcControlError('pc-control-stale', 'The source PC connection changed before history transfer.')
      return JSON.stringify([floor.id,pin,controlGeneration(agent)])
    }
    const captured = proof()
    return () => { if (proof() !== captured) throw pcControlError('pc-control-stale', 'The managed conversation changed while history transfer was queued.') }
  }

  function assertPcControlTarget(floor: Floor, target: string, req: { here?: boolean; takeOver?: boolean }) {
    if (!isPcControl(floor)) return
    if (target !== floor.targetPcId || req.here || req.takeOver) throw pcControlError('pc-control-wrong-device', 'This chat is pinned to its registered PC. Takeover and fallback are unavailable.')
    const live = whereAll()
    for (const a of floor.agents) if (a.sessionId && live[a.sessionId] && live[a.sessionId].id !== floor.targetPcId) {
      throw pcControlError('pc-control-wrong-device', 'A conflicting runtime exists on another PC. Nothing was stopped or moved.')
    }
    for (const a of floor.agents) if (a.sessionId && held.get(a.sessionId)?.holder && held.get(a.sessionId)!.holder !== floor.targetPcId) throw pcControlError('pc-control-wrong-device', 'A conflicting lease exists on another PC. Nothing was stopped or moved.')
  }

  function guardPcControlRoute(r: MountRequest, params: string[]) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) || r.rest.startsWith('/pc-control')) return
    if (!/^\/floors(?:\/|$)/.test(r.rest)) return
    // Sending is subject to the existing typing ACL and pinned launch guards, not workspace editing.
    if (r.method === 'POST' && /^\/floors\/[^/]+\/agents\/[^/]+\/say$/.test(r.rest)) return
    const id = params[0], f = id ? allFloors().find(f => f.id === id) : null
    if (isPcControl(f)) throw immutablePcControl()
    if (isObject(r.body)) {
      const body = r.body
      if (r.body.workspace === 'pc-control' || r.body.pcControlSlot !== undefined ||
          (typeof body.floorId === 'string' && isPcControl(allFloors().find(f => f.id === body.floorId))) ||
          [r.body.sessionId, r.body.codexThread, r.body.opencodeSession].some(x => typeof x === 'string' && controlAlias(x)) ||
          (Array.isArray(body.agents) && body.agents.some(a => isObject(a) && [a.id,a.sessionId,a.codexThread,a.opencodeSession].some(x => typeof x === 'string' && controlAlias(x)))) ||
          (Array.isArray(r.body.order) && r.body.order.some(x => typeof x === 'string' && isPcControl(allFloors().find(f => f.id === x))))) throw immutablePcControl()
    }
  }

  const controlCapabilities = new Map<string, PcControlCapability | null>()
  const controlRuntimes = new Map<string, { generation: string; token: object; at: number; runtime: PcControlSlot['runtime'] }>()
  const controlGeneration = (a: FloorAgent) => JSON.stringify([a.id, a.sessionId, a.codexThread ?? null, a.opencodeSession ?? null])
  const controlDeviceCatalogue = (): PcControlKnownDevice[] => o.pcControlDevices?.() ?? [{ ...self(), online: true }]
  function scopePcControl(answer: PcControlAnswer, c: Caller): PcControlAnswer {
    return { workspaces: answer.workspaces.flatMap(w => {
      const agents = w.floor.agents.flatMap(a => {
        const rights = access.rights(c, a)
        if (!rights) return []
        return [{ ...a, ...rights, sharedWith: rights.can === 'owner' ? a.sharedWith : [] }]
      })
      if (!agents.length) return []
      const allowed = new Map(agents.map(a => [a.id, a]))
      return [{ ...w, floor: { ...w.floor, agents }, slots: w.slots.map(s => {
        const a = s.agentId ? allowed.get(s.agentId) : null
        return a ? { ...s, agent: a, canOpen: s.canOpen && a.can !== 'view', canChangeEngine: s.canChangeEngine && a.can === 'owner' }
          : { number: s.number, agentId: null, agent: null, runtime: null, canOpen: false, canChangeEngine: false }
      }) as PcControlWorkspace['slots'] }]
    }) }
  }
  function controlRawAnswer(): PcControlAnswer {
    if (mode() === 'member' && replica.pcControl) return replica.pcControl
    const known = new Map(controlDeviceCatalogue().map(d => [d.id, d]))
    return { workspaces: allFloors().filter(isPcControl).map(f => {
      const d = known.get(f.targetPcId) ?? { id: f.targetPcId, name: f.name, online: false }
      const cap = d.id === self().id ? { version: 1 as const, pinnedWorkspace: true as const, actualEngineProof: true as const, engines: ['claude', 'codex'] as ('claude'|'codex')[] } : controlCapabilities.get(d.id) ?? null
      const device = { ...d, capability: cap, unavailable: !d.online ? 'offline' as const : !cap ? 'update-required' as const : null }
      return { device, floor: f, revision: pcControlRevision(f), slots: ([1,2] as const).map(number => {
        const agent = f.agents.find(a => a.pcControlSlot === number)!
        const info = agent.sessionId ? chats.info(agent.sessionId) : null
        const proof = controlRuntimes.get(`${d.id}:${agent.id}`)
        const remoteRuntime = d.online && proof?.generation === controlGeneration(agent) && proof.token === team?.member(d.id)?.token && Date.now() - proof.at < 10_000 ? proof.runtime : null
        const runtime = d.id !== self().id ? remoteRuntime : info && (info.engine === 'claude' || info.engine === 'codex') ? { engine: info.engine, startedAt: info.startedAt, state: info.state } : null
        return { number, agentId: agent.id, agent, runtime, canOpen: device.unavailable === null, canChangeEngine: device.unavailable === null }
      }) as PcControlWorkspace['slots'] }
    }) }
  }
  async function requirePcControlPeer(link: LinkPeer) {
    let cap: unknown
    try { cap = await request(link, 'pc-control-capabilities', {}, 5000) } catch { cap = null }
    if (!isObject(cap) || cap.version !== 1 || cap.pinnedWorkspace !== true || cap.actualEngineProof !== true || !Array.isArray(cap.engines) || !cap.engines.includes('claude') || !cap.engines.includes('codex')) {
      controlCapabilities.set(link.id, null)
      throw pcControlError('pc-control-update-required', `${link.name} needs an app update before PC Control can start a chat.`)
    }
    controlCapabilities.set(link.id, cap as unknown as PcControlCapability)
  }
  function localControlRuntime(raw: unknown) {
    if (!isObject(raw) || typeof raw.floorId !== 'string' || !Array.isArray(raw.slots) || raw.slots.length > 2 || Object.keys(raw).some(k => !['floorId','slots'].includes(k))) throw apiError(400, 'Expected managed runtime bindings.')
    const f = floorOf(raw.floorId)
    if (!isPcControl(f)) throw immutablePcControl()
    assertPcControlTarget(f, self().id, {})
    const ids = new Set<string>()
    const slots = raw.slots.map(x => {
      if (!isObject(x) || typeof x.agentId !== 'string' || typeof x.generation !== 'string' || Object.keys(x).some(k => !['agentId','generation'].includes(k)) || ids.has(x.agentId)) throw apiError(400, 'Expected unique managed slots.')
      ids.add(x.agentId)
      const a = agentOf(f, x.agentId)
      if (x.generation !== controlGeneration(a)) throw pcControlError('pc-control-stale', 'The target conversation changed. Refresh PC Control.')
      const info = a.sessionId ? chats.info(a.sessionId) : null
      if (info && (info.floorId !== f.id || info.agentId !== a.id || !['claude','codex'].includes(info.engine))) throw pcControlError('engine-runtime-mismatch', 'The target runtime does not belong to this managed slot.')
      return { agentId: a.id, generation: x.generation, runtime: info ? { engine: info.engine, startedAt: info.startedAt, state: info.state } : null }
    })
    return { pcId: self().id, floorId: f.id, slots }
  }
  async function refreshControlRuntime(link: LinkPeer, w: PcControlWorkspace) {
    const slots = w.floor.agents.map(a => ({ agentId: a.id, generation: controlGeneration(a) }))
    const raw = await request<unknown>(link, 'pc-control-runtime', { floorId: w.floor.id, slots }, 5000)
    if (!isObject(raw) || raw.pcId !== link.id || raw.floorId !== w.floor.id || !Array.isArray(raw.slots) || raw.slots.length !== slots.length || team?.member(link.id)?.token !== link.token) throw pcControlError('pc-control-update-required', 'The target did not provide a current managed runtime proof.')
    const checked = new Map<string, PcControlSlot['runtime']>()
    for (const x of raw.slots) {
      if (!isObject(x) || typeof x.agentId !== 'string' || checked.has(x.agentId) || !slots.some(s => s.agentId === x.agentId && s.generation === x.generation)) throw pcControlError('pc-control-stale', 'The target runtime proof belongs to a different conversation.')
      const runtime = x.runtime
      if (runtime !== null && (!isObject(runtime) || !['claude','codex'].includes(String(runtime.engine)) || typeof runtime.startedAt !== 'string' || !Number.isFinite(Date.parse(runtime.startedAt)) || !['idle','running','question'].includes(String(runtime.state)))) throw pcControlError('pc-control-update-required', 'The target returned malformed runtime proof.')
      checked.set(x.agentId, runtime as PcControlSlot['runtime'])
    }
    const current = floorOf(w.floor.id)
    for (const s of slots) if (!current.agents.some(a => a.id === s.agentId && controlGeneration(a) === s.generation)) throw pcControlError('pc-control-stale', 'The conversation changed while its runtime was checked.')
    for (const s of slots) controlRuntimes.set(`${link.id}:${s.agentId}`, { generation: s.generation, token: link.token, at: Date.now(), runtime: checked.get(s.agentId)! })
  }
  async function controlAnswer(c: Caller): Promise<PcControlAnswer> {
    if (mode() !== 'member') {
      const devices = controlDeviceCatalogue()
      const workflow = pickFloors().list()
      const bindings = (a: FloorAgent) => [a.id, a.sessionId, a.codexThread, a.opencodeSession, ...(a.conversationHistory ?? []).flatMap(h => [h.sessionId, h.codexThread, h.opencodeSession])].filter((x): x is string => typeof x === 'string')
      const ids = new Set(workflow.flatMap(f => [f.id, ...f.agents.flatMap(bindings)]))
      for (const f of controlFloors.store.list()) if (ids.has(f.id) || f.agents.some(a => bindings(a).some(x => ids.has(x)))) throw immutablePcControl()
      controlFloors.ensure(devices)
    }
    const scoped = scopePcControl(controlRawAnswer(), c)
    await Promise.all(scoped.workspaces.map(async w => {
      if (!w.device.online || w.device.id === self().id) return
      const link = team?.member(w.device.id)
      if (link) await requirePcControlPeer(link).then(() => refreshControlRuntime(link, w)).catch(() => {
        controlCapabilities.set(link.id, null)
        for (const a of w.floor.agents) controlRuntimes.delete(`${link.id}:${a.id}`)
      })
    }))
    return scopePcControl(controlRawAnswer(), c)
  }

  const controlMutations = new Map<string, Promise<unknown>>()
  function controlMutate(device: string, agentId: string, action: string, r: MountRequest) {
    const pending = (controlMutations.get(device) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const c = callerOf(r), raw = r.body
      if (!isObject(raw) || Object.keys(raw).some(k => !['expected', ...(action === 'engine' ? ['engine','confirmNewConversation'] : [])].includes(k))) throw apiError(400, 'PC Control requires an exact expected snapshot.')
      const answer = await controlAnswer(c), w = answer.workspaces.find(w => w.device.id === device)
      if (!w) throw pcControlError('pc-control-forbidden', 'That PC workspace is unavailable to you.', 403)
      const f = floorOf(w.floor.id), a = agentOf(f, agentId)
      access.needChat(c, a, action === 'engine' ? 'owner' : 'type', 'PC Control')
      assertPcControlExpected(f, a, raw.expected)
      if (w.device.unavailable) throw pcControlError(w.device.unavailable === 'offline' ? 'pc-control-offline' : 'pc-control-update-required', `${w.device.name} is ${w.device.unavailable}. Nothing was started or moved.`, w.device.unavailable === 'offline' ? 424 : 409)
      assertPcControlTarget(f, device, {})
      if (action === 'engine') {
        if (!['claude','codex'].includes(String(raw.engine)) || (raw.confirmNewConversation !== undefined && raw.confirmNewConversation !== true)) throw apiError(400, 'Choose Claude or Codex.')
        if (raw.engine !== a.engine) await patchFloor(f.id, { agents: f.agents.map(x => x.id === a.id ? { ...x, engine: raw.engine } : x),
          confirmNewConversation: raw.confirmNewConversation, expectedConversation: { agentId: a.id, ...raw.expected } }, access.ownerOf(c))
      } else if (action === 'stop') {
        if (a.sessionId) await stopAt(device, a.sessionId)
      } else if (action === 'open') {
        const opened = device === self().id ? await openChat(f.id, a.id, {}) : await openOnPeer(peerOf(device), f, a)
        const workspace = (await controlAnswer(c)).workspaces.find(w => w.device.id === device)!
        emit({ t: 'pc-control', answer: controlRawAnswer() })
        if (mode() !== 'member') pushState()
        return { workspace, opened }
      }
      emit({ t: 'pc-control', answer: controlRawAnswer() })
      return { workspace: (await controlAnswer(c)).workspaces.find(w => w.device.id === device)! }
    })
    controlMutations.set(device, pending)
    void pending.finally(() => { if (controlMutations.get(device) === pending) controlMutations.delete(device) }).catch(() => {})
    return pending
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

  // ---------------------------------------------------------------------------------------
  // F-134: the engine of an agent, and where a Codex chat's conversation is

  /** The engine an agent really runs: its own setting, else Settings › Chats'. */
  const engineFor = (agent: FloorAgent): 'claude' | 'codex' | 'opencode' => executionIdentityOf(agent, defaultsNow()).engine
  const isCodexSession = (sid: string): boolean => {
    const at = bySession(sid)
    return !!at && engineFor(at.agent) === 'codex'
  }
  const rolloutCache = new Map<string, string>()
  const switchFences = createSwitchFences(path.join(o.dir, 'engine-switches.json'))
  const activeSwitches = new Set<string>()
  const conversionProgress = createConversionProgress()
  const pullFrom = (peer: LinkPeer, sid: string, file: string) => {
    const guard = controlTransferGuard(peer, sid)
    guard()
    return pullTranscriptFrom(peer, sid, file, () => {
      if (switchFences.blocked(sid)) return false
      try { guard(); return true } catch { return false }
    })
  }
  const threadWatchers = new Map<string, () => void>()
  /** A Codex chat's rollout file, once its conversation id is known and the file is there; null for every other chat. */
  function codexRollout(sid: string): string | null {
    const at = bySession(sid)
    const thread = at && engineFor(at.agent) === 'codex' ? at.agent.codexThread : null
    if (!thread || !o.codex) return null
    const cached = rolloutCache.get(thread)
    if (cached && existsSync(cached)) return cached
    const found = findRollout(o.codex.paths.home, thread)
    if (found) rolloutCache.set(thread, found)
    else rolloutCache.delete(thread)
    return found
  }
  /** Every place that looks for a chat's conversation goes through this: a Codex chat's is its rollout, any other chat's is Claude's JSONL. */
  const isOpenCode = (sid: string) => { const at = bySession(sid); return !!at && engineFor(at.agent) === 'opencode' }
  const findTranscript = (sid: string, dir: string): string | null => isOpenCode(sid) ? openCode.file(sid) : codexRollout(sid) ?? findClaudeTranscript(sid, dir)

  /** Where this PC keeps a session's JSONL, whether it has it yet or not. */
  function fileOf(sid: string): string {
    if (!validMirrorSid(sid)) throw apiError(400, 'Expected a canonical session id')
    if (isOpenCode(sid)) return openCode.mirror(sid)
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
  const poolOptions: ChatPoolOptions = {
    addDirs: [uploads.dir],
    // F-083: a chat with an open order or unfinished work is never ended for being idle.
    keep: sid => workOf(sid) !== null,
    idleReapMs: o.idleReapMs,
    reapEveryMs: o.reapEveryMs,
    onEnded: e => {
      void executionService?.runtime.ended(e.sessionId)
      approvalNativeRuntimes.delete(e.sessionId)
      // F-134: a Codex chat that ended lets the login go (the last one puts a changed login back to the CRM first, then takes the file out) and its profile.
      if (e.engine === 'codex' && o.codex) {
        removeProfile(o.codex.paths, e.sessionId)
        void o.codex.release(e.sessionId).catch(err => log?.warn(`Codex login: ${message(err)}`))
      }
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
    codexBin: () => o.codex?.bin() ?? null,
    codexCredential: () => o.codex?.credentialEnv() ?? null,
    codexSend: o.codexSend,
    token: o.token,
    credential: o.credential,
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
  }
  const openCode = createOpenCodePool({
    dir: path.join(o.dir, 'opencode'), toolsUrl: () => poolOptions.toolsUrl(), shim,
    credential: o.openCodeCredential ?? (async () => { throw apiError(503, 'OpenCode CRM credentials are not configured on this PC.') }),
    find: o.openCodeFind, backend: o.openCodeBackend, freeMemory: o.openCodeFreeMemory, spawn: o.spawn,
    keep: sid => workOf(sid) !== null,
    identity: o.openCodeIdentity,
    onBind: async (sid, native) => {
      const at = bySession(sid)
      if (!at) throw apiError(409, 'The OpenCode chat binding changed during start.')
      if (mode() === 'member' && !isLocalFloor(at.floor.id)) await request(needHub(), 'opencode-bind', { sessionId: sid, native })
      else floors.setOpenCodeSession(at.floor.id, at.agent.id, native)
    },
    onChange: () => poolOptions.onChange?.(), onEnded: e => poolOptions.onEnded?.(e),
  })
  const nativeChats = combinePools(createChatPool(poolOptions), openCode.pool)
  if (o.codex && o.chatHost?.inspect && o.chatHost.current && !o.spawn) {
    executionService = createExecutionService({ directory: path.join(o.dir, 'codex-claude'), manager: o.codex, host: o.chatHost, self,
      pool: () => nativeChats, memorySettings: poolOptions.settings,
      current: request => {
        try {
          const at = bySession(request.binding.sessionId!)
          if (!at || isPcControl(at.floor) || request.targetPcId !== self().id) return false
          assertExecutionCAS(request.binding, snapshotAgentExecution(at.agent, defaultsNow()))
          return loadSession(o.crmSession ?? path.join(o.dir, '..', 'crm-session.json'))?.user.id === request.ownerId
        } catch { return false }
      },
      actor: scope => {
        const agent = workflowExecutionAgent(scope.floorId, scope.agentId)
        if (agent.owner?.id !== scope.ownerId || scope.targetPcId !== self().id
          || agent.homePc !== scope.targetPcId) throw executionHttpError('execution-forbidden', 'authorization')
      },
      state: scope => floors.executionState(scope.floorId, scope.agentId),
      floorFile: () => path.join(o.dir, mode() === 'member' ? 'floors-local.json' : 'floors.json'),
      commit: request => { floors.commitExecution(request) },
      target: (scope, profile) => targetExecution(profile, workflowExecutionAgent(scope.floorId, scope.agentId)),
      progress: (scope, stage, operationId) => {
        if (operationId && stage === 'checking') conversionProgress.begin(scope.floorId, scope.agentId, operationId)
        if (operationId && conversionProgress.get(scope.floorId, scope.agentId)?.operationId !== operationId) return
        conversionProgress.update(scope.floorId, scope.agentId, stage)
      },
      nativeOpen: async (request, assertCurrent, executable) => {
        const guard = () => {
          assertCurrent()
          const agent = workflowExecutionAgent(request.scope.floorId, request.scope.agentId)
          assertExecutionCAS(request.binding, snapshotAgentExecution(agent, defaultsNow()))
          if (request.signal.aborted || request.kind !== 'native' || request.binding.execution.profile !== 'codex-native-v1'
            || agent.owner?.id !== request.scope.ownerId || request.scope.targetPcId !== self().id
            || loadSession(o.crmSession ?? path.join(o.dir, '..', 'crm-session.json'))?.user.id !== request.scope.ownerId) throw executionHttpError('execution-forbidden', 'open')
        }
        guard()
        await openChat(request.scope.floorId, request.scope.agentId, { cols: request.cols, rows: request.rows }, guard, executable)
        guard()
      },
      launch: request => {
        const floor = floorOf(request.scope.floorId), agent = workflowExecutionAgent(floor.id, request.scope.agentId)
        assertExecutionCAS(request.binding, snapshotAgentExecution(agent, defaultsNow()))
        const sid = request.binding.sessionId!, cwd = executionLaunchCwd(findTranscriptCwd(sid, projectsDir), () => codeDirOf(floor))
        prepareClaudeConfig(cwd, claudeJson)
        const brief = composeAgentBrief(floor, { ...agent, model: '' }, o.memory?.start ? memoryBrief() : '', orderReplies())
          + '\n\nExecution: provider Codex (ChatGPT subscription), harness Claude Code, transcript Claude JSONL. Every provider request is GPT-6.1 Sol with explicit max effort. Never claim to be native Codex.\n'
        const built = strictConfigFor(o.dir, sid, appMcpServers, mcpRegistryFile, claudeJson, cwd, agent.mcpServers)
        return { sessionId: sid, floorId: floor.id, agentId: agent.id, cwd, briefPath: writeBrief(briefsDir, sid, brief),
          mcpConfig: built.file, strictMcp: true, model: 'gpt-6.1-sol', effort: 'max', resume: !!findClaudeTranscript(sid, projectsDir), cols: request.cols, rows: request.rows }
      },
      seal: async (scope, expected) => {
        conversionProgress.update(scope.floorId, scope.agentId, 'stopping')
        assertExecutionCAS(expected, floors.executionState(scope.floorId, scope.agentId).binding)
        if (!expected.sessionId || expected.execution.engine === 'opencode') throw executionHttpError('execution-lineage-invalid', 'selection')
        const token = randomUUID(), file = expected.execution.engine === 'codex'
          ? expected.codexThread && o.codex ? findRollout(o.codex.paths.home, expected.codexThread) : null
          : findClaudeTranscript(expected.sessionId, projectsDir)
        if (!file) throw executionHttpError('execution-lineage-invalid', 'selection')
        switchFences.begin(expected.sessionId, token, 'execution-profile-v1')
        if (nativeChats.info(expected.sessionId)) { nativeChats.kill(expected.sessionId, 'execution-selection'); await nativeChats.waitStopped?.(expected.sessionId) }
        if (expected.execution.profile === 'codex-in-claude-v1') await executionService?.runtime.ended(expected.sessionId)
        await settled(file)
        switchFences.snapshot(expected.sessionId, token, file, 'execution-profile-v1'); switchFences.seal(expected.sessionId, token, 'execution-profile-v1')
        const digest = sourceHash(file)
        return { assertCurrent: () => { if (sourceHash(file) !== digest) throw executionHttpError('execution-stale', 'selection') },
          finish: (committed, changed) => { if (committed && changed) switchFences.retire(expected.sessionId!, token, 'execution-profile-v1'); else switchFences.cancel(expected.sessionId!, token, 'execution-profile-v1') } }
      },
      prepare: async (scope, expected, target) => {
        const floor = floorOf(scope.floorId), file = expected.execution.engine === 'codex'
          ? expected.codexThread && o.codex ? findRollout(o.codex.paths.home, expected.codexThread) : null
          : findClaudeTranscript(expected.sessionId!, projectsDir)
        if (!file) throw executionHttpError('execution-lineage-invalid', 'selection')
        const onProgress = (stage: import('../../shared/conversion-progress.ts').ConversionStage, transfer: import('../codex/complete-conversion.ts').TransferProgress) => conversionProgress.update(scope.floorId, scope.agentId, stage, transfer)
        if (target.profile === 'codex-native-v1' && o.codex) {
          let recovery: import('../codex/complete-conversion.ts').CompleteConversionOptions['recovery']
          if (expected.execution.profile === 'codex-native-v1') {
            const agent=workflowExecutionAgent(scope.floorId,scope.agentId),history=agent.conversationHistory??[]
            const chain: import('../../shared/agentic.ts').ConversationRecord[]=[]
            const visited=new Set<string>()
            let cursor=history.find(r=>r.sessionId===expected.sessionId&&r.engine==='codex')
            while(cursor) {
              if(visited.has(cursor.sessionId)||chain.length>=32)throw executionHttpError('execution-lineage-invalid','selection')
              visited.add(cursor.sessionId);chain.unshift(cursor)
              if(!cursor.sourceSessionId)break
              const previous=history.filter(r=>r.sessionId===cursor!.sourceSessionId)
              cursor=previous.find(r=>r.sourceSessionId)||previous[0]
              if(!cursor)throw executionHttpError('execution-lineage-invalid','selection')
            }
            if(chain.length<3||chain[0].engine!=='codex')throw executionHttpError('execution-lineage-invalid','selection')
            const seals=JSON.parse(readFileSync(path.join(o.dir,'engine-switches.json'),'utf8')) as Array<{sessionId:string;state:string;file?:string;sha256?:string}>
            const segments: NonNullable<typeof recovery>['segments']=[]
            for(const [index,record] of chain.entries()) {
              const source=record.engine==='codex'&&record.codexThread?findRollout(o.codex.paths.home,record.codexThread):record.engine==='claude'?findClaudeTranscript(record.sessionId,projectsDir):null
              if(!source||record.homePc!==self().id)throw executionHttpError('execution-lineage-invalid','selection')
              if(record.sessionId!==expected.sessionId){const seal=seals.find(s=>s.sessionId===record.sessionId)
                if(nativeChats.info(record.sessionId)||seal?.state!=='retired'||seal.file!==source||seal.sha256!==sourceHash(source))throw executionHttpError('execution-lineage-invalid','selection')}
              segments.push({file:source,format:record.engine as 'codex'|'claude',sessionId:record.sessionId,delta:index!==0})
            }
            recovery={segments}
          }
          return forkNativeCodexExecution({ expected, target, file, cwd: conversationCwd(file) || codeDirOf(floor), codexHome: o.codex.paths.home, onProgress, recovery })
        }
        return forkClaudeExecution({ expected, target, file, cwd: conversationCwd(file) || codeDirOf(floor), projectsDir, onProgress })
      },
    })
  }
  let blockedLegacyAdoption = false
  const assertLegacySid = (sid: string) => {
    const current = bySession(sid)
    if (current) requireLegacyExecution(current.agent, defaultsNow())
  }
  const legacySidAllowed = (sid: string) => { try { assertLegacySid(sid); return true } catch { return false } }
  const runtimeSidAllowed = (sid: string) => {
    try {
      const at = bySession(sid)
      if (!at || executionIdentityOf(at.agent, defaultsNow()).profile !== 'codex-in-claude-v1') return legacySidAllowed(sid)
      const binding = snapshotAgentExecution(at.agent, defaultsNow()), info = nativeChats.info(sid)
      if (!info?.execution || !executionService?.runtime.matches(binding, info.bridgeRunId)) return false
      assertExecutionCAS(binding, info.execution); return true
    } catch { return false }
  }
  // F-163: this agent's own bridge chat in the pool, admitted or not, can be stopped and shown (never typed into): bridge-stop.ts.
  const ownBridgeSid = (sid: string) => ownBridgeChat(bySession(sid)?.agent, nativeChats.info(sid))
  function assertMessageRuntime(sid: string, targetPcId: string, confirmed: boolean) {
    const at=bySession(sid)
    if(!at)return
    const runtime=nativeChats.info(sid)
    requireMessageExecution(at.agent,defaultsNow(),{selfPcId:self().id,targetPcId,confirmed,
      runtimeBinding:runtime?.execution,runId:runtime?.bridgeRunId,
      admitted:(expected,runId)=>executionService?.runtime.matches(expected,runId)===true})
  }
  const chats: ChatPool = { ...nativeChats,
    beforeAdopt: async info => {
      const at = bySession(info.sessionId)
      if (at && executionIdentityOf(at.agent, defaultsNow()).profile === 'codex-in-claude-v1') {
        const expected = snapshotAgentExecution(at.agent, defaultsNow())
        assertExecutionCAS(expected, info.execution)
        if (!executionService || !info.bridgeRunId) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        await executionService.runtime.adopt(expected, info.bridgeRunId)
      }
    },
    start: options => { assertLegacySid(options.sessionId); switchFences.assertWritable(options.sessionId); return nativeChats.start(options) },
    input: (sid, data) => runtimeSidAllowed(sid) && !switchFences.blocked(sid) && nativeChats.input(sid, data),
    press: (sid, data) => runtimeSidAllowed(sid) && !switchFences.blocked(sid) && nativeChats.press(sid, data),
    type: (sid, text, options) => runtimeSidAllowed(sid) && !switchFences.blocked(sid) && nativeChats.type(sid, text, options),
    deliver: async (sid, text, options) => !runtimeSidAllowed(sid) || switchFences.blocked(sid) ? 'blocked' : nativeChats.deliver?.(sid, text, options) ?? 'unconfirmed',
    attach: (sid, viewer) => runtimeSidAllowed(sid) || ownBridgeSid(sid) ? nativeChats.attach(sid, viewer) : null,
    resize: (sid, cols, rows) => { if (runtimeSidAllowed(sid)) nativeChats.resize(sid, cols, rows) },
    kill: (sid, why) => (runtimeSidAllowed(sid) || ownBridgeSid(sid)) && nativeChats.kill(sid, why),
    typeWhenReady: (sid, text, options) => { assertLegacySid(sid); switchFences.assertWritable(sid); nativeChats.typeWhenReady(sid, text, options) },
    adopt: (info, pty, replay) => {
      try {
        const at = bySession(info.sessionId)
        if (at && executionIdentityOf(at.agent, defaultsNow()).profile === 'codex-in-claude-v1') {
          if (!executionService) throw executionHttpError('execution-capability-required', 'runtime')
          const expected = snapshotAgentExecution(at.agent, defaultsNow())
          assertExecutionCAS(expected, info.execution)
          if (!executionService?.runtime.matches(expected, info.bridgeRunId)) throw executionHttpError('execution-runtime-mismatch', 'runtime')
        } else assertLegacySid(info.sessionId)
      } catch (error) { blockedLegacyAdoption = true; throw error }
      const result = nativeChats.adopt(info, pty, replay)
      if (switchFences.blocked(info.sessionId)) nativeChats.kill(info.sessionId, 'engine-switch-recovery')
      return result
    },
  }

  // F-075: the chats the agent before this one left running in the chat host are taken over at once.
  let hostAdopted = !o.chatHost
  function requireHostAdoption() {
    if(!hostAdopted)throw apiError(503,'Chats are reconnecting. Try again shortly.')
  }
  const adopted: Promise<void> = o.chatHost
    ? Promise.resolve(existsSync(path.join(o.dir, 'codex-claude', 'capability.json')) ? executionService?.runtime.ensure() : undefined)
        .then(() => o.chatHost!.adopt(chats))
        .then(r => {
          hostAdopted = true
          // F-134: a Codex chat the host kept running holds the Codex login file: it counts as one of the chats that keep it.
          for (const c of chats.live()) if (c.engine === 'codex') o.codex?.adopt(c.sessionId)
          if (r.adopted.length || r.ended.length) log?.info(`chat host: took over ${r.adopted.length} running chat${r.adopted.length === 1 ? '' : 's'}${r.ended.length ? `; ${r.ended.length} ended while no agent was there` : ''}`)
        })
        .catch(e => void log?.warn(`chat host: could not take over its chats: ${message(e)}`))
    : Promise.resolve()
  // F-134, once the chats the host kept are known: profiles of chats that are gone are swept, and a Codex login file left by a crash is settled (put back to the CRM
  // first if Codex had refreshed it) and taken out when no Codex chat runs.
  void adopted.then(async () => {
    const cx = o.codex
    if (!cx) return
    if (blockedLegacyAdoption || floors.hasUnverifiedExecution()) {
      log?.warn('Execution ownership is unverified; native credential cleanup is deferred until trusted provider adoption.')
      return
    }
    for (const floor of floors.list()) for (const agent of floor.agents) {
      if (engineFor(agent) !== 'codex' || !agent.sessionId || agent.codexThread) continue
      const sid = agent.sessionId
      if (!learnThread(sid, floor.id, agent.id, 0) && chats.info(sid)) watchThread(sid, floor.id, agent.id, 0)
    }
    try {
      sweepProfiles(cx.paths, new Set(chats.live().filter(c => c.engine === 'codex').map(c => profileName(c.sessionId))))
      await cx.sweep()
    } catch (e) {
      log?.warn(`Codex start-up sweep: ${message(e)}`)
    }
  }).catch(e => log?.warn(`Codex start-up discovery blocked: ${message(e)}`))
  // The host is lost (it died): the chats that ran in it end. Noted first; reopened (resumed) when a host is back.
  let lostWithHost: Array<{ sid: string; state: ChatState }> = []
  o.chatHost?.onLost(why => {
    hostAdopted = false
    lostWithHost = Object.entries(chats.states()).map(([sid, state]) => ({ sid, state }))
    log?.error(`the chat host is gone (${why}): ${lostWithHost.length} chat(s) ended with it; they are reopened when a host is back`)
  })
  o.chatHost?.onBack(() => {
    hostAdopted = true
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

  /**
   * F-134: starts an agent's chat on this PC with Codex. The CRM's login is made ready first (codex/index.ts acquire: refused with a Codex code if it can't be), the
   * chat's profile is written (its brief, model, effort and MCP servers; the chat's own key is only NAMED there), and codex is started in the shared home.
   * A chat whose conversation id is not known yet is a new conversation; its id is learnt from its rollout file once Codex has written it.
   */
  async function startCodexHere(floor: Floor, agent: FloorAgent, sid: string, size: OpenChatRequest, executionGuard?: () => void, nativeExecutable?: string): Promise<boolean> {
    executionGuard?.()
    const cx = o.codex
    if (!cx) throw Object.assign(apiError(503, "Codex isn't set up on this PC."), { code: 'not-installed' })
    const thread = agent.codexThread ?? learnThread(sid, floor.id, agent.id, 0)?.thread ?? null
    // A discovered member-side candidate is not resumable until the hub commits its native binding.
    const binding = threadBinds.get(sid)
    if (binding) await binding
    const requireConfirmedThread = () => {
      executionGuard?.()
      const current = bySession(sid)
      if (current?.floor.id !== floor.id || current.agent.id !== agent.id || engineFor(current.agent) !== 'codex' || (current.agent.codexThread ?? null) !== thread) {
        throw pcControlError('engine-change-stale', 'The approved Codex conversation changed before launch. Refresh and open the chat again.')
      }
    }
    requireConfirmedThread()
    const rollout = thread ? findRollout(cx.paths.home, thread) : null
    const resume = !!rollout
    const cwd = (rollout && conversationCwd(rollout)) || codeDirOf(floor)
    if (thread && !resume) {
      throw Object.assign(apiError(409, "This Codex conversation isn't on this PC: Codex conversations stay on the PC that started them (for now). Open the chat on that PC, or change the agent's engine to start a new conversation."), {
        code: 'codex-conversation-elsewhere',
      })
    }
    await cx.acquire(sid)
    try {
      requireConfirmedThread()
      const dflt = defaultsNow()
      const brief = composeAgentBrief(floor, agent, o.memory?.start ? memoryBrief() : '', orderReplies(), 'Codex')
      const mcp: Record<string, McpServerToml> = {
        // The shim is told whose chat it is by the terminal's environment, never by a file.
        [MCP_SERVER_NAME]: { command: process.execPath, args: [shim], env_vars: ['SAD_AGENTIC_KEY', 'SAD_AGENTIC_URL'] },
      }
      const registry = readRegistry(mcpRegistryFile)
      for (const name of chosen(registry, agent.mcpServers)) {
        const def = registry[name]
        mcp[name] = { command: def.command, args: def.args, ...(def.env && Object.keys(def.env).length ? { env: def.env } : {}) }
      }
      writeProfile(cx.paths, { sessionId: sid, cwd, brief, model: agent.codexModel || dflt.codexModel || '', effort: agent.codexEffort || dflt.codexEffort || '', mcp, ...(cx.credentialEnv() ? { keyVar: cx.credentialEnv()!.name } : {}) })
      log?.info(`chat ${sid.slice(0, 8)}: Codex, MCP servers ${Object.keys(mcp).join(', ')}`)
      const startedMs = Date.now()
      chats.start({
        sessionId: sid,
        floorId: floor.id,
        agentId: agent.id,
        cwd,
        briefPath: '',
        model: '',
        resume,
        cols: size.cols,
        rows: size.rows,
        engine: 'codex',
        codex: { home: cx.paths.home, profile: profileName(sid), thread: resume ? thread : null, ...(nativeExecutable ? { bin: nativeExecutable } : {}) },
      })
      launched.set(sid, { effort: agent.codexEffort || dflt.codexEffort || '', at: new Date().toISOString(), ultracode: false })
      heartbeat.opened(sid)
      chatLog.append({ event: 'start', sessionId: sid, agent: agent.name, floor: floor.name, cause: startCause.get(sid) ?? (resume ? 'resumed' : 'new') })
      startCause.delete(sid)
      if (!resume) watchThread(sid, floor.id, agent.id, startedMs)
      if (team) tail.track(sid, fileOf(sid), markOf(fileOf(sid)).bytes)
      return resume
    } catch (e) {
      removeProfile(cx.paths, sid)
      await cx.release(sid)
      throw e
    }
  }

  function unboundCodex(sid: string, floorId: string, agentId: string) {
    const at = bySession(sid)
    return at?.floor.id === floorId && at.agent.id === agentId && engineFor(at.agent) === 'codex' && !at.agent.codexThread
  }

  const threadBinds = new Map<string, Promise<void>>()
  function learnThread(sid: string, floorId: string, agentId: string, sinceMs: number) {
    if (!o.codex || !unboundCodex(sid, floorId, agentId)) return null
    const found = discoverThread(o.codex.paths.home, sid, sinceMs)
    if (!found || !unboundCodex(sid, floorId, agentId)) return null
    assertCodexThreadAvailable(allFloors(), floorId, agentId, found.thread)
    const record = () => {
      rolloutCache.set(found.thread, found.file)
      log?.info(`chat ${sid.slice(0, 8)}: Codex conversation ${found.thread.slice(0, 8)}`)
      if (team && chats.info(sid)) tail.track(sid, found.file, 0)
    }
    if (mode() === 'member' && !isLocalFloor(floorId)) {
      if (!threadBinds.has(sid)) {
        const binding = request(needHub(), 'codex-bind', { sessionId: sid, native: found.thread }).then(reply => {
          if (!isObject(reply) || reply.ok !== true) throw apiError(409, 'Native conversation binding was not confirmed by the hub.')
          const at = bySession(sid)
          if (at?.floor.id !== floorId || at.agent.id !== agentId || engineFor(at.agent) !== 'codex' || (at.agent.codexThread && at.agent.codexThread !== found.thread)) throw pcControlError('engine-change-stale', 'The conversation changed while its native binding was being confirmed.')
          if (at?.floor.id === floorId && at.agent.id === agentId && engineFor(at.agent) === 'codex' && !at.agent.codexThread) {
            replica.floors = replica.floors.map(f => f.id !== floorId ? f : { ...f, agents: f.agents.map(a => a.id !== agentId ? a : { ...a, codexThread: found.thread }) })
          }
          record()
        }).catch(error => {
          log?.warn(`Could not record the remote Codex conversation: ${message(error)}`)
          if (!closing && chats.info(sid) && unboundCodex(sid, floorId, agentId)) watchThread(sid, floorId, agentId, sinceMs)
          throw error
        }).finally(() => threadBinds.delete(sid))
        threadBinds.set(sid, binding)
        void binding.catch(() => {}) // Background discovery reports through its watcher; launchers await the same confirmation.
      }
    } else { floors.setCodexThread(floorId, agentId, found.thread); record() }
    return found
  }

  /** Includes adopted chats. A delayed first write is not a reason to abandon a live conversation. */
  function watchThread(sid: string, floorId: string, agentId: string, startedMs: number) {
    if (!o.codex) return
    threadWatchers.get(sid)?.()
    threadWatchers.set(sid, watchForThread({
      active: () => !closing && !!chats.info(sid) && unboundCodex(sid, floorId, agentId),
      discover: () => !!learnThread(sid, floorId, agentId, startedMs),
      failed: e => log?.warn(`chat ${sid.slice(0, 8)}: couldn't keep its Codex conversation id: ${message(e)}`),
    }))
  }

  /** A newer login was put in place while Codex chats were running: they hold the older one, so each is restarted (its conversation resumes), one after the other. */
  function restartCodexChats() {
    void (async () => {
      for (const c of chats.live()) {
        if (closing || c.engine !== 'codex') continue
        try {
          await restartChat(c.sessionId)
        } catch (e) {
          log?.warn(`couldn't restart chat ${c.sessionId.slice(0, 8)} on the newer Codex login: ${message(e)}`)
        }
      }
    })()
  }

  /** Starts the agent's chat on this PC (its lease already got). */
  async function startHere(floor: Floor, agent: FloorAgent, sid: string, size: OpenChatRequest, executionGuard?: () => void, nativeExecutable?: string): Promise<boolean> {
    executionGuard?.()
    requireLegacyExecution(agent, defaultsNow())
    assertPcControlTarget(floor, self().id, size)
    if (engineFor(agent) === 'opencode') {
      const dflt = defaultsNow(), cwd = codeDirOf(floor)
      const selection = openCodeSelection(agent, dflt)
      if (agent.opencodeSession && agent.homePc && agent.homePc !== self().id) throw apiError(409, 'OpenCode conversations resume on their home PC.')
      const mcp: NonNullable<import('../opencode/backend.ts').BackendOptions['mcp']> = {}
      const registry = readRegistry(mcpRegistryFile)
      for (const name of chosen(registry, agent.mcpServers)) { const def = registry[name]; mcp[name] = { command: [def.command, ...def.args], environment: def.env } }
      await openCode.prepare({ sessionId: sid, floorId: floor.id, agentId: agent.id, cwd, briefPath: '', model: '', resume: !!agent.opencodeSession, engine: 'opencode', provider: selection.provider, selectedModel: selection.model, native: agent.opencodeSession ?? null, brief: composeAgentBrief(floor, agent, o.memory?.start ? memoryBrief() : '', orderReplies(), 'OpenCode'), mcp })
      heartbeat.opened(sid)
      chatLog.append({ event: 'start', sessionId: sid, agent: agent.name, floor: floor.name, cause: agent.opencodeSession ? 'resumed' : 'new' })
      if (team) tail.track(sid, fileOf(sid), markOf(fileOf(sid)).bytes)
      return !!agent.opencodeSession
    }
    if (engineFor(agent) === 'codex') return startCodexHere(floor, agent, sid, size, executionGuard, nativeExecutable)
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
    const offline: OfflineChats = { on: offlineSettings.on(), active: offlineActive(), since: sub === null && downSince !== null ? new Date(downSince).toISOString() : null, hubName: team!.hub()?.name ?? null }
    return { pc: self().name, role: 'member', hub: team!.hub()?.name ?? null, reachable: sub !== null, offline, pcs: pcs() }
  }

  const emitWhere = () => emit({ t: 'where', elsewhere: elsewhere(), last: lastAll(), team: teamInfo() })
  const emitFloors = () => { emit({ t: 'floors', floors: allFloors() }); emit({ t: 'pc-control', answer: controlRawAnswer() }) }

  function hold(sid: string, who: { id: string; name: string }) {
    const pin = controlPinnedPc(sid)
    if (pin && pin !== who.id) throw pcControlError('pc-control-wrong-device', 'This lease belongs only to its pinned PC.')
    held.set(sid, { holder: who.id, holderName: who.name, heldAt: Date.now(), last: held.get(sid)?.last ?? null })
    saveHeld()
    // F-064: the first PC to run a chat is its home (a chat that has one keeps it, however it is run later).
    const at = floors.bySession(sid)
    if (at && !at.agent.homePc) floors.setHome(at.floor.id, at.agent.id, who)
  }

  /** Lets a session go: what `who` held is free, and ran last there. */
  function release(sid: string, who: { id: string; name: string }) {
    const pin = controlPinnedPc(sid)
    if (pin && pin !== who.id) return
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
    const managed = bySession(sid)
    if (managed) assertPcControlTarget(managed.floor, id, {})
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
    const bound = bySession(sid)
    if (bound) requireLegacyExecution(bound.agent, defaultsNow())
    const pinned = bySession(sid)
    if (pinned) assertPcControlTarget(pinned.floor, who.id, { takeOver })
    switchFences.assertWritable(sid)
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
    switchFences.assertWritable(sid)
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
      const state = { t: 'state', floors: floors.list(), pcControl: controlRawAnswer(), defaults: chatDefaults.get(), where: whereAll(), last: lastAll(), marks: marksHere(), engineSwitchContinuity: { version: 1, failClosed: true, homePcPreparation: true } }
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
    if (pulling.has(sid) || chats.info(sid) || switchFences.blocked(sid)) return
    pulling.add(sid)
    pulls = pulls
      .then(async () => {
        // Started here meanwhile: this PC writes it now.
        if (chats.info(sid) || switchFences.blocked(sid)) return
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
        const live = Object.fromEntries(Object.entries(raw.live).filter((e): e is [string, ChatState] => typeof e[1] === 'string' && validMirrorSid(e[0]) && (!controlPinnedPc(e[0]) || controlPinnedPc(e[0]) === from.id)))
        remote.set(from.id, { name: from.name, live })
        // What it held and no longer runs (it stopped, or restarted): let go.
        for (const [sid, h] of held) if (h.holder === from.id && !live[sid] && Date.now() - h.heldAt > LEASE_GRACE_MS) release(sid, from)
        emitWhere()
        pushState()
      }
      if ((raw.t === 'hello' || raw.t === 'marks') && isObject(raw.marks)) {
        const l = link()
        for (const [sid, m] of Object.entries(raw.marks)) {
          if (!validMirrorSid(sid)) continue
          if (controlPinnedPc(sid) && controlPinnedPc(sid) !== from.id) continue
          if (!isMark(m) || chats.info(sid)) continue
          const h = held.get(sid)
          if (h?.holder && h.holder !== from.id) continue
          if (m.bytes > markOf(fileOf(sid)).bytes && l) backfill(l, sid)
        }
      }
      if (raw.t === 'jsonl' && typeof raw.sid === 'string' && validMirrorSid(raw.sid) && typeof raw.from === 'number' && typeof raw.d === 'string') {
        if (controlPinnedPc(raw.sid) && controlPinnedPc(raw.sid) !== from.id) return
        // Only from the PC running it (or granted it, starting), and never into a copy this PC writes.
        if (chats.info(raw.sid) || (held.get(raw.sid)?.holder !== from.id && remote.get(from.id)?.live[raw.sid] === undefined)) return
        const data = Buffer.from(raw.d, 'base64')
        if (switchFences.blocked(raw.sid)) return
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
    if (!h.link || !sub) {
      const here = !offlineSettings.on()
        ? ''
        : offlineActive()
          ? ' New floors and chats made on this PC work without it.'
          : ` If it stays out of reach for ${Math.round(offlineAfter / 1000)} s, new floors and chats can be made on this PC.`
      throw Object.assign(apiError(503, `${h.name} (the hub) can't be reached right now, so the floors on it are read-only here and no chat of theirs can start. Chats running here go on.${here}`), { code: 'hub-offline' })
    }
    return h.link
  }

  function memberTick() {
    void reconcileSwitchFences().catch(error => log?.warn('Engine-switch recovery remains fenced: ' + message(error)))
    if (mode() !== 'member') {
      downSince = null
      if (sub) dropSub()
      return
    }
    const link = team!.hub()?.link ?? null
    if (sub && (!link || sub.token !== link.token)) dropSub()
    if (sub) downSince = null
    else if (downSince === null) downSince = Date.now()
    // F-127: floors made here while the Server was away join it as soon as it can be reached (again, after a failure, every 30 s).
    if (link && sub && !adopting && Date.now() >= adoptRetryAt && localFloors.list().length) void adoptLocal(link)
    if (!link || sub || subscribing) return
    subscribing = true
    link.open({ op: 'subscribe' }).then(
      stream => {
        subscribing = false
        sub = { token: link.token, stream }
        replica.engineSwitchContinuity = undefined
        downSince = null
        writeLine(stream, { t: 'hello', live: chats.states(), marks: marksHere() })
        readLines(stream, raw => onHubEvent(link, raw))
        const gone = () => {
          if (sub?.stream !== stream) return
          sub = null
          downSince = Date.now()
          emitWhere()
        }
        stream.on('close', gone)
        stream.on('error', gone)
        log?.info(`following ${link.name}'s floors`)
        emitWhere()
        // F-127: this PC's own floors from the time the Server was away.
        void adoptLocal(link)
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
    downSince = Date.now()
    s?.stream.destroy()
    emitWhere()
  }

  function onHubEvent(link: LinkPeer, raw: unknown) {
    if (!isObject(raw)) return
    if (raw.t === 'state' && Array.isArray(raw.floors)) {
      replica = {
        engineSwitchContinuity: isObject(raw.engineSwitchContinuity) && raw.engineSwitchContinuity.version === 1 && raw.engineSwitchContinuity.failClosed === true && raw.engineSwitchContinuity.homePcPreparation === true
          ? { version: 1, failClosed: true, homePcPreparation: true } : undefined,
        floors: raw.floors as Floor[],
        pcControl: isObject(raw.pcControl) && Array.isArray(raw.pcControl.workspaces) ? raw.pcControl as unknown as PcControlAnswer : undefined,
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
        if (!validMirrorSid(sid) || !isMark(theirs) || chats.info(sid)) continue
        const mine = markOf(fileOf(sid))
        if (mine.bytes < theirs.bytes || (mine.bytes === theirs.bytes && mine.tail !== theirs.tail)) backfill(link, sid)
      }
    } else if (raw.t === 'jsonl' && typeof raw.sid === 'string' && validMirrorSid(raw.sid) && typeof raw.from === 'number' && typeof raw.d === 'string') {
      if (chats.info(raw.sid) || switchFences.blocked(raw.sid)) return
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
    requireLegacyExecution(agent, defaultsNow())
    let sid = agent.sessionId
    assertPcControlTarget(floor, self().id, req)
    if (sid) switchFences.assertWritable(sid)
    await requirePeerEngine(link, agent)
    if (sid && chats.info(sid)) {
      requireRunningEngine(engineFor(agent), chats.info(sid)!.engine)
      const proof = await request<{ engine?: RuntimeEngine }>(link, 'lease', { sessionId: sid, takeOver: false, expectedEngine: engineFor(agent) })
      if (engineFor(agent) !== 'claude') requireRunningEngine(engineFor(agent), proof.engine)
      switchFences.assertWritable(sid)
      return { sessionId: sid, started: false, resumed: false, engine: chats.info(sid)!.engine }
    }
    const atHome = await resumeAtHome(floor, agent, sid, req)
    if (atHome) return atHome
    if (!sid) {
      sid = randomUUID()
      const r = isPcControl(floor)
        ? await request<{ floor: Floor }>(link, 'pc-control-bind', { floorId, agentId, sessionId: sid, revision: pcControlRevision(floor), expectedEngine: engineFor(agent) })
        : await request<{ floor: Floor }>(link, 'http', { method: 'POST', rest: `/floors/${enc(floorId)}/agents/${enc(agentId)}/session`, body: { sessionId: sid } })
      replica.floors = replica.floors.map(f => (f.id === r.floor.id ? r.floor : f))
    }
    const granted = await request<{ mark: FileMark; tookOverFrom: string | null; engine?: RuntimeEngine }>(link, 'lease', { sessionId: sid, takeOver: req.takeOver === true, expectedEngine: engineFor(agent) }, 45_000)
    try {
      if (engineFor(agent) !== 'claude') requireRunningEngine(engineFor(agent), granted.engine)
      // This PC's copy brought up to the hub's first, unless it already has all of it.
      const file = fileOf(sid)
      const mark = isMark(granted.mark) ? granted.mark : NO_FILE
      // F-134: a Codex chat's conversation is not mirrored between PCs yet: it stays on the PC that started it.
      const codexHere = (() => {
        try {
          return engineFor(agentOf(floorOf(floorId), agentId)) !== 'claude'
        } catch {
          return false
        }
      })()
      if (!codexHere && mark.bytes && !(markOf(file).bytes >= mark.bytes && sameMark(markOf(file, mark.bytes), mark))) await pullFrom(link, sid, file)
      const now = floorOf(floorId)
      const resumed = await startHere(now, agentOf(now, agentId), sid, req)
      requireRunningEngine(engineFor(agentOf(floorOf(floorId), agentId)), chats.info(sid)?.engine)
      return { sessionId: sid, started: true, resumed, engine: chats.info(sid)!.engine, ...(granted.tookOverFrom ? { tookOverFrom: granted.tookOverFrom } : {}) }
    } catch (e) {
      await request(link, 'release', { sessionId: sid, mark: markOf(fileOf(sid)) }).catch(() => {})
      throw e
    }
  }

  // ---------------------------------------------------------------------------------------
  // F-127: the floors made on this PC while the Server was away join the Server's list when it is back

  let adopting = false
  let adoptRetryAt = 0
  let adoptStatus: AdoptStatus = { state: 'idle', floors: 0, joined: 0, sessions: 0, why: null }
  const setAdopt = (s: Partial<AdoptStatus>) => {
    adoptStatus = { ...adoptStatus, ...s }
    emit({ t: 'adopt', adopt: adoptStatus })
  }

  interface AdoptAnswer {
    floors: { id: string; name: string; created: boolean; renamedFrom: string | null }[]
    /** The hub's copy of each conversation after it caught up. */
    marks: Record<string, FileMark>
  }

  /**
   * The member's side. The Server is asked to take the floors in whole (same ids, owners, shares, chats), then its list must show them, the conversations must be
   * equal on both sides (the same size and tail; a chat still running here is only moved on from where the Server's copy is), and only THEN are they dropped from the
   * local file, which is kept as floors-local.adopted-<time>.json: nothing is deleted. Any failure leaves everything as it was and it is tried again in 30 s;
   * asking twice is a no-op on the Server (it knows a floor by id).
   */
  async function adoptLocal(link: LinkPeer): Promise<void> {
    if (adopting || mode() !== 'member' || sub === null) return
    const all = localFloors.list()
    if (!all.length) return
    adopting = true
    try {
      const pending = all.filter(f => !replica.floors.some(x => x.id === f.id))
      const sids = all.flatMap(f => f.agents.flatMap(a => (a.sessionId ? [a.sessionId] : [])))
      setAdopt({ state: 'running', floors: all.length, joined: all.length - pending.length, sessions: 0, why: null })
      const running = sids.filter(s => !!chats.info(s))
      const marks: Record<string, FileMark> = {}
      for (const sid of sids) {
        const found = findTranscript(sid, projectsDir)
        if (found) marks[sid] = markOf(found)
      }
      let checked = 0
      {
        // Always all of them: a floor the Server has already is a no-op there, but its conversations are brought up and checked again before anything is dropped.
        const notes = Object.fromEntries(all.map(f => [f.id, memory.all(f.id).map(x => ({ text: x.text, tags: x.tags, authorName: x.authorName ?? null }))]))
        const answer = await request<AdoptAnswer>(link, 'adopt', { floors: all, running, marks, notes }, 120_000)
        for (const sid of sids) {
          const mine = marks[sid]
          if (!mine) continue
          const theirs = answer.marks?.[sid]
          if (!isMark(theirs)) throw new Error(`the Server has no copy of chat ${sid.slice(0, 8)} yet`)
          if (running.includes(sid)) {
            // Still writing here: its stream goes on from where the Server's copy is (what it lacks is sent again).
            tail.track(sid, fileOf(sid), theirs.bytes)
          } else if (theirs.bytes !== mine.bytes || theirs.tail !== mine.tail) {
            throw new Error(`the Server's copy of chat ${sid.slice(0, 8)} isn't equal to this PC's yet`)
          }
          checked++
        }
      }
      // Its own list must show them, each with the same chats and owners, before the local copy goes.
      const deadline = Date.now() + 20_000
      while (!all.every(f => replica.floors.some(x => x.id === f.id))) {
        if (sub === null) throw new Error('the link to the Server dropped')
        if (Date.now() > deadline) throw new Error("the Server's list doesn't show them yet")
        await new Promise(r => setTimeout(r, 100))
      }
      for (const f of all) {
        const theirs = replica.floors.find(x => x.id === f.id)!
        const same = f.agents.length === theirs.agents.length && f.agents.every(a => theirs.agents.some(b => b.id === a.id && b.sessionId === a.sessionId && b.owner?.id === a.owner?.id))
        if (!same) throw new Error(`the Server lists floor "${f.name}" differently from this PC`)
      }
      writeAtomic(path.join(o.dir, `floors-local.adopted-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${json({ at: new Date().toISOString(), to: link.name, floors: all })}\n`)
      for (const f of all) localFloors.remove(f.id)
      log?.info(`F-127: ${all.length} floors made here while the Server was away joined ${link.name}'s list (${checked} conversations checked)`)
      setAdopt({ state: 'done', floors: all.length, joined: all.length, sessions: checked, why: null })
      emitFloors()
    } catch (e) {
      adoptRetryAt = Date.now() + (o.adoptRetryMs ?? 30_000)
      const why = message(e)
      log?.warn(`F-127: floors made here couldn't join ${link.name}'s list yet: ${why}`)
      setAdopt({ state: 'failed', why: /doesn't do adopt/.test(why) ? `${link.name} is an older build and can't take them in yet: update it.` : why })
    } finally {
      adopting = false
    }
  }

  /** The hub's side: floors a member made while it was away, taken in whole. A floor it already has (same id) is left alone. */
  async function adoptFloors(from: { id: string; name: string }, raw: unknown): Promise<AdoptAnswer> {
    if (!isObject(raw) || !Array.isArray(raw.floors) || raw.floors.length === 0 || raw.floors.length > 200) throw apiError(400, 'Expected {floors: [...]}')
    const running = new Set(Array.isArray(raw.running) ? raw.running.filter((x): x is string => typeof x === 'string') : [])
    const marks = isObject(raw.marks) ? raw.marks : {}
    const notes = isObject(raw.notes) ? raw.notes : {}
    const link = team?.member(from.id) ?? null
    const out: AdoptAnswer['floors'] = []
    const mine: Record<string, FileMark> = {}
    for (const f of raw.floors) {
      if (isObject(f) && (f.workspace === 'pc-control' || (typeof f.id === 'string' && controlAlias(f.id)) || (Array.isArray(f.agents) && f.agents.some(a => isObject(a) && (a.pcControlSlot !== undefined || [a.id, a.sessionId, a.codexThread, a.opencodeSession].some(x => typeof x === 'string' && controlAlias(x))))))) throw immutablePcControl()
    }
    for (const f of raw.floors) {
      const { floor, created, renamedFrom } = hubFloors.adopt(f, from)
      out.push({ id: floor.id, name: floor.name, created, renamedFrom })
      const list = notes[floor.id]
      if (created && Array.isArray(list)) {
        for (const x of list.slice(0, 500)) {
          if (isObject(x) && typeof x.text === 'string') memory.save(floor.id, { text: x.text, tags: Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === 'string') : [], authorName: typeof x.authorName === 'string' ? x.authorName : null })
        }
        memoryChanged(floor.id)
      }
      for (const a of floor.agents) {
        const sid = a.sessionId
        if (!sid) continue
        // It runs there now (held by that PC), or it ran there last.
        if (running.has(sid)) hold(sid, from)
        else release(sid, from)
        const want = marks[sid]
        if (isMark(want) && link) await catchUpFrom(link, sid, want)
        const found = findTranscript(sid, projectsDir)
        if (found) mine[sid] = markOf(found)
      }
    }
    log?.info(`${from.name}: ${out.filter(f => f.created).length} floors it made while the Server was away joined the list`)
    return { floors: out, marks: mine }
  }

  /** GET /agentic/offline-chats: the setting, whether it is in use now, and how the joining goes. */
  function offlineAnswer() {
    const t = teamInfo()
    return { ...(t?.offline ?? { on: offlineSettings.on(), active: false, since: null, hubName: null }), adopt: adoptStatus }
  }

  /** GET /agentic/codex/status: names and plain sentences only, never a login. */
  function codexAnswer(): CodexStatus {
    if (o.codex) return o.codex.status()
    return {
      enabled: true,
      installed: false,
      version: null,
      state: 'not-installed',
      hint: "Codex isn't set up on this PC.",
      assigned: null,
      lastFetchedAt: null,
      lastWrittenBackAt: null,
      waitingToWriteBack: false,
    }
  }

  // F-165: the facts behind the Dependencies page, all already on this PC. `claude --version` is the one
  // process started, at most once a minute; nothing reaches ChatGPT, the CRM or a credential.
  let claudeSeen: { at: number; path: string | null; version: string | null } | null = null
  function claudeVersion() {
    if (claudeSeen && Date.now() - claudeSeen.at < 60_000) return claudeSeen
    const file = o.claude ?? findClaude()
    let version: string | null = null
    if (file) {
      const r = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
      version = r.status === 0 ? parseVersion(r.stdout) : null
    }
    return (claudeSeen = { at: Date.now(), path: file, version })
  }
  function localDependencies(): DependencyReport {
    const codex = o.codex?.status() ?? null, claude = claudeVersion()
    let chatHost = false
    try { o.chatHost?.current?.(); chatHost = !!o.chatHost } catch { chatHost = false }
    return dependencyReport({ pc: { id: self().id, name: self().name }, platform: process.platform, arch: process.arch, node: process.versions.node,
      claude: { found: !!claude.path, version: claude.version }, codex: { found: !!codex?.installed, version: codex?.version ?? null }, chatHost,
      codexState: codex?.state ?? null, codexKind: codex?.assigned?.kind ?? null, codexHint: codex?.hint ?? null,
      bridge: executionService?.runtime.status() ?? null }, Date.now())
  }
  const dependencyShape = (v: unknown): v is DependencyReport => isObject(v) && v.version === 1 && Array.isArray(v.checks) && isObject(v.pc)
  async function dependenciesAnswer(): Promise<DependenciesAnswer> {
    return { pcs: await Promise.all(pcs().map(async (pc): Promise<DependencyPc> => {
      if (pc.here) return { ...pc, report: localDependencies(), error: null }
      try {
        const report = await request<unknown>(peerOf(pc.id), 'dependencies', {}, 20_000)
        return dependencyShape(report) ? { ...pc, report, error: null } : { ...pc, report: null, error: 'It answered something this page can\'t read: update that PC.' }
      } catch (e) {
        // A PC on a build from before F-165 does not know the question.
        return { ...pc, report: null, error: /doesn't do dependencies/.test(message(e)) ? 'That PC runs an older build: update it to see its checks.' : `Can't reach it right now (${message(e)}).` }
      }
    })) }
  }

  function retireCodexSettings(r: MountRequest) {
    const c = callerOf(r)
    // Preserve the old endpoint's person/admin checks even though it can no longer change anything.
    if (o.auth && c.person?.canSeeAll !== true) {
      o.auth.deny(c, c.person ? 403 : 401, c.person ? 'admin-only' : 'sign-in', 'PUT /agent-api/agentic/codex/settings')
      throw c.person ? authError(403, 'Only the owner of this app changes this.', 'admin-only') : authError(401, 'Sign in first.', 'sign-in')
    }
    throw apiError(410, 'The local Codex chats setting has been retired. Codex uses installation and CRM access checks.')
  }

  function setOfflineChats(raw: unknown, r: MountRequest) {
    if (!isObject(raw) || typeof raw.on !== 'boolean') throw apiError(400, 'Expected {on: true | false}')
    const c = callerOf(r)
    // A machine setting: a signed-in sbskrrt's to change (the open app, at any level, and everybody else are not).
    if (o.auth && c.person?.canSeeAll !== true) {
      o.auth.deny(c, c.person ? 403 : 401, c.person ? 'admin-only' : 'sign-in', 'PUT /agent-api/agentic/offline-chats')
      throw c.person ? authError(403, 'Only the owner of this app changes this.', 'admin-only') : authError(401, 'Sign in first.', 'sign-in')
    }
    offlineSettings.set(raw.on)
    log?.warn(`${c.person?.username ?? 'someone'} turned "New chats on this PC while the Server is down" ${raw.on ? 'ON' : 'off'}`)
    emitWhere()
    return offlineAnswer()
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
  async function requirePeerEngine(link: LinkPeer, agent: FloorAgent) {
    // Hybrid Claude never reaches the historical Claude-only compatibility exception.
    const expectedEngine = requireLegacyExecution(agent, defaultsNow())
    if (expectedEngine !== 'claude') {
      let proof: unknown
      try { proof = await request(link, 'engine-open-capabilities', {}, 5000) } catch { throw engineUpdateRequired(link.name) }
      if (!isObject(proof) || proof.version !== 1 || !Array.isArray(proof.engines) || !proof.engines.includes(expectedEngine)) throw engineUpdateRequired(link.name)
    }
  }

  async function openOnPeer(link: LinkPeer, floor: Floor, agent: FloorAgent, text?: string): Promise<ChatOpened> {
    requireLegacyExecution(agent, defaultsNow())
    const expectedEngine = engineFor(agent)
    if (isPcControl(floor)) { assertPcControlTarget(floor, link.id, {}); await requirePcControlPeer(link) }
    await requirePeerEngine(link, agent)
    const opened = await request<ChatOpened>(link, 'open', { floorId: floor.id, agentId: agent.id, expectedEngine, text }, 60_000)
    // Legacy Claude-only apps can still open Claude. They never prove support for a newer engine.
    if (opened.engine === undefined && expectedEngine !== 'claude') throw engineUpdateRequired(link.name)
    if (opened.engine !== undefined) requireRunningEngine(expectedEngine, opened.engine)
    return opened
  }

  async function resumeAtHome(floor: Floor, agent: FloorAgent, sid: string | null, req: OpenChatRequest): Promise<ChatOpened | null> {
    if (isPcControl(floor) && agent.homePc !== floor.targetPcId) throw pcControlError('pc-control-wrong-device', 'The saved home does not match this PC workspace.')
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
      return { ...(await openOnPeer(link, floor, agent, req.say)), on: name }
    }
    // A member reaches every other PC through the hub, which does the same for it (the run-on route).
    if (!team?.hub()?.link || !sub) throw offline()
    const via = await request<ChatOpened>(needHub(), 'http', { method: 'POST', rest: `/floors/${enc(floor.id)}/agents/${enc(agent.id)}/run-on`, body: { pc: home, say: req.say } }, 60_000).catch((e: unknown) => {
      throw (e as { status?: unknown }).status === HOME_OFFLINE_STATUS ? offline() : e
    })
    return { ...via, on: name }
  }

  /** Its chat, running here: started fresh, resumed from its transcript, taken over, or as it was. */
  async function openChat(floorId: string, agentId: string, req: OpenChatRequest, executionGuard?: () => void, nativeExecutable?: string): Promise<ChatOpened> {
    requireHostAdoption()
    executionGuard?.()
    const managed = floorOf(floorId)
    if (isPcControl(managed) && (req.here || req.takeOver)) throw immutablePcControl()
    requireLegacyExecution(agentOf(managed, agentId), defaultsNow())
    const selected = agentOf(floorOf(floorId), agentId).sessionId
    if (selected) switchFences.assertWritable(selected)
    // F-127: a floor made on this PC while the Server was away is run here, as on a PC alone: no lease, this PC's own Claude sign-in.
    if (mode() === 'member') {
      if (!isLocalFloor(floorId)) return openOnMember(floorId, agentId, req)
      if (engineFor(agentOf(floorOf(floorId), agentId)) === 'claude') needClaudeHere()
    }
    let floor = floorOf(floorId)
    const agent = agentOf(floor, agentId)
    let sid = agent.sessionId
    if (sid && chats.info(sid)) {
      const actual = chats.info(sid)!.engine
      requireRunningEngine(engineFor(agent), actual)
      return { sessionId: sid, started: false, resumed: false, engine: actual }
    }
    const atHome = await resumeAtHome(floor, agent, sid, req)
    executionGuard?.()
    if (atHome) return atHome
    if (!sid) {
      sid = randomUUID()
      floor = floors.bindSession(floor.id, agent.id, sid)
    }
    const tookOverFrom = mode() === 'hub' ? await lease(sid, self(), req.takeOver === true, agent.name) : undefined
    try {
      executionGuard?.()
      const now = floorOf(floorId)
      const resumed = await startHere(now, agentOf(now, agentId), sid, req, executionGuard, nativeExecutable)
      executionGuard?.()
      requireRunningEngine(engineFor(agentOf(floorOf(floorId), agentId)), chats.info(sid)?.engine)
      return { sessionId: sid, started: true, resumed, engine: chats.info(sid)!.engine, ...(tookOverFrom ? { tookOverFrom } : {}) }
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
    if (at) requireLegacyExecution(at.agent, defaultsNow())
    if (!at || !chats.info(sid)) return false
    if (chats.info(sid)?.engine === 'opencode') {
      await openCode.abort(sid)
      chats.kill(sid, 'restart')
      await openCode.waitStopped(sid)
      return resumeChat(sid)
    }
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
    await adopted
    if (team?.role() === 'member') return false
    const at = floors.bySession(sid)
    if (!at) return false
    try {
      // Here: it was open on this PC when the app stopped (or needs its token again), so it comes back on this PC.
      const opened = await openChat(at.floor.id, at.agent.id, isPcControl(at.floor) ? {} : { here: true })
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
  const typeIntoOrUndo = (undo: () => void, c: { sessionId: string; id: string }, body: string, uncertain?: () => void, actor?: Caller) =>
    typeInto(c, body, { confirmed: true, caller: actor }).then(ok => { if (!ok) undo(); return ok }).catch(e => {
      if (e?.code === 'delivery-unconfirmed') uncertain?.()
      else undo()
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


  // The one key a Cancel button presses (the member PC's 'keys' request takes it, and digits, nothing else).
  const ESC_KEY = String.fromCharCode(27)

  /**
   * What a waiting chat asks, off its live screen only: options come from the menu drawn now, never from older text above a newer
   * footer. Where the screen can't be had, the scroll-back gives the words around it but no buttons (nothing is pressed from stale text).
   */
  async function promptOfChat(c: { sessionId: string; id: string }) {
    let native: NativeApprovalSnapshot | null = null
    const runtime = approvalRuntime(c.sessionId, c.id)
    try {
      if (c.id === self().id) native = localApprovalSnapshot(c.sessionId, null)
      else {
        const link = team?.member(c.id)
        if (link) native = nativeApprovalSnapshot(await request(link, 'approval-snapshot-v1', { version: 1, pcId: c.id, sessionId: c.sessionId }), c.id, c.sessionId)
      }
      if (native && c.id !== self().id && (native.proof.hubId !== self().id || native.proof.hubEpoch === null)) native = null
    } catch { /* Missing/malformed/old peers never get a legacy keys fallback. */ }
    if (!native) return { menu: null, context: 'This PC needs a current app and a live native prompt before approvals can be used.', cancellable: false,
      id: createHash('sha256').update(JSON.stringify([promptEpoch, c, 'unsupported'])).digest('hex'), native: null }
    const p = native.proof
    return { menu: native.menu, context: native.context, cancellable: native.cancellable,
      id: createHash('sha256').update(JSON.stringify([promptEpoch, c.sessionId, c.id, runtime, p.targetEpoch, p.generation, p.hubId, p.hubEpoch, p.floorId, p.agentId, p.promptId])).digest('hex'), native }
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
  async function typeInto(c: { sessionId: string; id: string }, body: string, opt: { human?: boolean; confirmed?: boolean; caller?: Caller } = {}): Promise<boolean> {
    assertMessageRuntime(c.sessionId,c.id,opt.confirmed===true)
    const refuseDraft = opt.human !== true
    if (opt.confirmed) {
      let result: unknown, diagnostic: DeliveryReceipt | null = null
      if (c.id === self().id) {
        const delivery = await confirmedDelivery(c.sessionId, body, refuseDraft, opt.caller, r => { diagnostic = r })
        result = delivery === 'blocked' && chats.drafting(c.sessionId) ? 'draft' : { delivery }
      }
      else {
        const at = bySession(c.sessionId)
        if (!at) return false
        const tracking = remoteNativeDelivery(c.id, c.sessionId, body, 'agent-message', randomUUID(), deliveryBinding(at.agent), opt.caller).catch(() => null)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const receipt = await Promise.race([tracking, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 18_000) })])
          diagnostic = receipt
          result = receipt?.blockedByDraft ? 'draft' : { delivery: receipt?.state === 'pending' ? 'unconfirmed' : receipt?.state ?? 'unconfirmed' }
        } finally { clearTimeout(timer) }
      }
      if (result === 'draft') throw apiError(409, draftWords(c.sessionId))
      const delivery = isObject(result) ? result.delivery : undefined
      if (delivery === 'sent') return true
      if (delivery === 'blocked') throw Object.assign(apiError(409, blockDescription(diagnostic)), { code: 'delivery-blocked' })
      if (delivery === 'gone') return false
      throw Object.assign(apiError(409, 'Delivery is not confirmed; the one pending message may already have been submitted, may still complete, or may remain in the composer. Inspect the destination; do not automatically press Enter or resend.'), { code: 'delivery-unconfirmed' })
    }
    if (c.id === self().id) return chats.type(c.sessionId, body, refuseDraft ? { refuseDraft: true } : undefined)
    const link = team?.member(c.id)
    if (!link) return false
    const r = await request<boolean | 'draft'>(link, 'type', { sessionId: c.sessionId, text: body, ...(refuseDraft ? { refuseDraft: true } : {}) }).catch(() => false)
    if (r === 'draft') throw apiError(409, draftWords(c.sessionId))
    return r === true
  }

  const logDeliveryBlock = (sid: string | null, reason: DeliveryBlockReason) => log?.warn(`chat ${sid?.slice(0, 8) ?? 'unbound'}: delivery blocked (${reason})`)
  const blockDescription = (r: Pick<DeliveryReceipt, 'reason' | 'targetPcName'> | null | undefined) => r?.reason
    ? `${deliveryBlockWords(r.reason, r.targetPcName)} [${r.reason}]`
    : 'The destination refused this send without a specific diagnostic. Inspect the terminal before another send. [peer-blocked]'
  const messageReceipts = createDeliveryReceipts(path.join(o.dir, 'message-receipts.json'))
  const nativeReceipts = createDeliveryReceipts(path.join(o.dir, 'native-delivery-receipts.json'))
  const humanInputGrants = createHumanInputGrants()
  const deliveryActor = (r?: { caller?: Caller }) => r?.caller?.person ? `person:${r.caller.person.id}` : JSON.stringify(r?.caller ?? OPEN)
  const deliveryBinding = (a: FloorAgent) => {
    const execution = executionIdentityOf(a, defaultsNow())
    return JSON.stringify([a.sessionId, execution.engine, a.codexThread ?? null, a.opencodeSession ?? null, a.homePc ?? null,
      ...(a.executionProfile !== undefined || a.executionRevision !== undefined
        ? [execution.profile, execution.provider, execution.harness, execution.transcript, a.executionRevision ?? 0] : [])])
  }
  function advanceDeliveryBinding(binding: string, a: FloorAgent): string | null {
    const current = deliveryBinding(a)
    if (binding === current) return binding
    // Learning the first native ID on this same runtime is not a conversation switch.
    try {
      const before: unknown = JSON.parse(binding), after: unknown[] = JSON.parse(current)
      if (!Array.isArray(before) || before.length !== after.length) return null
      const slot = engineFor(a) === 'codex' ? 2 : engineFor(a) === 'opencode' ? 3 : -1
      if (slot < 0 || before[slot] !== null || typeof after[slot] !== 'string') return null
      return before.every((v, i) => i === slot || v === after[i]) ? current : null
    } catch { return null }
  }
  const deliveryAcl = (actor: Caller, sid: string) => {
    try { const at = bySession(sid); return !!at && (access.needChat(actor, at.agent, 'type', 'message delivery'), true) } catch { return false }
  }
  function sayIntent(raw: unknown): Omit<SayRequest, 'text'> {
    if (!isObject(raw)) return {}
    if (raw.messageId !== undefined && (typeof raw.messageId !== 'string' || !UUID_RE.test(raw.messageId))) throw apiError(400, 'messageId must be a UUID')
    if (raw.expectedSessionId !== undefined && raw.expectedSessionId !== null && (typeof raw.expectedSessionId !== 'string' || !validTransferSid(raw.expectedSessionId))) throw apiError(400, 'expectedSessionId must be the captured session ID or null')
    return { ...(raw.messageId !== undefined ? { messageId: String(raw.messageId) } : {}), ...(raw.expectedSessionId !== undefined ? { expectedSessionId: raw.expectedSessionId as string | null } : {}) }
  }

  function beginNativeDelivery(sessionId: string, body: string, owner: string, messageId?: string, expectedBinding?: string, extraGuard?: () => boolean, authorize?: (phase: HumanInputPhase) => Promise<boolean>) {
    assertMessageRuntime(sessionId,self().id,true)
    const at = bySession(sessionId)
    if (!at) throw apiError(409, 'The destination conversation changed. Nothing was submitted.')
    const { floor, agent } = at
    return nativeReceipts.begin({ id: messageId, owner, floorId: floor.id, agentId: agent.id, text: body, expectedSessionId: sessionId }, async (bind, noteBlocked) => {
      const generation = chats.generation?.(sessionId)
      let binding = expectedBinding ?? deliveryBinding(agent)
      let reason: DeliveryBlockReason | undefined
      const fail = (code: DeliveryBlockReason) => { reason = code; return false }
      const refuse = () => { const code = reason ?? 'preflight-failed'; logDeliveryBlock(sessionId, code); return noteBlocked(code) }
      const valid = () => {
        const current = bySession(sessionId), runtime = chats.info(sessionId)
        if (closing) return fail('agent-closing')
        if (!current || current.floor.id !== floor.id || current.agent.id !== agent.id) return fail('binding-changed')
        if (!runtime) return fail('runtime-unavailable')
        if (chats.generation?.(sessionId) !== generation) return fail('generation-changed')
        if (runtime.engine !== engineFor(current.agent)) return fail('runtime-mismatch')
        if (switchFences.blocked(sessionId)) return fail('switch-in-progress')
        const advanced = advanceDeliveryBinding(binding, current.agent)
        if (!advanced) return fail('binding-changed')
        binding = advanced
        try { assertMessageRuntime(sessionId,self().id,true) } catch { return fail('runtime-mismatch') }
        try { assertPcControlTarget(current.floor, self().id, {}) } catch { return fail('pc-control-denied') }
        return extraGuard?.() === false ? fail('authorization-revoked') : true
      }
      if (!generation) { reason = 'runtime-unavailable'; return refuse() }
      if (!valid()) return refuse()
      bind(sessionId, generation, false)
      const state = await chats.deliver?.(sessionId, body, { refuseDraft: true, waitUntilReady: true, waitForOutcome: true, guard: valid, authorize, onBlocked: code => { reason ??= code } }) ?? 'unconfirmed'
      return state === 'blocked' ? refuse() : state
    })
  }

  /** Tool callers retain a bounded observation window; the one native transaction continues. */
  async function confirmedDelivery(sessionId: string, body: string, _refuseDraft: boolean, actor?: Caller, onResult?: (receipt: DeliveryReceipt) => void) {
    try {
      const at = bySession(sessionId)
      if (!at) return 'gone' as const
      const owner = 'agent-message', receipt = beginNativeDelivery(sessionId, body, owner, undefined, undefined, actor ? () => deliveryAcl(actor, sessionId) : undefined)
      const final = await nativeReceipts.wait(receipt.id, owner, at.floor.id, at.agent.id)
      if (final) onResult?.(final)
      return final?.state === 'pending' ? 'unconfirmed' as const : final?.state ?? 'unconfirmed' as const
    } catch { return 'unconfirmed' as const }
  }

  function validReceipt(raw: unknown, id: string): raw is DeliveryReceipt {
    return isObject(raw) && raw.id === id && ['pending','sent','blocked','unconfirmed','gone'].includes(String(raw.state)) && (raw.sessionId === null || typeof raw.sessionId === 'string') && (raw.generation === null || typeof raw.generation === 'string') && typeof raw.started === 'boolean' && typeof raw.updatedAt === 'string' && (raw.reason === undefined || isDeliveryBlockReason(raw.reason)) && (raw.targetPcName === undefined || typeof raw.targetPcName === 'string' && raw.targetPcName.length <= 120)
  }

  /** The initial request is sent once. A broken response changes the operation into status-only observation. */
  async function remoteNativeDelivery(pcId: string, sid: string, body: string, owner: string, id: string, binding: string, actor?: Caller, humanAuthority?: () => boolean): Promise<(DeliveryReceipt & { blockedByDraft?: boolean }) | null> {
    assertLegacySid(sid)
    const peer = () => team?.member(pcId) ?? null
    const first = peer()
    const refuse = (reason: DeliveryBlockReason): DeliveryReceipt => {
      logDeliveryBlock(sid, reason)
      return { id, state: 'blocked', sessionId: sid, generation: null, started: false, updatedAt: new Date().toISOString(), reason, targetPcName: first?.name.slice(0, 120) }
    }
    if (!first) return refuse('peer-unreachable')
    let support: unknown
    try { support = await request<unknown>(first, 'delivery-capabilities', {}, 3000) }
    catch (error) {
      const old = (error as { code?: string }).code === 'unknown-op' || /this PC doesn't do delivery-capabilities/i.test(message(error))
      log?.warn(`chat ${sid.slice(0, 8)}: delivery capability check (${old ? 'unknown-operation' : 'no-capability-answer'})`)
      return refuse(old ? 'peer-delivery-unsupported' : 'peer-unreachable')
    }
    if (!isObject(support) || support.version !== 1 || support.idempotent !== true) {
      log?.warn(`chat ${sid.slice(0, 8)}: delivery capability check (missing-capability-fields)`)
      return refuse('peer-delivery-unsupported')
    }
    if (humanAuthority && support.humanInputAuthorization !== 1) return refuse('peer-authorization-unsupported')
    const target = bySession(sid)
    if (!target) return refuse('binding-changed')
    const currentBinding = advanceDeliveryBinding(binding, target.agent)
    if (!currentBinding) return refuse('binding-changed')
    if (actor && !deliveryAcl(actor, sid)) return refuse('access-denied')
    binding = currentBinding
    const grant = humanAuthority ? humanInputGrants.register(pcId, first.token, id, sid, humanAuthority) : null
    if (humanAuthority && !grant) return refuse('authorization-revoked')
    try {
    let raw: unknown = await request(first, 'type', { sessionId: sid, text: body, refuseDraft: true, confirmDelivery: true, messageId: id, owner, expectedBinding: binding, floorId: target.floor.id, agentId: target.agent.id, targetPcId: pcId, actor, ...(grant ? { humanAuthorization: grant.nonce } : {}) }, 16_000).catch(() => null)
    const deadline = Date.now() + 300_000
    for (;;) {
      const r = isObject(raw) ? raw.receipt : null
      if (validReceipt(r, id) && r.state !== 'pending') {
        if (r.state === 'blocked') {
          logDeliveryBlock(sid, r.reason ?? 'peer-blocked')
          // Older senders could call a post-paste menu 'blocked'. Without a
          // specific pre-input diagnostic, preserve uncertainty and its fence.
          if (!r.reason) return { ...r, state: 'unconfirmed' }
        }
        return { ...r, ...(r.state === 'blocked' && r.reason === 'draft' ? { blockedByDraft: true } : {}) }
      }
      if (raw !== null && !validReceipt(r, id)) return null
      if (Date.now() >= deadline || closing) return validReceipt(r, id) ? { ...r, state: 'unconfirmed' } : null
      await new Promise<void>(resolve => setTimeout(resolve, 500))
      const link = peer()
      raw = link ? await request(link, 'delivery-status', { messageId: id, owner, floorId: target.floor.id, agentId: target.agent.id, targetPcId: pcId }, 6000).catch(() => null) : null
    }
    } finally { grant?.close() }
  }

  // F-076: what was answered and sent as the person (viewable), and the cards the assistant prepared (never sent by it).
  const approvalLog = createApprovalLog(path.join(o.dir, 'approvals.jsonl'))
  // The phones (browsers) whose signature an approval or a send needs: registered once, here on the hub.
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
    floors.list().filter(f => !isPcControl(f)).flatMap(f => f.agents.map(a => ({ sessionId: a.sessionId, floorId: f.id, floorName: f.name, agentId: a.id, agentName: a.name, assistant: isOrchestratorAgent(f.name, a) })))
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
    proof: (_body, r) => {
      const by = humanProof('pair', [], undefined, r)
      deviceLog('A pair code for the phone app was made', by)
      return by
    },
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
          env: () => librarianEnv(process.env, o.token?.() ?? null, o.credential?.() ?? null),
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
    if (mode() === 'member' && !isLocalSession(me.sessionId)) return request<string>(needHub(), 'tool', { sessionId: me.sessionId, name, arguments: rawArgs }).catch(error => {
      if (['send_to_chat', 'app_send_to_chat', 'broadcast_to_chats'].includes(name) && [502, 504].includes(error?.status)) throw Object.assign(apiError(409, 'Delivery is not confirmed after the connection failed; pending messages may already be submitted or may still complete. Inspect the destination; do not automatically press Enter or resend.'), { code: 'delivery-unconfirmed' })
      throw error
    })
    return toolFor(me.sessionId, name, rawArgs)
  }

  /** A tool call from the chat `sid` (running here, or on a member that passed it on). */
  async function toolFor(sid: string, name: string, rawArgs: unknown, as?: { floor: Floor; agent: FloorAgent }): Promise<string> {
    // F-127: on a member this is a chat of a floor made here: what lives on the Server (the task list, the phone, WhatsApp, the screen, the memory layer) is not here.
    if (mode() === 'member' && NEEDS_SERVER.has(name)) {
      throw Object.assign(apiError(503, `That needs the Server (${team?.hub()?.name ?? 'the hub'}), which this chat's floor is not on yet. It joins the Server's list when the Server is back.`), { code: 'hub-offline' })
    }
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
        if (!(await typeIntoOrUndo(undo, target, `[message from ${agent.name} on ${floor.name}, chat ${sid.slice(0, 8)}${order ? `, ${orders.marker(order)}` : ''}] ${body}`, () => { if (order) openOrder(order, sid, target.sessionId, body) }, me))) throw apiError(409, atPrompt(target.sessionId) ? promptWords(target.sessionId) : 'That chat stopped before the message reached it')
        if (order) openOrder(order, sid, target.sessionId, body)
        log?.info(`${agent.name} → chat ${target.sessionId.slice(0, 8)} (another floor or PC): a message`)
        return order ? `Sent to chat ${target.sessionId} as order ${order}. Its answer at the end of its turn comes back to you here by itself ("[reply from ...]"): do not wait for it, and do not ask it to answer.` : `Sent to chat ${target.sessionId}.`
      }
      case 'app_open_chat': {
        requireHostAdoption()
        const { floor: f, agent: a } = findAgent(args.floor, args.agent)
        access.needChat(me, a, 'owner', toolWhere)
        const explicitProfile = args.executionProfile
        if (args.restoreHistory !== undefined && (args.restoreHistory !== true || explicitProfile !== 'codex-native-v1')) throw executionHttpError('execution-invalid', 'selection')
        if (explicitProfile !== undefined && explicitProfile !== 'codex-in-claude-v1' && explicitProfile !== 'codex-native-v1') throw executionHttpError('execution-invalid', 'open')
        if (explicitProfile || executionIdentityOf(a, defaultsNow()).profile === 'codex-in-claude-v1') {
          workflowExecutionAgent(f.id, a.id)
          if (!executionService || !me.person || !a.owner || !a.homePc || a.homePc !== self().id
            || (args.pc !== undefined && args.pc !== self().id && String(args.pc).toLowerCase() !== self().name.toLowerCase())) throw executionHttpError('execution-capability-required', 'open')
          const scope = { actorId: me.person.id, ownerId: a.owner.id, floorId: f.id, agentId: a.id, targetPcId: a.homePc }
          executionService.bindActor(scope, chatExecutionActor({ floorId: floor.id, agentId: agent.id }, scope,
            { floors, access, target: workflowExecutionAgent }))
          const operationId = typeof args.operationId === 'string' ? args.operationId : explicitProfile ? '' : randomUUID()
          const reply = await executionService.openTool(scope, operationId, explicitProfile === 'codex-in-claude-v1', explicitProfile === 'codex-native-v1' ? explicitProfile : 'codex-in-claude-v1', args.restoreHistory === true)
          return json({ ...reply, sessionId: reply.committed.sessionId, agent: a.name, floor: f.name, pc: self().name })
        }
        const pcName = typeof args.pc === 'string' && args.pc.trim() ? args.pc.trim().toLowerCase() : null
        const pc = pcName ? pcs().find(p => p.name.toLowerCase() === pcName || p.id === args.pc) : null
        if (pcName && !pc) throw apiError(404, `No PC called ${String(args.pc)} within reach; app_chats lists them`)
        const opened =
          pc && !pc.here
            ? await openOnPeer(peerOf(pc.id), f, a)
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
        if (args.sessionId === sid) throw apiError(400, "That's your own chat")
        const at=typeof args.sessionId==='string'?bySession(args.sessionId):null
        if(at?.agent.homePc===self().id&&executionIdentityOf(at.agent,defaultsNow()).profile==='codex-in-claude-v1'
          &&!executionService?.runtime.matches(snapshotAgentExecution(at.agent,defaultsNow()))) {
          access.needChat(me,at.agent,'owner',toolWhere)
          workflowExecutionAgent(at.floor.id,at.agent.id)
          if(!executionService)throw executionHttpError('execution-capability-required','runtime')
          const expected=snapshotAgentExecution(at.agent,defaultsNow())
          await executionService.runtime.cancelUnstarted(expected,()=>{
            const source=floors.bySession(sid),fresh=workflowExecutionAgent(at.floor.id,at.agent.id)
            if(!source||access.asChat(source.agent).person?.id!==me.person!.id)throw executionHttpError('execution-forbidden','authorization')
            assertExecutionCAS(expected,snapshotAgentExecution(fresh,defaultsNow()))
            access.needChat(access.asChat(source.agent),fresh,'owner',toolWhere)
          })
          return `The exact unconfirmed managed start for ${at.agent.sessionId} was stopped and its end verified.`
        }
        const target = anyChat(args.sessionId)
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
        if (!(await typeIntoOrUndo(undo, c, `[message from ${tag}${order ? `, ${orders.marker(order)}` : ''}] ${body}`, () => { if (order) openOrder(order, sid, c.sessionId, body) }, me))) throw apiError(409, atPrompt(c.sessionId) ? promptWords(c.sessionId) : 'That chat stopped before the message reached it')
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
        const outcomes = await Promise.all(to.map(async c => {
          try { return { c, sent: await typeInto(c, `[broadcast from ${tag}] ${body}`, { confirmed: true, caller: me }), unknown: false, draft: false } }
          catch (e) { return { c, sent: false, unknown: isObject(e) && e.code === 'delivery-unconfirmed', draft: e instanceof Error && /unsent text in its box/.test(e.message) } }
        }))
        const uncertain = outcomes.filter(r => r.unknown).map(r => r.c)
        const refused = outcomes.filter(r => !r.sent && !r.unknown).map(r => r.c)
        const failed = outcomes.filter(r => !r.sent && !r.unknown && !r.draft).map(r => r.c)
        if (refused.length || uncertain.length) {
          drafts.push(...outcomes.filter(r => r.draft).map(r => r.c))
          to.splice(0, to.length, ...to.filter(c => !refused.includes(c) && !uncertain.includes(c)))
        }
        const nameOf = (c: { sessionId: string }) => floors.bySession(c.sessionId)?.agent.name ?? c.sessionId.slice(0, 8)
        return `Sent to ${to.length} chat${to.length === 1 ? '' : 's'}.${skipped.length ? ` Skipped ${skipped.length} waiting at a prompt (Approvals tab): ${skipped.map(nameOf).join(', ')}.` : ''}${drafts.length ? ` Skipped ${drafts.length} with unsent text in the box (try again shortly): ${drafts.map(nameOf).join(', ')}.` : ''}${failed.length ? ` Not submitted to ${failed.map(nameOf).join(', ')}: blocked or unavailable.` : ''}${uncertain.length ? ` Delivery not confirmed for ${uncertain.map(nameOf).join(', ')}; the pending messages may already be submitted or may still complete. Inspect those chats; do not automatically press Enter or resend.` : ''}`
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
        if (args.mode === 'keyword' || !memoryOn || mode() === 'member' || !access.isAdmin(me)) return json({ entries })
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
    return { floors: access.scope(c, all.filter(f => !isPcControl(f)), want), live: mine(chats.states()), elsewhere: mine(elsewhere()), last: mine(lastAll()), team: teamInfo(), defaultCodeDir,
      engineSwitchContinuity: mode() === 'member' ? replica.engineSwitchContinuity : { version: 1, failClosed: true, homePcPreparation: true } }
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

  const preparedSwitches = new Map<string, ConversationBinding>()
  const floorMutations = new Map<string, Promise<unknown>>()

  /** Conversions are prepared before the atomic chart commit; never substitute an empty binding. */
  function carryConversation(_floor: Floor, previous: FloorAgent, _to: 'claude' | 'codex' | 'opencode') {
    requireLegacyExecution(previous, defaultsNow())
    const result = preparedSwitches.get(previous.id)
    if (!result) throw Object.assign(apiError(409, 'History was not prepared. The current conversation is unchanged.'), { code: 'engine-change-conversion-failed' })
    return { sessionId: result.sessionId, codexThread: result.codexThread, opencodeSession: result.opencodeSession, homePc: result.homePc, homePcName: result.homePcName }
  }

  function localSwitchSource(previous: FloorAgent): string | null {
    requireLegacyExecution(previous, defaultsNow())
    const sid = previous.sessionId!
    const current = bySession(sid)
    if (current && isPcControl(current.floor) && chats.info(sid)) requireRunningEngine(engineFor(previous), chats.info(sid)!.engine)
    if (engineFor(previous) === 'opencode') {
      if (!chats.info(sid) && (!openCode.install() || !previous.opencodeSession)) throw Object.assign(apiError(409, 'OpenCode history is unavailable on its home PC. The current conversation is unchanged.'), { code: 'engine-change-conversion-failed' })
      return null
    }
    const file = engineFor(previous) === 'codex'
      ? previous.codexThread && o.codex ? findRollout(o.codex.paths.home, previous.codexThread) : null
      : findClaudeTranscript(sid, projectsDir)
    if (!file) throw Object.assign(apiError(409, `${previous.name}: source transcript is unavailable on its home PC. The current engine and conversation are unchanged.`), { code: 'engine-change-conversion-failed' })
    return file
  }

  function switchSourcePc(previous: FloorAgent) {
    const managed = allFloors().find(f => isPcControl(f) && f.agents.some(a => a.id === previous.id))
    if (isPcControl(managed)) {
      assertPcControlTarget(managed, managed.targetPcId, {})
      return { id: managed.targetPcId, name: managed.name }
    }
    const active = whereAll()[previous.sessionId!]
    if (active) return active
    const last = lastAll()[previous.sessionId!]?.pc
    if (last) {
      const known = pcs().filter(p => p.name === last)
      if (known.length === 1) return known[0]
      if (known.length > 1) throw Object.assign(apiError(409, 'More than one PC has the last source PC name. Resume the original conversation on its PC before switching.'), { code: 'engine-change-conversion-failed' })
      if (previous.homePc && previous.homePcName === last) return { id: previous.homePc, name: last }
      throw Object.assign(apiError(424, `The newest history is on ${last}, which is offline. The current conversation is unchanged.`), { code: 'engine-change-home-offline' })
    }
    return previous.homePc ? { id: previous.homePc, name: previous.homePcName ?? previous.homePc } : self()
  }

  async function prepareLocalSwitch(floor: Floor, previous: FloorAgent, next: FloorAgent, switchId: string) {
    assertPcControlTarget(floor, self().id, {})
    requireLegacyExecution(previous, defaultsNow())
    requireLegacyExecution(next, defaultsNow())
    if (isPcControl(floor) && previous.sessionId && chats.info(previous.sessionId)) requireRunningEngine(engineFor(previous), chats.info(previous.sessionId)!.engine)
    const file = localSwitchSource(previous)
    const sid = previous.sessionId!, from = engineFor(previous), to = engineFor(next)
    conversionProgress.begin(floor.id, previous.id, switchId)
    conversionProgress.update(floor.id, previous.id, 'stopping')
    switchFences.begin(sid, switchId)
    if (from !== 'opencode' && chats.info(sid)) {
      chats.kill(sid, 'engine-change')
      await chats.waitStopped?.(sid)
      if (file) await settled(file)
    }
    if (file) switchFences.snapshot(sid, switchId, file)
    if (to === 'opencode') {
      const { provider, model } = openCodeSelection(next, defaultsNow())
      if (!openCode.install() || (provider !== 'opencode' && !o.openCodeCredential)) throw apiError(503, 'OpenCode is not configured on this PC.')
      if (provider === 'opencode') freeModel(model)
      else await o.openCodeCredential!(provider)
      if (openCode.status().live >= 2) throw apiError(503, 'OpenCode is at this PC’s two-backend limit.')
    }
    let cwd = chats.info(sid)?.cwd || (file && conversationCwd(file)) || codeDirOf(floor)
    let result: PreparedConversation
    if (from !== 'opencode' && to !== 'opencode') {
      if (!file) throw apiError(409, 'Source transcript is unavailable')
      cwd = chats.info(sid)?.cwd || conversationCwd(file) || cwd
      const converted = await switchConversationComplete({ to, file, cwd, codexHome: o.codex?.paths.home, projectsDir,
        onProgress: (stage, transfer) => conversionProgress.update(floor.id, previous.id, stage, transfer) })
      result = { sessionId: to === 'claude' ? converted.id : randomUUID(), codexThread: to === 'codex' ? converted.id : null, opencodeSession: null, file: converted.file }
    } else {
      let source: unknown
      let sourceEngine = from
      if (from === 'opencode') {
        if (chats.info(sid)) { await openCode.abort(sid); chats.kill(sid, 'engine-change'); await openCode.waitStopped(sid) }
        source = JSON.parse(await interchange(openCode.install()!, openCode.rootOf(sid), cwd, ['export', previous.opencodeSession!]))
        const mirror = openCode.file(sid)
        if (!mirror) throw apiError(409, 'The stopped OpenCode source has no verified history mirror')
        switchFences.snapshot(sid, switchId, mirror)
        if (isObject(source) && isObject(source.info) && typeof source.info.directory === 'string' && path.isAbsolute(source.info.directory)) cwd = source.info.directory
      } else {
        if (!file) throw apiError(409, 'Source transcript is unavailable')
        cwd = chats.info(sid)?.cwd || conversationCwd(file) || cwd
        // Normalize only bounded current context, never read a whole large JSONL into the heap.
        const timestamp = new Date().toISOString()
        source = from === 'claude'
          ? convertClaude(claudeFileContext(file).lines, { id: randomUUID(), cwd, timestamp }).lines
          : toClaude(conversationLines(file), { sessionId: sid, cwd, timestamp })
        sourceEngine = from === 'claude' ? 'codex' : 'claude'
      }
      result = await prepareConversation({ from: sourceEngine, to, source, cwd, projectsDir, codexHome: o.codex?.paths.home, openCodeRoot: openCode.rootOf, install: openCode.install() })
    }

    return { ...result, homePc: self().id, homePcName: self().name }
  }

  /** Only the authenticated hub can ask a member to prepare its own current native history. No floor mutation here. */
  async function prepareSwitchPeer(raw: unknown) {
    if (!isObject(raw) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string' || !isObject(raw.expected) || !isObject(raw.next) ||
      !['claude', 'codex', 'opencode'].includes(String(raw.next.engine))) throw apiError(400, 'Expected an engine-switch preparation')
    const floor = floorOf(raw.floorId), previous = agentOf(floor, raw.agentId), expected = raw.expected
    requireLegacyExecution(previous, defaultsNow())
    const nextRaw = raw.next
    if (['executionProfile', 'executionRevision', 'execution', 'provider', 'harness', 'transcript'].some(k => Object.hasOwn(nextRaw, k))) throw executionHttpError('execution-capability-required', 'selection')
    const matches = () => {
      const current = agentOf(floorOf(floor.id), previous.id)
      return current.sessionId === expected.sessionId && engineFor(current) === expected.engine &&
        (current.codexThread ?? null) === (expected.codexThread ?? null) && (current.opencodeSession ?? null) === (expected.opencodeSession ?? null)
    }
    if (!matches()) throw Object.assign(apiError(409, 'The source conversation changed on its home PC. Refresh and confirm again.'), { code: 'engine-change-stale' })
    if (!previous.sessionId || (!chats.info(previous.sessionId) && previous.homePc && previous.homePc !== self().id && lastAll()[previous.sessionId]?.pc !== self().name)) throw apiError(409, 'This PC does not hold the source conversation')
    localSwitchSource(previous)
    if (raw.checkOnly === true) return { ready: true }
    const next = { ...previous, engine: raw.next.engine, opencodeProvider: raw.next.opencodeProvider, opencodeModel: raw.next.opencodeModel } as FloorAgent
    if (typeof raw.switchId !== 'string') throw apiError(400, 'Expected an engine-switch operation id')
    const binding = await prepareLocalSwitch(floor, previous, next, raw.switchId)
    if (!matches()) throw Object.assign(apiError(409, 'The source conversation changed during conversion. Refresh and confirm again.'), { code: 'engine-change-stale' })
    return { binding, sourceSessionId: previous.sessionId, to: engineFor(next) }
  }

  async function finishSwitchPeer(raw: unknown) {
    if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.switchId !== 'string') throw apiError(400, 'Expected a source session and operation id')
    if (raw.action === 'seal') switchFences.seal(raw.sessionId, raw.switchId)
    else if (raw.action === 'retire') switchFences.retire(raw.sessionId, raw.switchId)
    else if (raw.action === 'cancel') { if (!chats.info(raw.sessionId)) await chats.waitStopped?.(raw.sessionId); switchFences.cancel(raw.sessionId, raw.switchId) }
    else throw apiError(400, 'Expected seal, retire or cancel')
    return { ok: true }
  }

  let reconcilingSwitches = false
  async function reconcileSwitchFences() {
    if (reconcilingSwitches || closing) return
    reconcilingSwitches = true
    try {
      for (const fence of switchFences.pending()) {
        if (activeSwitches.has(fence.token)) continue
        let action: string
        if (mode() === 'member') {
          const link = team?.hub()?.link
          if (!link || !sub) continue
          try { action = (await request<{ state: string }>(link, 'engine-switch-status', { sessionId: fence.sessionId, switchId: fence.token })).state }
          catch { continue /* Keep a durable fence until the authoritative hub can answer. */ }
        } else action = bySession(fence.sessionId) ? 'cancel' : 'retire'
        if (action === 'cancel') { if (!chats.info(fence.sessionId)) await chats.waitStopped?.(fence.sessionId); switchFences.cancel(fence.sessionId, fence.token) }
        else if (action === 'retire') { switchFences.retire(fence.sessionId, fence.token); chats.kill(fence.sessionId, 'engine-switch-retired') }
      }
    } finally { reconcilingSwitches = false }
  }
  setImmediate(() => { void reconcileSwitchFences().catch(error => log?.warn('Engine-switch recovery remains fenced: ' + message(error))) })

  function patchFloor(id: string, body: unknown, as?: ChatOwner) {
    const pending = (floorMutations.get(id) ?? Promise.resolve()).catch(() => {}).then(() => patchFloorPrepared(id, body, as))
    floorMutations.set(id, pending)
    void pending.finally(() => { if (floorMutations.get(id) === pending) floorMutations.delete(id) }).catch(() => {})
    return pending
  }

  async function patchFloorPrepared(id: string, body: unknown, as?: ChatOwner) {
    if (!isObject(body)) throw apiError(400, 'Expected {name?, globalPrompt?, codeDir?, agents?}')
    const before = floorOf(id)
    if (typeof body.codeDir === 'string' && body.codeDir.trim()) checkFolder(body.codeDir)
    const preview = floors.validatePatch(id, body as FloorPatch, as)
    const fingerprint = JSON.stringify(before), defaultEngine = defaultsNow().engine
    const switchId = randomUUID(), peers = new Map<string, LinkPeer>()
    const changes = before.agents.flatMap(previous => {
      const next = preview.agents.find(a => a.id === previous.id)
      return next && previous.sessionId && engineFor(previous) !== engineFor(next) ? [{ previous, next }] : []
    })
    const peerBody = (previous: FloorAgent, next: FloorAgent) => ({ floorId: id, agentId: previous.id, switchId,
      expected: { sessionId: previous.sessionId, engine: engineFor(previous), codexThread: previous.codexThread ?? null, opencodeSession: previous.opencodeSession ?? null },
      next: { engine: engineFor(next), opencodeProvider: next.opencodeProvider, opencodeModel: next.opencodeModel } })
    const finishPeer = (previous: FloorAgent, action: string) => {
      const peer = peers.get(previous.id)
      return peer ? request(peer, 'engine-switch-finish', { sessionId: previous.sessionId, switchId, action }, 10_000) : Promise.resolve()
    }
    let committed: Floor | undefined
    activeSwitches.add(switchId)
    for (const {previous} of changes) conversionProgress.begin(id, previous.id, switchId)
    try {
      // Hub lease/open/input barrier begins before any async preparation. The source host also fences itself.
      for (const { previous } of changes) switchFences.begin(previous.sessionId!, switchId)
      for (const { previous, next } of changes) {
        const location = switchSourcePc(previous)
        if (location.id !== self().id) {
          const peer = team?.member(location.id)
          if (!peer) throw Object.assign(apiError(424, `${previous.name}'s newest history is on ${location.name}, which is offline. The current conversation is unchanged.`), { code: 'engine-change-home-offline' })
          peers.set(previous.id, peer)
          await request(peer, 'engine-switch-prepare', { ...peerBody(previous, next), checkOnly: true }, 120_000)
        } else localSwitchSource(previous)
      }
      for (const { previous, next } of changes) {
        const peer = peers.get(previous.id)
        let raw: unknown
        if (peer) {
          conversionProgress.update(id, previous.id, 'converting')
          const reply = await request<{ binding: unknown; sourceSessionId: string; to: string }>(peer, 'engine-switch-prepare', peerBody(previous, next), 120_000)
          if (reply.sourceSessionId !== previous.sessionId || reply.to !== engineFor(next)) throw new Error('Home PC returned a mismatched source or target')
          raw = reply.binding
        } else raw = await prepareLocalSwitch(before, previous, next, switchId)
        preparedSwitches.set(previous.id, validatePreparedConversation(raw, engineFor(next), previous, peer?.id ?? self().id, allFloors().flatMap(f => f.agents), [...preparedSwitches.values()]))
      }
      // Seal remote source hashes while every old session remains fenced, then check local sources synchronously.
      for (const { previous } of changes) if (peers.has(previous.id)) await finishPeer(previous, 'seal')
      for (const { previous } of changes) if (!peers.has(previous.id)) switchFences.seal(previous.sessionId!, switchId)
      if (JSON.stringify(floorOf(id)) !== fingerprint || defaultsNow().engine !== defaultEngine) throw Object.assign(apiError(409, 'This floor changed while the conversation was prepared. Refresh and confirm again.'), { code: 'engine-change-stale' })
      for (const {previous} of changes) conversionProgress.update(id, previous.id, 'saving')
      committed = floors.patch(id, body as FloorPatch, as)
      // Never release an old session after success, even while the member still has a debounced old replica.
      for (const { previous } of changes) {
        try { switchFences.retire(previous.sessionId!, switchId) } catch (error) { log?.warn('Could not persist retirement; durable preparation fence remains: ' + message(error)) }
        await finishPeer(previous, 'retire').catch(error => log?.warn('Home PC retirement awaits reconnect; source remains fenced: ' + message(error)))
      }
      const kept = new Set(committed.agents.map(a => a.id))
      for (const old of before.agents) {
        const after = committed.agents.find(a => a.id === old.id)
        if (old.sessionId && (!kept.has(old.id) || after?.sessionId !== old.sessionId || (engineFor(old) === 'opencode' && (old.opencodeProvider !== after?.opencodeProvider || old.opencodeModel !== after?.opencodeModel)))) stopAnywhere(old.sessionId)
      }
      for (const {previous} of changes) conversionProgress.update(id, previous.id, 'complete')
      return { floor: committed }
    } catch (error) {
      for (const {previous} of changes) conversionProgress.update(id, previous.id, committed ? 'complete' : 'failed')
      if (committed) { log?.warn('Conversation switch committed; cleanup will be retried: ' + message(error)); return { floor: committed } }
      if (isObject(error) && ['engine-change-stale', 'engine-change-home-offline', 'engine-change-in-progress', 'engine-runtime-mismatch', 'pc-control-wrong-device', 'pc-control-update-required'].includes(String(error.code))) throw error
      log?.warn('Engine switch blocked: ' + message(error))
      throw Object.assign(apiError(409, 'History could not be carried over: ' + message(error) + '. The current engine and conversation are unchanged; resume it or retry after fixing the source.'), { code: 'engine-change-conversion-failed' })
    } finally {
      if (!committed) for (const { previous } of changes) {
        try { switchFences.cancel(previous.sessionId!, switchId) } catch (error) { log?.warn('Original conversation unlock awaits recovery: ' + message(error)) }
        await finishPeer(previous, 'cancel').catch(error => log?.warn('Home PC unlock awaits reconnect: ' + message(error)))
      }
      for (const { previous } of changes) preparedSwitches.delete(previous.id)
      activeSwitches.delete(switchId)
    }
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

  function humanOnly(r: MountRequest) { r.caller = requireCrmHuman(o.auth, r) }
  const byOf = (r: MountRequest) => `the app (${String(r.headers['user-agent'] ?? 'a browser').replace(/\s+/g, ' ').slice(0, 90)})`
  const promptActions = createPromptActions()
  const promptEpoch = randomUUID()
  const approvalLinks = new WeakMap<object, string>()
  const approvalRuntime = (sid: string, pc: string) => {
    if (pc === self().id) return chats.info(sid)?.startedAt
    const token = team?.member(pc)?.token
    if (!token) return undefined
    if (!approvalLinks.has(token)) approvalLinks.set(token, randomUUID())
    return approvalLinks.get(token)
  }
  const nativePromptActions = createPromptActions()
  const approvalGrants = new Map<string, { proof: NativeApprovalProof; hubToken: object | null }>()
  function approvalGeneration(sid: string): string {
    const info = chats.info(sid)
    if (!info) throw apiError(409, 'That native chat is no longer running.')
    const pool = chats as ChatPool & { generation?: (sid: string) => string | null }
    if (pool.generation) {
      const value = pool.generation(sid)
      if (!value) throw apiError(409, 'Native generation is unavailable; update this PC.')
      return `pool:${value}`
    }
    // Older pool API: onEnded deletes this record even for same-SID/same-timestamp restarts.
    const fingerprint = JSON.stringify([info.startedAt, info.engine, info.floorId, info.agentId])
    const previous = approvalNativeRuntimes.get(sid)
    if (previous?.fingerprint !== fingerprint) approvalNativeRuntimes.set(sid, { fingerprint, generation: randomUUID() })
    return approvalNativeRuntimes.get(sid)!.generation
  }
  function requireApprovalHub(token: object | null, expectedId = team?.hub()?.id) {
    if (!token || mode() !== 'member' || team?.hub()?.id !== expectedId || team?.hub()?.link?.token !== token) throw apiError(409, 'The current pinned Server connection is required for approval.')
  }
  function sweepApprovalGrants() {
    for (const [id, grant] of approvalGrants) if (grant.proof.expiresAt < Date.now()) approvalGrants.delete(id)
  }
  function localApprovalSnapshot(sid: string, hubToken: object | null): NativeApprovalSnapshot {
    assertLegacySid(sid)
    if (hubToken) requireApprovalHub(hubToken)
    const info = chats.info(sid), at = floors.bySession(sid), screen = chats.screen(sid)
    if (!info || !at || !screen || info.floorId !== at.floor.id || info.agentId !== at.agent.id || (at.agent.homePc && at.agent.homePc !== self().id) || (isPcControl(at.floor) && at.floor.targetPcId !== self().id)) throw apiError(409, 'The native approval target changed.')
    sweepApprovalGrants()
    if (approvalGrants.size >= 4096) throw apiError(429, 'Too many approval snapshots; wait one minute and refresh.')
    const p = promptOf(screen.join('\n'))
    if (hubToken && !approvalLinks.has(hubToken)) approvalLinks.set(hubToken, randomUUID())
    const proof: NativeApprovalProof = { version: 1, grantId: randomUUID(), pcId: self().id, sessionId: sid, floorId: at.floor.id, agentId: at.agent.id,
      generation: approvalGeneration(sid), targetEpoch: promptEpoch, hubEpoch: hubToken ? approvalLinks.get(hubToken)! : null, hubId: hubToken ? team!.hub()!.id : null, promptId: p.id, expiresAt: Date.now() + APPROVAL_GRANT_MS }
    approvalGrants.set(proof.grantId, { proof, hubToken })
    return { proof, menu: p.menu, context: p.context, cancellable: p.cancellable }
  }
  async function commitNativeApproval(raw: unknown, hubToken: object | null, validateLocal?: (agent: FloorAgent) => void): Promise<{ version: 1; committed: true }> {
    if (!isNativeApprovalCommit(raw)) throw apiError(400, 'Expected a versioned, target-bound approval commit.')
    if (hubToken) requireApprovalHub(hubToken, raw.proof.hubId ?? undefined)
    else if (!validateLocal) throw authError(401, 'A current CRM session is required.', 'sign-in')
    const proof = raw.proof, grant = approvalGrants.get(proof.grantId)
    if (!grant || grant.hubToken !== hubToken || JSON.stringify(grant.proof) !== JSON.stringify(proof)) throw apiError(409, 'The native approval grant is not current.')
    return nativePromptActions.run(JSON.stringify([proof.sessionId, proof.generation, proof.promptId]), JSON.stringify([raw.action, raw.n ?? null]), async markNativeAttempt => {
      if (hubToken) requireApprovalHub(hubToken, proof.hubId ?? undefined)
      const at = floors.bySession(proof.sessionId), info = chats.info(proof.sessionId), screen = chats.screen(proof.sessionId)
      assertLegacySid(proof.sessionId)
      if (proof.expiresAt < Date.now() || proof.targetEpoch !== promptEpoch || proof.pcId !== self().id || !at || !info || !screen ||
          at.floor.id !== proof.floorId || at.agent.id !== proof.agentId || info.floorId !== proof.floorId || info.agentId !== proof.agentId || (at.agent.homePc && at.agent.homePc !== self().id) || (isPcControl(at.floor) && at.floor.targetPcId !== self().id) ||
          info.state !== 'question' || approvalGeneration(proof.sessionId) !== proof.generation) throw apiError(409, 'The native approval target or grant changed before input.')
      const p = promptOf(screen.join('\n'))
      if (p.id !== proof.promptId || (raw.action === 'cancel' ? !p.cancellable : !answerable(p.menu) || !p.menu!.options.some(x => x.n === raw.n))) throw apiError(409, 'The native prompt changed before input.')
      // No await between the final target/human check and the receiving native write.
      validateLocal?.(at.agent)
      markNativeAttempt()
      if (!chats.input(proof.sessionId, raw.action === 'cancel' ? ESC_KEY : String(raw.n))) throw apiError(409, 'Native approval was not confirmed; do not retry automatically.')
      return { version: 1, committed: true }
    })
  }
  function humanProof(kind: SignedKind, _fields: (string | number | boolean)[], _legacySignature: unknown, r?: ProofRequest): string {
    // F158: never inspect old device keys, settings, signatures or unsigned flags.
    return describeHuman(requireCrmHuman(o.auth, r, ['autoupdate', 'pair', 'wa-send'].includes(kind)))
  }
  function humanTarget(r: ProofRequest | undefined, agent: FloorAgent, need: 'type' | 'owner' = 'type') {
    const caller = requireCrmHuman(o.auth, r)
    if (r) r.caller = caller
    access.needChat(caller, agent, need, 'human approval/send')
    const at = agent.sessionId ? whereAll()[agent.sessionId] : null
    if (mode() === 'member' && (at?.id ?? agent.homePc) !== self().id) throw Object.assign(apiError(409, 'Sign in on the Server page to act on a chat running on another PC.'), { code: 'hub-sign-in-required', hubOrigin: null })
    return caller
  }
  function setAutoUpdate(raw: unknown, by: string, r?: ProofRequest) {
    if (!isObject(raw) || typeof raw.on !== 'boolean') throw apiError(400, 'Expected {on}')
    const who = humanProof('autoupdate', [raw.on], undefined, r)
    const st = autoUpdate.set(raw.on, `${who} via ${by}`)
    deviceLog(`Automatic updates when quiet switched ${raw.on ? 'ON' : 'off'}`, `${who} via ${by}`)
    return st
  }
  const deviceLog = (detail: string, by: string) => approvalLog.add({ kind: 'device', floor: '', agent: '', pc: self().name, sessionId: '', detail, by })
  function retiredApprovalDevices(): never { throw Object.assign(apiError(410, 'Approval-device enrollment was removed. Sign in through CRM; no device registration is used.'), { code: 'approval-devices-retired' }) }

  /** One durable intent; neither a timeout nor reopening the chat replays its paste. */
  async function sayTo(id: string, agentId: string, body: string, intent: Omit<SayRequest, 'text'> = {}, actor: Caller = OPEN, onSent?: (sid: string) => void, humanAuthority?: () => boolean): Promise<SayAnswer> {
    const owner = deliveryActor({ caller: actor })
    const receipt = messageReceipts.begin({ id: intent.messageId, owner, floorId: id, agentId, text: body, expectedSessionId: intent.expectedSessionId }, async (bind, noteBlocked) => {
      let mayHaveSubmitted = false, observedSid = intent.expectedSessionId ?? null
      let reason: DeliveryBlockReason | undefined
      const refuse = (code: DeliveryBlockReason, pcName?: string) => { logDeliveryBlock(observedSid, code); return noteBlocked(code, pcName) }
      try {
      if (humanAuthority?.() === false) return refuse('authorization-revoked')
      let agent = agentOf(floorOf(id), agentId)
      observedSid = agent.sessionId
      if (intent.expectedSessionId !== undefined && agent.sessionId !== intent.expectedSessionId) return refuse('stale-session')
      try { access.needChat(actor, agent, 'type', 'message delivery') } catch { return refuse('access-denied') }
      let sid = agent.sessionId, pc = sid ? whereAll()[sid]?.id : undefined, started = false
      if (!sid || !pc) {
        if (access.rights(actor, agent)?.can !== 'owner') return refuse('owner-required')
        const requestedHome = agent.homePc
        // Opening never carries text. Only the receipt-owned transaction can submit it afterwards.
        const opened = await openChat(id, agentId, {})
        sid = opened.sessionId; started = opened.started
        pc = chats.info(sid) ? self().id : whereAll()[sid]?.id
        // The authenticated open can precede the debounced live advertisement. Its home is
        // usable only when the canonical binding still agrees with the requested home.
        if (!pc && opened.on && requestedHome && agentOf(floorOf(id), agentId).homePc === requestedHome) pc = requestedHome
      }
      agent = agentOf(floorOf(id), agentId)
      if (!sid || !pc) return refuse('target-unavailable')
      if (agent.sessionId !== sid) return refuse('binding-changed')
      observedSid = sid
      const targetSid = sid
      let binding = deliveryBinding(agent)
      const invalid = (code: DeliveryBlockReason) => { reason = code; return false }
      const valid = () => {
        try {
          const current = agentOf(floorOf(id), agentId)
          const advanced = advanceDeliveryBinding(binding, current)
          if (!advanced) return invalid('binding-changed')
          binding = advanced
          try { access.needChat(actor, current, 'type', 'message delivery') } catch { return invalid('access-denied') }
          if (switchFences.blocked(targetSid)) return invalid('switch-in-progress')
          if (humanAuthority?.() === false) return invalid('authorization-revoked')
          return true
        } catch { return invalid('target-unavailable') }
      }
      if (!valid()) return refuse(reason ?? 'preflight-failed')
      let final: DeliveryReceipt | null
      if (pc === self().id) {
        const generation = chats.generation?.(sid)
        if (!generation) return refuse('runtime-unavailable')
        bind(sid, generation, started)
        const native = beginNativeDelivery(sid, body, owner, receiptId(), binding, valid)
        mayHaveSubmitted = true
        do { final = await nativeReceipts.wait(native.id, owner, id, agentId, 15_000) } while (final?.state === 'pending' && !closing)
      } else {
        mayHaveSubmitted = true
        final = await remoteNativeDelivery(pc, sid, body, owner, receiptId(), binding, actor, humanAuthority ? valid : undefined)
        if (final?.generation) bind(sid, final.generation, started)
      }
      if (final?.state === 'sent') onSent?.(sid)
      if (final?.state === 'blocked') return refuse(reason ?? final.reason ?? 'peer-blocked', final.targetPcName)
      return final?.state === 'pending' ? 'unconfirmed' : final?.state ?? 'unconfirmed'
      } catch { return mayHaveSubmitted ? 'unconfirmed' : refuse(reason ?? 'preflight-failed') }
    })
    // The send callback is always a microtask, after this stable ID has been allocated.
    function receiptId() { return receipt.id }
    const final = await messageReceipts.wait(receipt.id, owner, id, agentId)
    if (final?.state === 'sent') return { ok: true, started: final.started, receipt: final }
    const state = final?.state ?? 'unconfirmed'
    const description = state === 'pending'
      ? 'The one message is still awaiting submission confirmation and may still complete. Observe its receipt; do not press Enter or resend.'
      : state === 'blocked' || state === 'gone'
        ? blockDescription(final)
        : 'Delivery is not confirmed. The one message may already have been submitted or may remain in the composer. Inspect the destination; do not press Enter or resend.'
    throw Object.assign(apiError(409, description), { code: `delivery-${state}` })
  }

  /** The keys of a numbered choice, into a chat anywhere (this PC's, or through the link). */
  async function typeKeys(c: { sessionId: string; id: string }, data: string, proof: NativeApprovalProof, validateLocal: (agent: FloorAgent) => void, markDispatch: () => void): Promise<boolean> {
    const command: NativeApprovalCommit = { version: 1, proof, action: data === ESC_KEY ? 'cancel' : 'answer', ...(data === ESC_KEY ? {} : { n: Number(data) }) }
    if (c.id === self().id) return (await commitNativeApproval(command, null, current => { validateLocal(current); markDispatch() })).committed
    const link = team?.member(c.id)
    if (!link) throw apiError(409, 'The pinned PC disconnected before approval dispatch.')
    // Human authentication/ACL linearizes at authenticated dispatch. Never forward cookies or raw claimed people.
    const at = floors.bySession(c.sessionId)
    if (!at) throw apiError(409, 'The approval target changed before dispatch.')
    validateLocal(at.agent)
    const dispatchPeer: LinkPeer = { ...link, open: async meta => {
      const stream = await link.open(meta), end = stream.end
      stream.end = function (...args: unknown[]) {
        try {
          if (team?.member(c.id)?.token !== link.token) throw apiError(409, 'The pinned PC changed before dispatch.')
          const latest = floors.bySession(c.sessionId)
          if (!latest) throw apiError(409, 'The approval target changed before dispatch.')
          validateLocal(latest.agent)
          markDispatch()
          return Reflect.apply(end, stream, args)
        } catch (error) { stream.destroy(); throw error }
      } as typeof stream.end
      return stream
    } }
    const result = await request<{ version: number; committed: boolean }>(dispatchPeer, 'approval-commit-v1', command)
    if (result?.version !== 1 || result.committed !== true) throw apiError(409, 'Approval commit was not confirmed; inspect the prompt and do not retry automatically.')
    return true
  }

  /** Every chat waiting at a prompt, on every floor and PC, with what its screen says. */
  async function listApprovals(r?: ProofRequest): Promise<ApprovalsAnswer> {
    const caller = requireCrmHuman(o.auth, r)
    const where = whereAll()
    const waiting = floors.list().flatMap(f => f.agents.flatMap(a => (access.rights(caller, a)?.can && access.rights(caller, a)?.can !== 'view' && a.sessionId && where[a.sessionId]?.state === 'question' ? [{ f, a, w: where[a.sessionId], sid: a.sessionId }] : [])))
    const items = await Promise.all(
      waiting.map(async ({ f, a, w, sid }): Promise<ApprovalItem> => {
        const p = await promptOfChat({ sessionId: sid, id: w.id })
        return { sessionId: sid, floorId: f.id, floorName: f.name, agentId: a.id, agentName: a.name, pc: w.name, state: w.state, menu: p.menu, context: p.context, id: p.id, answerable: answerable(p.menu), cancellable: p.cancellable }
      }),
    )
    return { items, prepared: [...prepared.values()].filter(card => { const a = allFloors().find(f => f.id === card.floorId)?.agents.find(a => a.id === card.agentId); const rights = a ? access.rights(caller, a) : null; return rights && rights.can !== 'view' }).sort((x, y) => y.at.localeCompare(x.at)) }
  }

  /** His tap on option n of the prompt he was shown: typed into that chat exactly as pressing it there. Refused when the prompt has changed since. */
  async function answerApproval(raw: unknown, by: string, r?: ProofRequest) {
    if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.id !== 'string' || typeof raw.n !== 'number') throw apiError(400, 'Expected {sessionId, id, n}')
    const req = raw as unknown as AnswerRequest
    // Only the current CRM session and current target rights authorize this action.
    by = `${humanProof('answer', [req.sessionId, req.id, req.n], undefined, r)} via ${by}`
    const at = floors.bySession(req.sessionId)
    const w = whereAll()[req.sessionId]
    if (!at || !w) throw apiError(404, "That chat isn't running any more")
    humanTarget(r, at.agent)
    const runtime = w.id === self().id ? chats.info(req.sessionId)?.startedAt : team?.member(w.id)?.token
    if (w.state !== 'question') throw apiError(409, 'That chat is no longer waiting at a prompt; look again.')
    const p = await promptOfChat({ sessionId: req.sessionId, id: w.id })
    if (!p.native) throw Object.assign(apiError(409, 'That PC needs an app update before native approval can be verified.'), { code: 'approval-peer-update-required' })
    if (!answerable(p.menu)) throw apiError(409, 'That prompt can only be answered in the chat itself.')
    if (p.id !== req.id) throw apiError(409, 'That prompt has changed since you looked at it; look again.')
    const option = p.menu!.options.find(x => x.n === req.n)
    if (!option) throw apiError(400, `The prompt has no option ${req.n}`)
    const latest = floors.bySession(req.sessionId)
    const current = whereAll()[req.sessionId]
    if (!latest || latest.agent.id !== at.agent.id || current?.id !== w.id || (w.id === self().id ? chats.info(req.sessionId)?.startedAt : team?.member(w.id)?.token) !== runtime) throw apiError(409, 'The running target changed; refresh the prompt.')
    humanTarget(r, latest.agent)
    return promptActions.run(JSON.stringify([req.sessionId, req.id]), JSON.stringify(['answer', req.n]), async markNativeAttempt => {
      const now = await promptOfChat({ sessionId: req.sessionId, id: w.id })
      if (!now.native || now.id !== req.id || !answerable(now.menu) || !now.menu!.options.some(x => x.n === req.n)) throw apiError(409, 'That prompt changed before the answer could be committed; refresh it.')
      const target = floors.bySession(req.sessionId), live = whereAll()[req.sessionId]
      if (!target || target.agent.id !== at.agent.id || live?.id !== w.id || live.state !== 'question' || (w.id === self().id ? chats.info(req.sessionId)?.startedAt : team?.member(w.id)?.token) !== runtime) throw apiError(409, 'The running target changed before the answer could be committed; refresh it.')
      humanTarget(r, target.agent)
      if (!(await typeKeys({ sessionId: req.sessionId, id: w.id }, String(req.n), now.native.proof, current => humanTarget(r, current), markNativeAttempt))) throw apiError(409, `${at.agent.name}'s chat on ${w.name} can't be answered right now`)
      const detail = `${p.menu!.question || 'A prompt'} → ${option.n}. ${option.label}${p.context ? ` | ${p.context.split('\n').slice(-3).join(' / ')}` : ''}`
      approvalLog.add({ kind: 'answer', floor: at.floor.name, agent: at.agent.name, pc: w.name, sessionId: req.sessionId, detail, by })
      log?.info(`approved for ${at.agent.name} on ${at.floor.name}: option ${option.n}`)
      return { ok: true, answered: `${option.n}. ${option.label}`, agent: at.agent.name, floor: at.floor.name }
    })
  }

  /**
   * His tap on Cancel (Esc) for the prompt he was shown: one Escape key into that chat, only while its screen still shows the same prompt
   * and its footer says "Esc to cancel". CRM-authorized like an answer. On a permission prompt Esc means No.
   */
  async function cancelApproval(raw: unknown, by: string, r?: ProofRequest) {
    if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.id !== 'string') throw apiError(400, 'Expected {sessionId, id}')
    const req = raw as unknown as CancelRequest
    by = `${humanProof('cancel', [req.sessionId, req.id], undefined, r)} via ${by}`
    const at = floors.bySession(req.sessionId)
    const w = whereAll()[req.sessionId]
    if (!at || !w) throw apiError(404, "That chat isn't running any more")
    humanTarget(r, at.agent)
    const runtime = w.id === self().id ? chats.info(req.sessionId)?.startedAt : team?.member(w.id)?.token
    if (w.state !== 'question') throw apiError(409, 'That chat is no longer waiting at a prompt; look again.')
    const p = await promptOfChat({ sessionId: req.sessionId, id: w.id })
    if (!p.native) throw Object.assign(apiError(409, 'That PC needs an app update before native approval can be verified.'), { code: 'approval-peer-update-required' })
    if (!p.cancellable) throw apiError(409, 'That prompt has no "Esc to cancel"; answer it in the chat itself.')
    if (p.id !== req.id) throw apiError(409, 'That prompt has changed since you looked at it; look again.')
    const latest = floors.bySession(req.sessionId)
    const current = whereAll()[req.sessionId]
    if (!latest || latest.agent.id !== at.agent.id || current?.id !== w.id || (w.id === self().id ? chats.info(req.sessionId)?.startedAt : team?.member(w.id)?.token) !== runtime) throw apiError(409, 'The running target changed; refresh the prompt.')
    humanTarget(r, latest.agent)
    return promptActions.run(JSON.stringify([req.sessionId, req.id]), 'cancel', async markNativeAttempt => {
      const now = await promptOfChat({ sessionId: req.sessionId, id: w.id })
      if (!now.native || now.id !== req.id || !now.cancellable) throw apiError(409, 'That prompt changed before Cancel could be committed; refresh it.')
      const target = floors.bySession(req.sessionId), live = whereAll()[req.sessionId]
      if (!target || target.agent.id !== at.agent.id || live?.id !== w.id || live.state !== 'question' || (w.id === self().id ? chats.info(req.sessionId)?.startedAt : team?.member(w.id)?.token) !== runtime) throw apiError(409, 'The running target changed before Cancel could be committed; refresh it.')
      humanTarget(r, target.agent)
      if (!(await typeKeys({ sessionId: req.sessionId, id: w.id }, ESC_KEY, now.native.proof, current => humanTarget(r, current), markNativeAttempt))) throw apiError(409, `${at.agent.name}'s chat on ${w.name} can't be cancelled right now`)
      const detail = `${p.menu?.question || 'A prompt'} → Esc (cancel)${p.context ? ` | ${p.context.split('\n').slice(-3).join(' / ')}` : ''}`
      approvalLog.add({ kind: 'answer', floor: at.floor.name, agent: at.agent.name, pc: w.name, sessionId: req.sessionId, detail, by })
      log?.info(`cancelled (Esc) for ${at.agent.name} on ${at.floor.name}`)
      return { ok: true, agent: at.agent.name, floor: at.floor.name }
    })
  }

  /** His own words, into a chosen agent's chat as plain input: no "[message from ...]", as if typed there. */
  async function sendAsMe(raw: unknown, by: string, rq?: ProofRequest) {
    if (!isObject(raw) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string') throw apiError(400, 'Expected {floorId, agentId, text}')
    const req = raw as unknown as SendAsMeRequest
    const body = text(req.text, 'text', MAX_SAY_TEXT)
    // Cached legacy signature fields are ignored, never an alternative to a CRM session.
    by = `${humanProof('send', [req.floorId, req.agentId, createHash('sha256').update(body, 'utf8').digest('hex'), typeof req.card === 'string' ? req.card : ''], undefined, rq)} via ${by}`
    const at = agentOf(floorOf(req.floorId), req.agentId)
    const person = humanTarget(rq, at, at.sessionId && whereAll()[at.sessionId] ? 'type' : 'owner')
    const humanAuthority = () => {
      try { const current = requireCrmHuman(o.auth, rq); return current.sid === person.sid && current.person?.id === person.person?.id }
      catch { return false }
    }
    const floor = floorOf(req.floorId)
    const r = await sayTo(req.floorId, req.agentId, body, sayIntent(raw), rq?.caller ?? OPEN, sid => {
      const w = whereAll()[sid]
      approvalLog.add({ kind: 'send', floor: floor.name, agent: at.name, pc: w?.name ?? self().name, sessionId: sid, detail: body, by })
      if (typeof req.card === 'string') prepared.delete(req.card)
      log?.info(`sent as the person to ${at.name} on ${floor.name}`)
    }, humanAuthority)
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

  type Row = Record<string, unknown>
  /** F-067: pauses between the commands typed into one chat, so claude has taken the first before the next arrives. */
  const TUNE_GAP_MS = o.tuneGapMs ?? 800

  /**
   * F-067: changes an agent's model, effort and/or ultracode (kept on the agent: its chat starts with them every time)
   * and, when its chat runs and is waiting for the person, types the commands that change them in that chat now
   * (`/model`, `/effort`, `/effort ultracode`). A chat that is working, or at a question, or stopped, takes
   * them at its next start; the answer says which.
   */
  async function tuneAgent(floorId: string, agentId: string, raw: unknown): Promise<TuneAnswer> {
    requireLegacyExecution(agentOf(floorOf(floorId), agentId), defaultsNow())
    if (!isObject(raw)) throw apiError(400, 'Expected {model?, effort?, ultracode?}')
    if (raw.codexModel !== undefined || raw.codexEffort !== undefined) return tuneCodex(floorId, agentId, raw)
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
    if (engineFor(a) !== 'claude') throw apiError(400, `${a.name} runs ${engineFor(a)}: use that engine’s provider/model settings.`)
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

  /**
   * F-134: a Codex agent's model and effort. They are kept on the agent and used at its chat's next start (a running Codex chat is not typed into: its model and
   * reasoning level are read from its profile when it starts).
   */
  async function tuneCodex(floorId: string, agentId: string, raw: Row): Promise<TuneAnswer> {
    const before = floorOf(floorId)
    const a = agentOf(before, agentId)
    requireLegacyExecution(a, defaultsNow())
    if (engineFor(a) !== 'codex') throw apiError(409, `${a.name} runs Claude: change its model and effort with model and effort, or change its engine first.`)
    if (raw.codexModel !== undefined && typeof raw.codexModel !== 'string') throw apiError(400, 'codexModel is a model name, or "" for the one Codex chooses')
    if (raw.codexEffort !== undefined && !(CODEX_EFFORTS as readonly unknown[]).includes(raw.codexEffort)) throw apiError(400, 'codexEffort is low, medium, high, xhigh, max, or "" for the one Codex chooses')
    const codexModel = raw.codexModel !== undefined ? String(raw.codexModel).trim().slice(0, CODEX_MODEL_MAX) : (a.codexModel ?? '')
    const codexEffort = raw.codexEffort !== undefined ? (raw.codexEffort as CodexEffort) : (a.codexEffort ?? '')
    const floor = floors.patch(before.id, { agents: before.agents.map(x => (x.id === a.id ? { ...x, codexModel, codexEffort } : x)) })
    const running = !!a.sessionId && !!whereAll()[a.sessionId]
    return {
      floor,
      applied: 'next',
      detail: running
        ? `${a.name}'s Codex model and effort are kept; its chat is running, so they apply when the chat next starts.`
        : `${a.name}'s Codex model and effort are kept; they apply when its chat next starts.`,
    }
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
    if (['executionProfile', 'executionRevision', 'execution', 'provider', 'harness', 'transcript'].some(k => Object.hasOwn(body, k))) throw executionHttpError('execution-capability-required', 'selection')
    const from = body.sessionId
    if (isPcControl(floorOf(floorId)) || controlAlias(from)) throw immutablePcControl()
    const intoId = typeof body.agentId === 'string' && body.agentId ? body.agentId : null
    const floor = floorOf(floorId)
    if (intoId) requireLegacyExecution(agentOf(floor, intoId), defaultsNow())
    const previousBinding = bySession(from)
    if (previousBinding) requireLegacyExecution(previousBinding.agent, defaultsNow())
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
    ['GET', /^\/pc-control$/, (_, r) => controlAnswer(callerOf(r))],
    ['GET', /^\/pc-control\/pcs\/([^/]+)$/, async ([device], r) => {
      const w = (await controlAnswer(callerOf(r))).workspaces.find(w => w.device.id === device)
      if (!w) throw pcControlError('pc-control-forbidden', 'That PC workspace is unavailable to you.', 403)
      return { workspace: w }
    }],
    ['POST', /^\/pc-control\/pcs\/([^/]+)\/slots\/([^/]+)\/open$/, ([device, agent], r) => controlMutate(device, agent, 'open', r)],
    ['POST', /^\/pc-control\/pcs\/([^/]+)\/slots\/([^/]+)\/stop$/, ([device, agent], r) => controlMutate(device, agent, 'stop', r)],
    ['POST', /^\/pc-control\/pcs\/([^/]+)\/slots\/([^/]+)\/engine$/, ([device, agent], r) => controlMutate(device, agent, 'engine', r)],
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
    // F-127: this PC's setting for new chats while the Server is down, and how the floors made then are joining the Server's list.
    ['GET', /^\/offline-chats$/, () => offlineAnswer(), 'local'],
    // F-134: Codex on this PC.
    ['GET', /^\/opencode\/status$/, () => openCode.status(), 'local'],
    ['GET', /^\/codex\/status$/, () => codexAnswer(), 'local'],
    // F-165: what Codex in Claude Code needs on this PC and on each PC within reach, read-only.
    ['GET', /^\/dependencies$/, () => dependenciesAnswer(), 'local'],
    ['POST', /^\/codex\/refresh$/, async () => {
        await o.codex?.check()
        return codexAnswer()
      }, 'local'],
    ['GET', /^\/codex\/settings$/, () => ({ enabled: true }), 'local'],
    ['PUT', /^\/codex\/settings$/, (_, r) => retireCodexSettings(r), 'local'],
    ['PUT', /^\/offline-chats$/, (_, r) => setOfflineChats(r.body, r), 'local'],
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
    ['PUT', /^\/defaults$/, (_, r) => {
      if (isObject(r.body) && typeof r.body.engine === 'string' && ['', 'claude', 'codex', 'opencode'].includes(r.body.engine) &&
        engineOf(r.body.engine as AgentEngine, '') !== engineOf(defaultsNow().engine, '') &&
        allFloors().some(f => f.agents.some(a => !a.engine && a.sessionId))) {
        throw Object.assign(apiError(409, 'Some existing conversations follow the default engine. Choose an explicit engine for those agents with conversation carry-over before changing the default.'), { code: 'engine-change-conversion-failed' })
      }
      return { defaults: chatDefaults.set(r.body) }
    }],
    // Forwarded on members: an old hub must answer 404, rather than a new member promising safety for it.
    ['GET', /^\/engine-switch-capabilities$/, () => ({ version: 1, failClosed: true, homePcRouting: true })],
    // F-067: the long-press menu: an agent's model, effort and ultracode, applied now to a chat that waits.
    ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/tune$/, ([id, agentId], r) => tuneAgent(id, agentId, r.body)],
    // F-076: human-only. Answer a waiting chat's prompt from one place; say something as the person. Never a chat's key (it has no route here).
    ['GET', /^\/approvals$/, (_, r) => (humanOnly(r), listApprovals(r)), 'local'],
    ['POST', /^\/approvals\/answer$/, (_, r) => (humanOnly(r), answerApproval(r.body, byOf(r), r)), 'local'],
    ['POST', /^\/approvals\/cancel$/, (_, r) => (humanOnly(r), cancelApproval(r.body, byOf(r), r)), 'local'],
    ['POST', /^\/send-as-me$/, (_, r) => (humanOnly(r), sendAsMe(r.body, byOf(r), r)), 'local'],
    ['GET', /^\/auto-update$/, (_, r) => (humanOnly(r), autoUpdate.read())],
    ['POST', /^\/auto-update$/, (_, r) => (humanOnly(r), setAutoUpdate(r.body, byOf(r), r))],
    ['GET', /^\/approvals\/devices$/, () => retiredApprovalDevices()],
    ['POST', /^\/approvals\/devices\/code$/, () => retiredApprovalDevices()],
    ['POST', /^\/approvals\/devices\/register$/, () => retiredApprovalDevices()],
    ['GET', /^\/approvals\/devices\/recover$/, () => retiredApprovalDevices()],
    ['POST', /^\/approvals\/devices\/recover\/start$/, () => retiredApprovalDevices()],
    ['POST', /^\/approvals\/devices\/recover\/finish$/, () => retiredApprovalDevices()],
    ['POST', /^\/approvals\/devices\/remove$/, () => retiredApprovalDevices()],
    ['POST', /^\/approvals\/devices\/unsigned$/, () => retiredApprovalDevices()],
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
    ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/chat$/, ([id, agentId], r) => {
      const body = r.body
      if (isObject(body) && ['executionVersion', 'openIntentId', 'expectedExecution'].some(k => Object.hasOwn(body, k))) {
        const request = requireExecutionOpenRequest(r.body), agent = workflowExecutionAgent(id, agentId)
        assertExecutionCAS(request.expectedExecution, snapshotAgentExecution(agent, defaultsNow()))
        if (!executionService) throw executionHttpError('execution-capability-required', 'open', request.openIntentId)
        return executionService.open(executionScope(id, agentId, r), request)
      }
      return openChat(id, agentId, openRequest(r.body))
    }, 'local'],
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
        if (engineFor(agent) === 'opencode' && agent.opencodeSession && agent.homePc && agent.homePc !== pc) throw apiError(409, 'OpenCode conversations resume on their home PC. Switch engines to carry the conversation to another PC.')
        let opened: ChatOpened
        let name = self().name
        if (pc === self().id) {
          opened = await openChat(id, agentId, { takeOver: true, here: true })
          if (say && opened.started) chats.typeWhenReady(opened.sessionId, say)
        } else {
          const link = mode() === 'hub' ? (team?.member(pc) ?? null) : null
          if (!link) throw apiError(HOME_OFFLINE_STATUS, `${homeName(agent, pc)} can't be reached right now, so ${agent.name}'s chat can't move there.`)
          name = link.name
          opened = { ...(await openOnPeer(link, floorOf(id), agent, say)), on: link.name }
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
        return sayTo(id, agentId, body, sayIntent(r.body), callerOf(r))
      },
    ],
    ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/deliveries$/, () => ({ version: 1, idempotent: true, expectedSessionId: true, receipts: true })],
    ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/deliveries\/([^/]+)$/, ([id, agentId, messageId], r) => {
      const receipt = messageReceipts.lookup(messageId, deliveryActor(r), id, agentId)
      if (!receipt) throw apiError(404, 'No delivery receipt for this person and agent.')
      return { receipt }
    }],
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

  function workflowExecutionAgent(id: string, agentId: string): FloorAgent {
    const floor = floorOf(id), agent = agentOf(floor, agentId)
    if (isPcControl(floor) || [agent.id, agent.sessionId, agent.codexThread, agent.opencodeSession].some(x => typeof x === 'string' && controlAlias(x))) throw immutablePcControl()
    executionIdentityOf(agent, defaultsNow())
    return agent
  }
  function targetExecution(profile: ReturnType<typeof requireExecutionCapabilityQuery>['profile'], agent: FloorAgent): ExecutionIdentity {
    const engine = profile === 'codex-native-v1' ? 'codex' : profile === 'opencode-native-v1' ? 'opencode' : 'claude'
    return normalizeExecution({ engine, executionProfile: profile, opencodeProvider: agent.opencodeProvider }, defaultsNow())
  }
  function executionScope(id: string, agentId: string, r: MountRequest): ExecutionIntentScope {
    const agent = workflowExecutionAgent(id, agentId), caller = callerOf(r)
    if (!executionService || !caller.person || !agent.homePc) throw executionHttpError('execution-forbidden', 'authorization')
    const ownerId = agent.owner?.id
    if (!ownerId) throw executionHttpError('execution-forbidden', 'authorization')
    const scope = { actorId: caller.person.id, ownerId, floorId: id, agentId, targetPcId: agent.homePc }
    executionService.bindActor(scope, () => {
      const latest = o.auth ? o.auth.caller(r.headers) : caller
      if (latest.person?.id !== caller.person!.id || latest.sid !== caller.sid) throw executionHttpError('execution-forbidden', 'authorization')
      access.needChat(latest, workflowExecutionAgent(id, agentId), 'owner', 'execution')
    })
    return scope
  }
  async function executionCapability(id: string, agentId: string, r: MountRequest): Promise<ExecutionCapabilityReply> {
    const agent = workflowExecutionAgent(id, agentId), query = requireExecutionCapabilityQuery(Object.fromEntries(r.query))
    const current = snapshotAgentExecution(agent, defaultsNow()), target = targetExecution(query.profile, agent)
    if (!current.homePc) throw executionHttpError('execution-capability-required', 'capability')
    if (executionService && current.homePc === self().id) {
      try { return await executionService.capability(executionScope(id, agentId, r), query) }
      catch (error) { if ((error as { code?: string }).code !== 'execution-capability-required') throw error }
    }
    return { version: 1, current, target, targetPcId: current.homePc, available: false, unavailableCode: 'execution-capability-required' }
  }
  type ProfileRoute = [string, RegExp, Handler, 'local', Rule]
  const profileOwner: Rule = { kind: 'chat', need: 'owner', floor: 0, agent: 1 }
  // The separately-owned legacy access/POLICY file is outside this allocation. These explicit owner rules
  // pass through the SAME PC Control/SID/ACL dispatcher; there is no unguarded raw/forwarding shortcut.
  const executionRoutes: ProfileRoute[] = [
    ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/conversion-progress$/, ([id, agentId]) => ({ progress: conversionProgress.get(id, agentId) }), 'local', profileOwner],
    ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/execution-capability$/, ([id, agentId], r) => executionCapability(id, agentId, r), 'local', profileOwner],
    ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/execution-selection$/, ([id, agentId], r) => {
      const agent = workflowExecutionAgent(id, agentId), request = requireExecutionSelectionRequest(r.body)
      if ([request.expected.agentId, request.expected.sessionId, request.expected.codexThread, request.expected.opencodeSession].some(x => typeof x === 'string' && controlAlias(x))) throw immutablePcControl()
      assertExecutionCAS(request.expected, snapshotAgentExecution(agent, defaultsNow()))
      if (!executionService) throw executionHttpError('execution-capability-required', 'selection', request.selectionIntentId)
      return executionService.select(executionScope(id, agentId, r), request)
    }, 'local', profileOwner],
    ['POST', /^\/floors\/([^/]+)\/agents\/([^/]+)\/execution-verify$/, ([id, agentId], r) => {
      const agent = workflowExecutionAgent(id, agentId)
      if (!isObject(r.body) || r.body.version !== 1 || Object.keys(r.body).some(key => !['version', 'expected'].includes(key))) throw executionHttpError('execution-invalid', 'capability')
      assertExecutionCAS(r.body.expected, snapshotAgentExecution(agent, defaultsNow()))
      if (!executionService) throw executionHttpError('execution-capability-required', 'capability')
      return executionService.verify(executionScope(id, agentId, r))
    }, 'local', profileOwner],
    ['GET', /^\/floors\/([^/]+)\/agents\/([^/]+)\/execution-intents\/([^/]+)$/, ([id, agentId, intent], r) => {
      workflowExecutionAgent(id, agentId)
      if (!executionIntentId(intent)) throw executionHttpError('execution-invalid', 'status')
      if (!executionService) throw executionHttpError('execution-capability-required', 'status', intent)
      return executionService.status(executionScope(id, agentId, r), intent)
    }, 'local', profileOwner],
  ]
  function guardWorkflowExecution(r: MountRequest, params: string[], profile: boolean): void {
    if (profile) { workflowExecutionAgent(params[0], params[1]); return }
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)) return
    const body = r.body
    if (isObject(body) && ['executionProfile', 'executionRevision', 'execution', 'provider', 'harness', 'transcript'].some(k => Object.hasOwn(body, k))) throw executionHttpError('execution-capability-required', 'selection')
    if (isObject(body) && typeof body.sessionId === 'string') {
      const source = bySession(body.sessionId)
      if (source) requireLegacyExecution(source.agent, defaultsNow())
    }
    if (/^\/floors\/[^/]+\/agents\/[^/]+\//.test(r.rest) && !r.rest.endsWith('/share')) {
      const agent = agentOf(floorOf(params[0]), params[1])
      if(r.method==='POST'&&r.rest.endsWith('/say')&&isObject(body)&&typeof body.messageId==='string'&&UUID_RE.test(body.messageId)
        &&typeof body.expectedSessionId==='string'&&body.expectedSessionId===agent.sessionId){
        assertMessageRuntime(body.expectedSessionId,self().id,true);return
      }
      // Stop only ends the chat's process: its binding, profile and history stay as they are, and the bridge retires the
      // run once its exact processes are gone (as app_stop_chat's stop of a proved chat does). It is the owner's (POLICY).
      // Refusing it left a Codex in Claude Code chat unstoppable from the page ("has not proved this execution capability").
      const stopOnly = r.method === 'POST' && /^\/floors\/[^/]+\/agents\/[^/]+\/terminate$/.test(r.rest)
      if (!stopOnly && !(r.rest.endsWith('/chat') && isObject(r.body) && Object.hasOwn(r.body, 'executionVersion'))) requireLegacyExecution(agent, defaultsNow())
    }
    if (r.method === 'DELETE' && /^\/floors\/[^/]+$/.test(r.rest)) for (const agent of floorOf(params[0]).agents) requireLegacyExecution(agent, defaultsNow())
  }

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

  /**
   * F-127: a member runs this route itself instead of passing it to a hub that can't answer: any route of a floor made here (it is not on the Server yet),
   * and a NEW floor while the Server has been out of reach and offline chats are allowed. A new floor while the Server answers goes to the Server as ever.
   */
  function runsHere(method: string, pattern: RegExp, params: string[]): boolean {
    if (mode() !== 'member') return false
    if (method === 'POST' && pattern.source === '^\\/floors$') {
      if (!offlineActive()) return false
      needClaudeHere()
      return true
    }
    return pattern.source.startsWith('^\\/floors\\/([^/]+)') && params.length > 0 && isLocalFloor(params[0])
  }

  /** Runs the route `rest` names; `forward` (a member) passes a non-local one to its hub instead. */
  async function route(r: MountRequest, forward?: (r: MountRequest) => Promise<unknown>): Promise<unknown> {
    let methodMismatch = false
    for (const [method, pattern, run, where, profileRule] of [...executionRoutes, ...routes]) {
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
      guardPcControlRoute(r, params)
      const versionedOpen = r.method === 'POST' && /^\/floors\/[^/]+\/agents\/[^/]+\/chat$/.test(r.rest)
        && isObject(r.body) && ['executionVersion', 'openIntentId', 'expectedExecution'].some(k => Object.hasOwn(r.body as object, k))
      if ((profileRule || versionedOpen) && !callerOf(r).person) throw authError(401, 'Sign in before using execution selection.', 'sign-in')
      checkRule(profileRule ?? ruleOf(method, pattern), params, r)
      guardWorkflowExecution(r, params, profileRule !== undefined)
      if (forward && where !== 'local' && !runsHere(method, pattern, params)) return await forward(r)
      if(r.method==='POST'&&/^\/floors\/[^/]+\/agents\/[^/]+\/(?:chat|execution-selection)$/.test(r.rest))requireHostAdoption()
      return await run(params, r)
    }
    throw apiError(methodMismatch ? 405 : 404, methodMismatch ? `${r.method} is not allowed here` : `No such path: ${AGENTIC_PREFIX}${r.rest}`)
  }

  /** A member's change, passed to the hub; its own folder for a floor becomes `folderFor` (checked here, where it is). */
  async function toHub(r: MountRequest): Promise<unknown> {
    if (/^\/(?:approvals|send-as-me|auto-update)(?:\/|$)/.test(r.rest)) { requireCrmHuman(o.auth, r); throw Object.assign(apiError(409, 'Sign in on the Server page for this action.'), { code: 'hub-sign-in-required', hubOrigin: null }) }
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
        // F-165: a member's Dependencies page asks for the hub's checks.
        case 'dependencies':
          return answer(() => localDependencies())
        case 'delivery-capabilities':
          return answer(() => ({ version: 1, idempotent: true, receipts: true, humanInputAuthorization: 1 }))
        case 'delivery-authorize':
          return answer(raw => humanInputGrants.authorize(from.id, team?.member(from.id)?.token, raw))
        case 'pc-control-capabilities':
          return answer(() => ({ version: 1, pinnedWorkspace: true, actualEngineProof: true, engines: ['claude', 'codex'] }))
        case 'pc-control-runtime':
          return answer(localControlRuntime)
        case 'engine-open-capabilities':
          return answer(() => ({ version: 1, engines: ['claude', 'codex', 'opencode'] }))
        case 'engine-switch-status':
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.switchId !== 'string') throw apiError(400, 'Expected source and operation id')
            return { state: activeSwitches.has(raw.switchId) ? 'active' : bySession(raw.sessionId) ? 'cancel' : 'retire' }
          })
        case 'subscribe':
          return stream => onSubscribe(from, stream)
        case 'adopt':
          // F-127: floors a member made while it could not reach this PC, taken in whole.
          return answer(raw => adoptFloors(from, raw))
        case 'opencode-bind':
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.native !== 'string') throw apiError(400, 'Expected OpenCode binding')
            const at = bySession(raw.sessionId)
            if (!at || engineFor(at.agent) !== 'opencode' || held.get(raw.sessionId)?.holder !== from.id) throw apiError(403, 'This PC does not hold that OpenCode conversation')
            floors.setOpenCodeSession(at.floor.id, at.agent.id, raw.native)
            return { ok: true }
          })
        case 'codex-bind':
          return answer(raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string' || typeof raw.native !== 'string') throw apiError(400, 'Expected Codex binding')
            const at = bySession(raw.sessionId)
            if (at && isPcControl(at.floor)) assertPcControlTarget(at.floor, from.id, {})
            if (!at || engineFor(at.agent) !== 'codex' || (held.get(raw.sessionId)?.holder !== from.id && at.agent.homePc !== from.id)) throw apiError(403, 'This PC does not hold that Codex conversation')
            if (at.agent.codexThread && at.agent.codexThread !== raw.native) throw apiError(409, 'The native Codex binding changed')
            floors.setCodexThread(at.floor.id, at.agent.id, raw.native)
            if (at.agent.homePc !== from.id) floors.setHome(at.floor.id, at.agent.id, from)
            return { ok: true }
          })
        case 'http':
          return answer(body => fromMember(from, body))
        case 'lease':
          return answer(async raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string') throw apiError(400, 'Expected {sessionId, takeOver}')
            const at = floors.bySession(raw.sessionId)
            if (!at) throw apiError(404, "That chat isn't an agent's on a floor")
            const expected = engineFor(at.agent)
            if (raw.expectedEngine === undefined && expected !== 'claude') throw engineUpdateRequired(from.name)
            if (raw.expectedEngine !== undefined) requireRunningEngine(expected, raw.expectedEngine as RuntimeEngine)
            const tookOverFrom = (await lease(raw.sessionId, from, raw.takeOver === true, at.agent.name)) ?? null
            return { mark: markOf(fileOf(raw.sessionId)), tookOverFrom, engine: expected }
          })
        case 'pc-control-bind':
          return answer(raw => {
            if (!isObject(raw) || Object.keys(raw).some(k => !['floorId','agentId','sessionId','revision','expectedEngine'].includes(k)) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string' || typeof raw.sessionId !== 'string' || !UUID_RE.test(raw.sessionId)) throw apiError(400, 'Expected a pinned PC binding.')
            const floor = floorOf(raw.floorId), agent = agentOf(floor, raw.agentId)
            if (!isPcControl(floor)) throw immutablePcControl()
            assertPcControlTarget(floor, from.id, {})
            if (raw.revision !== pcControlRevision(floor) || agent.sessionId !== null || raw.expectedEngine !== engineFor(agent)) throw pcControlError('pc-control-stale', 'Refresh PC Control before opening this slot.')
            if (controlAlias(raw.sessionId) || allFloors().some(f => f.agents.some(a => a.sessionId === raw.sessionId))) throw immutablePcControl()
            return { floor: floors.bindSession(floor.id, agent.id, raw.sessionId) }
          })
        case 'release':
          return answer(async raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string' || !validTransferSid(raw.sessionId)) throw apiError(400, 'Expected {sessionId, mark}')
            const pin = controlPinnedPc(raw.sessionId)
            if (pin && pin !== from.id) throw pcControlError('pc-control-wrong-device', 'Only the pinned PC can release this managed conversation.')
            const link = team?.member(from.id)
            if (pin && !link) throw pcControlError('pc-control-stale', 'The managed source PC connection is no longer current.')
            const guard = link ? controlTransferGuard(link, raw.sessionId) : () => {}
            guard()
            if (link && isMark(raw.mark)) await catchUpFrom(link, raw.sessionId, raw.mark).catch(e => log?.warn(`couldn't bring chat ${String(raw.sessionId).slice(0, 8)} up from ${from.name}: ${message(e)}`))
            guard()
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
            const expected = engineFor(agentOf(floorOf(raw.floorId), raw.agentId))
            if (raw.expectedEngine === undefined && expected !== 'claude') throw engineUpdateRequired(from.name)
            if (raw.expectedEngine !== undefined) requireRunningEngine(expected, raw.expectedEngine as RuntimeEngine)
            const target = floorOf(raw.floorId)
            if (isPcControl(target)) { assertPcControlTarget(target, self().id, {}); if (raw.expectedEngine === undefined) throw pcControlError('pc-control-update-required', 'PC Control requires explicit engine proof.') }
            return openChat(raw.floorId, raw.agentId, isPcControl(target) ? {} : { takeOver: true, here: true }).then(opened => {
              if (opened.started && typeof raw.text === 'string' && raw.text) chats.typeWhenReady(opened.sessionId, raw.text.slice(0, MAX_SAY_TEXT))
              return opened
            })
          })
        case 'pull':
          return servePull(sid => validMirrorSid(sid) ? findTranscript(sid, projectsDir) : null)
      }
    } else if (m === 'member' && from.id === team!.hub()?.id) {
      const approvalHubToken = team?.hub()?.link?.token ?? null
      switch (op) {
        // F-165: the hub's Dependencies page asks for this PC's checks.
        case 'dependencies':
          return answer(() => localDependencies())
        case 'delivery-capabilities':
          return answer(() => ({ version: 1, idempotent: true, receipts: true, humanInputAuthorization: 1 }))
        case 'delivery-status':
          return answer(raw => {
            if (!isObject(raw) || typeof raw.messageId !== 'string' || typeof raw.owner !== 'string' || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string' || raw.targetPcId !== self().id) throw apiError(400, 'Expected a delivery receipt on this PC.')
            const receipt = nativeReceipts.lookup(raw.messageId, raw.owner, raw.floorId, raw.agentId)
            return { receipt, blockedByDraft: receipt?.state === 'blocked' && !!receipt.sessionId && chats.drafting(receipt.sessionId) }
          })
        case 'approval-snapshot-v1':
          return answer(raw => {
            requireApprovalHub(approvalHubToken, from.id)
            if (!isObject(raw) || Object.keys(raw).some(k => !['version', 'pcId', 'sessionId'].includes(k)) || raw.version !== 1 || raw.pcId !== self().id || typeof raw.sessionId !== 'string') throw apiError(400, 'Expected a versioned native approval target.')
            return localApprovalSnapshot(raw.sessionId, approvalHubToken)
          })
        case 'approval-commit-v1':
          return answer(raw => { requireApprovalHub(approvalHubToken, from.id); return commitNativeApproval(raw, approvalHubToken) })
        case 'pc-control-capabilities':
          return answer(() => ({ version: 1, pinnedWorkspace: true, actualEngineProof: true, engines: ['claude', 'codex'] }))
        case 'pc-control-runtime':
          return answer(localControlRuntime)
        case 'engine-open-capabilities':
          return answer(() => ({ version: 1, engines: ['claude', 'codex', 'opencode'] }))
        case 'engine-switch-finish':
          return answer(finishSwitchPeer)
        case 'engine-switch-prepare':
          return answer(prepareSwitchPeer)
        case 'stop':
          return answer(async raw => {
            if (!isObject(raw) || typeof raw.sessionId !== 'string') throw apiError(400, 'Expected {sessionId}')
            const current = bySession(raw.sessionId)
            if (current) assertPcControlTarget(current.floor, self().id, {})
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
            if (raw.confirmDelivery === true && raw.messageId !== undefined) {
              if (typeof raw.messageId !== 'string' || !UUID_RE.test(raw.messageId) || typeof raw.owner !== 'string' || raw.owner.length > 256 || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string' || typeof raw.expectedBinding !== 'string' || raw.targetPcId !== self().id) throw apiError(400, 'Expected one pinned delivery intent.')
              const { messageId, owner, floorId, agentId, sessionId, text: body } = raw
              const existing = nativeReceipts.lookup(messageId, owner, floorId, agentId)
              if (existing) {
                const receipt = nativeReceipts.begin({ id: messageId, owner, floorId, agentId, text: body, expectedSessionId: sessionId }, async () => 'blocked')
                return { receipt, blockedByDraft: receipt.state === 'blocked' && chats.drafting(sessionId) }
              }
              const current = bySession(sessionId)
              if (current?.floor.id !== floorId || current.agent.id !== agentId) throw apiError(409, 'The destination conversation changed. Nothing was submitted.')
              assertPcControlTarget(current.floor, self().id, {})
              const actor = isObject(raw.actor) ? raw.actor as unknown as Caller : undefined
              if (raw.humanAuthorization !== undefined && (typeof raw.humanAuthorization !== 'string' || !UUID_RE.test(raw.humanAuthorization))) throw apiError(400, 'Expected one native input authorization.')
              const hub = team!.hub()?.link, generation = chats.generation?.(sessionId)
              const nonce = raw.humanAuthorization
              let sequence = 0
              const authorize = typeof nonce === 'string' ? async (phase: HumanInputPhase) => {
                if (!hub || !generation || team!.hub()?.link?.token !== hub.token || chats.generation?.(sessionId) !== generation) return false
                const next = sequence++
                const proof = await request<unknown>(hub, 'delivery-authorize', { nonce, messageId, sessionId, generation, phase, sequence: next }, 3000).catch(() => null)
                return isObject(proof) && proof.version === 1 && proof.allowed === true && proof.sequence === next && team!.hub()?.link?.token === hub.token && chats.generation?.(sessionId) === generation
              } : undefined
              const receipt = beginNativeDelivery(sessionId, body, owner, messageId, raw.expectedBinding, actor ? () => deliveryAcl(actor, sessionId) : undefined, authorize)
              return nativeReceipts.wait(receipt.id, owner, floorId, agentId, 12_000).then(final => ({ receipt: final, blockedByDraft: final?.state === 'blocked' && chats.drafting(sessionId) }))
            }
            // A caller that is not the person typing (an agent's message, a broadcast, a nudge) asks for the draft check: this PC knows its own screens.
            if (raw.refuseDraft === true && chats.drafting(raw.sessionId)) return 'draft'
            if (raw.confirmDelivery === true) return confirmedDelivery(raw.sessionId, raw.text, raw.refuseDraft === true).then(delivery => ({ delivery }))
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
          // Approval-only legacy RPC retired. Terminal sockets and ordinary MCP type remain unchanged.
          return answer(() => { throw Object.assign(apiError(409, 'Update the Server and target PC for versioned approval commits.'), { code: 'approval-peer-update-required' }) })
        case 'open':
          // F-025: another PC's Run on, for this one: the chat taken over here.
          return answer(raw => {
            if (!isObject(raw) || typeof raw.floorId !== 'string' || typeof raw.agentId !== 'string') throw apiError(400, 'Expected {floorId, agentId}')
            const expected = engineFor(agentOf(floorOf(raw.floorId), raw.agentId))
            if (raw.expectedEngine === undefined && expected !== 'claude') throw engineUpdateRequired(from.name)
            if (raw.expectedEngine !== undefined) requireRunningEngine(expected, raw.expectedEngine as RuntimeEngine)
            const target = floorOf(raw.floorId)
            if (isPcControl(target)) { assertPcControlTarget(target, self().id, {}); if (raw.expectedEngine === undefined) throw pcControlError('pc-control-update-required', 'PC Control requires explicit engine proof.') }
            return openChat(raw.floorId, raw.agentId, isPcControl(target) ? {} : { takeOver: true, here: true }).then(opened => {
              if (opened.started && typeof raw.text === 'string' && raw.text) chats.typeWhenReady(opened.sessionId, raw.text.slice(0, MAX_SAY_TEXT))
              return opened
            })
          })
        case 'pull':
          return servePull(sid => validMirrorSid(sid) ? findTranscript(sid, projectsDir) : null)
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
      if (at && !runtimeSidAllowed(sid)) return false
      return !at || access.rights(caller, at.agent)?.can !== 'view'
    }
    return (ws: WsSocket) => {
      const current = bySession(sid), running = chats.info(sid)
      // F-163: a paused bridge chat whose run lost its admission is still shown (typing() above keeps its keys out).
      if (current && !runtimeSidAllowed(sid) && !ownBridgeSid(sid)) return ws.close(1008, 'This execution has not proved a supported runtime.')
      if (current && isPcControl(current.floor) && running && current.floor.targetPcId !== self().id) return ws.close(1008, 'This runtime is on the wrong PC.')
      if (current && running) {
        try { requireRunningEngine(engineFor(current.agent), running.engine) }
        catch { ws.sendText(JSON.stringify({ t: 'exit', code: null })); return ws.close(1008, 'Saved and running engines disagree; reconcile the conversation first.') }
      }
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
    const expected = bySession(sid)
    const support = expected && isPcControl(expected.floor) ? requirePcControlPeer(link) : expected ? requirePeerEngine(link, expected.agent) : Promise.resolve()
    support.then(() => link.open({ op: 'terminal' })).then(
      s => {
        if (closed) return void s.destroy()
        stream = s
        writeLine(s, { sessionId: sid, ...(expected ? { expectedEngine: engineFor(expected.agent) } : {}) })
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
        const current = bySession(sid), running = chats.info(sid)
        try {
          if (current) requireLegacyExecution(current.agent, defaultsNow())
          if (current && isPcControl(current.floor)) assertPcControlTarget(current.floor, running ? self().id : current.floor.targetPcId, {})
          if (current && raw.expectedEngine !== undefined) requireRunningEngine(engineFor(current.agent), raw.expectedEngine as RuntimeEngine)
          if (current && running) requireRunningEngine(engineFor(current.agent), running.engine)
        } catch { return ended() }
        detach = chats.attach(sid, { send: m => void writeLine(stream, m) })
        if (detach) return
        const w = from && mode() === 'hub' ? whereAll()[sid] : undefined
        const link = w && w.id !== self().id && w.id !== from!.id ? (team?.member(w.id) ?? null) : null
        if (!link) return ended()
        early = []
        const asked = sid
        const expectedEngine = current ? engineFor(current.agent) : undefined
        const support = current && isPcControl(current.floor) ? requirePcControlPeer(link) : current ? requirePeerEngine(link, current.agent) : Promise.resolve()
        support.then(() => link.open({ op: 'terminal' })).then(
          s => {
            if (stream.destroyed) return void s.destroy()
            relay = s
            writeLine(s, { sessionId: asked, ...(expectedEngine ? { expectedEngine } : {}) })
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
        if (!legacySidAllowed(sid)) return ended()
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
      const saved = /^\/saved-views\/(pc|phone)$/.exec(rest)
      if (saved) return (req, res, caller) => {
        if (url.search) throw apiError(400, 'Saved views do not accept selectors')
        return savedViewsRequest(o.auth, req, res, caller, saved[1])
      }
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
          requireLegacyExecution(agentOf(floorOf(decodeURIComponent(up[1])), decodeURIComponent(up[2])), defaultsNow())
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
            { t: 'pc-control', answer: controlRawAnswer() },
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
    crmFiles,
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
    executionRouteKeys: () => executionRoutes.map(([m, p]) => policyKey(m, p)),
    driveRequest: async (body, timeoutMs) => request<unknown>(needHub(), 'drive', body, timeoutMs ?? 30_000),
    serve,
    restartChat,
    restartCodexChats,
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
      executionService?.close()
      messageReceipts.close()
      nativeReceipts.close()
      humanInputGrants.close()
      for (const cancel of threadWatchers.values()) cancel()
      threadWatchers.clear()
      void crmFiles.close()
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
