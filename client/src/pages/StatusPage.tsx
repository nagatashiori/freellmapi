import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, RefreshCw, Download, Search, CheckSquare, Square, Save, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'

interface ProbeSettings {
  intervalMs: number
  lastRun: string | null
}

interface CatalogPlatform {
  platform: string
  keyCount: number
  modelCount: number
  canDiscover: boolean
  baseUrl: string | null
  listUrl: string | null
  kind: 'channel' | 'builtin'
}

interface CatalogModel {
  id: string
  name: string
  ownedBy?: string
  alreadyRegistered: boolean
  modelDbId?: number | null
  localEnabled?: boolean | null
  localOnly?: boolean
  existsOtherPlatform?: boolean
}

interface DiscoverResult {
  platform: string
  listUrl: string
  total: number
  registered: number
  newCount: number
  localOnly?: number
  models: CatalogModel[]
}

type CatalogMode = 'add' | 'remove'

export default function StatusPage() {
  const qc = useQueryClient()

  const { data: settings, refetch: refetchSettings } = useQuery<ProbeSettings>({
    queryKey: ['probe-settings'],
    queryFn: () => apiFetch('/api/fallback/probe-settings'),
    refetchInterval: 10_000,
  })

  const { data: platformsData, refetch: refetchPlatforms } = useQuery<{ platforms: CatalogPlatform[] }>({
    queryKey: ['model-catalog-platforms'],
    queryFn: () => apiFetch('/api/keys/model-catalog/platforms'),
  })
  const platforms = platformsData?.platforms ?? []

  const [draftInterval, setDraftInterval] = useState<number | null>(null)
  const [saveMsg, setSaveMsg] = useState('')
  useEffect(() => {
    if (settings && draftInterval === null) setDraftInterval(settings.intervalMs)
  }, [settings, draftInterval])

  const saveInterval = useMutation({
    mutationFn: (intervalMs: number) =>
      apiFetch('/api/fallback/probe-settings', { method: 'PUT', body: JSON.stringify({ intervalMs }) }),
    onSuccess: () => {
      refetchSettings()
      setSaveMsg('已保存')
      setTimeout(() => setSaveMsg(''), 2000)
    },
    onError: (e: any) => setSaveMsg(e.message || '保存失败'),
  })

  const runProbeAll = useMutation({
    mutationFn: () => apiFetch('/api/fallback/probe-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['health'] }),
  })

  const [platform, setPlatform] = useState('')
  const [discover, setDiscover] = useState<DiscoverResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [hideRegistered, setHideRegistered] = useState(true)
  const [importMsg, setImportMsg] = useState('')
  const [mode, setMode] = useState<CatalogMode>('add')

  useEffect(() => {
    if (platform || platforms.length === 0) return
    const first = platforms.find(p => p.canDiscover) || platforms[0]
    if (first) setPlatform(first.platform)
  }, [platform, platforms])

  const fetchModels = useMutation({
    mutationFn: (p: string) =>
      apiFetch('/api/keys/model-catalog/discover', {
        method: 'POST',
        body: JSON.stringify({ platform: p }),
      }) as Promise<DiscoverResult>,
    onSuccess: (data) => {
      setDiscover(data)
      // default select depends on mode
      if (mode === 'add') {
        setSelected(new Set(data.models.filter(m => !m.alreadyRegistered).map(m => m.id)))
      } else {
        setSelected(new Set()) // delete mode: user picks deliberately
      }
      setImportMsg('')
    },
    onError: (e: any) => {
      setDiscover(null)
      setSelected(new Set())
      setImportMsg(e.message || '获取失败')
    },
  })

  const importModels = useMutation({
    mutationFn: (payload: { platform: string; modelIds: string[] }) =>
      apiFetch('/api/keys/model-catalog/import', {
        method: 'POST',
        body: JSON.stringify({ ...payload, enable: false }),
      }) as Promise<{ added: number; skipped: number; models: { modelId: string }[] }>,
    onSuccess: (data) => {
      setImportMsg(`已更新 +${data.added} 个（已有跳过 ${data.skipped}）。新增模型默认关闭，探测成功后才会开启。`)
      if (platform) fetchModels.mutate(platform)
      refetchPlatforms()
      // Keep all 5 pages in sync: new local model rows affect fallback chain,
      // model list, health, routing-status, and this page's platform counts.
      qc.invalidateQueries({ queryKey: ['fallback'] })
      qc.invalidateQueries({ queryKey: ['models'] })
      qc.invalidateQueries({ queryKey: ['health'] })
      qc.invalidateQueries({ queryKey: ['routing-status'] })
      qc.invalidateQueries({ queryKey: ['keys'] })
    },
    onError: (e: any) => setImportMsg(e.message || '更新失败'),
  })

  const removeModels = useMutation({
    mutationFn: (payload: { platform: string; modelIds: string[] }) =>
      apiFetch('/api/keys/model-catalog/remove', {
        method: 'POST',
        body: JSON.stringify(payload),
      }) as Promise<{ removed: number; models: { modelId: string }[] }>,
    onSuccess: (data) => {
      setImportMsg(`已删除 ${data.removed} 个本地模型（不可恢复）。`)
      setSelected(new Set())
      if (platform) fetchModels.mutate(platform)
      refetchPlatforms()
      qc.invalidateQueries({ queryKey: ['fallback'] })
      qc.invalidateQueries({ queryKey: ['models'] })
      qc.invalidateQueries({ queryKey: ['health'] })
      qc.invalidateQueries({ queryKey: ['routing-status'] })
      qc.invalidateQueries({ queryKey: ['keys'] })
    },
    onError: (e: any) => setImportMsg(e.message || '删除失败'),
  })

  const visibleModels = useMemo(() => {
    if (!discover) return []
    const q = filter.trim().toLowerCase()
    return discover.models.filter(m => {
      if (mode === 'add') {
        // add mode: hide already registered if toggled; always hide pure localOnly from "add" default view unless not hide
        if (hideRegistered && m.alreadyRegistered) return false
      } else {
        // remove mode: only show local models
        if (!m.alreadyRegistered) return false
      }
      if (!q) return true
      return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || (m.ownedBy || '').toLowerCase().includes(q)
    })
  }, [discover, filter, hideRegistered, mode])

  const selectableVisible = useMemo(() => {
    if (mode === 'add') return visibleModels.filter(m => !m.alreadyRegistered)
    return visibleModels.filter(m => m.alreadyRegistered)
  }, [visibleModels, mode])

  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every(m => selected.has(m.id))

  function toggleOne(id: string, canSelect: boolean) {
    if (!canSelect) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelected(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const m of selectableVisible) next.delete(m.id)
      } else {
        for (const m of selectableVisible) next.add(m.id)
      }
      return next
    })
  }

  function switchMode(next: CatalogMode) {
    setMode(next)
    setSelected(new Set())
    setImportMsg('')
    if (next === 'add') setHideRegistered(true)
    else setHideRegistered(false)
    // re-default selection after mode switch if list already loaded
    if (discover) {
      if (next === 'add') {
        setSelected(new Set(discover.models.filter(m => !m.alreadyRegistered).map(m => m.id)))
      }
    }
  }

  const selectedCount = selected.size
  const currentPlat = platforms.find(p => p.platform === platform)
  const intervalDirty = draftInterval !== null && settings != null && draftInterval !== settings.intervalMs

  function confirmRemove() {
    if (selectedCount === 0 || !platform) return
    const ok = window.confirm(`确定从本地删除 ${selectedCount} 个「${platform}」模型？\n不会影响上游供应商，只删本库记录，不可恢复。`)
    if (!ok) return
    removeModels.mutate({ platform, modelIds: [...selected] })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="健康检查与模型目录" description="探测间隔、供应商模型更新，以及运行时模型组去重" />

      <section className="rounded-xl border bg-card p-5 space-y-2">
        <h3 className="text-sm font-medium">模型组去重</h3>
        <p className="text-xs text-muted-foreground">
          同核心名会在运行时自动合并成一个模型组（如 gpt-5-5 / gpt-5.5 / GPT-5.5）。
          不再写绝对排名，不再把未知模型设为 900，也不需要手动重跑校准。
        </p>
      </section>

      <section className="rounded-xl border bg-card p-5 space-y-5">
        <div>
          <h3 className="text-sm font-medium mb-1">检查间隔</h3>
          <p className="text-xs text-muted-foreground mb-3">自动探测所有已启用模型的频率（改完后点「保存设置」）</p>
          <select
            className="rounded-lg border bg-card px-3 py-2 text-sm w-full max-w-xs"
            value={draftInterval ?? settings?.intervalMs ?? 3600000}
            onChange={e => {
              setDraftInterval(Number(e.target.value))
              setSaveMsg('')
            }}
          >
            <option value={600000}>每 10 分钟</option>
            <option value={1800000}>每 30 分钟</option>
            <option value={3600000}>每 1 小时</option>
            <option value={7200000}>每 2 小时</option>
            <option value={21600000}>每 6 小时</option>
          </select>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-1">上次检查</h3>
          <p className="text-xs text-muted-foreground">{settings?.lastRun || '从未运行'}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => draftInterval != null && saveInterval.mutate(draftInterval)}
            disabled={saveInterval.isPending || draftInterval == null || !intervalDirty}
          >
            {saveInterval.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            {saveInterval.isPending ? '保存中…' : '保存设置'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => runProbeAll.mutate()} disabled={runProbeAll.isPending}>
            {runProbeAll.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
            {runProbeAll.isPending ? '探测中…' : '立即探测'}
          </Button>
          {saveMsg && (
            <span className={`text-xs ${saveMsg === '已保存' ? 'text-[#4ade80]' : 'text-[#f87171]'}`}>{saveMsg}</span>
          )}
          {intervalDirty && !saveMsg && (
            <span className="text-xs text-muted-foreground">有未保存的更改</span>
          )}
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-medium mb-1">供应商模型更新</h3>
          <p className="text-xs text-muted-foreground">
            对比远端与本地：<span className="text-foreground font-medium">更新</span>只补新增；
            <span className="text-foreground font-medium">删除</span>只删本地记录（不动上游）。
            已有不会重复添加。新同步默认关闭，探测成功后才开。
          </p>
        </div>

        {/* mode switch */}
        <div className="inline-flex rounded-lg border p-0.5 text-xs">
          <button
            type="button"
            onClick={() => switchMode('add')}
            className={`px-3 py-1.5 rounded-md transition-colors ${mode === 'add' ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            更新（新增）
          </button>
          <button
            type="button"
            onClick={() => switchMode('remove')}
            className={`px-3 py-1.5 rounded-md transition-colors ${mode === 'remove' ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            删除本地
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <select
            className="rounded-lg border bg-card px-3 py-2 text-sm flex-1 min-w-0"
            value={platform}
            onChange={e => {
              setPlatform(e.target.value)
              setDiscover(null)
              setSelected(new Set())
              setImportMsg('')
            }}
          >
            {platforms.length === 0 && <option value="">还没有密钥</option>}
            {platforms.map(p => (
              <option key={p.platform} value={p.platform} disabled={!p.canDiscover}>
                {p.platform} · {p.kind === 'channel' ? '渠道' : '内置'} · 本地 {p.modelCount} · {p.keyCount} 把密钥
                {p.canDiscover ? '' : '（不支持 /models）'}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={!platform || !currentPlat?.canDiscover || fetchModels.isPending}
            onClick={() => platform && fetchModels.mutate(platform)}
          >
            {fetchModels.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {fetchModels.isPending ? '对比中…' : '检查更新'}
          </Button>
        </div>

        {currentPlat?.listUrl && (
          <p className="text-[11px] text-muted-foreground truncate">对比来源：{currentPlat.listUrl}</p>
        )}

        {discover && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                远端 {discover.total} · 本地已有 {discover.registered}
                {mode === 'add' && (
                  <> · <span className="text-foreground font-medium">可更新 {discover.newCount}</span></>
                )}
                {typeof discover.localOnly === 'number' && discover.localOnly > 0 && (
                  <> · <span className="text-[#fbbf24]">远端已下架 {discover.localOnly}</span></>
                )}
              </span>
              <span className="mx-1">·</span>
              <span className="text-foreground font-medium">已选 {selectedCount}</span>
              <div className="flex-1" />
              {mode === 'add' && (
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hideRegistered}
                    onChange={e => setHideRegistered(e.target.checked)}
                    className="rounded border"
                  />
                  只看可更新
                </label>
              )}
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="筛选模型…"
                className="w-full rounded-lg border bg-card py-1.5 pl-9 pr-3 text-sm outline-none focus:border-foreground/30"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={toggleAllVisible} disabled={selectableVisible.length === 0}>
                {allVisibleSelected ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
                {allVisibleSelected ? '取消可见全选' : (mode === 'add' ? '全选可更新' : '全选可见')}
              </Button>
              {mode === 'add' ? (
                <Button
                  size="sm"
                  disabled={selectedCount === 0 || importModels.isPending}
                  onClick={() => importModels.mutate({ platform, modelIds: [...selected] })}
                >
                  {importModels.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {importModels.isPending ? '更新中…' : `更新已选（${selectedCount}）`}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedCount === 0 || removeModels.isPending}
                  onClick={confirmRemove}
                  className="border-[#f87171]/40 text-[#f87171] hover:bg-[#f87171]/10"
                >
                  {removeModels.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  {removeModels.isPending ? '删除中…' : `删除已选（${selectedCount}）`}
                </Button>
              )}
            </div>

            <div className="rounded-lg border max-h-80 overflow-y-auto">
              {visibleModels.length === 0 ? (
                <p className="text-xs text-muted-foreground p-4 text-center">
                  {mode === 'add' && discover.newCount === 0 && hideRegistered
                    ? '该供应商已与本地一致，没有可更新的新模型。'
                    : mode === 'remove'
                      ? '本地没有可删除的模型。'
                      : '没有匹配的模型。'}
                </p>
              ) : (
                <ul className="divide-y divide-border/40">
                  {visibleModels.map(m => {
                    const isLocal = m.alreadyRegistered
                    const canSelect = mode === 'add' ? !isLocal : isLocal
                    const checked = selected.has(m.id)
                    return (
                      <li key={m.id + (m.localOnly ? ':local' : '')}>
                        <label
                          className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40 ${!canSelect ? 'opacity-40 cursor-default' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!canSelect}
                            onChange={() => toggleOne(m.id, canSelect)}
                            className="rounded border shrink-0"
                          />
                          <span className="font-medium truncate flex-1">{m.name}</span>
                          <span className="text-muted-foreground truncate max-w-[40%] text-right">{m.id}</span>
                          {m.localOnly && (
                            <span className="text-[10px] text-[#fbbf24] shrink-0">远端已下架</span>
                          )}
                          {isLocal && !m.localOnly && mode === 'add' && (
                            <span className="text-[10px] text-muted-foreground shrink-0">已有</span>
                          )}
                          {!isLocal && mode === 'add' && (
                            <span className="text-[10px] text-[#4ade80] shrink-0">可更新</span>
                          )}
                          {isLocal && mode === 'remove' && (
                            <span className="text-[10px] text-muted-foreground shrink-0">本地</span>
                          )}
                          {!isLocal && m.existsOtherPlatform && (
                            <span className="text-[10px] text-[#fbbf24] shrink-0">其他平台已有</span>
                          )}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        {importMsg && (
          <p className={`text-xs ${importMsg.startsWith('已更新') || importMsg.startsWith('已删除') ? 'text-[#4ade80]' : 'text-[#f87171]'}`}>
            {importMsg}
          </p>
        )}
      </section>

      <section className="rounded-xl border bg-card p-5 space-y-3">
        <h3 className="text-sm font-medium">工作原理</h3>
        <div className="text-xs text-muted-foreground space-y-2">
          <p><span className="text-foreground">更新</span>：检查远端多出来的模型 → 勾选 → 写入本地（不重复、不删旧）。</p>
          <p><span className="text-foreground">删除</span>：勾选本地模型 → 从本库移除（含 fallback / profile）。上游供应商不受影响。</p>
          <p>「远端已下架」= 本地有、远端列表没有，方便清理。</p>
          <p>新同步模型默认<span className="text-foreground">关闭</span>。Dashboard 探测成功 → 自动开启；失败 → 只关该渠道。</p>
        </div>
      </section>
    </div>
  )
}
