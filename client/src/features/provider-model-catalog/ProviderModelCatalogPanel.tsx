/**
 * 供应商模型目录前端面板。
 *
 * 本文件集中管理该功能的查询、状态和界面，StatusPage 只负责挂载。
 * 后端业务规则不在这里重复实现：前端只表达“发现、只增、本地删除”三种操作。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckSquare, Download, RefreshCw, Search, Square, Trash2 } from 'lucide-react'
import type {
  ProviderCatalogDiscoveryResult,
  ProviderCatalogImportResult,
  ProviderCatalogLocalResult,
  ProviderCatalogRemoveResult,
  ProviderCatalogSourcesResponse,
} from '@freellmapi/shared/types.js'
import { apiFetch, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'

/** 页面只有两个明确模式，避免把“更新”和“删除”混成一个同步动作。 */
type CatalogMode = 'discover' | 'local'

/** 页面通知使用明确语义，不再根据中文开头猜颜色。 */
type Notice = {
  text: string
  tone: 'success' | 'warning' | 'error'
}

/** 将远端模型和本地模型统一成一套仅供界面渲染的字段。 */
type ViewModel = {
  id: string
  name: string
  ownedBy?: string
  alreadyRegistered: boolean
  existsOtherSource?: boolean
  localEnabled?: boolean
  routingEnabled?: boolean
}

/** 本功能自己的 React Query key，集中定义以便统一失效缓存。 */
const QUERY_KEYS = {
  sources: ['provider-model-catalog', 'sources'] as const,
  local: (sourceId: string) => ['provider-model-catalog', 'local', sourceId] as const,
}

// 模型变化后这些页面都可能显示旧数据，因此统一在一个地方失效缓存。
const MODEL_VIEW_QUERY_KEYS = [
  ['fallback'],
  ['models'],
  ['health'],
  ['routing-status'],
  ['keys'],
] as const

/** 把 API 错误转换成用户可理解的中文；401 不再伪装成“没有密钥”。 */
function readableError(error: unknown, fallback: string): string {
  const apiError = error as ApiError
  if (apiError?.status === 401) return '登录状态已失效，请重新登录后再试。'
  return error instanceof Error && error.message ? error.message : fallback
}

