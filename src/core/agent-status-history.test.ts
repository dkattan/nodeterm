import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetForTest, agentStatusHistory, EXPIRE_MS, onNodeStateChange, recordAgentEvent } from './agent-status-mirror'

afterEach(() => { _resetForTest(); vi.restoreAllMocks() })

describe('agent status display history', () => {
  it('returns only state and its original age, without replaying events or granting identity', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    recordAgentEvent({ nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'blocked',
      sessionId: 'conversation', verified: true, pendingId: 'approval', lastMessage: 'private text' })
    const listener = vi.fn()
    onNodeStateChange(listener)
    expect(agentStatusHistory(2_000)).toEqual({ n1: { state: 'blocked', updatedAt: 1_000 } })
    expect(listener).not.toHaveBeenCalled()
    expect(agentStatusHistory(EXPIRE_MS + 1_001)).toEqual({})
  })
})
