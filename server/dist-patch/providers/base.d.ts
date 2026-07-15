import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk, ChatToolDefinition, ChatToolChoice, Platform } from '@freellmapi/shared/types.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import type { ExtendedSamplingOptions } from '../lib/sampling-params.js';
/** A provider HTTP error carrying the upstream status and, when the response
 *  included a Retry-After header, the parsed delay so the router can bench the
 *  key for at least that long. */
export interface ProviderHttpError extends Error {
    status?: number;
    retryAfterMs?: number;
}
/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 *  millisecond delay. Returns undefined when absent or unparseable. */
export declare function parseRetryAfterMs(value: string | null | undefined): number | undefined;
/** Build an error for a non-OK upstream response, capturing the status and any
 *  Retry-After hint. Used by every provider adapter so the proxy can honor a
 *  provider's explicit back-off when it sets the cooldown. */
export declare function providerHttpError(res: Response, message: string): ProviderHttpError;
export interface CompletionOptions extends ExtendedSamplingOptions {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: string | string[];
    tools?: ChatToolDefinition[];
    tool_choice?: ChatToolChoice;
    parallel_tool_calls?: boolean;
    /** Per-call HTTP timeout override. Not part of the OpenAI wire format (it is
     * stripped before the request body is built); used by the probe script so
     * NVIDIA's 15-60s serverless cold starts don't read as failures. */
    timeoutMs?: number;
}
export declare abstract class BaseProvider {
    abstract readonly platform: Platform;
    abstract readonly name: string;
    /** Providers whose free tier needs no API key (e.g. Kilo's anonymous gateway).
     * When true, the gateway stores a sentinel key row so routing still considers
     * the platform "configured", and the provider omits the Authorization header
     * on outgoing requests. Defaults to false; set by subclasses. */
    keyless: boolean;
    abstract chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse>;
    abstract streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk>;
    abstract validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean>;
    protected fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>;
    protected makeId(): string;
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
    protected readSseStream(res: Response, inactivityTimeoutMs?: number): AsyncGenerator<ChatCompletionChunk>;
}
//# sourceMappingURL=base.d.ts.map