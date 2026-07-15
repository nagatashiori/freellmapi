import { useMemo, useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, RefreshCw, Play, ChevronDown, ChevronRight } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

interface ProbeResult {
  modelDbId: number
  platform: string
  modelId: string
  status: string
  latency: number
  error: string
  enabled?: boolean
}

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
    queryFn: () => apiFetch('/api/fallback/probe-history?hours=24&perPlatform=200'),
    refetchInterval: 60_000,
  })

  const healthMap = new Map<number, string>()
  if (healthRaw) for (const h of healthRaw) healthMap.set(h.modelDbId, h.healthStatus)

  const entries: any[] = []
  if (fallbackRaw) for (const fb of fallbackRaw) entries.push({ ...fb, healthStatus: healthMap.get(fb.modelDbId) ?? 'unknown' })

  const [probeResults, setProbeResults] = useState<Map<number, ProbeResult>>(new Map())
  const [probingAll, setProbingAll] = useState(false)
  const [probeProgress, setProbeProgress] = useState('')
  const [expandedModel, setExpandedModel] = useState<number | null>(null)
  const [showDisabled, setShowDisabled] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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

  const refreshLists = useCallback(() => {
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: ['health'] })
      qc.invalidateQueries({ queryKey: ['fallback'] })
    }, 400)
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
    } catch {
      // Revert on error
      patchEnabledInCache(modelDbId, currentEnabled)
    }
  }, [patchEnabledInCache, qc])

  const applyProbeResult = useCallback((res: ProbeResult) => {
    setProbeResults(prev => new Map(prev).set(res.modelDbId, res))
    if (typeof res.enabled === 'boolean') {
      patchEnabledInCache(res.modelDbId, res.enabled)
    } else if (res.status === 'ok' || res.status === 'success') {
      patchEnabledInCache(res.modelDbId, true)
    } else if (res.status === 'error' || res.status === 'timeout') {
      patchEnabledInCache(res.modelDbId, false)
    }
  }, [patchEnabledInCache])

  const doProbe = useCallback(async (modelDbId: number) => {
    setProbeResults(prev => new Map(prev).set(modelDbId, {
      modelDbId, platform: '', modelId: '', status: 'probing', latency: 0, error: '',
    }))
    try {
      const res = await apiFetch(`/api/fallback/probe/${modelDbId}`, { method: 'POST' }) as ProbeResult
      applyProbeResult(res)
      refreshLists()
    } catch (e: any) {
      setProbeResults(prev => new Map(prev).set(modelDbId, {
        modelDbId, platform: '', modelId: '', status: 'error', latency: 0, error: e.message, enabled: false,
      }))
      patchEnabledInCache(modelDbId, false)
    }
  }, [applyProbeResult, refreshLists, patchEnabledInCache])

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

  const probeList = useMemo(() => {
    const list: any[] = []
    for (const g of groups) {
      for (const m of g.models) {
        list.push(m)
        if (list.length >= 300) return list
      }
    }
    return list
  }, [groups])

  const doProbeAll = useCallback(async () => {
    const list = probeList
    if (list.length === 0) return
    setProbingAll(true)
    let ok = 0, err = 0, limited = 0
    setProbeProgress(`0/${list.length}`)

    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      setProbeResults(prev => new Map(prev).set(e.modelDbId, {
        modelDbId: e.modelDbId, platform: e.platform, modelId: e.modelId,
        status: 'probing', latency: 0, error: '',
      }))
      setProbeProgress(`${i + 1}/${list.length} · ${ok} 成功 · ${err} 失败 · ${limited} 限流`)
      try {
        const res = await apiFetch(`/api/fallback/probe/${e.modelDbId}`, { method: 'POST' }) as ProbeResult
        applyProbeResult(res)
        if (res.status === 'ok' || res.status === 'success') ok++
        else if (res.status === 'rate_limited') limited++
        else err++
      } catch (ex: any) {
        setProbeResults(prev => new Map(prev).set(e.modelDbId, {
          modelDbId: e.modelDbId, platform: e.platform, modelId: e.modelId,
          status: 'error', latency: 0, error: ex.message || 'request failed', enabled: false,
        }))
        patchEnabledInCache(e.modelDbId, false)
        err++
      }
      await new Promise(r => setTimeout(r, 200))
    }
    setProbeProgress(`完成 · ${list.length} · ${ok} 成功 · ${err} 失败 · ${limited} 限流`)
    refreshLists()
    setProbingAll(false)
  }, [probeList, applyProbeResult, refreshLists, patchEnabledInCache])

  const doProbePlatform = useCallback(async (platform: string, models: any[]) => {
    if (models.length === 0 || probingAll) return
    setProbingAll(true)
    let ok = 0, err = 0, limited = 0
    setProbeProgress(`${platform}: 0/${models.length}`)
    for (let i = 0; i < models.length; i++) {
      const e = models[i]
      setProbeResults(prev => new Map(prev).set(e.modelDbId, {
        modelDbId: e.modelDbId, platform: e.platform, modelId: e.modelId,
        status: 'probing', latency: 0, error: '',
      }))
      setProbeProgress(`${platform}: ${i + 1}/${models.length} · ${ok} 成功 · ${err} 失败`)
      try {
        const res = await apiFetch(`/api/fallback/probe/${e.modelDbId}`, { method: 'POST' }) as ProbeResult
        applyProbeResult(res)
        if (res.status === 'ok' || res.status === 'success') ok++
        else if (res.status === 'rate_limited') limited++
        else err++
      } catch (ex: any) {
        setProbeResults(prev => new Map(prev).set(e.modelDbId, {
          modelDbId: e.modelDbId, platform: e.platform, modelId: e.modelId,
          status: 'error', latency: 0, error: ex.message || 'request failed', enabled: false,
        }))
        patchEnabledInCache(e.modelDbId, false)
        err++
      }
      await new Promise(r => setTimeout(r, 200))
    }
    setProbeProgress(`${platform} 完成 · ${ok} 成功 · ${err} 失败 · ${limited} 限流`)
    refreshLists()
    setProbingAll(false)
  }, [probingAll, applyProbeResult, refreshLists, patchEnabledInCache])

  const totalOn = entries.filter(e => e.enabled).length
  const totalOff = entries.filter(e => !e.enabled).length
  const healthy = entries.filter(e => {
    const pr = probeResults.get(e.modelDbId)
    const s = pr?.status || e.healthStatus
    return s === 'ok' || s === 'success'
  }).length

  function toggleGroup(platform: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(platform)) next.delete(platform)
      else next.add(platform)
      return next
    })
  }

  // ── Mini timeline per model ─────────────────────────────────────────
  function MiniTimeline({ history }: { history: ProbeHistoryItem[] | undefined }) {
    if (!history || history.length === 0) return null
    const bars = [...history].reverse().slice(-30) // newest right, max 30
    return (
      <div className="flex items-center gap-[1px] shrink-0">
        {bars.map((h, i) => {
          const ok = h.status === 'success' || h.status === 'ok'
          const err = h.status === 'error' || h.status === 'timeout'
          const limited = h.status === 'rate_limited'
          const color = ok ? '#4ade80' : err ? '#f87171' : limited ? '#fbbf24' : '#374151'
          return (
            <div
              key={i}
              className="shrink-0 rounded-[1px]"
              style={{ width: 6, height: 12, backgroundColor: color }}
              title={`${h.modelId} · ${h.status} · ${h.latency}ms · ${h.time || ''}`}
            />
          )
        })}
      </div>
    )
  }

  function renderRow(entry: any) {
    const pr = probeResults.get(entry.modelDbId)
    const isExpanded = expandedModel === entry.modelDbId
    const status = pr?.status || entry.healthStatus
    const ok = status === 'ok' || status === 'success'
    const err = status === 'error' || status === 'timeout'
    const limited = status === 'rate_limited'
    const probing = pr?.status === 'probing'
    const color = ok ? '#4ade80' : err ? '#f87171' : limited ? '#fbbf24' : '#6b7280'
    const isEnabled = pr && pr.enabled !== undefined ? pr.enabled : entry.enabled
    const modelHistory = modelHistoryMap.get(entry.modelDbId)

    return (
      <div key={entry.modelDbId} className="border-b border-border/20 last:border-0" style={{ opacity: isEnabled ? 1 : 0.4 }}>
        <div
          className="flex items-center py-1.5 px-2 rounded hover:bg-muted/30 cursor-pointer gap-2"
          onClick={() => setExpandedModel(isExpanded ? null : entry.modelDbId)}
        >
          {probing ? (
            <RefreshCw className="size-3 animate-spin shrink-0" style={{ color }} />
          ) : (
            <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          )}
          <span className="text-xs font-medium flex-1 truncate">{entry.displayName || entry.modelId}</span>
          {/* Mini timeline */}
          <MiniTimeline history={modelHistory} />
          <span className="text-[10px] text-muted-foreground w-16 tabular-nums text-right">
            {pr && pr.status !== 'probing' ? (pr.latency > 0 ? pr.latency + 'ms' : '-') : '-'}
          </span>
          {/* Toggle switch */}
          <button
            onClick={e => { e.stopPropagation(); doToggle(entry.modelDbId, isEnabled) }}
            disabled={probing || probingAll}
            className={`text-[10px] px-2 py-0.5 rounded border shrink-0 ${
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
            className="text-[10px] px-2 py-0.5 rounded border bg-card hover:bg-muted disabled:opacity-30 ml-1 shrink-0"
          >
            {probing ? '…' : '测试'}
          </button>
        </div>
        {isExpanded && pr && pr.error && (
          <div className="pb-2 px-2">
            <pre className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {pr.error}
            </pre>
          </div>
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
          <Button size="sm" variant="outline" onClick={doProbeAll} disabled={probingAll || probeList.length === 0}>
            {probingAll ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {probingAll ? '测试中…' : '全部测试'}
          </Button>
        </div>
      </div>

      <div className="flex gap-4 text-[10px] text-muted-foreground flex-wrap items-center">
        <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-[#4ade80]" /> 健康</span>
        <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-[#f87171]" /> 错误</span>
        <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-[#fbbf24]" /> 限流</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-[#4ade80]" /> 绿条=成功</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded-sm bg-[#f87171]" /> 红条=失败</span>
        <span className="text-[10px] text-muted-foreground">← 最早 · 最新 →  每模型 24h 探测历史</span>
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
              return s === 'ok' || s === 'success'
            }).length
            const errCount = g.models.filter(m => {
              const pr = probeResults.get(m.modelDbId)
              const s = pr?.status || m.healthStatus
              return s === 'error' || s === 'timeout'
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
                      {errCount > 0 ? ` · 错 ${errCount}` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={probingAll}
                    onClick={() => doProbePlatform(g.platform, g.models)}
                    className="text-[10px] px-2 py-0.5 rounded border bg-card hover:bg-muted disabled:opacity-30 shrink-0"
                  >
                    测本组
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
