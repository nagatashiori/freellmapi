import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Loader2, X } from 'lucide-react'

// Thin async wrapper around the official health + pinned-model test paths.
// The server owns the run, so the page stays usable while the sweep proceeds.

export interface ProbeRunSnapshot {
  runId: string
  kind: 'full' | 'keys'
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  createdAt: string
  finishedAt: string | null
  progress: {
    totalCombos: number
    completedCombos: number
    okCount: number
    partialCount: number
    rateLimitedCount: number
    failedCount: number
  }
  result: {
    keys?: { keyId: number; platform: string; label: string | null; enabled: boolean; status: string }[]
    models?: unknown[]
  } | null
}

const FINISHED = new Set(['completed', 'cancelled', 'failed'])

export function ProbeRunPanel({ runId, onDismiss }: { runId: string; onDismiss: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: run } = useQuery<ProbeRunSnapshot>({
    queryKey: ['probe-run', runId],
    queryFn: () => apiFetch(`/api/fallback/probe-runs/${runId}`),
    refetchInterval: (query) => (query.state.data && FINISHED.has(query.state.data.status) ? false : 1500),
  })

  const cancel = useMutation({
    mutationFn: () => apiFetch(`/api/fallback/probe-runs/${runId}`, { method: 'DELETE' }),
  })

  // When the run lands, refresh every view that shows probe-derived state.
  const status = run?.status
  useEffect(() => {
    if (status && FINISHED.has(status)) {
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['routing-scores'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    }
  }, [status, queryClient])

  if (!run) return null
  const p = run.progress
  const pct = p.totalCombos > 0 ? Math.min(100, Math.round((p.completedCombos / p.totalCombos) * 100)) : 0
  const running = run.status === 'running'

  return (
    <div className="rounded-3xl border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {running && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          {t('keys.probeRunTitle')}
          <span className="text-xs font-normal text-muted-foreground">
            {run.status === 'completed' && t('keys.probeRunCompleted')}
            {run.status === 'cancelled' && t('keys.probeRunCancelled')}
            {run.status === 'failed' && t('keys.probeRunFailed')}
            {running && t('keys.probeRunProgress', { completed: p.completedCombos, total: p.totalCombos })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <Button variant="outline" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              <X className="size-3.5" />
              {cancel.isPending ? t('keys.probeRunCancelling') : t('keys.probeRunCancel')}
            </Button>
          )}
          {!running && (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>{t('keys.probeRunOk', { count: p.okCount })}</span>
        <span>{t('keys.probeRunPartial', { count: p.partialCount })}</span>
        <span>{t('keys.probeRunRateLimited', { count: p.rateLimitedCount })}</span>
        <span>{t('keys.probeRunFailedCount', { count: p.failedCount })}</span>
      </div>

      {run.status === 'completed' && run.result?.keys && run.result.keys.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {run.result.keys
            .filter((k) => k.status !== 'healthy')
            .slice(0, 12)
            .map((k) => (
              <span
                key={k.keyId}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
              >
                {k.label || `#${k.keyId}`}
                <span className="text-rose-500">{k.platform}</span>
              </span>
            ))}
        </div>
      )}
    </div>
  )
}
