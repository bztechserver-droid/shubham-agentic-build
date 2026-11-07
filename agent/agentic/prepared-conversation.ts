import type { FloorAgent } from '../../shared/agentic.ts'
import { OPENCODE_SESSION_RE } from '../../shared/opencode.ts'
import { apiError } from '../api.ts'

export type ConversationBinding = Pick<FloorAgent, 'sessionId' | 'codexThread' | 'opencodeSession' | 'homePc' | 'homePcName'>
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/** Validate trusted-peer correctness as strictly as local converter output; never trust truthy native pointers. */
export function validatePreparedConversation(raw: unknown, to: 'claude' | 'codex' | 'opencode', source: FloorAgent, pc: string, agents: FloorAgent[], pending: ConversationBinding[]): ConversationBinding {
  const fail = (): never => { throw Object.assign(apiError(409, 'Prepared conversation is invalid or aliases an existing session. The original remains selected.'), { code: 'engine-change-conversion-failed' }) }
  if (!raw || typeof raw !== 'object') return fail()
  const r = raw as ConversationBinding
  if (!uuid(r.sessionId) || r.sessionId === source.sessionId || r.homePc !== pc || typeof r.homePcName !== 'string' || !r.homePcName.trim() || r.homePcName.length > 80) return fail()
  if (to === 'codex' ? !uuid(r.codexThread) || r.opencodeSession != null : to === 'opencode' ? typeof r.opencodeSession !== 'string' || !OPENCODE_SESSION_RE.test(r.opencodeSession) || r.codexThread != null : r.codexThread != null || r.opencodeSession != null) return fail()
  const existing = [...agents.flatMap(a => [a, ...(a.conversationHistory ?? [])]), ...pending]
  if (existing.some(a => a.sessionId === r.sessionId || (r.codexThread && a.codexThread === r.codexThread) || (r.opencodeSession && a.opencodeSession === r.opencodeSession))) return fail()
  return { sessionId: r.sessionId, codexThread: r.codexThread ?? null, opencodeSession: r.opencodeSession ?? null, homePc: r.homePc, homePcName: r.homePcName }
}
