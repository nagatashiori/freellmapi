import { proxyFetch } from '../lib/proxy.js';
/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 *  millisecond delay. Returns undefined when absent or unparseable. */
export function parseRetryAfterMs(value) {
    if (!value)
        return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed))
        return Number(trimmed) * 1000;
    const when = Date.parse(trimmed);
    if (!Number.isNaN(when))
        return Math.max(0, when - Date.now());
    return undefined;
}
/** Build an error for a non-OK upstream response, capturing the status and any
 *  Retry-After hint. Used by every provider adapter so the proxy can honor a
 *  provider's explicit back-off when it sets the cooldown. */
export function providerHttpError(res, message) {
    const err = new Error(message);
    err.status = res.status;
    const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after'));
    if (retryAfterMs !== undefined)
        err.retryAfterMs = retryAfterMs;
    return err;
}
export class BaseProvider {
    /** Providers whose free tier needs no API key (e.g. Kilo's anonymous gateway).
     * When true, the gateway stores a sentinel key row so routing still considers
     * the platform "configured", and the provider omits the Authorization header
     * on outgoing requests. Defaults to false; set by subclasses. */
    keyless = false;
    async fetchWithTimeout(url, init, timeoutMs = 15000) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // requestType='chat' + timeoutMs makes the AbortError message read
            // `<platform>, chat, 15s` for triage from the requests.error column.
            return await proxyFetch(url, { ...init, signal: controller.signal }, this.platform, 'chat', timeoutMs);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    makeId() {
        return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    /**
     * Shared SSE reader for OpenAI-wire streaming endpoints (#231 audit).
     *
     * Hardened against the upstream failure modes observed live:
     *  - Inactivity timeout: fetchWithTimeout's abort timer dies the moment
     *    response HEADERS arrive, so a provider that stalls mid-body used to
     *    hang the client forever. Each read now has its own deadline.
     *  - Abrupt EOF: a stream that ends without `[DONE]` AND without any
     *    `finish_reason` is a truncated generation, not a completion. It used
     *    to end the generator silently (truncation logged as success); it now
     *    throws a retryable error so the proxy can fail over or report it.
     *    Providers that skip `[DONE]` but do send a terminal finish_reason
     *    (several compat shims) still complete normally.
     *
     * Malformed data lines are skipped, matching previous behavior.
     */
    async *readSseStream(res, inactivityTimeoutMs = 90000) {
        const reader = res.body?.getReader();
        if (!reader)
            throw new Error('No response body');
        const decoder = new TextDecoder();
        let buffer = '';
        let sawFinishReason = false;
        try {
            while (true) {
                let timer;
                const result = await Promise.race([
                    reader.read(),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(`${this.name} stream stalled: no data for ${inactivityTimeoutMs}ms (timeout)`)), inactivityTimeoutMs);
                    }),
                ]).finally(() => clearTimeout(timer));
                const { done, value } = result;
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: '))
                        continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]')
                        return;
                    try {
                        const chunk = JSON.parse(data);
                        if (chunk.choices?.some(c => c.finish_reason != null))
                            sawFinishReason = true;
                        yield chunk;
                    }
                    catch {
                        // Skip malformed chunks
                    }
                }
            }
        }
        finally {
            reader.cancel().catch(() => { });
        }
        if (!sawFinishReason) {
            throw new Error(`${this.name} stream ended unexpectedly (no [DONE], no finish_reason) — connection reset or truncated upstream`);
        }
    }
}
//# sourceMappingURL=base.js.map