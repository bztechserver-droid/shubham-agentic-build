import { CODEX_IN_CLAUDE_PROFILE, requireExecutionSnapshot } from '../../shared/chat-execution.ts'
import type { ChatInfo } from './chats.ts'

/**
 * F-163 (10 Nov): Stop, and the screen, for a Codex in Claude Code chat this PC's pool holds, also when its run
 * has lost its admission. A failed process check (a PowerShell query that timed out under load, say) pauses the
 * run AND drops its admission until a new full proof, and a paused run never gets one. Lead's chat was then
 * neither shown (a blank terminal) nor stopped (Stop answered {killed:false}); it could only be ended by hand.
 *
 * True only for the chat the pool itself started, or took over, for this agent's own session as a bridge chat:
 * its recorded snapshot names this agent and this session, with a bridge run. It allows ending that process
 * and reading what it printed. Typing, keys, resizing and message delivery still need the admitted run, and
 * the bridge still proves that the run's recorded processes ended before it releases anything.
 */
export function ownBridgeChat(agent: { readonly id: string; readonly sessionId?: string | null } | null | undefined,
  info: Pick<ChatInfo, 'sessionId' | 'agentId' | 'execution' | 'bridgeRunId'> | null | undefined): boolean {
  try {
    if (!agent?.sessionId || !info || info.sessionId !== agent.sessionId || info.agentId !== agent.id) return false
    if (typeof info.bridgeRunId !== 'string' || !info.bridgeRunId) return false
    const snapshot = requireExecutionSnapshot(info.execution)
    return snapshot.execution.profile === CODEX_IN_CLAUDE_PROFILE && snapshot.agentId === agent.id && snapshot.sessionId === agent.sessionId
  } catch { return false }
}
