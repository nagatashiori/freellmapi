/** Called once at startup (after initDb) and on PUT /api/settings/proxy. */
export declare function applyProxyUrl(dbValue: string): void;
export declare function getProxyUrl(): string;
/** Toggle the proxy on/off without losing the URL. */
export declare function applyProxyEnabled(enabled: boolean): void;
export declare function isProxyEnabled(): boolean;
/** Set which platforms bypass the proxy. Comma-separated string from DB. */
export declare function applyProxyBypass(platformsCsv: string): void;
export declare function getProxyBypassPlatforms(): string[];
/**
 * Request kinds recognised in AbortError messages. Mirrors the values
 * written to `requests.request_type` so the abort message and the row
 * column agree on terminology.
 */
export type ProxyRequestType = 'chat' | 'embedding' | 'image' | 'audio' | 'unknown';
/**
 * Format the `<platform>, <type>, <timeout>s` tag. Exposed for testing and
 * for callers that want to log the tag without re-throwing. Falls back
 * gracefully when fields are missing: unknown platform → 'unknown',
 * unknown type → 'unknown', no timeout → omit the trailing ', <N>s'.
 */
export declare function describeAbort(platform: string | undefined, type: ProxyRequestType, timeoutMs: number | undefined): string;
export declare function proxyFetch(url: string, init?: RequestInit, platform?: string, requestType?: ProxyRequestType, timeoutMs?: number): Promise<Response>;
/**
 * Returns true when the proxy is configured AND enabled. Used by the dashboard
 * to show the "Active" badge. Intentionally does NOT construct a dispatcher (so
 * it never triggers the lazy undici import) — "configured + enabled" is exactly
 * what the badge means.
 */
export declare function isProxyActive(): boolean;
/** Force-rebuild the outbound connection pools on the next request. Called on
 *  sleep/wake recovery to drop pooled TCP connections that died while the
 *  host was suspended (undici keeps them warm and would hand a dead socket
 *  to the first post-wake request). */
export declare function flushProxyCache(): void;
//# sourceMappingURL=proxy.d.ts.map