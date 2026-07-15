import type { ChatMessage } from '@freellmapi/shared/types.js';
export declare const CACHE_ENABLED_SETTING = "response_cache_enabled";
/**
 * Master switch. Default off so adopting the cache is an explicit choice. The
 * settings-table value wins when present (dashboard toggle, no restart), then
 * the RESPONSE_CACHE env var, then off.
 */
export declare function isCacheEnabled(): boolean;
/** Entry lifetime. Default 1h: long enough to absorb retries and agent re-runs,
 *  short enough that a refreshed catalog or key changes answers soon after. */
export declare function cacheTtlMs(): number;
/** Above this temperature a request wants variety, so it is never cached.
 *  Default 1.0 caches everything when enabled (max quota savings); lower it to
 *  restrict caching to (near-)deterministic calls. */
export declare function cacheMaxTemperature(): number;
/** Hard cap on stored entries; least-recently-used are evicted past this.
 *  Bounds memory use. */
export declare function cacheMaxEntries(): number;
export declare function isCacheableTemperature(temperature?: number | null): boolean;
export type CacheDirective = 'default' | 'off' | 'on';
export declare function parseCacheDirective(header: string | string[] | undefined, cacheControl?: string | string[] | undefined): CacheDirective;
/** Resolve the global switch + per-request directive into a single yes/no. */
export declare function cacheActive(directive: CacheDirective): boolean;
export interface CacheKeyInput {
    model: string | undefined;
    messages: ChatMessage[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    tools?: unknown;
    tool_choice?: unknown;
    stop?: unknown;
    response_format?: unknown;
    n?: unknown;
    seed?: unknown;
    presence_penalty?: unknown;
    frequency_penalty?: unknown;
    logit_bias?: unknown;
    logprobs?: unknown;
    top_logprobs?: unknown;
}
export declare function computeCacheKey(input: CacheKeyInput): string;
export interface CachedResponse {
    body: unknown;
    platform: string;
    modelId: string;
    keyId: number | null;
    promptTokens: number;
    completionTokens: number;
}
export interface StoreInput {
    body: unknown;
    platform: string;
    modelId: string;
    keyId: number | null;
    promptTokens: number;
    completionTokens: number;
}
/**
 * Look up a cached completion. Returns null on a miss or when the entry has aged
 * past the TTL (expired entries are deleted lazily on read). A hit bumps the
 * entry's hit_count and moves it to most-recently-used.
 */
export declare function getCachedResponse(cacheKey: string, now?: number): CachedResponse | null;
/**
 * Store a successful completion. Overwrites any existing entry for the key (a
 * re-generation refreshes the cached answer, its TTL, and its hit count).
 * Enforces the entry cap by evicting the least-recently-used entries. Best-
 * effort: an unserializable body is skipped so caching can never break a
 * request that already succeeded.
 */
export declare function storeCachedResponse(cacheKey: string, input: StoreInput, now?: number): void;
export interface CacheStats {
    entries: number;
    totalHits: number;
    savedPromptTokens: number;
    savedCompletionTokens: number;
}
/**
 * Aggregate cache stats for the dashboard. "saved" tokens are the provider
 * tokens that hits avoided spending: hit_count x the entry's token counts,
 * summed, i.e. the free-tier quota the cache gave back.
 */
export declare function getCacheStats(): CacheStats;
/** Drop every cached entry. Returns the number removed. */
export declare function clearCache(): number;
//# sourceMappingURL=cache.d.ts.map