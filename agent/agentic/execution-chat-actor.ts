import { executionHttpError } from '../../shared/chat-execution-http.ts'
import type { FloorAgent } from '../../shared/agentic.ts'
import type { Access } from './access.ts'
import type { FloorStore } from './floors.ts'
import type { ExecutionIntentScope } from './execution-intents.ts'

/** A target run outlives the launching conversation's SID (conversion changes it).
 * Resolve the same source slot and its current owner/rights on every dispatch instead.
 * Target owner/home/CAS and manager/native proof remain fenced by the execution service.
 */
export function chatExecutionActor(
  source: { floorId: string; agentId: string },
  scope: ExecutionIntentScope,
  ports: {
    floors: Pick<FloorStore, 'get'>
    access: Pick<Access, 'asChat' | 'needChat'>
    target(floorId: string, agentId: string): FloorAgent
  },
): () => void {
  const { floorId: sourceFloorId, agentId: sourceAgentId } = source
  const { actorId, floorId, agentId } = scope
  return () => {
    const agent = ports.floors.get(sourceFloorId)?.agents.find(a => a.id === sourceAgentId)
    const caller = agent?.sessionId ? ports.access.asChat(agent) : null
    if (!caller?.person || caller.person.id !== actorId) throw executionHttpError('execution-forbidden', 'authorization')
    ports.access.needChat(caller, ports.target(floorId, agentId), 'owner', 'tool app_open_chat')
  }
}
