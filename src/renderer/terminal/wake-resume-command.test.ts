import { describe, expect, it } from 'vitest'
import { parseGatewayModels } from '@shared/agents/model-gateway'
import { assembleWakeResumeCommand } from './agent-restart'

describe('Claude model selection when waking an existing shell', () => {
  it.each([400_000, 1_000_000])('resumes the selected %i-token model with [1m]', (contextWindow) => {
    const models = parseGatewayModels({
      data: [{ id: 'provider/long-model', context_length: contextWindow }]
    })
    const { command } = assembleWakeResumeCommand({
      agentId: 'claude',
      sessionId: 'saved-session',
      model: 'provider/long-model',
      models
    }, {})

    expect(command).toBe("claude --resume saved-session --model 'provider/long-model[1m]'")
  })

  it('preserves a recorded [1m] model while discovery is unavailable', () => {
    expect(assembleWakeResumeCommand({
      agentId: 'claude',
      sessionId: 'saved-session',
      model: 'provider/long-model[1m]',
      models: []
    }, {}).command).toBe("claude --resume saved-session --model 'provider/long-model[1m]'")
  })

  it('keeps the selected small-context model without adding [1m]', () => {
    expect(assembleWakeResumeCommand({
      agentId: 'claude',
      sessionId: 'saved-session',
      model: 'provider/compact-model',
      models: [{ id: 'provider/compact-model', contextWindow: 131_072 }]
    }, {}).command).toBe("claude --resume saved-session --model 'provider/compact-model'")
  })

  it('retains the agent default when the node has no selected model', () => {
    expect(assembleWakeResumeCommand({
      agentId: 'claude',
      sessionId: 'saved-session',
      model: undefined
    }, {}).command).toBe('claude --resume saved-session')
  })

  it('keeps Codex on its selected model and the existing shell path', () => {
    expect(assembleWakeResumeCommand({
      agentId: 'codex',
      sessionId: 'saved-session',
      model: 'provider/long-model',
      models: [{ id: 'provider/long-model', contextWindow: 400_000 }]
    }, {}).command).toBe("codex resume saved-session --model 'provider/long-model'")
  })
})
