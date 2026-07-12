import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FieldError } from '@/components/ui/field-error'
import { Badge } from '@/components/ui/badge'
import { isHttpUrl } from '@/lib/validate'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

// Split a free-text model field on commas / newlines into a clean id list,
// dropping blanks and duplicates so one endpoint can take several models. (#281)
function parseModelList(raw: string): string[] {
  const seen = new Set<string>()
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !seen.has(s) && seen.add(s))
}

type DiscoveredModel = {
  id: string
  ownedBy?: string
  alreadyRegistered: boolean
}

export function CustomProviderSection({ onAdded }: { onAdded?: () => void } = {}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [customType, setCustomType] = useState<'chat' | 'embedding' | 'image' | 'audio'>('chat')
  const [baseUrl, setBaseUrl] = useState('')
  const [platformId, setPlatformId] = useState('')
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [family, setFamily] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [supportsTools, setSupportsTools] = useState(true)
  const [supportsVision, setSupportsVision] = useState(false)

  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [hideAlready, setHideAlready] = useState(true)
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [manualMode, setManualMode] = useState(false)

  const modelsFromText = customType === 'chat' ? parseModelList(model) : [model.trim()].filter(Boolean)
  const modelsFromPick = customType === 'chat' && selected.size > 0 ? Array.from(selected) : []
  const models = !manualMode && modelsFromPick.length > 0 ? modelsFromPick : modelsFromText
  const multiple = customType === 'chat' && models.length > 1

  const [attempted, setAttempted] = useState(false)
  const baseUrlError = !baseUrl.trim()
    ? t('validation.required')
    : !isHttpUrl(baseUrl)
      ? t('validation.url')
      : null
  const modelError = models.length === 0 ? t('validation.required') : null

  const filteredDiscovered = useMemo(() => {
    if (!discovered) return []
    const q = filter.trim().toLowerCase()
    return discovered.filter(m => {
      if (hideAlready && m.alreadyRegistered) return false
      if (!q) return true
      return m.id.toLowerCase().includes(q) || (m.ownedBy?.toLowerCase().includes(q) ?? false)
    })
  }, [discovered, filter, hideAlready])

  const selectedVisibleCount = useMemo(
    () => filteredDiscovered.filter(m => selected.has(m.id)).length,
    [filteredDiscovered, selected],
  )

  const { data: embeddingsData } = useQuery<{ families: { family: string }[] }>({
    queryKey: ['embeddings'],
    queryFn: () => apiFetch('/api/embeddings'),
  })

  const discover = useMutation({
    meta: { silenceToast: true },
    mutationFn: () =>
      apiFetch<{ baseUrl: string; count: number; models: DiscoveredModel[] }>(
        '/api/keys/custom/discover',
        {
          method: 'POST',
          body: JSON.stringify({
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim() || undefined,
          }),
        },
      ),
    onSuccess: (data) => {
      setDiscoverError(null)
      setManualMode(false)
      setDiscovered(data.models)
      const next = new Set<string>()
      for (const m of data.models) {
        if (!m.alreadyRegistered) next.add(m.id)
      }
      // Don't auto-select hundreds; leave empty if too many, user filters first
      if (next.size > 80) {
        setSelected(new Set())
        setModel('')
        toast.success(t('keys.discoverSuccess', { count: data.count }))
      } else {
        setSelected(next)
        setModel(Array.from(next).join('\n'))
        toast.success(t('keys.discoverSuccess', { count: data.count }))
      }
    },
    onError: (err) => {
      setDiscoverError((err as Error).message)
      setDiscovered(null)
      setSelected(new Set())
    },
  })

  const addCustom = useMutation({
    meta: { silenceToast: true },
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
      setModel('')
      setDisplayName('')
      setFamily('')
      setSupportsTools(true)
      setSupportsVision(false)
      setDiscovered(null)
      setSelected(new Set())
      setFilter('')
      if (onAdded) {
        toast.success(t('keys.modelAdded'))
        onAdded()
      }
    },
  })

  const syncModelField = (next: Set<string>) => {
    setModel(Array.from(next).join('\n'))
  }

  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      syncModelField(next)
      return next
    })
  }

  const selectAllVisible = () => {
    setSelected(prev => {
      const next = new Set(prev)
      for (const m of filteredDiscovered) next.add(m.id)
      syncModelField(next)
      return next
    })
  }

  const clearSelection = () => {
    setSelected(new Set())
    setModel('')
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (baseUrlError || modelError) {
      setAttempted(true)
      return
    }
    setAttempted(false)
    const common = {
      baseUrl,
      model: models[0],
      displayName: !multiple ? (displayName || undefined) : undefined,
      apiKey: apiKey || undefined,
    }
    if (customType === 'chat') {
      const slug = platformId.trim().toLowerCase()
      addCustom.mutate({
        path: '/api/keys/custom',
        body: {
          baseUrl,
          models,
          displayName: !multiple ? (displayName || undefined) : undefined,
          apiKey: apiKey || undefined,
          supportsTools,
          supportsVision,
          // Named platform → multi API-key rotation (not classic one-key custom)
          ...(slug ? { platformId: slug, label: slug } : {}),
        },
      })
      return
    }
    if (customType === 'embedding') {
      addCustom.mutate({
        path: '/api/embeddings/custom',
        body: { ...common, family: family || undefined },
      })
      return
    }
    addCustom.mutate({
      path: '/api/media/custom',
      body: { ...common, modality: customType },
    })
  }

  const modelPlaceholder = customType === 'chat'
    ? 'qwen3:4b\nllama3:8b'
    : customType === 'embedding'
      ? 'text-embedding-3-small'
      : customType === 'image'
        ? 'gpt-image-1'
        : 'gpt-4o-mini-tts'
  const addLabel = customType === 'chat'
    ? (multiple ? t('keys.addModels', { count: models.length }) : t('keys.addModel'))
    : customType === 'embedding'
      ? t('keys.addEmbeddingModel')
      : customType === 'image'
        ? t('keys.addImageModel')
        : t('keys.addAudioModel')

  const canDiscover = customType === 'chat' && !!baseUrl.trim() && isHttpUrl(baseUrl)
  const showPicker = customType === 'chat' && discovered && !manualMode

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card/40 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t('keys.addCustom')}</p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              {t('keys.addCustomDescription')}
            </p>
          </div>
          {customType === 'chat' && (
            <Badge variant="secondary" className="shrink-0">
              {t('keys.discoverBadge')}
            </Badge>
          )}
        </div>

        <form onSubmit={submit} className="space-y-3">
          {/* Row 1: connection */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
            <div className="space-y-1.5 lg:col-span-2">
              <Label className="text-xs">{t('keys.customType')}</Label>
              <Select
                value={customType}
                onValueChange={(v) => {
                  setCustomType(v as typeof customType)
                  setDiscovered(null)
                  setSelected(new Set())
                  setManualMode(false)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat">{t('keys.customTypeChat')}</SelectItem>
                  <SelectItem value="embedding">{t('keys.customTypeEmbedding')}</SelectItem>
                  <SelectItem value="image">{t('keys.customTypeImage')}</SelectItem>
                  <SelectItem value="audio">{t('keys.customTypeAudio')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 lg:col-span-3">
              <Label className="text-xs">{t('keys.customPlatformId')}</Label>
              <Input
                value={platformId}
                onChange={(e) => setPlatformId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase())}
                placeholder={t('keys.customPlatformIdPlaceholder')}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground leading-snug">
                {t('keys.customPlatformIdHint')}
              </p>
            </div>
            <div className="space-y-1.5 lg:col-span-5">
              <Label className="text-xs">{t('keys.customBaseUrl')}</Label>
              <Input
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://provider.example/v1"
                className="font-mono text-xs"
                aria-invalid={attempted && !!baseUrlError}
              />
              {attempted && <FieldError error={baseUrlError} />}
            </div>
            <div className="space-y-1.5 lg:col-span-3">
              <Label className="text-xs">{t('keys.customApiKey')}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={t('keys.customDisplayNameOptional')}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
            {customType === 'chat' && (
              <div className="space-y-1.5 lg:col-span-2 flex flex-col justify-end">
                <Button
                  type="button"
                  className="w-full"
                  disabled={!canDiscover || discover.isPending}
                  onClick={() => {
                    if (baseUrlError) {
                      setAttempted(true)
                      return
                    }
                    discover.mutate()
                  }}
                >
                  {discover.isPending ? t('keys.discovering') : t('keys.discoverModels')}
                </Button>
              </div>
            )}
          </div>

          {/* Discover picker */}
          {showPicker && (
            <div className="rounded-xl border bg-background shadow-sm overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 justify-between border-b px-3 py-2.5 bg-muted/40">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{t('keys.discoverTitle')}</span>
                  <Badge variant="outline">{t('keys.discoverHint', { count: discovered.length, selected: selected.size })}</Badge>
                  {selectedVisibleCount > 0 && selectedVisibleCount !== selected.size && (
                    <span className="text-muted-foreground">
                      ({selectedVisibleCount} {t('keys.discoverVisibleSelected')})
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button type="button" size="sm" variant="ghost" onClick={selectAllVisible}>
                    {t('keys.discoverSelectAll')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={clearSelection}>
                    {t('keys.discoverClear')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setManualMode(true)
                      setDiscovered(null)
                    }}
                  >
                    {t('keys.discoverManual')}
                  </Button>
                </div>
              </div>

              <div className="px-3 py-2 flex flex-wrap items-center gap-3 border-b">
                <Input
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder={t('keys.discoverFilter')}
                  className="h-8 max-w-sm font-mono text-xs"
                />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                  <Switch size="sm" checked={hideAlready} onCheckedChange={setHideAlready} />
                  {t('keys.discoverHideAlready')}
                </label>
              </div>

              <div className="max-h-64 overflow-y-auto p-2 space-y-0.5">
                {filteredDiscovered.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-2 py-6 text-center">{t('keys.discoverEmpty')}</p>
                ) : (
                  filteredDiscovered.map(m => {
                    const on = selected.has(m.id)
                    return (
                      <label
                        key={m.id}
                        className={cn(
                          'flex items-start gap-2.5 rounded-lg px-2.5 py-2 cursor-pointer transition-colors border border-transparent',
                          on ? 'bg-primary/8 border-primary/20' : 'hover:bg-muted/60',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-primary"
                          checked={on}
                          onChange={() => toggleOne(m.id)}
                        />
                        <span className="font-mono text-xs break-all flex-1 leading-relaxed">{m.id}</span>
                        <span className="flex shrink-0 gap-1">
                          {m.ownedBy && (
                            <Badge variant="ghost" className="text-[10px] max-w-[7rem] truncate">
                              {m.ownedBy}
                            </Badge>
                          )}
                          {m.alreadyRegistered && (
                            <Badge variant="secondary" className="text-[10px]">
                              {t('keys.discoverAlready')}
                            </Badge>
                          )}
                        </span>
                      </label>
                    )
                  })
                )}
              </div>
            </div>
          )}

          {/* Manual model entry (default or after "manual") */}
          {(!showPicker) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {customType === 'chat' ? t('keys.customModels') : t('keys.customModel')}
                </Label>
                <Textarea
                  value={model}
                  onChange={e => {
                    setModel(e.target.value)
                    if (selected.size) setSelected(new Set())
                  }}
                  placeholder={modelPlaceholder}
                  rows={customType === 'chat' ? 3 : 1}
                  className="font-mono text-xs"
                  aria-invalid={attempted && !!modelError}
                />
                {attempted && <FieldError error={modelError} />}
                {customType === 'chat' && (
                  <p className="text-[11px] text-muted-foreground">{t('keys.discoverOrManual')}</p>
                )}
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('keys.customDisplayName')}</Label>
                  <Input
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    placeholder={multiple ? t('keys.customDisplayNamePerModel') : t('keys.customDisplayNameOptional')}
                    disabled={multiple}
                  />
                </div>
                {customType === 'embedding' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('keys.customFamily')}</Label>
                    <Input
                      value={family}
                      onChange={e => setFamily(e.target.value)}
                      placeholder={embeddingsData?.families?.[0]?.family ?? t('keys.customFamilyPlaceholder')}
                      className="font-mono text-xs"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {showPicker && attempted && modelError && <FieldError error={modelError} />}

          {/* Caps + submit */}
          <div className="flex flex-wrap items-end gap-3 pt-1">
            {customType === 'chat' && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('keys.customCapabilities')}</Label>
                <div className="flex h-9 items-center gap-4">
                  <label className="flex items-center gap-1.5 text-xs">
                    <Switch size="sm" checked={supportsTools} onCheckedChange={setSupportsTools} />
                    <span>{t('models.tools')}</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <Switch size="sm" checked={supportsVision} onCheckedChange={setSupportsVision} />
                    <span>{t('models.vision')}</span>
                  </label>
                </div>
              </div>
            )}
            {showPicker && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('keys.customDisplayName')}</Label>
                <Input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  placeholder={multiple ? t('keys.customDisplayNamePerModel') : t('keys.customDisplayNameOptional')}
                  disabled={multiple}
                  className="w-[160px]"
                />
              </div>
            )}
            <div className="flex-1" />
            <Button type="submit" disabled={addCustom.isPending} className="min-w-[140px]">
              {addCustom.isPending ? t('keys.addingCustom') : addLabel}
            </Button>
          </div>
        </form>
      </div>

      {(addCustom.isError || discoverError) && (
        <p className="text-destructive text-xs px-1">
          {discoverError || (addCustom.error as Error)?.message}
        </p>
      )}
    </div>
  )
}
