// Per-key model scope. A null or invalid scope is intentionally treated as
// unscoped so a bad optional setting cannot silently make a provider unusable.

/** Parse api_keys.model_scope_json into an O(1) lookup set. */
export function parseModelScope(json: string | null | undefined): Set<string> | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return null;
    const ids = value.map(item => typeof item === 'string' ? item.trim() : '')
      .filter((item): item is string => item.length > 0);
    // A scope is all-or-nothing. A malformed array must not silently become a
    // partial allow-list, because that could unexpectedly route a request to a
    // key the operator meant to exclude.
    if (ids.length !== value.length) return null;
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  }
}

/** Whether a key with the parsed scope may serve the requested model. */
export function scopeAllows(scope: Set<string> | null, modelId: string): boolean {
  return scope === null || scope.has(modelId);
}
