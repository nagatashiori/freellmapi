export declare function canMakeRequest(platform: string, modelId: string, keyId: number, limits: {
    rpm: number | null;
    rpd: number | null;
    tpm: number | null;
    tpd: number | null;
}): boolean;
export declare function canUseTokens(platform: string, modelId: string, keyId: number, estimatedTokens: number, limits: {
    tpm: number | null;
    tpd: number | null;
}): boolean;
export declare function getProviderDailyRequestCap(platform: string): number | null;
export declare function providerDailyRequestCount(platform: string, keyId: number, now?: number): number;
export declare function canUseProvider(platform: string, keyId: number, now?: number): boolean;
export declare function recordRequest(platform: string, modelId: string, keyId: number): void;
export declare function recordTokens(platform: string, modelId: string, keyId: number, tokens: number): void;
export declare function getNextCooldownDuration(platform: string, modelId: string, keyId: number): number;
export declare const PAYMENT_REQUIRED_COOLDOWN_MS: number;
export declare const MODEL_FORBIDDEN_COOLDOWN_MS: number;
export declare function recentHitCount(platform: string, modelId: string, keyId: number, now: number, windowMs?: number): number;
export declare function getCooldownDurationForLimit(platform: string, modelId: string, keyId: number, limits: {
    rpd: number | null;
    tpd: number | null;
}, retryAfterMs?: number | null): number;
export declare function setCooldown(platform: string, modelId: string, keyId: number, durationMs?: number): void;
export declare function isOnCooldown(platform: string, modelId: string, keyId: number): boolean;
/**
 * Soonest moment any active cooldown expires, in ms since epoch, or null when
 * nothing is cooling down. Used to tell an exhausted caller roughly when to
 * retry (#423) instead of the bare "wait for rate limits to reset".
 */
export declare function getSoonestCooldownExpiry(now?: number): number | null;
export declare function getRateLimitStatus(platform: string, modelId: string, keyId: number, limits: {
    rpm: number | null;
    rpd: number | null;
    tpm: number | null;
    tpd: number | null;
}): {
    rpm: {
        used: number;
        limit: number | null;
    };
    rpd: {
        used: number;
        limit: number | null;
    };
    tpm: {
        used: number;
        limit: number | null;
    };
};
export type LearnedLimitKind = 'tpm' | 'tpd' | 'rpm' | 'rpd';
export interface LearnedLimit {
    kind: LearnedLimitKind;
    limit: number;
}
/**
 * Pure parser: pull a provider-reported ceiling out of an error message. Returns
 * null unless BOTH a numeric "Limit N" and a confident axis (TPM/TPD/RPM/RPD)
 * are present — guessing the axis would write the wrong column and mis-route
 * every future request, so we refuse to guess.
 */
export declare function parseProviderLimit(message: string | undefined | null): LearnedLimit | null;
/**
 * Persist a provider-reported limit onto the model row, but ONLY when it makes
 * us more conservative: fill a NULL (unknown) limit, or LOWER an existing one
 * that was too high. Never raises a limit — hitting a ceiling means our pre-check
 * already let too much through, so the true limit is at or below what we used.
 * Returns the learned limit when a row was actually changed, else null.
 * DB-guarded (no-op when the DB is unavailable), like the rest of this module.
 */
export declare function learnLimitFromError(modelDbId: number, err: {
    message?: string;
}): LearnedLimit | null;
//# sourceMappingURL=ratelimit.d.ts.map