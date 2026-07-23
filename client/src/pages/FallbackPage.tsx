import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Boxes, Search, X, Activity, Play, RefreshCw } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { useProbe } from '@/lib/use-probe'
import {
  buildGroups,
  groupMaxContext,
  hasConfiguredProviderKeys,
  type FallbackEntry,
  type ModelGroupRow,
  type RoutingData,
  type RoutingStrategy,
  type RoutingWeights,
  type Row,
  type TokenUsageData,
} from '@/lib/routing'
import { Button } from '@/components/ui/button'
import { CustomWeightsPopover } from '@/components/custom-weights-popover'
import { EmptyState } from '@/components/empty-state'
import { GettingStarted } from '@/components/getting-started'
import { GroupHeaderCells, ModelTableHead, SortableGroupRow } from '@/components/model-table'
import { TableSkeleton } from '@/components/ui/skeleton'
import { TokenUsageBar } from '@/components/token-usage-bar'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'
import { PenaltyInspector } from '@/components/penalty-inspector'

// Routing group tab labels
const ROUTING_PROFILES = [
  { key: 'default', label: 'Default (AUTO)' },
  { key: 'high', label: 'high' },
  { key: 'mid', label: 'mid' },
  { key: 'light', label: 'light' },
] as const

// `tKey` is the i18n suffix under `strategies.*` (label) and `strategies.*Blurb`.
// It differs from the routing `key` for Manual, whose strategy id is 'priority'.
const STRATEGIES: { key: RoutingStrategy; tKey: string }[] = [
  { key: 'priority', tKey: 'manual' },
  { key: 'balanced', tKey: 'balanced' },
  { key: 'smartest', tKey: 'smartest' },
  { key: 'fastest', tKey: 'fastest' },
  { key: 'reliable', tKey: 'reliable' },
  { key: 'custom', tKey: 'custom' },
]

// Minimum-context filter buckets for the Models page toolbar. `key` is the token
// threshold (0 = no filter); numeric labels are not localized (they're numbers).
const CTX_BUCKETS: { key: number; label?: string; tKey?: string }[] = [
  { key: 0, tKey: 'ctxAny' },
  { key: 32_000, label: '32K+' },
  { key: 128_000, label: '128K+' },
  { key: 1_000_000, label: '1M+' },
]

// Rows rendered up front; a sentinel below the table streams in the rest as
// you scroll. Keeps first paint cheap when the catalog grows into the
// hundreds without a virtualization dependency (which would fight dnd-kit).
const RENDER_CHUNK = 50


