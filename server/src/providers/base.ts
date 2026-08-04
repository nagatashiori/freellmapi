import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import type { ExtendedSamplingOptions } from '../lib/sampling-params.js';
import { proxyFetch } from '../lib/proxy.js';

/** A provider HTTP error carrying the upstream status and, when the response
 *  included a Retry-After header, the parsed delay so the router can bench the
 *  key for at least that long. */
export interface ProviderHttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

/** Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 *  millisecond delay. Returns undefined when absent or unparseable. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/** Build an error for a non-OK upstream response, capturing the status and any
 *  Retry-After hint. Used by every provider adapter so the proxy can honor a
 *  provider's explicit back-off when it sets the cooldown. */
export function providerHttpError(res: Response, message: string): ProviderHttpError {
  const err = new Error(message) as ProviderHttpError;
  err.status = res.status;
  const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after'));
  if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
  return err;
}

// Extended sampling knobs (top_k, seed, penalties, logit_bias, logprobs,
// response_format…) ride along via ExtendedSamplingOptions; adapters forward
// them per the platform policy in lib/sampling-params.ts.
/** 供应商模型列表的完整请求描述；仅服务端可见，不得直接返回浏览器。 */
export interface ModelCatalogRequest {
  url: string;
  headers?: Record<string, string>;
}

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
  /** External abort signal that cancels this request when it fires. The fallback
   * loop passes the per-attempt deadline (single-hop timeout OR remaining
   * budget) here, plus the client-disconnect signal, so a provider request
   * actually stops instead of only being "the last attempt". Merged with the
   * internal per-call timeout in fetchWithTimeout; either one aborting cancels
   * the fetch. */
  signal?: AbortSignal;
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;
  /** Providers whose free tier needs no API key (e.g. Kilo's anonymous gateway).
   * When true, the gateway stores a sentinel key row so routing still considers
   * the platform "configured", and the provider omits the Authorization header
   * on outgoing requests. Defaults to false; set by subclasses. */
  keyless = false;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean>;

  /**
   * 可选的模型列表请求。供应商 adapter 只声明请求方式，解析、脱敏和数据库规则
   * 统一由 provider-model-catalog service 处理。
   */
  getModelCatalogRequest(_apiKey: string): ModelCatalogRequest | null {
    return null;
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // Merge the external signal (per-attempt deadline from the fallback loop,
    // or a client disconnect) with the internal timer: whichever fires first
    // aborts the request. Both listeners are cleaned up in finally so no timer
    // or listener leaks past the request.
    const onExternalAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      // requestType='chat' + timeoutMs makes the AbortError message read
      // `<platform>, chat, 15s` for triage from the requests.error column.
      return await proxyFetch(url, { ...init, signal: controller.signal }, this.platform, 'chat', timeoutMs);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Race a ReadableStream read against an external abort signal. Lets a stream
   *  pump (readSseStream, the Google adapter's own reader) stop promptly when
   *  the fallback loop's budget/deadline or a client disconnect fires, instead
   *  of blocking on the next upstream byte that may never come. */
  protected async readOrAbort(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ done: boolean; value?: Uint8Array }> {
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    if (!signal) return reader.read();
    let listener: (() => void) | undefined;
    const abort = new Promise<never>((_, reject) => {
      listener = () => reject(new DOMException('The operation was aborted', 'AbortError'));
      signal.addEventListener('abort', listener, { once: true });
    });
    return Promise.race([reader.read(), abort]).finally(() => {
      if (listener) signal.removeEventListener('abort', listener);
    });
  }

  protected makeId(): string {
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
  protected async *readSseStream(
    res: Response,
    inactivityTimeoutMs = 90000,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let sawFinishReason = false;

    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          this.readOrAbort(reader, signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${this.name} stream stalled: no data for ${inactivityTimeoutMs}ms (timeout)`)),
              inactivityTimeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(timer));

        const { done, value } = result;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          try {
            const chunk = JSON.parse(data) as ChatCompletionChunk;
            if (chunk.choices?.some(c => c.finish_reason != null)) sawFinishReason = true;
            yield chunk;
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    if (!sawFinishReason) {
      throw new Error(`${this.name} stream ended unexpectedly (no [DONE], no finish_reason) — connection reset or truncated upstream`);
    }
  }
}
