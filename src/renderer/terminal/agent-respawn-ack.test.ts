import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAgentRespawnAckForTests,
  agentRespawnPending,
  beginAgentRespawn,
  reportAgentRespawn
} from './agent-respawn-ack'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  __resetAgentRespawnAckForTests()
  vi.useRealTimers()
})

describe('agent respawn acknowledgements', () => {
  it('resolves only from the replacement lifecycle', async () => {
    const ticket = beginAgentRespawn('node-1')
    expect(agentRespawnPending('node-1')).toBe(true)
    expect(reportAgentRespawn('node-1', ticket.generation, { ok: true })).toBe(true)
    await expect(ticket.promise).resolves.toEqual({ ok: true })
    expect(agentRespawnPending('node-1')).toBe(false)
  })

  it('keeps a failed replacement actionable', async () => {
    const ticket = beginAgentRespawn('node-1')
    reportAgentRespawn('node-1', ticket.generation, {
      ok: false,
      reason: 'agent-not-running',
      detail: 'replacement failed'
    })
    await expect(ticket.promise).resolves.toEqual({
      ok: false,
      reason: 'agent-not-running',
      detail: 'replacement failed'
    })
  })

  it('times out a lifecycle that never reports', async () => {
    const ticket = beginAgentRespawn('node-1', 25)
    await vi.advanceTimersByTimeAsync(25)
    await expect(ticket.promise).resolves.toEqual({
      ok: false,
      detail: 'the replacement terminal did not become ready in time'
    })
  })

  it('ignores a late acknowledgement from an older lifecycle', async () => {
    const old = beginAgentRespawn('node-1')
    old.cancel('old attempt ended')
    const current = beginAgentRespawn('node-1')
    expect(reportAgentRespawn('node-1', old.generation, { ok: true })).toBe(false)
    expect(agentRespawnPending('node-1', current.generation)).toBe(true)
    reportAgentRespawn('node-1', current.generation, { ok: true })
    await expect(current.promise).resolves.toEqual({ ok: true })
  })
})
