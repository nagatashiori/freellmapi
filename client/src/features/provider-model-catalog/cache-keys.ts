/**
 * Catalog changes affect more than the catalog panel itself.
 * Prefix keys are intentional: TanStack Query invalidates nested keys too.
 */
export const PROVIDER_CATALOG_INVALIDATION_KEYS = [
  ['fallback'],
  ['models'],
  ['health'],
  ['routing-status'],
  ['profile-models'],
  ['probe-history'],
  ['keys'],
  ['model-catalog-platforms'],
] as const
