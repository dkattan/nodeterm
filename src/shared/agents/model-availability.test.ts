import { describe, expect, it } from 'vitest'
import {
  modelAvailability,
  modelLaunchShapeMismatch,
  modelRecoveryCure,
  modelRecoverySessionKey,
  modelRecoveryTrigger,
  modelWindowChange,
  modelWindowSessionKey
} from './model-availability'
import type { GatewayModel } from './model-gateway'

const CATALOGUE: GatewayModel[] = [
  { id: 'provider/large', contextWindow: 400_000 },
  { id: 'openai/small', contextWindow: 128_000 },
  { id: 'anthropic/no-window' }
]

describe('modelAvailability', () => {
  it('flags an absent id and accepts either [1m] spelling', () => {
    expect(modelAvailability('gone/model', CATALOGUE).unavailable).toBe(true)
    expect(modelAvailability('provider/large', CATALOGUE).unavailable).toBe(false)
    expect(modelAvailability('provider/large[1m]', CATALOGUE).unavailable).toBe(false)
  })

  it('does not judge an absent record or empty catalogue', () => {
    expect(modelAvailability(undefined, CATALOGUE).unavailable).toBe(false)
    expect(modelAvailability('gone/model', []).unavailable).toBe(false)
  })
})

describe('modelLaunchShapeMismatch', () => {
  it('compares the exact launch record with today’s assembler output', () => {
    expect(modelLaunchShapeMismatch('claude', 'provider/large', CATALOGUE)).toBe(true)
    expect(modelLaunchShapeMismatch('claude', 'provider/large[1m]', CATALOGUE)).toBe(false)
    expect(modelLaunchShapeMismatch('codex', 'provider/large', CATALOGUE)).toBe(false)
  })
})

describe('legacy model-window observations', () => {
  it('seeds once, then detects a change per session', () => {
    expect(modelWindowChange('provider/large', CATALOGUE, undefined)).toEqual({
      changed: false,
      contextWindow: 400_000,
      fresh: true
    })
    expect(modelWindowChange('provider/large[1m]', CATALOGUE, 200_000).changed).toBe(true)
    expect(modelWindowSessionKey('node-a', 'provider/large[1m]')).toBe('node-a:provider/large')
    expect(modelWindowSessionKey('node-b', 'provider/large')).not.toBe(
      modelWindowSessionKey('node-a', 'provider/large')
    )
  })
})

describe('modelRecoveryTrigger', () => {
  it('detects removed, changed-window, and stale-shape launch records', () => {
    expect(modelRecoveryTrigger('claude', 'gone/model', 200_000, CATALOGUE)).toBe('gone')
    expect(modelRecoveryTrigger('claude', 'provider/large[1m]', 200_000, CATALOGUE)).toBe('win')
    expect(modelRecoveryTrigger('claude', 'provider/large', 400_000, CATALOGUE)).toBe('shape')
  })

  it('fails closed for legacy records and missing reported windows', () => {
    expect(modelRecoveryTrigger('claude', undefined, 200_000, CATALOGUE)).toBeNull()
    expect(modelRecoveryTrigger('claude', 'provider/large[1m]', undefined, CATALOGUE)).toBeNull()
    expect(modelRecoveryTrigger('claude', 'anthropic/no-window', 200_000, CATALOGUE)).toBeNull()
  })
})

describe('modelRecoveryCure', () => {
  it('requires the actual restarted record to cure each trigger', () => {
    expect(modelRecoveryCure('gone', 'claude', 'openai/small', 128_000, CATALOGUE).cured).toBe(true)
    expect(modelRecoveryCure('win', 'claude', 'provider/large[1m]', 400_000, CATALOGUE).cured).toBe(true)
    expect(modelRecoveryCure('shape', 'claude', 'provider/large[1m]', 400_000, CATALOGUE).cured).toBe(true)
  })

  it('fails closed for missing or stale actual records', () => {
    expect(modelRecoveryCure('gone', 'claude', undefined, undefined, CATALOGUE).cured).toBe(false)
    expect(modelRecoveryCure('gone', 'claude', 'gone/model', 200_000, CATALOGUE).cured).toBe(false)
    expect(modelRecoveryCure('win', 'claude', 'provider/large[1m]', 200_000, CATALOGUE).cured).toBe(false)
    expect(modelRecoveryCure('shape', 'claude', 'provider/large', 400_000, CATALOGUE).cured).toBe(false)
    expect(modelRecoveryCure('gone', 'claude', 'openai/small', 128_000, []).cured).toBe(false)
  })
})

describe('modelRecoverySessionKey', () => {
  it('keeps nodes, reasons, and trigger versions independent', () => {
    const key = modelRecoverySessionKey('node-a', 'provider/large', 'win', 400_000)
    expect(key).not.toBe(modelRecoverySessionKey('node-b', 'provider/large', 'win', 400_000))
    expect(key).not.toBe(modelRecoverySessionKey('node-a', 'provider/large', 'shape', 'large[1m]'))
    expect(key).not.toBe(modelRecoverySessionKey('node-a', 'provider/large', 'win', 500_000))
  })
})
