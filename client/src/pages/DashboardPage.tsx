import { useMemo, useState, useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, RefreshCw, Play, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useProbe } from '@/lib/use-probe'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import {
  dashboardHealthTone,
  isDashboardHealthy,
  isDashboardIssue,
  isDashboardLimited,
  type DashboardHealthKey,
} from '@/lib/dashboard-health'

const HEALTH_LABEL: Record<DashboardHealthKey, string> = {
  ok: '健康',
  error: '错误',
  limited: '限流',
  probing: '探测中',
  disabled: '已关闭',
  unknown: '待探测',
}

// Probes run every 6h, so a 24h window leaves ~4 samples — too sparse to read
// as a bar. 7 days at one slot per probe is what makes the strip legible.
const UPTIME_WINDOW_HOURS = 168
const UPTIME_SLOTS = 28

interface ProbeHistoryItem {
  modelDbId: number
  modelId: string
  status: string
  latency: number
  error: string | null
  time: string
}

export default function DashboardPage() {
  const qc = useQueryClient()

  const { data: fallbackRaw, isLoading } = useQuery<any[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
    refetchInterval: 30_000,
  })

  const { data: healthRaw } = useQuery<any[]>({
    queryKey: ['health', 'models'],
    queryFn: () => apiFetch('/api/fallback/health'),
    refetchInterval: 30_000,
  })

  const { data: probeHistory } = useQuery<{ platforms: Record<string, ProbeHistoryItem[]> }>({
    queryKey: ['probe-history'],
    queryFn: () => apiFetch(`/api/fallback/probe-history?hours=${UPTIME_WINDOW_HOURS}&perPlatform=1200`),
    refetchInterval: 60_000,
  })

  const healthMap = new Map<number, string>()
  if (healthRaw) for (const h of healthRaw) healthMap.set(h.modelDbId, h.healthStatus)

  const entries: any[] = []
  if (fallbackRaw) for (const fb of fallbackRaw) entries.push({ ...fb, healthStatus: healthMap.get(fb.modelDbId) ?? 'unknown' })

  const { probeResults, probingAll, probeProgress, doProbe, doProbeAll, doProbeGroup } = useProbe()
  const [expandedModel, setExpandedModel] = useState<number | null>(null)
  const [showDisabled, setShowDisabled] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    const saved = localStorage.getItem('dashboard-collapsed-platforms')
    if (saved) {
      try {
        return new Set(JSON.parse(saved))
      } catch {
        return new Set()
      }
    }
    // Default: All collapsed
    return new Set()
  })
  const [deletingId, setDeletingId] = useState<string | number | null>(null)

  // Build per-model history lookup: modelDbId → ProbeHistoryItem[]
  const modelHistoryMap = useMemo(() => {
    const map = new Map<number, ProbeHistoryItem[]>()
    if (!probeHistory?.platforms) return map
    for (const history of Object.values(probeHistory.platforms)) {
      for (const h of history) {
        if (h.modelDbId == null) continue
        if (!map.has(h.modelDbId)) map.set(h.modelDbId, [])
        map.get(h.modelDbId)!.push(h)
      }
    }
    return map
  }, [probeHistory])

  const patchEnabledInCache = useCallback((modelDbId: number, enabled: boolean) => {
    qc.setQueryData<any[]>(['fallback'], (old) => {
      if (!old) return old
      return old.map(row => row.modelDbId === modelDbId ? { ...row, enabled } : row)
    })
  }, [qc])

  const doToggle = useCallback(async (modelDbId: number, currentEnabled: boolean) => {
    const newEnabled = !currentEnabled
    // Optimistic update
    patchEnabledInCache(modelDbId, newEnabled)
    try {
      await apiFetch(`/api/models/${modelDbId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: newEnabled, fallbackEnabled: newEnabled }),
      })
      qc.invalidateQueries({ queryKey: ['fallback'] })
      qc.invalidateQueries({ queryKey: ['models'] })
      qc.invalidateQueries({ queryKey: ['routing-status'] })
    } catch {
      // Revert on error
      patchEnabledInCache(modelDbId, currentEnabled)
    }
  }, [patchEnabledInCache, qc])

  const doDeleteGroup = useCallback(async (platform: string, models: any[]) => {
    if (deletingId === platform) { // Use platform string as group id
      try {
        await Promise.all(models.map(m => apiFetch(`/api/models/${m.modelDbId}`, { method: 'DELETE' })))
        qc.invalidateQueries({ queryKey: ['fallback'] })
        qc.invalidateQueries({ queryKey: ['models'] })
        qc.invalidateQueries({ queryKey: ['health'] })
        qc.invalidateQueries({ queryKey: ['routing-status'] })
        qc.invalidateQueries({ queryKey: ['model-catalog-platforms'] })
      } catch { /* ignore */ }
      setDeletingId(null)
    } else {
      setDeletingId(platform)
      setTimeout(() => setDeletingId(prev => prev === platform ? null : prev), 3000)
    }
  }, [deletingId, qc])

  const filtered = showDisabled ? entries : entries.filter(e => e.enabled)

  const groups = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const e of filtered) {
      const p = e.platform || 'unknown'
      if (!map.has(p)) map.set(p, [])
      map.get(p)!.push(e)
    }
    return [...map.entries()]
      .map(([platform, models]) => ({ platform, models }))
      .sort((a, b) => b.models.length - a.models.length || a.platform.localeCompare(b.platform))
  }, [filtered])

  // Default: All platforms collapsed initially if no memory
  useEffect(() => {
    if (typeof window !== 'undefined' && !localStorage.getItem('dashboard-collapsed-platforms')) {
      const allPlatforms = groups.map(g => g.platform)
      setCollapsed(new Set(allPlatforms))
      localStorage.setItem('dashboard-collapsed-platforms', JSON.stringify(allPlatforms))
    }
  }, [groups])

  const probeList = useMemo(() => {
    const list: { modelDbId: number; platform: string; modelId: string }[] = []
    for (const g of groups) {
      for (const m of g.models) {
        list.push({ modelDbId: m.modelDbId, platform: m.platform, modelId: m.modelId })
        if (list.length >= 300) return list
      }
    }
    return list
  }, [groups])

  const handleProbeAll = useCallback(() => doProbeAll(probeList), [doProbeAll, probeList])

  const handleProbePlatform = useCallback((platform: string, models: any[]) => {
    const list = models.map(m => ({ modelDbId: m.modelDbId, platform: m.platform, modelId: m.modelId }))
    doProbeGroup(platform, list)
  }, [doProbeGroup])

  const totalOn = entries.filter(e => e.enabled).length
  const totalOff = entries.filter(e => !e.enabled).length
  const liveStatus = (e: any) => probeResults.get(e.modelDbId)?.status || e.healthStatus
  const healthy = entries.filter(e => isDashboardHealthy(liveStatus(e))).length
  const issueCount = entries.filter(e => isDashboardIssue(liveStatus(e))).length
  const limitedCount = entries.filter(e => isDashboardLimited(liveStatus(e))).length
  const overallTone = dashboardHealthTone(
    issueCount > 0 ? 'error' : limitedCount > 0 ? 'rate_limited' : 'ok',
  )

  function toggleGroup(platform: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(platform)) next.delete(platform)
      else next.add(platform)
      localStorage.setItem('dashboard-collapsed-platforms', JSON.stringify([...next]))
      return next
    })
  }

  // ── Uptime strip per model ──────────────────────────────────────────
  // One slot per probe, newest on the right, padded on the left so every
  // model's strip spans the same width no matter how much history it has.
  function UptimeBar({ history }: { history: ProbeHistoryItem[] | undefined }) {
    const recent = history ? [...history].reverse().slice(-UPTIME_SLOTS) : []
    const padding = UPTIME_SLOTS - recent.length
    return (
      <div className="mt-2 flex h-7 items-stretch gap-[3px]">
        {Array.from({ length: padding }, (_, i) => (
          <div key={`pad-${i}`} className="min-w-0 flex-1 rounded-[2px] bg-muted/50" title="无探测数据" />
        ))}
        {recent.map((h, i) => (
          <div
            key={i}
            className="min-w-0 flex-1 rounded-[2px]"
            style={{ backgroundColor: dashboardHealthTone(h.status).color }}
            title={`${h.status} · ${h.latency}ms · ${h.time || ''}`}
          />
        ))}
      </div>
    )
  }

  function uptimePercent(history: ProbeHistoryItem[] | undefined): number | null {
    if (!history || history.length === 0) return null
    const ok = history.filter(h => isDashboardHealthy(h.status)).length
    return Math.round((ok / history.length) * 1000) / 10
  }

  function renderRow(entry: any) {
    const pr = probeResults.get(entry.modelDbId)
    const isExpanded = expandedModel === entry.modelDbId
    const status = pr?.status || entry.healthStatus
    const probing = pr?.status === 'probing'
    const color = dashboardHealthTone(status).color
    const isEnabled = pr && pr.enabled !== undefined ? pr.enabled : entry.enabled
    // 24h average latency (server-computed from probe history). The mini
    // timeline still uses the local probe-history cache; the number beside
    // it is the authoritative value the server ships with /api/fallback.
    const ls = entry.latencyStats
    const avgMs = ls?.avgMs ?? 0
    const avgN = ls?.sampleCount ?? 0

    const history = modelHistoryMap.get(entry.modelDbId)
    const uptime = uptimePercent(history)
    const tone = dashboardHealthTone(probing ? 'probing' : status)

    return (
      <div
        key={entry.modelDbId}
        className="border-b border-border/20 px-3 py-3 last:border-0"
        style={{ opacity: isEnabled ? 1 : 0.45 }}
      >
        <div
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 cursor-pointer"
          onClick={() => setExpandedModel(isExpanded ? null : entry.modelDbId)}
        >
          {probing ? (
            <RefreshCw className="size-3 shrink-0 self-center animate-spin" style={{ color }} />
          ) : (
            <span className="size-2.5 shrink-0 self-center rounded-full" style={{ backgroundColor: color }} />
          )}
          {/* Display names are unified across providers, so several rows under
              different providers read identically ("GLM-5", "GLM-5"). The real
              provider-side model id — the one with the slash — is what tells
              them apart. It gets the full row width here so it is never cut
              off; only the status/controls sit to its right. */}
          <span className="text-sm font-medium">{entry.displayName || entry.modelId}</span>
          {entry.displayName && entry.modelId && entry.displayName !== entry.modelId && (
            <span className="font-mono text-[11px] font-normal text-muted-foreground break-all">
              {entry.modelId}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <span className="text-[11px]" style={{ color: tone.color }}>
              {HEALTH_LABEL[tone.key]}
            </span>
            <span
              className="text-[11px] text-muted-foreground tabular-nums"
              title={avgN > 0 ? `24h 平均延迟（${avgN} 次成功探测）` : '24h 内无成功探测'}
            >
              {avgN > 0 ? `24h ${avgMs}ms` : '—'}
            </span>
            <button
              onClick={e => { e.stopPropagation(); doToggle(entry.modelDbId, isEnabled) }}
              disabled={probing || probingAll}
              className={`text-[10px] px-2 py-0.5 rounded border ${
                isEnabled
                  ? 'bg-[#4ade80]/10 border-[#4ade80]/30 text-[#4ade80]'
                  : 'bg-[#f87171]/10 border-[#f87171]/30 text-[#f87171]'
              }`}
            >
              {isEnabled ? '开' : '关'}
            </button>
            <button
              onClick={e => { e.stopPropagation(); doProbe(entry.modelDbId) }}
              disabled={probing || probingAll}
              className="text-[10px] px-2 py-0.5 rounded border bg-card hover:bg-muted disabled:opacity-30"
            >
              {probing ? '…' : '测试'}
            </button>
            <button
              onClick={e => { e.stopPropagation(); doDeleteGroup(entry.platform, [entry]) }}
              disabled={probing || probingAll}
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                deletingId === entry.platform
                  ? 'bg-[#f87171]/20 border border-[#f87171]/50 text-[#f87171]'
                  : 'border border-transparent text-muted-foreground hover:text-[#f87171] hover:border-[#f87171]/30'
              }`}
            >
              {deletingId === entry.platform ? '确认?' : <Trash2 className="size-3" />}
            </button>
          </span>
        </div>
        <UptimeBar history={history} />
        <div className="mt-1.5 flex items-center text-[10px] text-muted-foreground">
          <span>7 天前</span>
          <span className="mx-auto text-foreground/70">
            {uptime === null ? '暂无探测样本' : `成功率 ${uptime}%`}
          </span>
          <span>现在</span>
        </div>
        {isExpanded && pr && pr.error && (
          <pre className="mt-2 text-[10px] text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
            {pr.error}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold">模型状态监控</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {entries.length} 个模型 · {healthy} 健康 · {totalOn} 开启 · {totalOff} 关闭 · {groups.length} 个供应商
            {probeProgress ? ` · ${probeProgress}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDisabled(v => !v)}
            className="text-[11px] px-2.5 py-1.5 rounded-lg border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {showDisabled ? '隐藏已关闭' : '显示已关闭'}
          </button>
          <Button size="sm" variant="outline" onClick={handleProbeAll} disabled={probingAll || probeList.length === 0}>
            {probingAll ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {probingAll ? '测试中…' : '全部测试'}
          </Button>
        </div>
      </div>

      {/* Overall banner, the way a public status page opens with one verdict
          before the per-component detail. */}
      {entries.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3.5"
          style={{
            borderColor: `${overallTone.color}47`,
            backgroundColor: `${overallTone.color}17`,
          }}
        >
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: overallTone.color }} />
          <b className="text-sm font-semibold">
            {issueCount === 0
              ? `全部 ${entries.length} 个模型运行正常`
              : `${entries.length} 个模型中 ${healthy} 个健康运行`}
          </b>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {issueCount > 0 ? `${issueCount} 异常 · ` : ''}
            {limitedCount > 0 ? `${limitedCount} 限流 · ` : ''}
            {totalOff} 已关闭 · {groups.length} 个供应商
          </span>
        </div>
      )}

      <div className="flex gap-4 text-[10px] text-muted-foreground flex-wrap items-center">
        <span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-[#4ade80]" /> 成功</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-[#fbbf24]" /> 限流</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-[#f87171]" /> 失败</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-muted" /> 无数据</span>
        <span>← 最早 · 最新 → 每格一次探测，共 7 天</span>
      </div>

      <p className="text-[11px] text-muted-foreground">
        点行展开错误详情。点开关按钮直接启用/禁用模型。点测试直连上游验证。
      </p>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">加载中…</div>
      ) : groups.length === 0 ? (
        <EmptyState icon={Activity} title="暂无模型" description="请先添加 API 密钥。" />
      ) : (
        <div className="space-y-3">
          {groups.map(g => {
            const isCollapsed = collapsed.has(g.platform)
            const onCount = g.models.filter(m => {
              const pr = probeResults.get(m.modelDbId)
              return pr?.enabled !== undefined ? pr.enabled : m.enabled
            }).length
            const okCount = g.models.filter(m => {
              const pr = probeResults.get(m.modelDbId)
              const s = pr?.status || m.healthStatus
              return isDashboardHealthy(s)
            }).length
            const errCount = g.models.filter(m => {
              const pr = probeResults.get(m.modelDbId)
              const s = pr?.status || m.healthStatus
              return isDashboardIssue(s)
            }).length
            const limitedCount = g.models.filter(m => {
              const pr = probeResults.get(m.modelDbId)
              const s = pr?.status || m.healthStatus
              return isDashboardLimited(s)
            }).length

            return (
              <div key={g.platform} className="rounded-xl border bg-card overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border/40">
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.platform)}
                    className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                  >
                    {isCollapsed
                      ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                      : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="text-sm font-medium truncate">{g.platform}</span>
                    <span className="text-[11px] text-muted-foreground shrink-0">
                      {g.models.length} · 开 {onCount} · 健康 {okCount}
                      {limitedCount > 0 ? ` · 限流 ${limitedCount}` : ''}
                      {errCount > 0 ? ` · 错 ${errCount}` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={probingAll}
                    onClick={() => handleProbePlatform(g.platform, g.models)}
                    className="text-[10px] px-2 py-0.5 rounded border bg-card hover:bg-muted disabled:opacity-30 shrink-0"
                  >
                    测本组
                  </button>
                  <button
                    type="button"
                    disabled={probingAll}
                    onClick={() => doDeleteGroup(g.platform, g.models)}
                    className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ml-1 transition-colors ${
                      deletingId === g.platform
                        ? 'bg-[#f87171]/20 border border-[#f87171]/30 text-[#f87171]'
                        : 'border border-transparent text-muted-foreground hover:text-[#f87171] hover:border-[#f87171]/30'
                    }`}
                  >
                    {deletingId === g.platform ? '确认?' : <Trash2 className="size-3.5" />}
                  </button>
                </div>
                {!isCollapsed && (
                  <div className="px-1 py-0.5">
                    {g.models.map(renderRow)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
