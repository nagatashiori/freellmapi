import { useEffect, useState, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Save, Trash2, RefreshCw, Activity } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CopyButton } from '@/components/copy-button'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/tooltip'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { ModelTableHead, SortableRowContent } from '@/components/model-table'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import {
  groupQuotaBadge,
  providerLabel,
  type FallbackEntry,
  type RoutingData,
  type Row,
} from '@/lib/routing'

type ModelSettingsPatch = {
  displayName: string
  contextWindow: number | null
  supportsVision: boolean
  supportsTools: boolean
  fallbackEnabled: boolean
}

interface ProbeResult {
  modelDbId: number
  platform?: string
  modelId?: string
  status: string
  latency: number
  error: string
  enabled?: boolean
}

// Server probe hard-timeout is 15s; client waits a bit longer for JSON roundtrip.
const PROBE_CLIENT_TIMEOUT_MS = 18_000

async function probeOne(modelDbId: number): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const tmr = window.setTimeout(() => ctrl.abort(), PROBE_CLIENT_TIMEOUT_MS)
  try {
    return await apiFetch(`/api/fallback/probe/${modelDbId}`, {
      method: 'POST',
      signal: ctrl.signal,
    }) as ProbeResult
  } catch (e: any) {
    if (e?.name === 'AbortError' || /aborted|timeout/i.test(String(e?.message || e))) {
      return {
        modelDbId,
        platform: '',
        modelId: '',
        status: 'timeout',
        latency: PROBE_CLIENT_TIMEOUT_MS,
        error: `timeout after ${PROBE_CLIENT_TIMEOUT_MS}ms`,
        enabled: false,
      }
    }
    throw e
  } finally {
    window.clearTimeout(tmr)
  }
}



interface HealthRow {
  modelDbId: number
  healthStatus: string
  lastProbedAt?: string | null
}

function statusMeta(status: string) {
  const s = status || 'unknown'
  if (s === 'ok' || s === 'success') return { label: '健康', color: '#4ade80', key: 'ok' as const }
  if (s === 'error' || s === 'timeout') return { label: '错误', color: '#f87171', key: 'error' as const }
  if (s === 'rate_limited') return { label: '限流', color: '#fbbf24', key: 'limited' as const }
  if (s === 'probing') return { label: '测试中', color: '#6b7280', key: 'probing' as const }
  return { label: '未知', color: '#6b7280', key: 'unknown' as const }
}

