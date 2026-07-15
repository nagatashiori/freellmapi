import type { Platform, QuotaMetric, QuotaObservationSource, QuotaResetStrategy, ProviderQuotaObservation, ProviderQuotaState } from '@freellmapi/shared/types.js';
export interface QuotaObservationContext {
    platform: Platform;
    keyId?: number;
    providerAccountId?: string | null;
    modelId?: string | null;
    quotaPoolKey?: string | null;
    endpoint?: string | null;
    origin?: 'health' | 'proxy' | 'responses' | 'manual' | 'probe';
}
export interface QuotaObservationInput {
    platform?: Platform;
    keyId?: number;
    providerAccountId?: string | null;
    modelId?: string | null;
    quotaPoolKey?: string | null;
    metric?: QuotaMetric;
    limit?: number | null;
    remaining?: number | null;
    resetAt?: string | null;
    retryAfterMs?: number | null;
    resetStrategy?: QuotaResetStrategy;
    source?: QuotaObservationSource;
    statusCode?: number | null;
    notes?: string | null;
    rawJson?: string | null;
    endpoint?: string | null;
    confidence?: number;
    observedAt?: string;
}
export interface QuotaObservationView extends ProviderQuotaState {
    providerAccountId: string | null;
    modelId: string | null;
    endpoint: string | null;
    statusCode: number | null;
    retryAfterMs: number | null;
    rawJson: string | null;
    createdAt: string;
}
export declare function runWithQuotaObservationContext<T>(context: QuotaObservationContext, fn: () => T): T;
export declare function getQuotaObservationContext(): QuotaObservationContext | undefined;
export declare function inferQuotaPoolKey(platform: Platform, modelId?: string | null): string;
export declare function parseQuotaObservationsFromResponse(response: Response, opts?: Pick<QuotaObservationInput, 'platform' | 'modelId' | 'quotaPoolKey' | 'keyId' | 'providerAccountId' | 'endpoint'>): QuotaObservationInput[];
export declare function recordQuotaObservation(input: QuotaObservationInput): ProviderQuotaObservation | null;
export declare function recordQuotaObservationsFromResponse(response: Response, opts?: Pick<QuotaObservationInput, 'platform' | 'modelId' | 'quotaPoolKey' | 'keyId' | 'providerAccountId' | 'endpoint'>): ProviderQuotaObservation[];
export declare function getQuotaStateForKeys(): QuotaObservationView[];
//# sourceMappingURL=provider-quota.d.ts.map