export default function FallbackPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [deletingGroup, setDeletingGroup] = useState<string | null>(null)
  const [editingRankKey, setEditingRankKey] = useState<string | null>(null)
  const [editRankValue, setEditRankValue] = useState('')
  const [showDisabled, setShowDisabled] = useState(true)

  // Catalog search + filter state (#343).
  const [search, setSearch] = useState('')
  const [filterVision, setFilterVision] = useState(false)
  const [filterTools, setFilterTools] = useState(false)
  const [minContext, setMinContext] = useState(0)

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
  })

  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
    refetchInterval: 15_000,
  })

  const { probeResults, probingAll, probeProgress, doProbeAll, doProbeGroup } = useProbe()
  // Per-group 24h latency aggregate. Computed locally from the per-row
  // `latencyStats` the server already sends (no extra fetch). Sample-weighted
  // so a provider with 100 probes counts more than one with 5.
  function groupLatencyFor(members: any[]): { avgMs: number; sampleCount: number } {
    let sum = 0
    let total = 0
    for (const m of members) {
      const ls = m.latencyStats
      if (ls && ls.sampleCount > 0) {
        sum += ls.avgMs * ls.sampleCount
        total += ls.sampleCount
      }
    }
    return { avgMs: total > 0 ? Math.round(sum / total) : 0, sampleCount: total }
  }

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  const strategyMutation = useMutation({
    mutationFn: (payload: { strategy: RoutingStrategy; weights?: RoutingWeights }) =>
      apiFetch('/api/fallback/routing', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] }),
  })

  const strategy: RoutingStrategy = routing?.strategy ?? 'balanced'
  const isManual = strategy === 'priority'

  // Merge fallback metadata with live scores, keyed by model.
  const scoreById = new Map((routing?.scores ?? []).map(s => [s.modelDbId, s]))
  const allEntries = localEntries ?? entries

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  let configured: any[]
  let unconfiguredPlatforms: string[]
  let rows: Row[]

  const hasChanges = localEntries !== null

  // ── Routing group tabs (Default / high / mid / light) ──────────────
  const [activeProfile, setActiveProfile] = useState<string>('default')
  const isDefaultTab = activeProfile === 'default'

  // routing-status: lightweight per-group stats for the tab strip
  const { data: routingStatus } = useQuery<{ groups: any[] }>({
    queryKey: ['routing-status'],
    queryFn: () => apiFetch('/api/profiles/routing-status'),
    refetchInterval: 30_000,
  })
  const statusByGroup = new Map(routingStatus?.groups?.map(g => [g.name, g]) ?? [])

  const { data: profileEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['profile-models', activeProfile],
    queryFn: () => apiFetch(`/api/profiles/${statusByGroup.get(activeProfile)?.profileId ?? 3}/models`),
    enabled: !isDefaultTab && statusByGroup.has(activeProfile),
  })

  // Membership mutation: add/remove models from routing groups
  const membershipMutation = useMutation({
    mutationFn: (payload: { modelDbIds: number[]; add: string[]; remove: string[] }) =>
      apiFetch('/api/profiles/membership', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routing-status'] })
      if (!isDefaultTab) queryClient.invalidateQueries({ queryKey: ['profile-models', activeProfile] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  // Save handler depends on active tab
  function handleSave() {
    if (isDefaultTab) {
      saveMutation.mutate(allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })))
    } else {
      const pid = statusByGroup.get(activeProfile)?.profileId
      if (!pid) return
      const entries = profileEntries.map((e: any, i: number) => ({
        modelDbId: e.modelDbId ?? e.id,
        priority: e.priority ?? i + 1,
        enabled: e.enabled !== undefined ? e.enabled : true,
      }))
      profileReorderMutation.mutate(entries)
    }
  }

  // Reorder mutation for high/mid/light profiles
  const profileReorderMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch(`/api/profiles/${statusByGroup.get(activeProfile)?.profileId ?? 3}/reorder`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile-models', activeProfile] })
      queryClient.invalidateQueries({ queryKey: ['routing-status'] })
    },
  })

  // Determine the data source: fallback or profile models
  const effectiveEntries: FallbackEntry[] = isDefaultTab ? (localEntries ?? entries) : (profileEntries as any)
  // Profile API returns snake_case and no keyCount; normalize so buildGroups works.
  if (isDefaultTab) {
    configured = effectiveEntries.filter((e: any) => hasConfiguredProviderKeys(e))
    unconfiguredPlatforms = [...new Set(effectiveEntries.filter((e: any) => !hasConfiguredProviderKeys(e)).map((e: any) => e.platform))]
    rows = configured.map(e => ({ ...(scoreById.get(e.modelDbId) ?? {}), ...e }))
  } else {
    // For routing groups, skip keyCount filter (profile only contains its members)
    // and normalize field names from snake_case (profiles API) to camelCase.
    configured = effectiveEntries.map((e: any) => ({
      modelDbId: e.model_db_id ?? e.modelDbId,
      priority: e.priority ?? 0,
      enabled: e.enabled === true || e.enabled === 1,
      platform: e.platform,
      modelId: e.model_id ?? e.modelId,
      displayName: e.display_name ?? e.displayName,
      intelligenceRank: e.intelligence_rank ?? e.intelligenceRank ?? 999,
      speedRank: e.speed_rank ?? e.speedRank ?? 50,
      sizeLabel: e.size_label ?? e.sizeLabel ?? 'medium',
      rpmLimit: e.rpm_limit ?? e.rpmLimit ?? null,
      rpdLimit: e.rpd_limit ?? e.rpdLimit ?? null,
      tpmLimit: e.tpm_limit ?? e.tpmLimit ?? null,
      tpdLimit: e.tpd_limit ?? e.tpdLimit ?? null,
      contextWindow: e.context_window ?? e.contextWindow ?? null,
      monthlyTokenBudget: e.monthly_token_budget ?? e.monthlyTokenBudget ?? '',
      keyCount: 1, // profile members always have a key (added via key platform)
      totalKeyCount: e.total_key_count ?? e.totalKeyCount ?? 1,
      supportsVision: e.supports_vision ?? e.supportsVision ?? false,
      supportsTools: e.supports_tools ?? e.supportsTools ?? false,
    }))
    unconfiguredPlatforms = []
    rows = configured
  }

  // ── Model unification: a model served by several providers is always shown as
  // one logical row that links to its own page (the on/off toggle was removed). ─
  const orderedGroups = buildGroups(rows, isManual)
  const displayGroups = showDisabled ? orderedGroups : orderedGroups.filter(g => g.members.some(m => m.enabled))

  // Catalog search + filters (#343). Filtering operates on whole logical-model
  // groups; rank stays the model's position in the full chain so the numbers
  // don't renumber as you filter. Drag-to-reorder is only offered over the full,
  // unfiltered manual chain (reordering a filtered subset would be ambiguous).
  const rankByKey = new Map(orderedGroups.map((g, i) => [g.key, i + 1]))
  const query = search.trim().toLowerCase()
  const filtersActive = query !== '' || filterVision || filterTools || minContext > 0
  const visibleGroups = displayGroups.filter(g => {
    if (filterVision && !g.members.some(m => m.supportsVision)) return false
    if (filterTools && !g.members.some(m => m.supportsTools)) return false
    if (minContext > 0 && groupMaxContext(g.members) < minContext) return false
    if (query) {
      const hay = [
        g.label,
        g.members[0].canonicalId ?? '',
        ...g.members.map(m => m.platform),
        ...g.members.map(m => m.displayName),
        ...g.members.map(m => m.modelId),
      ].join(' ').toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  })
  const draggable = isManual && !filtersActive

  // Probe list: every configured model behind the visible groups. Drives the
  // "全部测试" button — results sync to /dashboard via the shared ['fallback']
  // query (the probe hook invalidates it).
  const probeList = useMemo(() => {
    const list: { modelDbId: number; platform: string; modelId: string }[] = []
    for (const g of visibleGroups) {
      for (const m of g.members) {
        list.push({ modelDbId: m.modelDbId, platform: m.platform, modelId: m.modelId })
        if (list.length >= 300) return list
      }
    }
    return list
  }, [visibleGroups])

  // Group probe state: prefers an "ok" member (the group is healthy if any
  // provider answers); otherwise the most recent non-probing result. Returns
  // 'probing' when every member is still mid-probe.
  const groupProbeState = useCallback((g: ModelGroupRow): { status?: string; latency?: number } => {
    const results = g.members.map(m => probeResults.get(m.modelDbId)).filter(Boolean)
    if (results.length === 0) return {}
    const ok = results.find(r => r!.status === 'ok' || r!.status === 'success')
    if (ok) return { status: ok!.status, latency: ok!.latency }
    if (results.every(r => r!.status === 'probing')) return { status: 'probing' }
    const latest = results[results.length - 1]!
    return { status: latest.status, latency: latest.latency }
  }, [probeResults])

  const handleProbeGroup = useCallback((g: ModelGroupRow) => {
    const list = g.members.map(m => ({ modelDbId: m.modelDbId, platform: m.platform, modelId: m.modelId }))
    doProbeGroup(g.label, list)
  }, [doProbeGroup])

  // Progressive rendering: grow the row budget whenever the sentinel below the
  // table scrolls near the viewport (drag autoscroll extends it too).
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK)
  const renderedGroups = visibleGroups.slice(0, renderLimit)
  const hasMoreRows = visibleGroups.length > renderLimit
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hasMoreRows) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      hits => {
        if (hits.some(h => h.isIntersecting)) setRenderLimit(l => l + RENDER_CHUNK)
      },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMoreRows, renderLimit])

  function clearFilters() {
    setSearch('')
    setFilterVision(false)
    setFilterTools(false)
    setMinContext(0)
  }

  function handleGroupToggle(memberIds: number[], enabled: boolean) {
    const ids = new Set(memberIds)
    setLocalEntries(allEntries.map(e => (ids.has(e.modelDbId) ? { ...e, enabled } : e)))
  }

  // Serialize the displayed group order (group-major, member-minor) to the flat
  // priority list PUT /api/fallback expects; keyless rows keep their tail spot.
  function persistGroupOrder(groups: ModelGroupRow[]) {
    const order: number[] = []
    for (const g of groups) for (const m of g.members) order.push(m.modelDbId)
    const unconfigured = allEntries.filter(e => e.keyCount === 0).map(e => e.modelDbId)
    const prio = new Map([...order, ...unconfigured].map((id, i) => [id, i + 1]))
    setLocalEntries(allEntries.map(e => ({ ...e, priority: prio.get(e.modelDbId) ?? e.priority })))
  }

  // Reorder models (the failover priority order). Providers within a model are
  // ordered by the active strategy and managed on the model's own page.
  function handleGroupedDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldI = orderedGroups.findIndex(g => `grp:${g.key}` === String(active.id))
    const newI = orderedGroups.findIndex(g => `grp:${g.key}` === String(over.id))
    if (oldI < 0 || newI < 0) return
    persistGroupOrder(arrayMove(orderedGroups, oldI, newI))
  }

  function doDeleteGroup(group: ModelGroupRow) {
    if (deletingGroup === group.key) {
      Promise.all(group.members.map(m =>
        apiFetch(`/api/models/${m.modelDbId}`, { method: 'DELETE' })
      )).then(() => {
        queryClient.invalidateQueries({ queryKey: ['fallback'] })
        queryClient.invalidateQueries({ queryKey: ['models'] })
        queryClient.invalidateQueries({ queryKey: ['health'] })
        queryClient.invalidateQueries({ queryKey: ['routing-status'] })
        queryClient.invalidateQueries({ queryKey: ['model-catalog-platforms'] })
        setDeletingGroup(null)
      }).catch(() => setDeletingGroup(null))
    } else {
      setDeletingGroup(group.key)
      setTimeout(() => setDeletingGroup(prev => prev === group.key ? null : prev), 3000)
    }
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return
    Promise.all([...selectedIds].map(id =>
      apiFetch(`/api/models/${id}`, { method: 'DELETE' })
    )).then(() => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['routing-status'] })
      queryClient.invalidateQueries({ queryKey: ['model-catalog-platforms'] })
      setSelectedIds(new Set())
      setBatchMode(false)
    })
  }

  function handleRankEditClick(group: ModelGroupRow) {
    setEditingRankKey(group.key)
    setEditRankValue(String(rankByKey.get(group.key) ?? 1))
  }

  function handleRankEditSubmit(key: string) {
    const targetRank = parseInt(editRankValue)
    setEditingRankKey(null)
    if (isNaN(targetRank) || targetRank < 1 || targetRank > orderedGroups.length) return
    const idx = orderedGroups.findIndex(g => g.key === key)
    if (idx < 0) return
    const newGroups = [...orderedGroups]
    const g = newGroups.splice(idx, 1)[0]
    newGroups.splice(Math.min(targetRank - 1, newGroups.length), 0, g)
    persistGroupOrder(newGroups)
  }

  return (
    <div>
      <PageHeader
        title={t('models.title')}
        description={t('strategies.description')}
        divider={false}
        actions={<ModelsTabs />}
      />

      <div className="space-y-6">
        {/* First-run checklist: hides itself once the install has keys + a request */}
        <GettingStarted />

        {/* Monthly token budget — moved to the top */}
        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

        {/* Strategy selector */}
        <section className="rounded-3xl border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium">{t('strategies.title')}</h2>
            {routing?.weights && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('strategies.weightsSummary', {
                  reliability: Math.round(routing.weights.reliability * 100),
                  speed: Math.round(routing.weights.speed * 100),
                  intelligence: Math.round(routing.weights.intelligence * 100),
                })}
              </span>
            )}
          </div>

          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border p-1">
            {STRATEGIES.map(s => (
              <Tooltip key={s.key} text={t(`strategies.${s.tKey}Blurb`)}>
                <button
                  disabled={strategyMutation.isPending}
                  onClick={() => strategyMutation.mutate({ strategy: s.key })}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    s.key === strategy
                      ? 'bg-foreground text-background font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {t(`strategies.${s.tKey}`)}
                </button>
              </Tooltip>
            ))}
            {strategy === 'custom' && routing && (
              <CustomWeightsPopover
                saved={routing.customWeights}
                saving={strategyMutation.isPending}
                onSave={w => strategyMutation.mutate({ strategy: 'custom', weights: w })}
              />
            )}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            {isManual ? t('strategies.modeManualHint') : t('strategies.modeScoreHint')}
          </p>
        </section>

        <PenaltyInspector />

        {/* Routing groups tab bar */}
        <section className="rounded-3xl border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between mb-3">
            <h2 className="text-sm font-medium">路由组</h2>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {ROUTING_PROFILES.filter(p => p.key !== 'default').map(p => {
                const s = statusByGroup.get(p.key)
                if (!s) return null
                return (
                  <span key={p.key} className="tabular-nums">
                    {p.key}↑{s.servable ?? '?'}
                  </span>
                )
              })}
            </div>
          </div>
          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border p-1">
            {ROUTING_PROFILES.map(p => {
              const s = statusByGroup.get(p.key)
              const servable = s?.servable ?? '?'
              const topName = s?.top?.displayName ?? ''
              const isActive = activeProfile === p.key
              const label = p.key === 'default' ? 'Default (AUTO)' : `${p.key} (${servable})`
              return (
                <button
                  key={p.key}
                  onClick={() => {
                    if (hasChanges && !window.confirm('放弃未保存的更改？')) return
                    setActiveProfile(p.key)
                  }}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    isActive
                      ? 'bg-foreground text-background font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                  title={topName ? `Top: ${topName}` : undefined}
                >
                  {label}
                  {topName && isActive && (
                    <span className="ml-1.5 opacity-60 font-normal">↑ {topName}</span>
                  )}
                </button>
              )
            })}
          </div>
          {!isDefaultTab && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              编辑 {activeProfile} 路由组顺序。Auto 请求用 {activeProfile} 组的排列。
              修改 Default 不会影响 {activeProfile}。
            </p>
          )}
        </section>

        {/* Unified routing / fallback table */}
        {isLoading ? (
          <TableSkeleton rows={8} />
        ) : displayGroups.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={t('models.noModelsTitle')}
            description={<>{t('models.noModelsBefore')}<Link to="/keys" className="underline text-foreground">{t('models.keysPageLink')}</Link>{t('models.noModelsAfter')}</>}
            action={
              <Link to="/keys">
                <Button size="sm">{t('setup.step1Cta')}</Button>
              </Link>
            }
          />
        ) : (
          <>
            {/* Catalog toolbar: search + capability/context filters (#343) */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={t('models.searchPlaceholder')}
                  aria-label={t('models.searchPlaceholder')}
                  className="w-full rounded-xl border bg-card py-1.5 pl-9 pr-8 text-sm outline-none transition-colors focus:border-foreground/30"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    aria-label={t('models.clearSearch')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setFilterVision(v => !v)}
                  aria-pressed={filterVision}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${filterVision ? 'bg-foreground text-background border-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {t('models.vision')}
                </button>
                <button
                  onClick={() => setFilterTools(v => !v)}
                  aria-pressed={filterTools}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${filterTools ? 'bg-foreground text-background border-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {t('models.tools')}
                </button>
                <div className="inline-flex items-center gap-1 rounded-xl border p-1" role="group" aria-label={t('models.ctxTitle')}>
                  {CTX_BUCKETS.map(b => (
                    <button
                      key={b.key}
                      onClick={() => setMinContext(b.key)}
                      className={`px-2.5 py-1 text-xs rounded-lg transition-colors tabular-nums ${minContext === b.key ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                    >
                      {b.tKey ? t(`models.${b.tKey}`) : b.label}
                    </button>
                  ))}
                </div>
                {!showDisabled && displayGroups.length < orderedGroups.length && (
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    已隐藏 {orderedGroups.length - displayGroups.length} 个
                  </span>
                )}
                <button
                  onClick={() => setShowDisabled(s => !s)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors whitespace-nowrap ${showDisabled ? 'bg-foreground text-background border-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {showDisabled ? '隐藏已关闭' : '显示已关闭'}
                </button>
                <button
                  onClick={() => { setBatchMode(v => !v); if (batchMode) setSelectedIds(new Set()) }}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${batchMode ? 'bg-[#f87171]/10 border-[#f87171]/30 text-[#f87171] font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {batchMode ? '退出选择' : '选择'}
                </button>
                <button
                  onClick={() => doProbeAll(probeList)}
                  disabled={probingAll || probeList.length === 0}
                  className="px-3 py-1.5 text-xs rounded-lg border border-foreground/20 text-foreground bg-card hover:bg-muted disabled:opacity-50 font-medium inline-flex items-center gap-1.5"
                  title={probeProgress || `测试全部 ${probeList.length} 个模型`}
                >
                  {probingAll ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  {probingAll ? '测试中…' : '全部测试'}
                </button>
                <Link to="/dashboard">
                  <button className="px-3 py-1.5 text-xs rounded-lg border border-foreground/20 text-foreground bg-card hover:bg-muted font-medium inline-flex items-center gap-1.5">
                    <Activity className="size-3.5" />
                    Status
                  </button>
                </Link>
              </div>
            </div>

            {probeProgress && (
              <div className="text-xs text-muted-foreground tabular-nums">{probeProgress}</div>
            )}

            {filtersActive && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t('models.showingCount', { shown: visibleGroups.length, total: displayGroups.length })}</span>
                <button onClick={clearFilters} className="underline hover:text-foreground">{t('models.clearFilters')}</button>
              </div>
            )}

            {/* DndContext must wrap OUTSIDE the table: it renders hidden a11y
                live-region <div>s, which are invalid as direct <table> children. */}
            {visibleGroups.length === 0 ? (
              <EmptyState
                title={t('models.noMatches')}
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>{t('models.clearFilters')}</Button>
                }
              />
            ) : draggable ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupedDragEnd}>
                <div className="rounded-2xl border overflow-x-auto">
                  <table className="w-full text-sm">
                    <ModelTableHead showProbe />
                    <SortableContext items={renderedGroups.map(g => `grp:${g.key}`)} strategy={verticalListSortingStrategy}>
                      <tbody>
                        {renderedGroups.map(g => {
                          const ps = groupProbeState(g)
                          return (
                          <SortableGroupRow key={g.key} group={g} rank={rankByKey.get(g.key) ?? 0} onToggleGroup={handleGroupToggle}
                            onDeleteGroup={doDeleteGroup}
                            batchMode={batchMode}
                            selectedIds={selectedIds}
                            onToggleSelect={id => setSelectedIds(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })}
                            editingRankId={editingRankKey}
                            editRankValue={editRankValue}
                            onEditChange={setEditRankValue}
                            onEditClick={() => handleRankEditClick(g)}
                            onEditSubmit={handleRankEditSubmit}
                            deletingKey={deletingGroup}
                            probeStatus={ps.status}
                            probeLatency={ps.latency}
                            avgLatency={groupLatencyFor(g.members)}
                            onProbeGroup={handleProbeGroup}
                            probingAll={probingAll}
                            showProbe
                          />
                          )
                        })}
                      </tbody>
                    </SortableContext>
                  </table>
                </div>
              </DndContext>
            ) : (
              <div className="rounded-2xl border overflow-x-auto">
                <table className="w-full text-sm">
                  <ModelTableHead showProbe />
                  <tbody>
                    {renderedGroups.map(g => (
                      <tr
                        key={g.key}
                        onClick={() => navigate(`/models/chat/${encodeURIComponent(g.members[0].canonicalId ?? g.members[0].modelId)}`)}
                        className={`group/row border-b last:border-0 cursor-pointer transition-colors hover:[&>td]:bg-muted/50 [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg ${g.members.some(m => m.enabled) ? '' : 'opacity-50'}`}
                      >
                        {(() => { const ps = groupProbeState(g); return (
                        <GroupHeaderCells group={g} rank={rankByKey.get(g.key) ?? 0} onToggleGroup={handleGroupToggle}
                          onDeleteGroup={doDeleteGroup}
                          batchMode={batchMode}
                          selected={g.members.some(m => selectedIds.has(m.modelDbId))}
                          onToggleSelect={id => setSelectedIds(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })}
                          editingRank={editingRankKey === g.key}
                          editValue={editRankValue}
                          onEditChange={setEditRankValue}
                          onEditClick={() => handleRankEditClick(g)}
                          onEditSubmit={() => handleRankEditSubmit(g.key)}
                          deletingKey={deletingGroup}
                          probeStatus={ps.status}
                          probeLatency={ps.latency}
                          avgLatency={groupLatencyFor(g.members)}
                          onProbeGroup={handleProbeGroup}
                          probingAll={probingAll}
                          showProbe
                        />
                        ) })()}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Invisible sentinel: when it nears the viewport the next row chunk
                renders. Present only while rows remain, so IO never fires idle. */}
            {hasMoreRows && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}

            {/* Floating action bar — fixed to the viewport so it's always visible,
                sliding up when there are unsaved changes and back down on save/discard. */}
            <FloatingBar show={hasChanges}>
              <span className="text-xs text-muted-foreground">{t('common.unsavedChanges')}</span>
              <Button variant="outline" size="sm" onClick={() => setLocalEntries(null)}>{t('common.discard')}</Button>
              <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('common.saving') : t('common.saveChanges')}
              </Button>
            </FloatingBar>

            {/* Batch delete floating bar */}
            {batchMode && (
              <FloatingBar show={batchMode}>
                <span className="text-xs text-muted-foreground">{selectedIds.size} 个模型已选择</span>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">加入</span>
                    {['high', 'mid', 'light'].map(p => (
                      <Button key={p} size="sm" variant="outline"
                        onClick={() => membershipMutation.mutate({ modelDbIds: [...selectedIds], add: [p], remove: [] })}
                        disabled={membershipMutation.isPending}
                        className="text-xs"
                      >
                        {p}
                      </Button>
                    ))}
                  </div>
                )}
                <Button variant="outline" size="sm" onClick={() => { setBatchMode(false); setSelectedIds(new Set()) }}>取消</Button>
                <Button size="sm" onClick={deleteSelected} disabled={selectedIds.size === 0} className="bg-[#f87171] hover:bg-[#ef4444] text-white">
                  删除选中
                </Button>
              </FloatingBar>
            )}

            {unconfiguredPlatforms.length > 0 && (
              <p className="text-xs text-muted-foreground">{t('models.hiddenNoKeys', { platforms: unconfiguredPlatforms.join(', ') })}</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
