// Stable identity for user-defined OpenAI-compatible endpoints.

import type { Db } from '../db/types.js';

/** Match the way base_url is stored and compare endpoints slash-insensitively. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Empty means a built-in/catalog model or a legacy unscoped custom row. */
export function endpointScopeForBaseUrl(baseUrl: string | null | undefined): string {
  return baseUrl ? normalizeBaseUrl(baseUrl) : '';
}

/** Resolve a user-defined endpoint scope from its bound credential. Built-in
 * provider keys normally have no base_url and therefore return an empty scope. */
export function endpointScopeOfKey(db: Db, keyId: number | null | undefined): string {
  if (keyId == null) return '';
  const row = db.prepare(
    'SELECT base_url FROM api_keys WHERE id = ?',
  ).get(keyId) as { base_url: string | null } | undefined;
  return endpointScopeForBaseUrl(row?.base_url);
}

/** Stable bucket identity for speed/reliability and round-robin cursors. */
export function modelStatsKey(
  platform: string,
  modelId: string,
  endpointScope: string | null | undefined,
): string {
  return endpointScope ? `${platform}:${modelId}@${endpointScope}` : `${platform}:${modelId}`;
}

/** Human-readable endpoint handle for qualified model IDs. */
export function endpointHandle(scope: string): string {
  const withoutScheme = scope.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slug = withoutScheme
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'endpoint';
}

export const ENDPOINT_ID_SEPARATOR = '#';

export function qualifiedModelMemberId(
  platform: string,
  modelId: string,
  endpointScope: string | null | undefined,
): string | null {
  if (!endpointScope) return null;
  return `${platform}:${modelId}${ENDPOINT_ID_SEPARATOR}${endpointHandle(endpointScope)}`;
}

export function endpointRefMatches(requested: string, endpointScope: string): boolean {
  const ref = requested.trim();
  return Boolean(ref && endpointScope && endpointHandle(ref) === endpointHandle(endpointScope));
}
