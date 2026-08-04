/**
 * 状态页只负责页面级组合。
 * 供应商模型管理的状态和操作全部位于 ProviderModelCatalogPanel，避免本页再次变成巨型业务文件。
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, RefreshCw } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { ProviderModelCatalogPanel } from '@/features/provider-model-catalog/ProviderModelCatalogPanel'

export default function StatusPage() {
  const queryClient = useQueryClient()
  const [probeError, setProbeError] = useState('')

  // 健康探测仍是独立功能；它不参与远端模型发现和本地删除逻辑。
  const runProbeAll = useMutation({
    mutationFn: () => apiFetch('/api/fallback/probe-all', { method: 'POST' }),
    onSuccess: () => {
      setProbeError('')
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
    onError: error => setProbeError(error instanceof Error ? error.message : '探测失败'),
  })

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="健康检查与模型目录" description="供应商健康检测、拉取模型，并用勾选统一管理本地模型与路由列表" />

      <section className="rounded-xl border bg-card p-5 space-y-2">
        <h3 className="text-sm font-medium">模型组去重</h3>
        <p className="text-xs text-muted-foreground">
          同核心名会在运行时自动合并成一个模型组。供应商模型管理不会写绝对排名，也不会重排 profile_models.priority。
        </p>
      </section>

      <section className="rounded-xl border bg-card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-medium mb-1">供应商健康检测</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            自动周期在「密钥」页面按供应商配置。这里的按钮只负责立即探测全部模型，不负责新增或删除模型。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => runProbeAll.mutate(undefined)} disabled={runProbeAll.isPending}>
          {runProbeAll.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
          {runProbeAll.isPending ? '探测中…' : '立即探测全部模型'}
        </Button>
        {probeError && <p className="text-xs text-[#f87171]">{probeError}</p>}
      </section>

      <ProviderModelCatalogPanel />
    </div>
  )
}
