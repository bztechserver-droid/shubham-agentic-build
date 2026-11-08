// Persistent, server-managed PC conversations; separate from workflow floors.
import type { ChatOpened, ChatState, Floor, FloorAgent } from './agentic.ts'

export type PcControlEngine = 'claude' | 'codex'
export type PcControlSlotNumber = 1 | 2

/** Persisted by the server, never accepted from a floor/agent PATCH. Missing = workflow. */
export interface PcControlFloorMarker {
  workspace: 'pc-control'
  targetPcId: string
}
export interface PcControlAgentMarker { pcControlSlot: PcControlSlotNumber }

export interface PcControlCapability {
  version: 1
  pinnedWorkspace: true
  actualEngineProof: true
  engines: PcControlEngine[]
}
export interface PcControlDevice {
  id: string
  name: string
  online: boolean
  /** Null/absent proof never permits a pinned native start, including Claude. */
  capability: PcControlCapability | null
  unavailable: 'offline' | 'update-required' | 'forbidden' | null
}
export interface PcControlSlot {
  number: PcControlSlotNumber
  /** Null for a slot the viewing person cannot access; no hidden conversation metadata. */
  agentId: string | null
  agent: FloorAgent | null
  runtime: { engine: PcControlEngine; startedAt: string; state: ChatState } | null
  canOpen: boolean
  canChangeEngine: boolean
}
export interface PcControlWorkspace {
  device: PcControlDevice
  /** Stable floor ID. Name follows registered device name; agents are ACL-filtered. */
  floor: Floor
  /** Opaque server snapshot token covering device pin + complete server-owned floor. */
  revision: string
  /** Exactly two descriptors; restricted slots have null agent/agentId. */
  slots: [PcControlSlot, PcControlSlot]
}
export interface PcControlAnswer { workspaces: PcControlWorkspace[] }
export interface PcControlExpected {
  revision: string
  engine: PcControlEngine
  sessionId: string | null
  codexThread: string | null
  /** Kept explicit so a stale/unsupported binding cannot masquerade as Claude/Codex. */
  opencodeSession: null
}
export interface PcControlOpenRequest { expected: PcControlExpected }
export interface PcControlStopRequest { expected: PcControlExpected }
export interface PcControlEngineRequest {
  expected: PcControlExpected
  engine: PcControlEngine
  /** Second attempt only, after the ordinary carry-over confirmation response. */
  confirmNewConversation?: true
}
export interface PcControlOpenAnswer {
  workspace: PcControlWorkspace
  opened: ChatOpened & { engine: PcControlEngine }
}
export interface PcControlMutationAnswer { workspace: PcControlWorkspace }

export type PcControlErrorCode =
  | 'pc-control-forbidden'
  | 'pc-control-immutable'
  | 'pc-control-wrong-device'
  | 'pc-control-offline'
  | 'pc-control-update-required'
  | 'pc-control-stale'
  | 'engine-runtime-mismatch'
  | 'engine-change-new-conversation'
  | 'engine-change-conversion-failed'
  | 'engine-change-stale'
  | 'engine-change-home-offline'

/**
 * Chat endpoints (under the existing authenticated agentic mount):
 * GET  /agent-api/agentic/pc-control
 * GET  /agent-api/agentic/pc-control/pcs/:deviceId
 * POST /agent-api/agentic/pc-control/pcs/:deviceId/slots/:agentId/open
 * POST /agent-api/agentic/pc-control/pcs/:deviceId/slots/:agentId/stop
 * POST /agent-api/agentic/pc-control/pcs/:deviceId/slots/:agentId/engine
 *
 * Every POST rejects unknown fields, including here/takeOver/pc/agents/sessionId outside
 * expected. Engine route derives the full two-agent array on server, uses existing native
 * conversion/fencing/CAS, and returns updated workspace before UI opens a carried binding.
 * Same-engine requests return the unchanged workspace without PATCH/conversion. Opening
 * always pins by stable deviceId; no offline StartHere/takeover/home fallback is accepted.
 *
 * Live refresh: AgenticEvent {t:'pc-control', answer:PcControlAnswer}, scoped per viewer.
 * Workflow GET /floors and its floors event exclude control floors; internal allFloors,
 * bySession and authorized messaging/feeds/attachments still resolve them. UI keeps this
 * answer separate and uses these engine endpoints rather than useEngineChange/getCurrentFloor.
 *
 * Connection owns shared/pc-build.ts and separate build/status/update service/mount:
 * /agent-api/pc-control/pcs/:deviceId/build[/check|/update/prepare|/update]. No overlap.
 */
