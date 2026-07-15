import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk } from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
import { type QuotaObservationContext } from '../services/provider-quota.js';
export declare class CloudflareProvider extends BaseProvider {
    readonly platform: "cloudflare";
    readonly name = "Cloudflare Workers AI";
    private parseKey;
    private normalizeMessages;
    chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse>;
    streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk>;
    validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean>;
    private verifyAt;
}
//# sourceMappingURL=cloudflare.d.ts.map