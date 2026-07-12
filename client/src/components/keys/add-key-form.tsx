import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FieldError } from '@/components/ui/field-error'
import type { ApiKey } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { GetKeyLink, PLATFORMS } from './shared'

type PlatformOption = { value: string; label: string; url?: string; keyless?: boolean; user?: boolean }

// The "Provider key" pane of the Add key dialog: paste a credential for a known
// provider OR an already-created named platform (modelscope / locedge / aihub…).
// Named platforms only appear after first Custom+platformId setup; then you add
// more keys here for multi-account rotation.
export function AddKeyForm({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<string>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [addAttempted, setAddAttempted] = useState(false)

  // Existing keys → discover named user platforms (have baseUrl, not classic custom)
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const platformOptions: PlatformOption[] = useMemo(() => {
    const builtin: PlatformOption[] = PLATFORMS.map(p => ({
      value: p.value,
      label: p.label,
      url: p.url,
      keyless: p.keyless,
    }))
    const known = new Set(builtin.map(p => p.value))
    known.add('custom')
    const userSlugs = new Map<string, string>() // platform → baseUrl label
    for (const k of keys) {
      const p = String(k.platform || '')
      if (!p || known.has(p)) continue
      if (!k.baseUrl) continue
      if (!userSlugs.has(p)) userSlugs.set(p, k.baseUrl)
    }
    const userOpts: PlatformOption[] = [...userSlugs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, base]) => ({
        value: p,
        label: p === 'aihub' ? 'AiHub' : p === 'modelscope' ? 'ModelScope' : `Custom: ${p}`,
        url: base,
        user: true,
      }))
    return [...userOpts, ...builtin]
  }, [keys])

  const addKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch<{ notice?: string | null }>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      toast.success(t('keys.keyAdded'))
      // Server notice when the key is for a platform with no models in the
      // current catalog tier yet (#438) — surfaced as a toast now that the
      // dialog closes on success.
      if (data?.notice) toast.info(data.notice)
      onSuccess()
    },
  })

  const selected = platformOptions.find(p => p.value === platform)
  const needsAccountId = platform === 'cloudflare'
  const isKeyless = selected?.keyless ?? false
  const isUserPlatform = selected?.user === true

  // Field-level validation: the submit stays clickable and reveals what is
  // missing instead of being silently disabled.
  const platformError = !platform ? t('validation.required') : null
  const keyError = !isKeyless && !apiKey.trim() ? t('validation.required') : null
  const accountIdError = needsAccountId && !accountId.trim() ? t('validation.required') : null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (platformError || keyError || accountIdError) {
      setAddAttempted(true)
      return
    }
    setAddAttempted(false)
    // Keyless providers submit an empty key; the backend stores a sentinel.
    const key = isKeyless ? '' : (needsAccountId ? `${accountId}:${apiKey}` : apiKey)
    addKey.mutate({ platform, key, label: label || undefined })
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-wrap gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.platform')}</Label>
          <Select value={platform} onValueChange={(v) => setPlatform(v ?? '')}>
            <SelectTrigger className="w-[260px]" aria-invalid={addAttempted && !!platformError}>
              <SelectValue placeholder={t('keys.selectPlatform')} />
            </SelectTrigger>
            <SelectContent>
              {platformOptions.some(p => p.user) && (
                <>
                  {platformOptions.filter(p => p.user).map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </>
              )}
              {platformOptions.filter(p => !p.user).map(p => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {addAttempted && <FieldError error={platformError} />}
          {isUserPlatform && (
            <p className="text-[11px] text-muted-foreground max-w-[260px] leading-snug">
              {t('keys.userPlatformAddKeyHint') || 'Adds another API key to this custom platform (same base URL, multi-account).'}
            </p>
          )}
          {(() => {
            const sel = platformOptions.find(p => p.value === platform)
            return sel?.url && !sel.user ? <div className="pt-0.5"><GetKeyLink url={sel.url} /></div> : null
          })()}
        </div>
        {needsAccountId && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.accountId')}</Label>
            <Input
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              placeholder="a1b2c3d4…"
              className="w-[200px] font-mono text-xs"
              aria-invalid={addAttempted && !!accountIdError}
            />
            {addAttempted && <FieldError error={accountIdError} />}
          </div>
        )}
        <div className="space-y-1.5 flex-1 min-w-[240px]">
          <Label className="text-xs">{needsAccountId ? t('keys.apiToken') : t('keys.customApiKey')}</Label>
          <Input
            type="password"
            value={isKeyless ? '' : apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={isKeyless ? t('keys.noKeyNeededPlaceholder') : (needsAccountId ? t('keys.bearerTokenPlaceholder') : t('keys.pasteKeyPlaceholder'))}
            className="font-mono text-xs"
            disabled={isKeyless}
            aria-invalid={addAttempted && !!keyError}
          />
          {addAttempted && <FieldError error={keyError} />}
          {isKeyless && (
            <p className="text-[11px] text-muted-foreground">
              {t('keys.keylessHint')}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.label')}</Label>
          <div className="flex flex-wrap items-center space-x-3">
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={t('keys.customDisplayNameOptional')}
              className="w-[160px]"
            />
            <Button type="submit" size="sm" disabled={addKey.isPending}>
              {addKey.isPending ? t('keys.adding') : isKeyless ? t('keys.enable') : t('keys.addKey')}
            </Button>
          </div>
        </div>
      </form>
      {addKey.isError && (
        <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
      )}
    </div>
  )
}
