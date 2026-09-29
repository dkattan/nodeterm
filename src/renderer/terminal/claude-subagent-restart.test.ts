import { describe, expect, it, vi } from 'vitest'
import { canRestartForClaudeSubagents, restartForClaudeSubagents, type ClaudeSubagentRestartCandidate } from './claude-subagent-restart'
import type { AgentRestartFn } from './agent-restart'

const idle: ClaudeSubagentRestartCandidate = {
  agentId: 'claude', state: 'done', sessionId: 'session', backgroundTask: false,
  liveSubagents: false, recurring: false, subscription: false
}

describe('applying Claude subagent settings to existing sessions', () => {
  it.each([
    { state: 'working' }, { state: 'waiting' }, { state: 'blocked' }, { state: undefined },
    { backgroundTask: true }, { liveSubagents: true }, { recurring: true },
    { subscription: true }, { sessionId: undefined }, { agentId: 'codex' }
  ])('skips non-idle or unaffected sessions: %j', (patch) => {
    expect(canRestartForClaudeSubagents({ ...idle, ...patch })).toBe(false)
  })

  it('recycles the shell, retaining the parent model and conversation', async () => {
    const fn = vi.fn<AgentRestartFn>().mockResolvedValue('restarted')
    expect(await restartForClaudeSubagents(['one'], () => idle, () => fn)).toEqual(['restarted'])
    expect(fn).toHaveBeenCalledWith(undefined, undefined, true, false, expect.any(Function))
  })

  it('rechecks a later session after the preceding restart and before termination', async () => {
    const state: Record<string, ClaudeSubagentRestartCandidate> = { one: { ...idle }, two: { ...idle } }
    const first = vi.fn<AgentRestartFn>().mockImplementation(async (_agent, _model, _shell, _clear, guard) => {
      state.one.liveSubagents = true
      state.two.state = 'working'
      // The node invokes this again after awaiting its pane probe, just before termination.
      return guard!() ? 'restarted' : 'not-eligible'
    })
    const second = vi.fn<AgentRestartFn>()
    const result = await restartForClaudeSubagents(['one', 'two'], (id) => state[id], (id) => id === 'one' ? first : second)
    expect(result).toEqual(['not-eligible', 'not-eligible'])
    expect(second).not.toHaveBeenCalled()
  })

  it('skips removed/unmounted nodes and continues after a failed restart', async () => {
    const fail = vi.fn<AgentRestartFn>().mockRejectedValue(new Error('transport closed'))
    const next = vi.fn<AgentRestartFn>().mockResolvedValue('restarted')
    expect(await restartForClaudeSubagents(['gone', 'unmounted', 'fail', 'next'],
      (id) => id === 'gone' ? undefined : idle,
      (id) => id === 'unmounted' ? undefined : id === 'fail' ? fail : next
    )).toEqual(['not-eligible', 'not-eligible', 'exit-timeout', 'restarted'])
  })
})
