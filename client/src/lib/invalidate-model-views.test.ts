import { describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { invalidateModelViews, MODEL_VIEW_INVALIDATION_KEYS } from './invalidate-model-views'

describe('model view invalidation', () => {
  it('covers every page that reads model, route, profile, health, or key data', () => {
    expect(MODEL_VIEW_INVALIDATION_KEYS).toEqual(expect.arrayContaining([
      ['fallback'],
      ['models'],
      ['health'],
      ['routing-status'],
      ['profile-models'],
      ['probe-history'],
      ['keys'],
      ['provider-model-catalog'],
      ['model-catalog-platforms'],
    ]))
  })

  it('invalidates every shared prefix when a mutation succeeds', () => {
    const invalidateQueries = vi.fn()
    invalidateModelViews({ invalidateQueries } as unknown as QueryClient)
    expect(invalidateQueries).toHaveBeenCalledTimes(MODEL_VIEW_INVALIDATION_KEYS.length)
    for (const queryKey of MODEL_VIEW_INVALIDATION_KEYS) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey })
    }
  })
})