// One model's own page: lists every provider that serves it (this model now
// fails over across these providers). Reached from the Models list; replaces the
// old inline group expansion.
export default function ModelDetailPage() {
  const { t } = useI18n()
  const { id } = useParams<{ id: string }>()
  const canonicalId = id ? decodeURIComponent(id) : ''
  const queryClient = useQueryClient()

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
  })
  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })
  const { data: healthRaw } = useQuery<HealthRow[]>({
    queryKey: ['health', 'models'],
    queryFn: () => apiFetch('/api/fallback/health'),
    refetchInterval: 30_000,
  })

  const [probeResults, setProbeResults] = useState<Map<number, ProbeResult>>(new Map())
  const [probingAll, setProbingAll] = useState(false)
  const [localMembers, setLocalMembers] = useState<Row[] | null>(null)
  // After a "测全部" pass, persist fastest-first provider order to backend
  // priority so routing follows the same order after refresh/restart.
  const [latencySorted, setLatencySorted] = useState<Row[] | null>(null)
  // Monotonic generation counter so a stale drag's persistence callback doesn't
  // clobber a newer drag's localMembers. If the user drags twice quickly, the
  // first drag's onSettled would otherwise clear the second drag's optimistic
  // state (the second mutate is still in-flight when the first settles).
  const dragGeneration = useRef(0)

  // 24h average latency across every provider serving this model, computed
  // server-side in the same query that builds /api/fallback. Sample-weighted:
  // providers with more successful probes count more.
  const groupMembers = entries
    .filter(e => e.keyCount > 0 && (e.canonicalId ?? e.modelId) === canonicalId)
  const groupAvgInfo = (() => {
    let sum = 0
    let total = 0
    for (const e of groupMembers) {
      const ls = e.latencyStats
      if (ls && ls.sampleCount > 0) {
        sum += ls.avgMs * ls.sampleCount
        total += ls.sampleCount
      }
    }
    return { avgMs: total > 0 ? Math.round(sum / total) : 0, sampleCount: total }
  })()

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const healthMap = new Map<number, string>()
  if (healthRaw) for (const h of healthRaw) healthMap.set(h.modelDbId, h.healthStatus)

  // Toggling a provider persists immediately (no save bar on this page): send the
  // full entries list with this one flipped, then refresh.
  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback'] }),
  })
  const modelPatchMutation = useMutation({
    mutationFn: ({ modelDbId, patch }: { modelDbId: number; patch: ModelSettingsPatch }) =>
      apiFetch(`/api/models/${modelDbId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['model-catalog-platforms'] })
    },
  })
  const modelDeleteMutation = useMutation({
    mutationFn: (modelDbId: number) => apiFetch(`/api/models/${modelDbId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['model-catalog-platforms'] })
    },
  })

  const isManual = (routing?.strategy ?? 'balanced') === 'priority'
  const scoreById = new Map((routing?.scores ?? []).map(s => [s.modelDbId, s]))

  // Providers serving this model: configured rows whose group matches the id
  // (canonicalId, or the bare model id for an ungrouped model).
  const members: Row[] = entries
    .filter(e => e.keyCount > 0 && (e.canonicalId ?? e.modelId) === canonicalId)
    .map(e => ({ ...(scoreById.get(e.modelDbId) ?? {}), ...e }))
    .sort((a, b) => (isManual ? a.priority - b.priority : (b.score ?? 0) - (a.score ?? 0)))

  const displayMembers = localMembers ?? members

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !isManual) return
    const oldI = displayMembers.findIndex(m => m.modelDbId === Number(active.id))
    const newI = displayMembers.findIndex(m => m.modelDbId === Number(over.id))
    if (oldI < 0 || newI < 0) return
    const reordered = arrayMove(displayMembers, oldI, newI)
    setLocalMembers(reordered)
    setLatencySorted(null)
    const gen = ++dragGeneration.current
    // Persist: build flat priority list from all entries, overriding order for
    // the members of this group.
    const memberIds = new Set(reordered.map(m => m.modelDbId))
    const priority = new Map(reordered.map((m, i) => [m.modelDbId, i + 1]))
    const all = entries.map(e => ({
      modelDbId: e.modelDbId,
      priority: memberIds.has(e.modelDbId) ? (priority.get(e.modelDbId) ?? e.priority) : e.priority,
      enabled: e.enabled,
    }))
    saveMutation.mutate(all, {
      onSettled: () => {
        if (dragGeneration.current === gen) setLocalMembers(null)
        queryClient.invalidateQueries({ queryKey: ['fallback'] })
      },
    })
  }

  function handleToggle(modelDbId: number, enabled: boolean) {
    saveMutation.mutate(entries.map(e => ({
      modelDbId: e.modelDbId,
      priority: e.priority,
      enabled: e.modelDbId === modelDbId ? enabled : e.enabled,
    })))
  }

  const patchEnabledInCache = useCallback((modelDbId: number, enabled: boolean) => {
    queryClient.setQueryData<FallbackEntry[]>(['fallback'], (old) => {
      if (!old) return old
      return old.map(row => row.modelDbId === modelDbId ? { ...row, enabled } : row)
    })
  }, [queryClient])

  const applyProbe = useCallback((res: ProbeResult) => {
    setProbeResults(prev => new Map(prev).set(res.modelDbId, res))
    if (typeof res.enabled === 'boolean') {
      patchEnabledInCache(res.modelDbId, res.enabled)
    } else if (res.status === 'ok' || res.status === 'success') {
      patchEnabledInCache(res.modelDbId, true)
    } else if (res.status === 'error' || res.status === 'timeout') {
      patchEnabledInCache(res.modelDbId, false)
    }
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    }, 400)
  }, [patchEnabledInCache, queryClient])

  const doProbe = useCallback(async (modelDbId: number) => {
    setProbeResults(prev => new Map(prev).set(modelDbId, {
      modelDbId, status: 'probing', latency: 0, error: '',
    }))
    try {
      const res = await probeOne(modelDbId)
      applyProbe(res)
    } catch (e: any) {
      applyProbe({
        modelDbId, status: 'error', latency: 0, error: e.message || 'request failed', enabled: false,
      })
    }
  }, [applyProbe])

  const doProbeAllMembers = useCallback(async () => {
    if (displayMembers.length === 0 || probingAll) return
    setProbingAll(true)
    for (const m of displayMembers) {
      setProbeResults(prev => new Map(prev).set(m.modelDbId, {
        modelDbId: m.modelDbId, status: 'probing', latency: 0, error: '',
      }))
      try {
        const res = await probeOne(m.modelDbId)
        applyProbe(res)
      } catch (e: any) {
        applyProbe({
          modelDbId: m.modelDbId, status: 'error', latency: 0, error: e.message || 'request failed', enabled: false,
        })
      }
      await new Promise(r => setTimeout(r, 200))
    }
    // Probe only updates the latency badges - it does NOT reorder providers
    // and does NOT write back to the DB. The operator's manual drag order on
    // /models/chat is the single source of truth for priority; auto-sorting by
    // probe latency was demoting rate-limited models (which fail fast = low
    // latency) to the top and permanently overwriting the manual order.
    setProbingAll(false)
  }, [displayMembers, probingAll, applyProbe])

  const label = members[0]?.groupLabel ?? members[0]?.displayName ?? canonicalId
  const quota = members.length ? groupQuotaBadge(members, t) : null
  const vision = members.some(m => m.supportsVision)
  const tools = members.some(m => m.supportsTools)

  // Health summary for header
  let okN = 0, errN = 0, limN = 0, unkN = 0
  for (const m of members) {
    const pr = probeResults.get(m.modelDbId)
    const st = pr?.status || healthMap.get(m.modelDbId) || 'unknown'
    if (st === 'ok' || st === 'success') okN++
    else if (st === 'error' || st === 'timeout') errN++
    else if (st === 'rate_limited') limN++
    else unkN++
  }

  // A ready-to-run request referencing this model by its unified id, so it fails
  // over across every provider above. Same base-URL derivation as the Keys page.
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`
  const snippet = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${keyData?.apiKey || 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${canonicalId}",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'`

  return (
    <div>
      <PageHeader title={label} description={t('models.providersHeading')} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link to="/models/chat" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" />{t('models.backToModels')}
          </Link>
          {members.length > 0 && (
            <Button size="sm" variant="outline" onClick={doProbeAllMembers} disabled={probingAll}>
              {probingAll ? <RefreshCw className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
              {probingAll ? '测试中…' : '测试全部提供方'}
            </Button>
          )}
        </div>

        {isLoading ? (
          <TableSkeleton rows={3} />
        ) : members.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('models.modelNotFound')}</p>
          </div>
        ) : (
          <>
            {/* Summary badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: members.length })}</span>
              {quota && <span title={quota.title} className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground tabular-nums">{quota.text}</span>}
              {vision && <span title={t('models.visionTitle')} className="text-[11px] rounded-full px-2 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">{t('models.vision')}</span>}
              {tools && <span title={t('models.toolsTitle')} className="text-[11px] rounded-full px-2 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">{t('models.tools')}</span>}
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-[#4ade80]/15 text-[#4ade80]">{okN} 健康</span>
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-[#f87171]/15 text-[#f87171]">{errN} 错误</span>
              {limN > 0 && <span className="text-[11px] rounded-full px-2 py-0.5 bg-[#fbbf24]/15 text-[#fbbf24]">{limN} 限流</span>}
              {unkN > 0 && <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground">{unkN} 未知</span>}
              {groupAvgInfo.sampleCount > 0 && (
                <span
                  title="24h 内所有 provider 成功探测的平均延迟（按成功探测次数加权平均）"
                  className="text-[11px] rounded-full px-2 py-0.5 bg-blue-600/15 text-blue-700 dark:bg-blue-400/15 dark:text-blue-400 tabular-nums"
                >
                  24h 平均 {groupAvgInfo.avgMs}ms · {groupAvgInfo.sampleCount} 次
                </span>
              )}
            </div>

            {/* Per-provider health + test (main request) */}
            <div className="rounded-2xl border bg-card overflow-hidden">
              <div className="px-4 py-3 border-b flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-medium">提供方健康</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">每个渠道单独测试；成功自动开启，失败自动关闭该渠道。</p>
                </div>
              </div>
              <div className="divide-y divide-border/40">
                {displayMembers.map(m => {
                  const pr = probeResults.get(m.modelDbId)
                  const status = pr?.status || healthMap.get(m.modelDbId) || 'unknown'
                  const meta = statusMeta(status)
                  const probing = status === 'probing'
                  const isEnabled = pr && pr.enabled !== undefined ? pr.enabled : m.enabled
                  return (
                    <div key={m.modelDbId} className="px-4 py-2.5" style={{ opacity: isEnabled ? 1 : 0.45 }}>
                      <div className="flex items-center gap-2 flex-wrap">
                        {probing ? (
                          <RefreshCw className="size-3 animate-spin shrink-0" style={{ color: meta.color }} />
                        ) : (
                          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                        )}
                        <span className="text-xs font-medium w-24 shrink-0 truncate">{providerLabel(m)}</span>
                        <code className="text-[11px] font-mono text-muted-foreground truncate flex-1 min-w-[8rem]">{m.modelId}</code>
                        <span className="text-[10px] text-muted-foreground w-14 text-right tabular-nums" title="本次探测的延迟">
                          {pr && pr.status !== 'probing' ? (pr.latency > 0 ? `${pr.latency}ms` : '-') : '-'}
                        </span>
                        <span
                          className="text-[10px] text-muted-foreground w-16 text-right tabular-nums"
                          title={m.latencyStats && m.latencyStats.sampleCount > 0
                            ? `24h 成功探测 ${m.latencyStats.sampleCount} 次的平均延迟`
                            : '24h 内无成功探测'}
                        >
                          {m.latencyStats && m.latencyStats.sampleCount > 0
                            ? `24h ${m.latencyStats.avgMs}ms`
                            : '24h —'}
                        </span>
                        <span className="text-[10px] w-8 text-right text-muted-foreground">{isEnabled ? '开' : '关'}</span>
                        <span className="text-[10px] w-12 text-right font-medium" style={{ color: meta.color }}>{meta.label}</span>
                        <button
                          type="button"
                          disabled={probing || probingAll}
                          onClick={() => doProbe(m.modelDbId)}
                          className="text-[10px] px-2 py-0.5 rounded border bg-background hover:bg-muted disabled:opacity-30"
                        >
                          {probing ? '…' : '测试'}
                        </button>
                        <Switch
                          size="sm"
                          checked={!!isEnabled}
                          disabled={saveMutation.isPending}
                          onCheckedChange={(v) => handleToggle(m.modelDbId, v)}
                        />
                      </div>
                      {pr?.error && (
                        <pre className="mt-1.5 text-[10px] text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                          {pr.error}
                        </pre>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Per-provider stats (same columns as the Models table) */}
            {isManual ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <div className="rounded-2xl border overflow-x-auto">
                  <table className="w-full text-sm">
                    <ModelTableHead />
                    <SortableContext items={displayMembers.map(m => m.modelDbId)} strategy={verticalListSortingStrategy}>
                      <tbody>
                        {displayMembers.map((m, i) => (
                          <SortableRowContent key={m.modelDbId} row={m} rank={i + 1} draggable onToggle={handleToggle} />
                        ))}
                      </tbody>
                    </SortableContext>
                  </table>
                </div>
              </DndContext>
            ) : (
              <div className="rounded-2xl border overflow-x-auto">
                <table className="w-full text-sm">
                  <ModelTableHead />
                  <tbody>
                    {displayMembers.map((m, i) => (
                      <tr key={m.modelDbId} className={`border-b last:border-0 ${m.enabled ? '' : 'opacity-50'}`}>
                        <SortableRowContent row={m} rank={i + 1} draggable={false} onToggle={handleToggle} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="rounded-2xl border bg-card p-4">
              <div className="mb-3">
                <h2 className="text-sm font-medium">{t('models.settingsHeading')}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('models.settingsHint')}</p>
              </div>
              <div className="space-y-3">
                {displayMembers.map(m => (
                  <ProviderSettingsRow
                    key={m.modelDbId}
                    model={m}
                    saving={modelPatchMutation.isPending && modelPatchMutation.variables?.modelDbId === m.modelDbId}
                    deleting={modelDeleteMutation.isPending && modelDeleteMutation.variables === m.modelDbId}
                    onSave={(patch) => modelPatchMutation.mutate({ modelDbId: m.modelDbId, patch })}
                    onDelete={() => modelDeleteMutation.mutate(m.modelDbId)}
                  />
                ))}
              </div>
            </div>

            {/* The provider-specific model id to send if you want to pin one provider. */}
            <div className="rounded-2xl border bg-card p-4">
              <h2 className="text-sm font-medium">{t('models.providerIdsHeading')}</h2>
              <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{t('models.providerIdsHint')}</p>
              <div className="space-y-1.5">
                {displayMembers.map(m => (
                  <div key={m.modelDbId} className="flex items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 text-muted-foreground">{providerLabel(m)}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{m.modelId}</code>
                    <Tooltip text={t('models.copyModelName')}>
                      <CopyButton text={m.modelId} label={t('models.copyModelName')} className="border-0 bg-transparent" />
                    </Tooltip>
                  </div>
                ))}
              </div>
            </div>

            {/* Ready-to-run snippet that references this model by its unified id. */}
            <div className="overflow-hidden rounded-2xl border bg-card">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <CopyButton text={snippet} className="size-7 shrink-0" label={t('common.copy')} />
                <span className="text-xs font-medium">{t('models.codeSnippetHeading')}</span>
              </div>
              <pre className="overflow-x-auto px-4 py-3 text-[11px] leading-relaxed"><code className="font-mono">{snippet}</code></pre>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ProviderSettingsRow({
  model,
  saving,
  deleting,
  onSave,
  onDelete,
}: {
  model: Row
  saving: boolean
  deleting: boolean
  onSave: (patch: ModelSettingsPatch) => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const [displayName, setDisplayName] = useState(model.displayName)
  const [contextWindow, setContextWindow] = useState(model.contextWindow ? String(model.contextWindow) : '')
  const [supportsVision, setSupportsVision] = useState(model.supportsVision)
  const [supportsTools, setSupportsTools] = useState(model.supportsTools)
  const [fallbackEnabled, setFallbackEnabled] = useState(model.enabled)

  useEffect(() => {
    setDisplayName(model.displayName)
    setContextWindow(model.contextWindow ? String(model.contextWindow) : '')
    setSupportsVision(model.supportsVision)
    setSupportsTools(model.supportsTools)
    setFallbackEnabled(model.enabled)
  }, [model.modelDbId, model.displayName, model.contextWindow, model.supportsVision, model.supportsTools, model.enabled])

  const parsedContext = contextWindow.trim() === '' ? null : Number(contextWindow)
  const contextInvalid = parsedContext !== null && (!Number.isInteger(parsedContext) || parsedContext <= 0)
  const nameInvalid = displayName.trim().length === 0
  const dirty =
    displayName.trim() !== model.displayName ||
    parsedContext !== (model.contextWindow ?? null) ||
    supportsVision !== model.supportsVision ||
    supportsTools !== model.supportsTools ||
    fallbackEnabled !== model.enabled
  const canSave = dirty && !nameInvalid && !contextInvalid && !saving && !deleting
  const sourceLabel = model.source === 'custom' ? t('models.customModel') : t('models.catalogModel')

  function save() {
    if (!canSave) return
    onSave({
      displayName: displayName.trim(),
      contextWindow: parsedContext,
      supportsVision,
      supportsTools,
      fallbackEnabled,
    })
  }

  return (
    <div className="rounded-xl border bg-background/60 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{providerLabel(model)}</span>
        <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{model.modelId}</code>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{sourceLabel}</span>
        {model.hasOverrides && (
          <span className="rounded-full bg-emerald-600/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
            {t('models.localOverride')}
          </span>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_8rem_auto_auto_auto_auto] md:items-end">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('models.displayName')}</span>
          <Input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            aria-invalid={nameInvalid}
            className="text-sm"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('models.contextWindow')}</span>
          <Input
            type="number"
            min={1}
            step={1}
            value={contextWindow}
            onChange={e => setContextWindow(e.target.value)}
            aria-invalid={contextInvalid}
            className="text-sm tabular-nums"
          />
        </label>
        <label className="flex h-8 items-center gap-2 text-xs">
          <Switch size="sm" checked={supportsTools} onCheckedChange={setSupportsTools} />
          <span>{t('models.tools')}</span>
        </label>
        <label className="flex h-8 items-center gap-2 text-xs">
          <Switch size="sm" checked={supportsVision} onCheckedChange={setSupportsVision} />
          <span>{t('models.vision')}</span>
        </label>
        <label className="flex h-8 items-center gap-2 text-xs">
          <Switch size="sm" checked={fallbackEnabled} onCheckedChange={setFallbackEnabled} />
          <span>{t('models.inFallback')}</span>
        </label>
        <div className="flex items-center justify-end gap-1">
          <Tooltip text={t('models.saveModelSettings')}>
            <Button type="button" size="icon-sm" variant="ghost" disabled={!canSave} onClick={save}>
              <Save className="size-3.5" />
            </Button>
          </Tooltip>
          <ConfirmButton
            variant="destructive"
            size="icon-sm"
            armedSize="xs"
            armedClassName=""
            disabled={saving || deleting}
            onConfirm={onDelete}
            aria-label={t('common.delete')}
          >
            <Trash2 className="size-3.5" />
          </ConfirmButton>
        </div>
      </div>
    </div>
  )
}
