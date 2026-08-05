import { describe, expect, it } from 'vitest'
import { buildPlayableModelOptions, reconcilePlaygroundModel } from './playground-models'

const entry = (overrides: Record<string, unknown> = {}) => ({
  modelDbId: 1,
  modelId: 'model-a',
  displayName: 'Model A',
  platform: 'provider-a',
  enabled: true,
  keyCount: 1,
  groupKey: 'model a',
  canonicalId: 'model-a',
  groupLabel: 'Model A',
  intelligenceRank: 1,
  sizeLabel: 'Small',
  ...overrides,
})

describe('Playground model availability', () => {
  it('uses the model-specific usable-key count instead of a provider-wide count', () => {
    const options = buildPlayableModelOptions([
      entry({ keyCount: 3, routingHealth: { usableKeyCount: 0 } }),
      entry({ modelDbId: 2, modelId: 'model-b', canonicalId: 'model-b', groupKey: 'model b', groupLabel: 'Model B', keyCount: 0 }),
      entry({ modelDbId: 3, modelId: 'model-c', canonicalId: 'model-c', groupKey: 'model c', groupLabel: 'Model C', keyCount: 1, routingHealth: { usableKeyCount: 1 } }),
    ])

    expect(options.map(option => option.value)).toEqual(['model-c'])
  })

  it('falls back to Auto when a refresh removes the selected model', () => {
    expect(reconcilePlaygroundModel('model-old', [{ value: 'model-new' }])).toBe('auto')
    expect(reconcilePlaygroundModel('model-new', [{ value: 'model-new' }])).toBe('model-new')
    expect(reconcilePlaygroundModel('fusion', [])).toBe('fusion')
  })
})
