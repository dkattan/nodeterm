// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { ClaudeSubagentSettingsPanel } from './ClaudeSubagentSettingsPanel'
import { useSettings } from '../../state/settings'
import { useModelGateway } from '../../state/modelGateway'
import { CLAUDE_SUBAGENT_RESTART_EVENT } from '../../terminal/claude-subagent-restart'

vi.mock('../../state/projects', () => ({ useProjects: (select: (state: { activeProjectId: string }) => unknown) => select({ activeProjectId: 'project' }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const save = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  save.mockReset().mockResolvedValue(undefined)
  window.nodeTerminal = { settings: { save } } as never
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true })
  useModelGateway.setState({ models: [
    { id: 'provider/compact-model', contextWindow: 131_072 },
    { id: 'provider/long-model', contextWindow: 400_000 }
  ] })
  host = document.createElement('div')
  root = createRoot(host)
  act(() => root.render(<ClaudeSubagentSettingsPanel />))
})
afterEach(async () => {
  act(() => root.unmount())
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})
function select(label: string, value: string): void {
  act(() => {
    const control = host.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement
    control.value = value
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const restart = (): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Restart idle'))!

describe('Claude subagent settings', () => {
  it('defaults to parent and saves an explicit model and force preference', async () => {
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('parent')
    select('Claude subagent model policy', 'model')
    expect(host.textContent).toContain('131,072 tokens')
    expect(host.textContent).toContain('400,000 tokens')
    select('Claude subagent model', 'provider/long-model')
    act(() => (host.querySelector('[role="switch"]') as HTMLButtonElement).click())
    await vi.runAllTimersAsync()
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      claudeSubagents: { mode: 'model', model: 'provider/long-model', force: false }
    }))
    select('Claude subagent model policy', 'claude')
    expect(host.querySelector('[aria-label="Claude subagent model"]')).toBeNull()
    expect(host.querySelector('[role="switch"]')).toBeNull()
  })

  it('awaits persistence before requesting a confirmed restart', async () => {
    select('Claude subagent model policy', 'claude')
    let complete!: () => void
    save.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve }))
    const listener = vi.fn()
    window.addEventListener(CLAUDE_SUBAGENT_RESTART_EVENT, listener)
    try {
      await act(async () => restart().click())
      expect(listener).not.toHaveBeenCalled()
      expect(restart().disabled).toBe(true)
      await act(async () => complete())
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener.mock.calls[0][0].detail).toEqual({ projectId: 'project' })
    } finally { window.removeEventListener(CLAUDE_SUBAGENT_RESTART_EVENT, listener) }
  })

  it('does not request a restart if saving fails', async () => {
    save.mockRejectedValueOnce(new Error('disk full'))
    const listener = vi.fn()
    window.addEventListener(CLAUDE_SUBAGENT_RESTART_EVENT, listener)
    try {
      await act(async () => restart().click())
      expect(listener).not.toHaveBeenCalled()
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('No sessions were restarted')
    } finally { window.removeEventListener(CLAUDE_SUBAGENT_RESTART_EVENT, listener) }
  })

  it('retains a saved route when discovery is unavailable without substituting another model', () => {
    act(() => {
      useSettings.getState().update({ claudeSubagents: { mode: 'model', model: 'saved-route', force: true } })
      useModelGateway.setState({ models: [] })
    })
    expect((host.querySelector('[aria-label="Claude subagent model"]') as HTMLSelectElement).value).toBe('saved-route')
    expect(host.textContent).toContain('not in current catalogue')
  })
})
