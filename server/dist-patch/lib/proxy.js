import http from 'http';
import https from 'https';
import { assertProviderUrlAllowed } from './url-guard.js';
let _proxyAgentCtor = null;
let _socksAgentCtor = null;
async function loadHttpProxyAgent() {
    if (!_proxyAgentCtor)
        _proxyAgentCtor = (await import('undici')).ProxyAgent;
    return _proxyAgentCtor;
}
async function loadSocksAgent() {
    if (!_socksAgentCtor)
        _socksAgentCtor = (await import('socks-proxy-agent')).SocksProxyAgent;
    return _socksAgentCtor;
}
// Module-level proxy URL.
let _proxyUrl = '';
let _proxyEnabled = true;
let _bypassPlatforms = new Set();
let _initialized = false;
// Cache.
let cached = null;
const CACHE_TTL_MS = 30_000;
/** Called once at startup (after initDb) and on PUT /api/settings/proxy. */
export function applyProxyUrl(dbValue) {
    const envUrl = process.env.PROXY_URL?.trim();
    if (envUrl) {
        _proxyUrl = envUrl;
    }
    else {
        _proxyUrl = dbValue.trim();
    }
    cached = null;
    if (_proxyUrl) {
        const masked = _proxyUrl.replace(/\/\/[^@]*@/, '//***@');
        console.log(`[proxy] Configured → ${masked}`);
    }
    else {
        console.log('[proxy] Not configured — outbound requests go direct.');
    }
    _initialized = true;
}
export function getProxyUrl() {
    return _proxyUrl;
}
/** Toggle the proxy on/off without losing the URL. */
export function applyProxyEnabled(enabled) {
    _proxyEnabled = enabled;
    if (!enabled)
        console.log('[proxy] Disabled — requests go direct.');
}
export function isProxyEnabled() {
    return _proxyEnabled;
}
/** Set which platforms bypass the proxy. Comma-separated string from DB. */
export function applyProxyBypass(platformsCsv) {
    _bypassPlatforms = new Set(platformsCsv
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean));
    if (_bypassPlatforms.size > 0) {
        console.log(`[proxy] Bypass for: ${[..._bypassPlatforms].join(', ')}`);
    }
}
export function getProxyBypassPlatforms() {
    return [..._bypassPlatforms];
}
/**
 * Returns true when a platform should NOT use the proxy.
 * True when: proxy is disabled globally, or the platform is in the bypass list.
 */
function shouldBypassProxy(platform) {
    if (!_proxyEnabled)
        return true;
    if (platform && _bypassPlatforms.has(platform.toLowerCase()))
        return true;
    return false;
}
/**
 * Resolve the proxy dispatcher. For SOCKS schemes this returns a
 * SocksProxyAgent; for HTTP/HTTPS it returns an undici ProxyAgent.
 */
async function resolveDispatcher() {
    const now = Date.now();
    if (cached && (now - cached.ts) < CACHE_TTL_MS) {
        return cached.dispatcher ? { dispatcher: cached.dispatcher, isSocks: cached.isSocks } : undefined;
    }
    if (!_initialized)
        applyProxyUrl('');
    if (!_proxyUrl) {
        cached = { dispatcher: undefined, proxyUrl: '', isSocks: false, ts: now };
        return undefined;
    }
    try {
        const isSocks = _proxyUrl.startsWith('socks5:') || _proxyUrl.startsWith('socks4:');
        if (isSocks) {
            const SocksAgent = await loadSocksAgent();
            const dispatcher = new SocksAgent(_proxyUrl);
            cached = { dispatcher, proxyUrl: _proxyUrl, isSocks: true, ts: now };
            return { dispatcher, isSocks: true };
        }
        const ProxyAgentCtor = await loadHttpProxyAgent();
        const dispatcher = new ProxyAgentCtor({ uri: _proxyUrl });
        cached = { dispatcher, proxyUrl: _proxyUrl, isSocks: false, ts: now };
        return { dispatcher, isSocks: false };
    }
    catch (err) {
        const masked = _proxyUrl.replace(/\/\/[^@]*@/, '//***@');
        console.error(`[proxy] Failed to create dispatcher for "${masked}": ${err.message}`);
        cached = { dispatcher: undefined, proxyUrl: _proxyUrl, isSocks: false, ts: now };
        return undefined;
    }
}
/**
 * Build an AbortError DOMException whose `message` carries a compact triage
 * tag in the form `<platform>, <type>, <timeout>s`. No upstream URL, no
 * credentials — the platform column in `requests` already identifies the
 * upstream and the type column identifies the request kind, so the abort
 * message just needs to round-trip what's already on the row.
 *
 * `isRetryableError()` still triggers on the literal substring "aborted".
 *
 * `elapsedMs` (when known) is appended so timeout vs. client-cancel is
 * distinguishable in logs.
 */
