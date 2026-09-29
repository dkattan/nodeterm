import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseGatewayModels } from '@shared/agents/model-gateway'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useModelGateway } from './modelGateway'
import { useSettings } from './settings'
import { createAgentNode } from './workspace'

const originalSettings = useSettings.getState()
const originalGateway = useModelGateway.getState()

beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

afterEach(() => {
  useSettings.setState(originalSettings)
  useModelGateway.setState(originalGateway)
})

describe('Bifrost discovery through Claude node creation', () => {
  it.each([
    { metadata: { context_length: 400_000 }, window: 400_000 },
    { metadata: { context_window: 400_000 }, window: 400_000 },
    { metadata: { context_length: 1_000_000 }, window: 1_000_000 }
  ])('preserves the model suffix for $window-token Bifrost metadata $metadata', ({ metadata, window }) => {
    const models = parseGatewayModels({ data: [{ id: 'provider/long-model', ...metadata }] })
    useModelGateway.setState({ models, status: 'ready', error: '' })

    const node = createAgentNode(
      'claude', 0, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, 'provider/long-model'
    )

    expect(node.data.initialCommand).toContain("--model 'provider/long-model[1m]'")
    expect(node.data.agentModel).toBe('provider/long-model')
    expect(node.data.agentLaunchModel).toBe('provider/long-model[1m]')
    expect(node.data.agentLaunchContextWindow).toBe(window)
  })
})
