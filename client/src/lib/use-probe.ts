import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

export interface ProbeResult {
  modelDbId: number
  platform: string
  modelId: string
  status: string
  latency: number
  error: string
  enabled?: boolean
}

const PROBE_CLIENT_TIMEOUT_MS = 18_000
const PROBE_CONCURRENCY = 2

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

export interface ProbeListEntry {
  modelDbId: number
  platform: string
  modelId: string
}

export function useProbe() {
  const qc = useQueryClient()
  const [probeResults, setProbeResults] = useState<Map<number, ProbeResult>>(new Map())
  const [probingAll, setProbingAll] = useState(false)
  const [probeProgress, setProbeProgress] = useState('')

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
      const res = await probeOne(modelDbId)
      applyProbeResult(res)
      refreshLists()
    } catch (e: any) {
      setProbeResults(prev => new Map(prev).set(modelDbId, {
        modelDbId, platform: '', modelId: '', status: 'error', latency: 0, error: e.message, enabled: false,
      }))
      patchEnabledInCache(modelDbId, false)
    }
  }, [applyProbeResult, refreshLists, patchEnabledInCache])

  const runProbeBatch = useCallback(async (label: string, list: ProbeListEntry[]) => {
    if (list.length === 0 || probingAll) return
    setProbingAll(true)
    let ok = 0, err = 0, limited = 0
    setProbeProgress(`${label}: 0/${list.length}`)
    for (let i = 0; i < list.length; i += PROBE_CONCURRENCY) {
      const chunk = list.slice(i, i + PROBE_CONCURRENCY)
      await Promise.all(chunk.map(async (e) => {
        setProbeResults(prev => new Map(prev).set(e.modelDbId, {
          modelDbId: e.modelDbId, platform: e.platform, modelId: e.modelId,
          status: 'probing', latency: 0, error: '',
        }))
        try {
          const res = await probeOne(e.modelDbId)
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
      }))
      setProbeProgress(`${label}: ${Math.min(i + PROBE_CONCURRENCY, list.length)}/${list.length} · ${ok} 成功 · ${err} 失败 · ${limited} 限流`)
    }
    setProbeProgress(`${label} 完成 · ${list.length} · ${ok} 成功 · ${err} 失败 · ${limited} 限流`)
    refreshLists()
    setProbingAll(false)
  }, [probingAll, applyProbeResult, refreshLists, patchEnabledInCache])

  const doProbeAll = useCallback((list: ProbeListEntry[]) => runProbeBatch('全部测试', list), [runProbeBatch])
  const doProbeGroup = useCallback((label: string, list: ProbeListEntry[]) => runProbeBatch(label, list), [runProbeBatch])

  const statusOf = useCallback((modelDbId: number, fallback?: string) => {
    return probeResults.get(modelDbId)?.status || fallback
  }, [probeResults])

  return { probeResults, probingAll, probeProgress, doProbe, doProbeAll, doProbeGroup, statusOf, setProbeResults }
}
