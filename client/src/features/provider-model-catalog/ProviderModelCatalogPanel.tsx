/**
 * 供应商模型目录前端面板。
 *
 * 页面只保留一条清晰流程：拉取模型 → 数据库已有的自动勾选 → 勾选新增、取消勾选删除。
 * 拉取本身只刷新显示，不会因为远端少了模型就自动改动本地数据库。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw, Search } from 'lucide-react'
import type {
  ProviderCatalogImportResult,
  ProviderCatalogManagedModel,
  ProviderCatalogRemoveResult,
  ProviderCatalogSourcesResponse,
  ProviderCatalogSyncResult,
} from '@freellmapi/shared/types.js'
import { apiFetch, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { PROVIDER_CATALOG_INVALIDATION_KEYS } from './cache-keys'

type Notice = {
  text: string
  tone: 'success' | 'warning' | 'error'
}

const QUERY_KEYS = {
  sources: ['provider-model-catalog', 'sources'] as const,
}

function readableError(error: unknown, fallback: string): string {
  const apiError = error as ApiError
  if (apiError?.status === 401) return '登录状态已失效，请重新登录后再试。'
  return error instanceof Error && error.message ? error.message : fallback
}

function postCatalog<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return apiFetch<T>(`/api/keys/model-catalog/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function ProviderModelCatalogPanel() {
  const queryClient = useQueryClient()
  const [sourceId, setSourceId] = useState('')
  const [catalog, setCatalog] = useState<ProviderCatalogSyncResult | null>(null)
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)

  const sourcesQuery = useQuery<ProviderCatalogSourcesResponse>({
    queryKey: QUERY_KEYS.sources,
    queryFn: () => apiFetch<ProviderCatalogSourcesResponse>('/api/keys/model-catalog/platforms'),
    retry: false,
  })
  const sources = sourcesQuery.data?.sources ?? sourcesQuery.data?.platforms ?? []
  const currentSource = sources.find(source => source.sourceId === sourceId)

  useEffect(() => {
    if (sources.length === 0) {
      if (sourceId) setSourceId('')
      return
    }
    if (sources.some(source => source.sourceId === sourceId)) return
    setSourceId((sources.find(source => source.canDiscover) ?? sources[0]).sourceId)
  }, [sourceId, sources])

  const syncCatalog = useMutation<ProviderCatalogSyncResult, unknown, string>({
    mutationFn: nextSourceId => postCatalog<ProviderCatalogSyncResult>('sync', { sourceId: nextSourceId }),
    onSuccess: data => {
      setCatalog(data)
      setNotice(data.warning
        ? { text: data.warning, tone: 'warning' }
        : { text: `已拉取 ${data.remoteTotal} 个远端模型，数据库已有 ${data.localTotal} 个。`, tone: 'success' })
    },
    onError: error => {
      setNotice({ text: readableError(error, '拉取模型失败'), tone: 'error' })
    },
  })

  function invalidateModelViews() {
    for (const queryKey of PROVIDER_CATALOG_INVALIDATION_KEYS) {
      queryClient.invalidateQueries({ queryKey })
    }
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.sources })
  }

  const toggleModel = useMutation<ProviderCatalogImportResult | ProviderCatalogRemoveResult, unknown, {
    model: ProviderCatalogManagedModel
    checked: boolean
  }>({
    mutationFn: ({ model, checked }) => checked
      ? postCatalog<ProviderCatalogImportResult>('import', { sourceId, modelIds: [model.id] })
      : postCatalog<ProviderCatalogRemoveResult>('remove', {
          sourceId,
          modelIds: [model.id],
          confirm: true,
        }),
    onSuccess: (data, variables) => {
      setCatalog(previous => {
        if (!previous) return previous
        if (variables.checked) {
          return {
            ...previous,
            localTotal: previous.localTotal + ('added' in data ? data.added : 0),
            models: previous.models.map(model => model.id === variables.model.id
              ? { ...model, alreadyRegistered: true, remotePresent: true }
              : model),
          }
        }
        return {
          ...previous,
          localTotal: Math.max(0, previous.localTotal - ('removed' in data ? data.removed : 0)),
          models: previous.models
            .filter(model => model.id !== variables.model.id || model.remotePresent)
            .map(model => model.id === variables.model.id
              ? {
                  ...model,
                  alreadyRegistered: false,
                  localEnabled: undefined,
                  routingEnabled: undefined,
                  catalogManaged: undefined,
                }
              : model),
        }
      })
      invalidateModelViews()
      setNotice({
        text: variables.checked ? '已添加模型。' : '已删除本地模型记录。',
        tone: 'success',
      })
    },
    onError: error => setNotice({ text: readableError(error, '更新模型失败'), tone: 'error' }),
  })

  function changeSource(nextSourceId: string) {
    setSourceId(nextSourceId)
    setCatalog(null)
    setFilter('')
    setNotice(null)
  }

  const visibleModels = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!catalog) return []
    return catalog.models.filter(model => !query
      || model.id.toLowerCase().includes(query)
      || model.name.toLowerCase().includes(query)
      || (model.ownedBy ?? '').toLowerCase().includes(query))
  }, [catalog, filter])

  function onToggleModel(model: ProviderCatalogManagedModel, checked: boolean) {
    if (toggleModel.isPending || model.existsOtherSource && model.localEnabled === undefined) return
    if (checked === model.alreadyRegistered) return
    toggleModel.mutate({ model, checked })
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
            点击“拉取模型”刷新清单。数据库里已有的模型会自动打勾；勾选就是添加，取消勾选就是删除。
          </p>
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

          <Button
            size="sm"
            variant="outline"
            disabled={!sourceId || syncCatalog.isPending}
            onClick={() => syncCatalog.mutate(sourceId)}
          >
            {syncCatalog.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {syncCatalog.isPending ? '拉取中…' : '拉取模型'}
          </Button>
        </div>

        {(sourcesQuery.isError || sources.length === 0) && sourcesMessage && (
          <p className="text-xs text-[#f87171]">{sourcesMessage}</p>
        )}

        {currentSource && (
          <div className="text-[11px] text-muted-foreground space-y-1">
            <p>密钥：启用 {currentSource.enabledKeyCount}/{currentSource.keyCount} · 健康 {currentSource.healthyKeyCount}/{currentSource.keyCount}</p>
            {catalog?.listUrl && <p className="truncate">远端来源：{catalog.listUrl}</p>}
          </div>
        )}

        {catalog && (
          <p className="text-xs text-muted-foreground">
            远端 {catalog.remoteTotal} · 数据库已有 {catalog.localTotal} · 清单显示 {catalog.models.length}
          </p>
        )}

        {catalog && (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={filter}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setFilter(event.target.value)}
                placeholder="筛选模型…"
                className="w-full rounded-lg border bg-card py-1.5 pl-9 pr-3 text-sm outline-none focus:border-foreground/30"
              />
            </div>

            <div className="rounded-lg border max-h-80 overflow-y-auto">
              {visibleModels.length === 0 ? (
                <p className="text-xs text-muted-foreground p-4 text-center">没有匹配的模型。</p>
              ) : (
                <ul className="divide-y divide-border/40">
                  {visibleModels.map(model => {
                    const lockedByOtherSource = model.existsOtherSource && model.localEnabled === undefined
                    return (
                      <li key={model.id}>
                        <label className={`flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/40 ${lockedByOtherSource ? 'opacity-50 cursor-default' : 'cursor-pointer'}`}>
                          <input
                            type="checkbox"
                            checked={model.alreadyRegistered}
                            disabled={lockedByOtherSource || toggleModel.isPending}
                            onChange={(event: ChangeEvent<HTMLInputElement>) => onToggleModel(model, event.target.checked)}
                            className="rounded border shrink-0"
                          />
                          <span className="font-medium truncate flex-1">{model.name}</span>
                          <span className="text-muted-foreground truncate max-w-[40%] text-right">{model.id}</span>
                          {lockedByOtherSource
                            ? <span className="text-[10px] text-[#fbbf24] shrink-0">其他来源已有</span>
                            : model.remotePresent
                              ? <span className="text-[10px] text-muted-foreground shrink-0">{model.alreadyRegistered ? '已添加' : '未添加'}</span>
                              : <span className="text-[10px] text-[#fbbf24] shrink-0">本地已有，远端未返回</span>}
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
          <p>拉取只刷新显示；远端失败、认证失败或空数组不会自动删除或禁用本地模型。</p>
          <p>只有用户明确取消勾选时，才会删除对应的本地记录。</p>
          <p>新增模型保持关闭，不修改现有优先级，也不运行 ranking、recalibrate 或 sort。</p>
        </div>
      </section>
    </>
  )
}