function abortError(platform, type, timeoutMs, elapsedMs) {
    const tag = describeAbort(platform, type, timeoutMs);
    const timing = typeof elapsedMs === 'number' ? ` after ${elapsedMs}ms` : '';
    return new DOMException(`The operation was aborted (${tag})${timing}`, 'AbortError');
}
/**
 * Format the `<platform>, <type>, <timeout>s` tag. Exposed for testing and
 * for callers that want to log the tag without re-throwing. Falls back
 * gracefully when fields are missing: unknown platform → 'unknown',
 * unknown type → 'unknown', no timeout → omit the trailing ', <N>s'.
 */
export function describeAbort(platform, type, timeoutMs) {
    const p = (platform && platform.trim()) || 'unknown';
    const t = type || 'unknown';
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return `${p}, ${t}`;
    }
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return `${p}, ${t}, ${seconds}s`;
}
/**
 * Rewrite an AbortError rejection so its `.message` carries the compact
 * triage tag `<platform>, <type>, <timeout>s`. Preserves `name: 'AbortError'`
 * so `isRetryableError()` (which matches on the substring "aborted") keeps
 * classifying it as retryable. If the original error is not an AbortError,
 * it's returned unchanged.
 */
function enrichAbort(err, platform, type, timeoutMs) {
    if (!err || typeof err !== 'object')
        return err;
    const e = err;
    const isAbort = e.name === 'AbortError' || /aborted/i.test(e.message ?? '');
    if (!isAbort)
        return e;
    const enriched = new DOMException(`The operation was aborted (${describeAbort(platform, type, timeoutMs)})`, 'AbortError');
    // Preserve upstream error chain so debug logs still see the original cause.
    if (e.cause !== undefined)
        enriched.cause = e.cause;
    return enriched;
}
function socksFetch(urlStr, init, agent, platform, type, timeoutMs) {
    const url = new URL(urlStr);
    const isTls = url.protocol === 'https:';
    const transport = isTls ? https : http;
    const port = url.port || (isTls ? 443 : 80);
    const method = init?.method ?? 'GET';
    const headers = {};
    if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers)) {
            headers[k.toLowerCase()] = v;
        }
    }
    const signal = init?.signal;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const req = transport.request({
            hostname: url.hostname,
            port,
            path: url.pathname + url.search,
            method,
            headers: { ...headers, host: url.hostname },
            agent,
            servername: isTls ? url.hostname : undefined,
            rejectUnauthorized: true,
            timeout: 120_000,
        }, (res) => {
            if (signal?.aborted) {
                res.destroy();
                reject(abortError(platform, type, timeoutMs, Date.now() - startedAt));
                return;
            }
            const status = res.statusCode ?? 0;
            const statusText = res.statusMessage ?? '';
            const body = new ReadableStream({
                start(controller) {
                    res.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
                    res.on('end', () => controller.close());
                    res.on('error', (err) => controller.error(err));
                },
                cancel() {
                    res.destroy();
                },
            });
            const hdrs = {};
            for (const [k, v] of Object.entries(res.headers)) {
                hdrs[k] = v;
            }
            resolve(new Response(body, { status, statusText, headers: hdrs }));
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        if (signal) {
            if (signal.aborted) {
                req.destroy();
                reject(abortError(platform, type, timeoutMs, Date.now() - startedAt));
                return;
            }
            signal.addEventListener('abort', () => {
                req.destroy();
                reject(abortError(platform, type, timeoutMs, Date.now() - startedAt));
            }, { once: true });
        }
        if (init?.body) {
            req.write(init.body);
        }
        req.end();
    });
}
/**
 * Drop-in replacement for `fetch(url, init)` that routes through the
 * configured proxy. Pass an optional `platform` string to respect the
 * per-platform bypass list.
 *
 * When no proxy is configured, or proxy is disabled, or the platform is
 * in the bypass list, this is a direct pass-through to `fetch()`.
 *
 * `requestType` and `timeoutMs` are propagated into the AbortError
 * message so triage reads `<platform>, <type>, <timeout>s`. Both default
 * to `undefined` / `'unknown'` when callers haven't been updated yet —
 * the abort still fires, it just omits the unknown fields.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export async function proxyFetch(url, init, platform, requestType = 'unknown', timeoutMs) {
    try {
        // SSRF guard (#440): 'custom' is the only platform whose target URL is
        // user-supplied (base_url on the api_keys row), so it is re-assessed on
        // every request — a URL saved before the guard existed, edited in the DB,
        // or whose DNS now points somewhere blocked still can't reach cloud
        // metadata / link-local addresses.
        if (platform === 'custom') {
            await assertProviderUrlAllowed(url);
            // Redirects are never followed for custom providers: fetch()'s default
            // 'follow' would re-request the Location target WITHOUT re-running the
            // guard above, so a public base_url answering 302 → an internal or
            // metadata address would defeat the check. socksFetch (http.request)
            // never followed redirects; forcing redirect: 'manual' here makes every
            // path behave the same, and the 3xx is converted to an explicit error
            // below so the operator sees why instead of a confusing empty body.
            init = { ...init, redirect: 'manual' };
        }
        const response = await dispatchFetch(url, init, platform, requestType, timeoutMs);
        if (platform === 'custom' && REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get('location') ?? 'an unspecified location';
            throw new Error(`Custom provider URL blocked: upstream redirected (${response.status}) to ${location}; ` +
                'redirects are not followed for custom providers, point base_url directly at the API');
        }
        return response;
    }
    catch (err) {
        // Rewrite bare "The operation was aborted" rejections so they carry the
        // compact triage tag. Preserves the AbortError name so
        // `isRetryableError()` still classifies the failure as retryable.
        throw enrichAbort(err, platform, requestType, timeoutMs);
    }
}
/** Route the request through the configured proxy (or straight to fetch). */
async function dispatchFetch(url, init, platform, requestType, timeoutMs) {
    // Bypass check: disabled globally, or this platform is exempt.
    if (shouldBypassProxy(platform)) {
        return fetch(url, init);
    }
    const resolved = await resolveDispatcher();
    // No dispatcher (no proxy URL configured, or it failed to build) → direct
    if (!resolved) {
        return fetch(url, init);
    }
    // SOCKS proxy → http/https fallback
    if (resolved.isSocks) {
        return socksFetch(url, init, resolved.dispatcher, platform, requestType, timeoutMs);
    }
    // HTTP/HTTPS proxy → undici (dispatcher is an undici extension not in TS types)
    return fetch(url, { ...init, dispatcher: resolved.dispatcher });
}
/**
 * Returns true when the proxy is configured AND enabled. Used by the dashboard
 * to show the "Active" badge. Intentionally does NOT construct a dispatcher (so
 * it never triggers the lazy undici import) — "configured + enabled" is exactly
 * what the badge means.
 */
