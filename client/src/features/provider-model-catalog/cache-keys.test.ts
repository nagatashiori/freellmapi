import { describe, expect, it } from 'vitest'
import { PROVIDER_CATALOG_INVALIDATION_KEYS } from './cache-keys'

describe('provider catalog cache invalidation', () => {
  it('refreshes every model, route, profile, and health view after a catalog change', () => {
    expect(PROVIDER_CATALOG_INVALIDATION_KEYS).toEqual(expect.arrayContaining([
      ['fallback'],
      ['models'],
      ['health'],
      ['routing-status'],
      ['profile-models'],
      ['probe-history'],
      ['keys'],
    ]))
  })
})
