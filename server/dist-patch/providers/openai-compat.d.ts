import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk, Platform } from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
import { type QuotaObservationContext } from '../services/provider-quota.js';
/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Fireworks AI.
 */
export declare class OpenAICompatProvider extends BaseProvider {
    readonly platform: Platform;
    readonly name: string;
    private readonly baseUrl;
    private readonly extraHeaders;
    private readonly validateUrl?;
    /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
     * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
    private readonly timeoutMs;
    /** NVIDIA NIM models reject any request that permits parallel tool calls with
     * `400 This model only supports single tool-calls at once!`. When set, pin
     * parallel_tool_calls to false whenever tools are in play. See issue #255. */
    private readonly forceSingleToolCall;
    constructor(opts: {
        platform: Platform;
        name: string;
        baseUrl: string;
        extraHeaders?: Record<string, string>;
        validateUrl?: string;
        timeoutMs?: number;
        keyless?: boolean;
        forceSingleToolCall?: boolean;
    });
    /** Resolve the parallel_tool_calls flag to send upstream. For providers that
     * only accept single tool calls (NVIDIA NIM), force `false` whenever tools are
     * present so the model never tries to emit two at once and 400s; otherwise pass
     * the caller's value through unchanged. See issue #255. */
    private resolveParallelToolCalls;
    /** Some providers (Groq especially) reject a model's tool call with a 400
     * `tool_use_failed` when the model emitted it as inline DIALECT TEXT
     * (`<function=NAME{...}</function>`, Hermes/Qwen XML, etc.) that the provider's
     * own parser couldn't convert — but they hand back the raw text in
     * `error.failed_generation`. Weaker tool models (e.g. groq llama-3.3-70b) hit
     * this constantly, dead-ending an agent's whole turn even though the call is
     * perfectly recoverable. Reuse the same inline-dialect rescue the proxy already
     * applies to streamed text: parse `failed_generation` into structured
     * tool_calls so the turn succeeds instead of failing over (or exhausting the
     * chain when every enabled tool model behaves the same way). See issue #264. */
    private rescueFailedGeneration;
    /** Keyless providers (Kilo's anonymous free tier) must send NO Authorization
     * header — a stored sentinel like `Bearer no-key` could be treated as an
     * invalid key. Everyone else sends the bearer as usual. */
    private authHeader;
    chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse>;
    streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk>;
    validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean>;
    /** True when GET /models succeeds without any Authorization header. */
    private isModelsEndpointPublic;
    /**
     * Real credential probe: 1-token chat/completions.
     * Used when /models is public and cannot distinguish good vs bad keys.
     */
    private validateKeyViaChat;
}
//# sourceMappingURL=openai-compat.d.ts.map