export function isProxyActive() {
    if (!_initialized)
        applyProxyUrl('');
    return _proxyEnabled && !!_proxyUrl;
}
/** Force-rebuild the outbound connection pools on the next request. Called on
 *  sleep/wake recovery to drop pooled TCP connections that died while the
 *  host was suspended (undici keeps them warm and would hand a dead socket
 *  to the first post-wake request). */
export function flushProxyCache() {
    // Outbound-proxy dispatcher (only in play when a proxy URL is configured).
    cached = null;
    // The default no-proxy path is bare fetch() on Node's GLOBAL undici
    // dispatcher — exactly the pool the headline laptop-lid scenario rides — so
    // nulling the proxy cache alone left the flush a no-op for most
    // deployments. Node keeps that dispatcher in the global symbol registry
    // (getGlobalDispatcher/setGlobalDispatcher read and write the same key), so
    // swap in a fresh instance of its own constructor: new requests get new
    // sockets, in-flight requests keep a reference to the old dispatcher and
    // complete undisturbed. Deliberately NOT `import('undici')`: the built-in
    // fetch uses Node's bundled copy, and the npm package isn't installed in
    // the production image (verified live — the import throws there).
    try {
        const sym = Symbol.for('undici.globalDispatcher.1');
        const current = globalThis[sym];
        // Symbol unset = no fetch has run yet, so there are no pooled sockets to drop.
        if (current?.constructor) {
            globalThis[sym] = new current.constructor();
        }
    }
    catch (err) {
        console.warn(`[proxy] could not replace the global fetch dispatcher on wake: ${err?.message ?? err}`);
    }
}
//# sourceMappingURL=proxy.js.map