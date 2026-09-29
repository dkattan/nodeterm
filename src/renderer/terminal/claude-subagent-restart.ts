import { capabilityAgentId } from '@shared/agents/config'
import { agentRestartFn, restartEligibility, settleRestart, type RestartOutcome } from './agent-restart'

export const CLAUDE_SUBAGENT_RESTART_EVENT = 'nodeterm:restart-idle-claude-subagents'

export interface ClaudeSubagentRestartCandidate {
  agentId?: string
  state?: string
  sessionId?: string
  backgroundTask: boolean
  liveSubagents: boolean
  recurring: boolean
  subscription: boolean
}

export function canRestartForClaudeSubagents(c: ClaudeSubagentRestartCandidate | undefined): boolean {
  return !!c?.agentId && capabilityAgentId(c.agentId) === 'claude' && c.state === 'done' &&
    !c.backgroundTask && !c.liveSubagents && !c.recurring && !c.subscription &&
    restartEligibility(c.agentId, c.state, c.sessionId).ok
}

/** Re-read each candidate after earlier restarts and again just before termination. */
export async function restartForClaudeSubagents(
  ids: readonly string[],
  read: (id: string) => ClaudeSubagentRestartCandidate | undefined,
  restart = agentRestartFn
): Promise<RestartOutcome[]> {
  const outcomes: RestartOutcome[] = []
  for (const id of ids) {
    const allowed = (): boolean => canRestartForClaudeSubagents(read(id))
    const fn = restart(id)
    outcomes.push(allowed() && fn
      ? await settleRestart(() => fn(undefined, undefined, true, false, allowed))
      : 'not-eligible')
  }
  return outcomes
}
