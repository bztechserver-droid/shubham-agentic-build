import type { ConversationRecord, FloorAgent } from '../../shared/agentic.ts'
import { executionIdentityOf } from './runtime-engine.ts'
import { requireExecutionIdentity, sameExecution } from '../../shared/chat-execution.ts'
import { OPENCODE_SESSION_RE } from '../../shared/opencode.ts'
import { executionHttpError } from '../../shared/chat-execution-http.ts'

type Engine = ConversationRecord['engine']
const id = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-zA-Z-]{8,64}$/.test(v)
const pc = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null

/** Hydrate only persisted server metadata, never content, paths or credentials. */
export function conversationHistory(raw: unknown): ConversationRecord[] {
  if (!Array.isArray(raw)) return []
  const records: ConversationRecord[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const r = value as Partial<ConversationRecord>
    if (Object.hasOwn(r, 'executionProfile') || Object.hasOwn(r, 'executionRevision') || Object.hasOwn(r, 'execution')) {
      const identity = r.execution === undefined ? undefined : requireExecutionIdentity(r.execution)
      if (r.executionProfile === 'opencode-native-v1' && !identity) throw executionHttpError('execution-invalid', 'selection')
      const computed = executionIdentityOf({ ...r, ...(r.engine === 'opencode' && identity ? { opencodeProvider: identity.provider } : {}) })
      if (identity && !sameExecution(identity, computed)) throw executionHttpError('execution-invalid', 'selection')
    }
    if (!['claude', 'codex', 'opencode'].includes(r.engine ?? '') || !id(r.sessionId) || typeof r.recordedAt !== 'string' || !Number.isFinite(Date.parse(r.recordedAt))) continue
    const entry: ConversationRecord = { engine: r.engine!, sessionId: r.sessionId, codexThread: id(r.codexThread) ? r.codexThread : null,
      opencodeSession: id(r.opencodeSession) || (typeof r.opencodeSession === 'string' && OPENCODE_SESSION_RE.test(r.opencodeSession)) ? r.opencodeSession! : null,
      homePc: pc(r.homePc), homePcName: typeof r.homePcName === 'string' ? r.homePcName.slice(0, 80) : null, recordedAt: r.recordedAt,
      ...(id(r.sourceSessionId) ? { sourceSessionId: r.sourceSessionId } : {}),
      ...(r.executionProfile !== undefined ? { executionProfile: r.executionProfile } : {}),
      ...(r.executionRevision !== undefined ? { executionRevision: r.executionRevision } : {}),
      ...(r.execution !== undefined ? { execution: requireExecutionIdentity(r.execution) } : {}) }
    const at = records.findIndex(x => x.sessionId === entry.sessionId && x.engine === entry.engine
      && x.executionProfile === entry.executionProfile && x.executionRevision === entry.executionRevision)
    if (at < 0) records.push(entry)
    else records[at] = entry
  }
  return records
}

/** Upsert a native binding without dropping previous engines, generations or lineage. */
export function rememberConversation(agent: FloorAgent, engine: Engine, sourceSessionId?: string): void {
  if (!agent.sessionId) return
  const history = conversationHistory(agent.conversationHistory)
  const identity = executionIdentityOf(agent)
  const at = history.findIndex(r => r.engine === engine && r.sessionId === agent.sessionId
    && r.executionProfile === agent.executionProfile && r.executionRevision === agent.executionRevision)
  const old = history[at]
  const entry: ConversationRecord = { engine, sessionId: agent.sessionId, codexThread: agent.codexThread ?? null,
    opencodeSession: agent.opencodeSession ?? null, homePc: agent.homePc ?? null, homePcName: agent.homePcName ?? null,
    recordedAt: old?.recordedAt ?? new Date().toISOString(), ...(sourceSessionId || old?.sourceSessionId ? { sourceSessionId: sourceSessionId || old?.sourceSessionId } : {}),
    ...(agent.executionProfile !== undefined ? { executionProfile: agent.executionProfile } : {}),
    ...(agent.executionRevision !== undefined ? { executionRevision: agent.executionRevision } : {}),
    ...(agent.executionProfile !== undefined ? { execution: identity } : {}) }
  if (at < 0) history.push(entry)
  else history[at] = entry
  agent.conversationHistory = history
}
