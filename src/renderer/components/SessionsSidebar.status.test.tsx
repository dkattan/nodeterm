// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionsSidebar, type SessionsSidebarProps } from './SessionsSidebar'
import { useAgentStatus } from '../state/agentStatus'

const fixtures = vi.hoisted(() => ({
  projects: [
    { id: 'p1', name: 'First project', color: '#888', nodes: [
      { id: 'delta', kind: 'terminal', title: 'Delta', color: '#888', agentId: 'claude', parentId: 'frame' },
      { id: 'bravo', kind: 'terminal', title: 'Bravo', color: '#888', agentId: 'claude' },
      { id: 'frame', kind: 'group', title: 'Canvas frame', color: '#888' }
    ] },
    { id: 'p2', name: 'Second project', color: '#888', nodes: [
      { id: 'charlie', kind: 'terminal', title: 'Charlie', color: '#888', agentId: 'claude' },
      { id: 'alpha', kind: 'terminal', title: 'Alpha', color: '#888', agentId: 'claude' }
    ] }
  ],
  history: vi.fn().mockResolvedValue({})
}))
vi.mock('../state/projects', () => ({
  useProjects: (select: (s: unknown) => unknown) => select({ projects: fixtures.projects, activeProjectId: 'p1' })
}))
vi.mock('../state/settings', () => ({
  useSettings: (select: (s: unknown) => unknown) => select({ settings: {
    sidebarGrouping: 'status', sidebarCollapsedItems: {}, sidebarAutoCollapse: true
  }, update: vi.fn() })
}))
vi.mock('../state/sessionNaming', () => ({ useSessionNaming: () => ({}) }))
vi.mock('../session/session', () => ({ useSession: () => ({ api }) }))
vi.mock('./ClosedHistorySection', () => ({ ClosedHistorySection: () => null }))
vi.mock('./SessionRow', () => ({ SessionRow: ({ row, onClick }: {
  row: { id: string; title: string }; onClick(): void
}) => <button data-session={row.id} onClick={onClick}>{row.title}</button> }))
const api = { readAgentStatusHistory: fixtures.history }

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const noop = () => {}
const props: SessionsSidebarProps = {
  open: true, pinned: true, liveActiveNodes: null,
  onTogglePin: noop, onClose: noop, onFocusNode: (id) => useAgentStatus.getState().clearUnread(id),
  onCloseSession: noop, onRenameSession: noop, onAiNameSession: noop, onRowContextMenu: noop,
  onProjectContextMenu: noop, onSwitchProject: noop, onAddToProject: noop, onMoveToGroup: noop,
  onAiNameGroup: noop, onReorder: noop, onReorderGroup: noop, onReorderProject: noop,
  onReopenProject: noop, onDeleteProject: noop, onReopenClosedSession: noop,
  onDiscardClosedSession: noop, onOpenClosedTranscript: noop
}
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  useAgentStatus.setState({ byId: {}, activeId: null })
  fixtures.history.mockResolvedValue({})
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks() })
const rows = () => [...host.querySelectorAll('[data-session]')].map((r) => r.getAttribute('data-session'))
const render = async () => { await act(async () => root.render(<SessionsSidebar {...props} />)) }

describe('Status tab renders one global order', () => {
  it.each([undefined, 1_000])('does not group projects or frames when update timestamps are %s', async (at) => {
    useAgentStatus.setState({ byId: Object.fromEntries(['delta', 'bravo', 'charlie', 'alpha']
      .map((id) => [id, { unread: false, lastUpdateAt: at }])) })
    await render()
    expect(rows()).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    expect(host.querySelectorAll('.ss-group__head, .ss-subgroup__head')).toHaveLength(0)
    expect([...host.querySelectorAll('.ss-status__label')].map((e) => e.textContent))
      .toEqual(['Need attention', 'Running', 'Idle', 'Unknown'])
  })

  it('keeps the newest Unknown row in place when it is read across projects', async () => {
    useAgentStatus.setState({ byId: {
      alpha: { unread: true, lastUpdateAt: 4_000 }, delta: { unread: false, lastUpdateAt: 3_000 },
      charlie: { unread: false, lastUpdateAt: 2_000 }, bravo: { unread: false, lastUpdateAt: 1_000 }
    } })
    await render()
    expect(rows()).toEqual(['alpha', 'delta', 'charlie', 'bravo'])
    act(() => (host.querySelector('[data-session="alpha"]') as HTMLButtonElement).click())
    expect(useAgentStatus.getState().byId.alpha.unread).toBe(false)
    expect(rows()).toEqual(['alpha', 'delta', 'charlie', 'bravo'])
    expect(host.textContent).not.toContain('Unread')
  })

  it('recovers a missed completion as display history without replaying a live hook', async () => {
    fixtures.history.mockResolvedValue({ delta: { state: 'done', updatedAt: 2_000 } })
    await render()
    const idle = [...host.querySelectorAll('.ss-status')]
      .find((s) => s.querySelector('.ss-status__label')?.textContent === 'Idle')!
    expect(idle.querySelector('[data-session="delta"]')).toBeTruthy()
    expect(useAgentStatus.getState().byId.delta).toEqual({ unread: false, lastKnownState: 'done', lastUpdateAt: 2_000 })
  })
})
