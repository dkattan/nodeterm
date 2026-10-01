import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentStatusSession } from '../state/agentStatus'
import { buildStatusList, type ProjectInput } from './sessionList'

const projects: ProjectInput[] = [{
  id: 'project', name: 'Project', color: '#888',
  nodes: ['older', 'newer', 'no-history'].map((id) => ({
    id, kind: 'terminal', title: id, color: '#888', agentId: 'claude'
  }))
}]

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('status sections after reopening and reading sessions', () => {
  it('keeps Unknown newest first across reload and unread acknowledgement', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { store } = createAgentStatusSession('status-order')
    store.getState().setState('older', 'working', 'claude')
    clock.mockReturnValue(2_000)
    store.getState().setState('newer', 'working', 'claude')
    store.getState().markUnread('newer')

    const restored = createAgentStatusSession('status-order').store
    const sections = () => buildStatusList(projects, null, 'project', restored.getState().byId, '')
    const unknown = () => sections().find((s) => s.kind === 'unknown')!.rows

    expect(sections().map((s) => s.label)).not.toContain('Unread')
    expect(unknown().map((r) => r.id)).toEqual(['newer', 'older', 'no-history'])
    expect(unknown().map((r) => r.statusUpdatedAt)).toEqual([2_000, 1_000, undefined])
    expect(restored.getState().byId.newer.state).toBeUndefined()
    expect(restored.getState().byId.newer.lastEventAt).toBeUndefined()
    expect(restored.getState().byId.newer.stateAt).toBeUndefined()

    clock.mockReturnValue(9_000)
    restored.getState().clearUnread('newer')
    expect(unknown().map((r) => r.id)).toEqual(['newer', 'older', 'no-history'])
    expect(unknown()[0].statusUpdatedAt).toBe(2_000)
  })

  it('uses the last agent update when stale working status becomes Unknown', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { store } = createAgentStatusSession('status-stale')
    store.getState().setState('older', 'working', 'claude')
    clock.mockReturnValue(3_000)
    store.getState().setState('older', 'working', 'claude')
    clock.mockReturnValue(4_000)
    store.getState().setState('newer', 'working', 'claude')
    clock.mockReturnValue(20_000)
    store.getState().sweepStaleWorking(5_000)

    const restored = createAgentStatusSession('status-stale').store
    const unknown = buildStatusList(projects, null, 'project', restored.getState().byId, '')
      .find((s) => s.kind === 'unknown')!.rows
    expect(unknown.map((r) => [r.id, r.statusUpdatedAt])).toEqual([
      ['newer', 4_000], ['older', 3_000], ['no-history', undefined]
    ])
  })
})

describe('historical display remains separate from live lifecycle state', () => {
  it('a restored hook clock is a "seen" label in Unknown, never live history or identity', () => {
    // Upstream #1060's reviewed model: a bare hook transition writes ONLY the debounced clock
    // key, and a restored clock asserts nothing about the live state — the row stays Unknown,
    // labeled "Last hook event … before nodeterm restarted". The main-table history
    // (lastKnownState/lastUpdateAt) comes from observeHistory, not from hook events.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { store } = createAgentStatusSession('historical')
    // Bare hook transitions never write the main table (upstream #1060): history persists only
    // through observeHistory — which itself refuses to replace a live state, so the session
    // boundary (the CLI exiting, state → undefined) comes first, exactly as in real usage.
    store.getState().setState('older', 'done', 'claude', false, undefined, true)
    store.getState().setState('older', undefined, 'claude')
    // Strictly newer than the transition stamp, or the history observation reads as stale —
    // and not in the mocked future, or the freshness guard refuses it.
    clock.mockReturnValue(2_000)
    store.getState().observeHistory({ older: { state: 'done', updatedAt: 1_200 } })
    const restored = createAgentStatusSession('historical').store
    const restoredEntry = restored.getState().byId.older
    expect(restoredEntry).toMatchObject({ lastKnownState: 'done', lastUpdateAt: 1_200 })
    for (const key of ['state', 'stateAt', 'stateVerified', 'lastEventAt', 'pendingId'])
      expect(restoredEntry).not.toHaveProperty(key)
    const rows = buildStatusList(projects, null, 'project', restored.getState().byId, '')
      .find((s) => s.kind === 'idle')!.rows
    expect(rows.map((r) => r.id)).toContain('older')
    expect(rows.find((r) => r.id === 'older')!.historicalStateLabel).toBe('Last seen Idle')
  })

  it('does not let a delayed snapshot overwrite a newer hook or session reset', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const { store } = createAgentStatusSession('race')
    store.getState().setState('older', 'working', 'claude')
    store.getState().observeHistory({ older: { state: 'done', updatedAt: 1_000 } })
    expect(store.getState().byId.older.lastKnownState).toBe('working')
    clock.mockReturnValue(3_000)
    store.getState().setState('older', undefined, 'claude')
    store.getState().observeHistory({ older: { state: 'done', updatedAt: 2_500 } })
    expect(store.getState().byId.older.lastKnownState).toBeUndefined()
  })

  it('clears historical state when a resumed session starts before its first turn', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000)
    const { store } = createAgentStatusSession('resume')
    store.getState().observeHistory({ older: { state: 'blocked', updatedAt: 1_000 } })
    store.getState().setState('older', undefined, 'claude')
    const restored = createAgentStatusSession('resume').store
    expect(restored.getState().byId.older.lastKnownState).toBeUndefined()
  })
  it('uses a recovered completion newer than the last real update, even after a stale sweep', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { store } = createAgentStatusSession('stale-recovery')
    store.getState().setState('older', 'working', 'claude')
    clock.mockReturnValue(20_000)
    store.getState().sweepStaleWorking(5_000)
    store.getState().observeHistory({ older: { state: 'done', updatedAt: 2_000 } })
    expect(store.getState().byId.older).toMatchObject({ lastKnownState: 'done', lastUpdateAt: 2_000 })
    expect(store.getState().byId.older.state).toBeUndefined()
    expect(store.getState().byId.older.lastEventAt).toBe(20_000) // recovery never renews this clock
  })

  it('ignores future or invalid persisted timestamps and their historical state', () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000)
    localStorage.setItem('invalid-history', JSON.stringify({
      future: { lastKnownState: 'done', lastUpdateAt: 3_001 },
      invalid: { lastKnownState: 'done', lastUpdateAt: '2_000' }
    }))
    const { store } = createAgentStatusSession('invalid-history')
    for (const entry of Object.values(store.getState().byId)) {
      expect(entry.lastUpdateAt).toBeUndefined()
      expect(entry.lastKnownState).toBeUndefined()
    }
  })

})
