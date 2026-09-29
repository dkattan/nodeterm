import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cachedWindowFor,
  sessionContextWindow,
  setGatewayModelWindowSource,
  staticWindowFor
} from './model-window'

describe('sessionContextWindow', () => {
  it('accepts the session override without rounding to a model family window', () => {
    expect(sessionContextWindow('1048576')).toBe(1_048_576)
    expect(sessionContextWindow('32768')).toBe(32_768)
  })
  it.each(['', '0', '-1', '1.5', '1e6', '200000junk', 'Infinity', 'NaN', '9007199254740992', ' 32000', undefined, null, 32000])('rejects invalid value %s', value => {
    expect(sessionContextWindow(value)).toBeNull()
  })
})

describe('model-window — current discovered-window authority', () => {
  let models: Array<{ id: string; contextWindow?: number }>

  beforeEach(() => {
    models = []
    setGatewayModelWindowSource(() => models)
  })

  afterEach(() => setGatewayModelWindowSource(null))

  it('prefers a current discovered window over the unknown-family guess', () => {
    models = [{ id: 'provider/long-model', contextWindow: 400_000 }]
    expect(cachedWindowFor('provider/long-model')).toBe(400_000)
  })

  it('matches an omitted provider prefix and normalizes [1m] on both sides', () => {
    models = [{ id: 'provider/previous-model[1m]', contextWindow: 400_000 }]
    expect(cachedWindowFor('previous-model')).toBe(400_000)
    expect(cachedWindowFor('provider/previous-model[1m]')).toBe(400_000)
  })

  it.each(['provider/arbitrary', 'claude-sonnet-test', 'provider/haiku-test', 'provider/arbitrary[1m]'])(
    'uses discovered limits for %s regardless of model name or the native default', (id) => {
      for (const contextWindow of [147_456, 384_000, 768_000]) {
        models = [{ id, contextWindow }]
        expect(cachedWindowFor(id)).toBe(contextWindow)
      }
    }
  )

  it('never takes another provider’s window or chooses an ambiguous short name by list order', () => {
    const catalogue = [
      { id: 'provider-a/shared-name', contextWindow: 147_456 },
      { id: 'provider-b/shared-name', contextWindow: 384_000 }
    ]
    for (const order of [catalogue, [...catalogue].reverse()]) {
      models = order
      expect(cachedWindowFor('provider-a/shared-name')).toBe(147_456)
      expect(cachedWindowFor('provider-b/shared-name')).toBe(384_000)
      expect(cachedWindowFor('provider-c/shared-name')).toBe(200_000)
      expect(cachedWindowFor('shared-name')).toBe(200_000)
    }
  })

  it('falls back immediately when the live provider changes scope or delists the id', () => {
    models = [{ id: 'provider/custom', contextWindow: 333_000 }]
    expect(cachedWindowFor('provider/custom')).toBe(333_000)
    models = []
    expect(cachedWindowFor('provider/custom')).toBe(200_000)
  })

  it('treats a missing or throwing provider as an empty catalogue', () => {
    setGatewayModelWindowSource(null)
    expect(cachedWindowFor('provider/custom')).toBe(200_000)
    setGatewayModelWindowSource(() => {
      throw new Error('scope unavailable')
    })
    expect(cachedWindowFor('provider/custom')).toBe(200_000)
  })

  it('ignores invalid reported windows and leaves static family rules unchanged', () => {
    models = [{ id: 'provider/custom', contextWindow: Number.NaN }]
    expect(cachedWindowFor('provider/custom')).toBe(200_000)
    expect(staticWindowFor('claude-haiku-4-5')).toBe(200_000)
    expect(staticWindowFor('claude-opus-5')).toBe(1_000_000)
    expect(staticWindowFor('unknown-thing')).toBe(200_000)
  })
})
