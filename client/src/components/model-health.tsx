import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

// ── Health probe (lightweight) ──────────────────────────────────────────────
const HEALTH_COLORS: Record<string, string> = {
  ok: '#4ade80',       // green
  success: '#4ade80',  // green
  error: '#f87171',    // red
  rate_limited: '#fbbf24', // yellow
  timeout: '#fb923c',  // orange
  unknown: '#6b7280',  // gray
}

export function HealthDot({ status }: { status?: string }) {
  const color = HEALTH_COLORS[status ?? 'unknown'] ?? HEALTH_COLORS.unknown
  return (
    <span
      title={`Health: ${status ?? 'unknown'}`}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: color,
        flexShrink: 0,
      }}
    />
  )
}

// ── Health data hook ────────────────────────────────────────────────────────
export interface ModelHealth {
  modelDbId: number
  healthStatus: string
  lastProbedAt: string | null
}

export function useModelHealth() {
  const { data, isLoading, refetch } = useQuery<ModelHealth[]>({
    queryKey: ['fallback', 'health'],
    queryFn: () => apiFetch('/api/fallback/health'),
    refetchInterval: 60_000, // every minute
  })

  const healthByModelDbId = useMemo(() => {
    const map = new Map<number, ModelHealth>()
    if (data) for (const h of data) map.set(h.modelDbId, h)
    return map
  }, [data])

  return { healthByModelDbId, isLoading, refetch }
}
