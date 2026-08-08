import type { QueryClient } from '@tanstack/react-query'

/**
 * All pages that show model or routing data read from the same database.
 * Prefix keys are intentional: TanStack Query also refreshes nested keys.
 */
export const MODEL_VIEW_INVALIDATION_KEYS = [
  ['fallback'],
  ['models'],
  ['health'],
  ['routing-status'],
  ['profile-models'],
  ['probe-history'],
  ['keys'],
  ['provider-model-catalog'],
  ['model-catalog-platforms'],
  ['analytics'],
  ['fusion-config'],
] as const

/** Refresh every model-related page after one model mutation succeeds. */
export function invalidateModelViews(queryClient: QueryClient): void {
  for (const queryKey of MODEL_VIEW_INVALIDATION_KEYS) {
    void queryClient.invalidateQueries({ queryKey })
  }
}

/**
 * Probe results change health and live routing data, not the catalog or keys.
 * Keeping this list narrow prevents a large probe batch from refetching every
 * page once per model.
 */
export const MODEL_HEALTH_INVALIDATION_KEYS = [
  ['health'],
  ['fallback'],
  ['probe-history'],
  ['routing-status'],
] as const

export function invalidateModelHealthViews(queryClient: QueryClient): void {
  for (const queryKey of MODEL_HEALTH_INVALIDATION_KEYS) {
    void queryClient.invalidateQueries({ queryKey })
  }
}
