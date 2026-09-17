import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { customEndpointKeyIds } from './custom-endpoint.js';
import { reserveMonthlyBudget } from './key-budget.js';
import {
  acquireLease,
  canMakeRequest,
  canUseKeyConcurrency,
  canUseProvider,
  canUseProviderMinute,
  canUseProviderTokens,
  canUseTokens,
  isOnCooldown,
  releaseLease,
} from './ratelimit.js';

export interface ReservedProviderCredential {
  id: number;
  key: string;
  baseUrl: string | null;
  release: () => void;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
  model_scope_json: string | null;
}

interface CredentialSourceRow {
  platform: string;
  key_id: number | null;
  model_id?: string;
  rpm_limit?: number | null;
  rpd_limit?: number | null;
  tpm_limit?: number | null;
  tpd_limit?: number | null;
}

/** Select and reserve a credential for the independent embeddings/media routers.
 *
 * Keep the official v0.11 monthly-budget reservation, but apply the same key
 * eligibility boundaries as chat where they are meaningful for non-chat calls:
 * model scope, custom-endpoint sibling pools, cooldowns, provider-wide request
 * and token caps, and the shared per-key concurrency lease. A custom model is
 * still bound to an ENDPOINT via key_id; every healthy sibling key with the same
 * base_url may serve it, matching the official chat router's endpoint semantics.
 *
 * Callers release after logging the result. The returned release is idempotent
 * and releases both the monthly-budget reservation and the in-flight lease.
 */
export function reserveProviderCredential(
  row: CredentialSourceRow,
  estimatedTokens: number,
  skip: (keyId: number) => boolean = () => false,
): { credential: ReservedProviderCredential | null; budgetBlocked: boolean } {
  if (row.platform === 'custom' && row.key_id == null) return { credential: null, budgetBlocked: false };
  const db = getDb();
  const anchor = row.key_id == null
    ? undefined
    : db.prepare('SELECT id, platform, base_url FROM api_keys WHERE id = ?').get(row.key_id) as
        { id: number; platform: string; base_url: string | null } | undefined;
  const endpointBound = row.platform === 'custom' && anchor?.platform === 'custom';
  const boundIds = row.key_id == null
    ? null
    : endpointBound
      ? customEndpointKeyIds(db, row.key_id)
      : new Set([row.key_id]);
  const modelId = row.model_id?.trim() || null;
  const limits = {
    rpm: row.rpm_limit ?? null,
    rpd: row.rpd_limit ?? null,
    tpm: row.tpm_limit ?? null,
    tpd: row.tpd_limit ?? null,
  };
  const keys = row.key_id != null && !endpointBound
    ? db.prepare(`
        SELECT id, platform, encrypted_key, iv, auth_tag, base_url, model_scope_json FROM api_keys
        WHERE id = ? AND enabled = 1 AND status IN ('healthy', 'unknown')
      `).all(row.key_id) as KeyRow[]
    : db.prepare(`
        SELECT id, platform, encrypted_key, iv, auth_tag, base_url, model_scope_json FROM api_keys
        WHERE platform = ? AND enabled = 1
          AND status IN ('healthy', 'unknown') ORDER BY RANDOM()
      `).all(row.platform) as KeyRow[];
  let budgetBlocked = false;
  for (const keyRow of keys) {
    if (boundIds && !boundIds.has(keyRow.id)) continue;
    if (skip(keyRow.id)) continue;
    if (modelId && !scopeAllows(parseModelScope(keyRow.model_scope_json), modelId)) continue;
    if (modelId) {
      if (isOnCooldown(row.platform, modelId, keyRow.id)) continue;
      if (!canUseProvider(row.platform, keyRow.id)) continue;
      if (!canUseProviderMinute(row.platform, keyRow.id)) continue;
      if (!canUseKeyConcurrency(row.platform, keyRow.id)) continue;
      if (!canMakeRequest(row.platform, modelId, keyRow.id, limits)) continue;
      if (!canUseTokens(row.platform, modelId, keyRow.id, estimatedTokens, limits)) continue;
      if (!canUseProviderTokens(row.platform, keyRow.id, modelId, estimatedTokens)) continue;
    }
    let key: string;
    try {
      key = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    } catch {
      continue;
    }
    const reservation = reserveMonthlyBudget(keyRow.id, estimatedTokens);
    if (!reservation.allowed) { budgetBlocked = true; continue; }
    const leaseId = modelId == null
      ? null
      : acquireLease(row.platform, modelId, keyRow.id, estimatedTokens);
    let released = false;
    return {
      credential: {
        id: keyRow.id, key,
        baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null,
        release: () => {
          if (released) return;
          released = true;
          if (leaseId != null) releaseLease(leaseId);
          reservation.release();
        },
      },
      budgetBlocked,
    };
  }
  return { credential: null, budgetBlocked };
}