/** 统一 POST JSON，避免四个 mutation 重复请求模板。 */
function postCatalog<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return apiFetch<T>(`/api/keys/model-catalog/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * 完整的供应商模型管理面板。
 * 维护时优先看：sourcesQuery → discoverRemote/localQuery → import/remove。
 */
export function ProviderModelCatalogPanel() {
  const queryClient = useQueryClient()
  const [sourceId, setSourceId] = useState('')
  const [mode, setMode] = useState<CatalogMode>('discover')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [hideRegistered, setHideRegistered] = useState(true)
  const [notice, setNotice] = useState<Notice | null>(null)

  // 来源列表只读数据库，不会解密或请求供应商密钥。
  const sourcesQuery = useQuery<ProviderCatalogSourcesResponse>({
    queryKey: QUERY_KEYS.sources,
    queryFn: () => apiFetch<ProviderCatalogSourcesResponse>('/api/keys/model-catalog/platforms'),
    retry: false,
  })
  // platforms 是旧服务端兼容字段，滚动升级期间仍可正常工作。
  const sources = sourcesQuery.data?.sources ?? sourcesQuery.data?.platforms ?? []
  const currentSource = sources.find(source => source.sourceId === sourceId)

  // 首次加载自动选择第一个支持远端发现的来源。
  useEffect(() => {
    if (sources.length === 0) {
      if (sourceId) setSourceId('')
      return
    }
    if (sources.some(source => source.sourceId === sourceId)) return
    setSourceId((sources.find(source => source.canDiscover) ?? sources[0]).sourceId)
  }, [sourceId, sources])

  // 远端发现必须由用户主动触发，因此使用 mutation 而不是自动 query。
  const discoverRemote = useMutation({
    mutationFn: (nextSourceId: string) => postCatalog<ProviderCatalogDiscoveryResult>('discover', {
      sourceId: nextSourceId,
    }),
    onSuccess: data => {
      setSelected(new Set(data.models.filter(model => !model.alreadyRegistered).map(model => model.id)))
      setNotice(data.warning ? { text: data.warning, tone: 'warning' } : null)
    },
    onError: error => {
      setSelected(new Set())
      setNotice({ text: readableError(error, '获取远端模型失败'), tone: 'error' })
    },
  })

  // 本地管理只读数据库，可以自动加载，也不会受远端 /models 故障影响。
  const localQuery = useQuery<ProviderCatalogLocalResult>({
    queryKey: QUERY_KEYS.local(sourceId),
    queryFn: () => postCatalog<ProviderCatalogLocalResult>('local', { sourceId }),
    enabled: mode === 'local' && Boolean(sourceId),
    retry: false,
  })

  /** 所有受模型变更影响的查询统一失效。 */
  function invalidateModelViews() {
    for (const queryKey of MODEL_VIEW_QUERY_KEYS) {
      queryClient.invalidateQueries({ queryKey })
    }
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sources })
    if (sourceId) queryClient.invalidateQueries({ queryKey: QUERY_KEYS.local(sourceId) })
  }

  const importModels = useMutation({
    mutationFn: (modelIds: string[]) => postCatalog<ProviderCatalogImportResult>('import', {
      sourceId,
      modelIds,
    }),
    onSuccess: data => {
      setSelected(new Set())
      setNotice({
        text: `已新增 ${data.added} 个模型，跳过已有 ${data.skipped} 个。新增模型保持关闭，探测成功后才会启用。`,
        tone: 'success',
      })
      // 清掉旧发现结果，避免刚导入的模型仍显示为“可新增”。
      discoverRemote.reset()
      invalidateModelViews()
    },
    onError: error => setNotice({ text: readableError(error, '新增失败'), tone: 'error' }),
  })

  const removeModels = useMutation({
    mutationFn: (modelIds: string[]) => postCatalog<ProviderCatalogRemoveResult>('remove', {
      sourceId,
      modelIds,
      confirm: true,
    }),
    onSuccess: data => {
      setSelected(new Set())
      setNotice({
        text: `已删除 ${data.removed} 个本地模型。目录管理模型已写入 tombstone，不会被后台自动加回。`,
        tone: 'success',
      })
      invalidateModelViews()
    },
    onError: error => setNotice({ text: readableError(error, '删除失败'), tone: 'error' }),
  })

  /** 切换来源时清空旧来源结果，防止误把 A 的模型操作到 B。 */
  function changeSource(nextSourceId: string) {
    setSourceId(nextSourceId)
    discoverRemote.reset()
    setSelected(new Set())
    setFilter('')
    setNotice(null)
  }

  /** 切换模式只切换视图，不触发任何导入或删除。 */
  function changeMode(nextMode: CatalogMode) {
    setMode(nextMode)
    setSelected(new Set())
    setFilter('')
    setNotice(null)
    if (nextMode === 'discover') setHideRegistered(true)
  }

  const discovery = discoverRemote.data
  const local = localQuery.data
  const activeResultLoaded = mode === 'discover' ? Boolean(discovery) : Boolean(local)

  // 两种后端结果统一成一个只供渲染的模型结构。
  const visibleModels = useMemo<ViewModel[]>(() => {
    const query = filter.trim().toLowerCase()
    const models: ViewModel[] = mode === 'discover'
      ? (discovery?.models ?? [])
      : (local?.models ?? []).map(model => ({
          ...model,
          alreadyRegistered: true,
        }))

    return models.filter(model => {
      if (mode === 'discover' && hideRegistered && model.alreadyRegistered) return false
      if (!query) return true
      return model.id.toLowerCase().includes(query)
        || model.name.toLowerCase().includes(query)
        || (model.ownedBy ?? '').toLowerCase().includes(query)
    })
  }, [discovery, filter, hideRegistered, local, mode])

  const selectableModels = mode === 'discover'
    ? visibleModels.filter(model => !model.alreadyRegistered)
    : visibleModels
  const allVisibleSelected = selectableModels.length > 0
    && selectableModels.every(model => selected.has(model.id))

  /** 单行勾选只修改浏览器状态，不写数据库。 */
  function toggleOne(modelId: string, canSelect: boolean) {
    if (!canSelect) return
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(modelId)) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }

  /** 全选仅作用于当前筛选后可见且可操作的模型。 */
  function toggleAllVisible() {
    setSelected(previous => {
      const next = new Set(previous)
      for (const model of selectableModels) {
        if (allVisibleSelected) next.delete(model.id)
        else next.add(model.id)
      }
      return next
    })
  }

  /** 删除前进行浏览器确认；后端仍会再次要求 confirm:true。 */
  function confirmRemove() {
    if (selected.size === 0) return
    const confirmed = window.confirm(
      `确定删除 ${selected.size} 个本地模型？\n\n只删除本机数据库记录，不会操作上游供应商。`,
    )
    if (confirmed) removeModels.mutate([...selected])
  }

  const sourcesMessage = sourcesQuery.isLoading
    ? '正在加载供应商…'
    : sourcesQuery.isError
      ? readableError(sourcesQuery.error, '供应商加载失败')
      : sources.length === 0
        ? '当前账户没有可用供应商密钥。'
        : ''

  const noticeClass = notice?.tone === 'success'
    ? 'text-[#4ade80]'
    : notice?.tone === 'warning'
      ? 'text-[#fbbf24]'
      : 'text-[#f87171]'

  return (
    <>
      <section className="rounded-xl border bg-card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-medium mb-1">供应商模型管理</h3>
          <p className="text-xs text-muted-foreground leading-5">
            远端发现只负责查找可新增模型；本地管理只负责查看和删除本地记录。两条流程互不推导，避免远端异常误删本地模型。
          </p>
        </div>

        <div className="inline-flex rounded-lg border p-0.5 text-xs">
          <button
            type="button"
            onClick={() => changeMode('discover')}
            className={`px-3 py-1.5 rounded-md transition-colors ${mode === 'discover' ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            发现并新增
          </button>
          <button
            type="button"
            onClick={() => changeMode('local')}
            className={`px-3 py-1.5 rounded-md transition-colors ${mode === 'local' ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground'}`}
          >
            本地模型管理
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <select
            className="rounded-lg border bg-card px-3 py-2 text-sm flex-1 min-w-0"
            value={sourceId}
            disabled={sourcesQuery.isLoading || sources.length === 0}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => changeSource(event.target.value)}
          >
            {sources.length === 0 && <option value="">{sourcesMessage || '没有供应商'}</option>}
            {sources.map(source => (
              <option key={source.sourceId} value={source.sourceId}>
                {source.label} · {source.platform} · 本地 {source.modelCount} · 密钥 {source.keyCount}
                {source.canDiscover ? '' : '（不支持远端列表）'}
              </option>
            ))}
          </select>

          {mode === 'discover' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!sourceId || !currentSource?.canDiscover || discoverRemote.isPending}
              onClick={() => discoverRemote.mutate(sourceId)}
            >
              {discoverRemote.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {discoverRemote.isPending ? '检查中…' : '检查远端新增'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!sourceId || localQuery.isFetching}
              onClick={() => localQuery.refetch()}
            >
              <RefreshCw className={`size-3.5 ${localQuery.isFetching ? 'animate-spin' : ''}`} />
              {localQuery.isFetching ? '加载中…' : '刷新本地列表'}
            </Button>
          )}
        </div>

        {(sourcesQuery.isError || sources.length === 0) && sourcesMessage && (
          <p className="text-xs text-[#f87171]">{sourcesMessage}</p>
        )}
        {mode === 'local' && localQuery.isError && (
          <p className="text-xs text-[#f87171]">{readableError(localQuery.error, '加载本地模型失败')}</p>
        )}

        {currentSource && (
          <div className="text-[11px] text-muted-foreground space-y-1">
            <p>密钥：启用 {currentSource.enabledKeyCount}/{currentSource.keyCount} · 健康 {currentSource.healthyKeyCount}/{currentSource.keyCount}</p>
            {mode === 'discover' && currentSource.listUrl && <p className="truncate">远端来源：{currentSource.listUrl}</p>}
          </div>
        )}

        {mode === 'discover' && discovery && (
          <p className="text-xs text-muted-foreground">
            远端 {discovery.total} · 本地已有 {discovery.registered} · <span className="text-foreground font-medium">可新增 {discovery.newCount}</span>
          </p>
        )}
        {mode === 'local' && local && (
          <p className="text-xs text-muted-foreground">本地模型 {local.total} · 已选 {selected.size}</p>
        )}

        {activeResultLoaded && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="text-foreground font-medium">已选 {selected.size}</span>
              <div className="flex-1" />
              {mode === 'discover' && (
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hideRegistered}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setHideRegistered(event.target.checked)}
                    className="rounded border"
                  />
                  只看可新增
                </label>
              )}
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={filter}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)}
                placeholder="筛选模型…"
                className="w-full rounded-lg border bg-card py-1.5 pl-9 pr-3 text-sm outline-none focus:border-foreground/30"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={toggleAllVisible} disabled={selectableModels.length === 0}>
                {allVisibleSelected ? <CheckSquare className="size-3.5" /> : <Square className="size-3.5" />}
                {allVisibleSelected ? '取消可见全选' : mode === 'discover' ? '全选可新增' : '全选可见'}
              </Button>

              {mode === 'discover' ? (
                <Button
                  size="sm"
                  disabled={!sourceId || selected.size === 0 || importModels.isPending || discovery?.remoteState === 'empty'}
                  onClick={() => importModels.mutate([...selected])}
                >
                  {importModels.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  {importModels.isPending ? '新增中…' : `新增已选（${selected.size}）`}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!sourceId || selected.size === 0 || removeModels.isPending}
                  onClick={confirmRemove}
                >
                  {removeModels.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  {removeModels.isPending ? '删除中…' : `删除本地（${selected.size}）`}
                </Button>
              )}
            </div>

            <div className="rounded-lg border max-h-80 overflow-y-auto">
              {visibleModels.length === 0 ? (
                <p className="text-xs text-muted-foreground p-4 text-center">
                  {mode === 'discover' && discovery?.remoteState === 'empty'
                    ? '远端返回空列表。本地模型未被标记或删除。'
                    : mode === 'discover' && discovery?.newCount === 0 && hideRegistered
                      ? '没有可新增模型。'
                      : mode === 'local'
                        ? '本地没有模型。'
                        : '没有匹配的模型。'}
                </p>
              ) : (
                <ul className="divide-y divide-border/40">
                  {visibleModels.map(model => {
                    const canSelect = mode === 'local' || !model.alreadyRegistered
                    return (
                      <li key={model.id}>
                        <label className={`flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/40 ${canSelect ? 'cursor-pointer' : 'opacity-40 cursor-default'}`}>
                          <input
                            type="checkbox"
                            checked={selected.has(model.id)}
                            disabled={!canSelect}
                            onChange={() => toggleOne(model.id, canSelect)}
                            className="rounded border shrink-0"
                          />
                          <span className="font-medium truncate flex-1">{model.name}</span>
                          <span className="text-muted-foreground truncate max-w-[40%] text-right">{model.id}</span>
                          {mode === 'discover' && model.alreadyRegistered && <span className="text-[10px] text-muted-foreground shrink-0">已有</span>}
                          {mode === 'discover' && !model.alreadyRegistered && <span className="text-[10px] text-[#4ade80] shrink-0">可新增</span>}
                          {mode === 'discover' && model.existsOtherSource && <span className="text-[10px] text-[#fbbf24] shrink-0">其他来源已有</span>}
                          {mode === 'local' && (
                            <span className="text-[10px] text-muted-foreground shrink-0">
                              {model.localEnabled ? '模型开' : '模型关'} / {model.routingEnabled ? '路由开' : '路由关'}
                            </span>
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

        {notice && <p className={`text-xs ${noticeClass}`}>{notice.text}</p>}
      </section>

      <section className="rounded-xl border bg-card p-5 space-y-3">
        <h3 className="text-sm font-medium">固定安全规则</h3>
        <div className="text-xs text-muted-foreground space-y-2">
          <p>远端失败、认证失败或返回空数组时，不会删除、禁用或标记任何本地模型。</p>
          <p>新增模型在 models、fallback_config、Default profile 三处均保持关闭。</p>
          <p>本地删除与远端发现分离；目录管理模型删除前写入 tombstone。</p>
          <p>该功能不修改现有优先级，也不运行 ranking、recalibrate 或 sort。</p>
        </div>
      </section>
    </>
  )
}
