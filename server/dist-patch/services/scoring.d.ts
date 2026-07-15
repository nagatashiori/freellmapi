export interface RoutingWeights {
    reliability: number;
    speed: number;
    intelligence: number;
}
export type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom';
export declare const BANDIT_PRESETS: Record<Exclude<RoutingStrategy, 'priority' | 'custom'>, RoutingWeights>;
export declare const DEFAULT_STRATEGY: RoutingStrategy;
export declare const PRIOR_SUCCESS = 1;
export declare const PRIOR_FAILURE = 1;
export declare function reliabilityPosterior(successes: number, failures: number): {
    alpha: number;
    beta: number;
};
export declare function expectedReliability(successes: number, failures: number): number;
export declare const SPEED_SCALE_TOK_S = 60;
export declare const TTFB_BEST_MS = 300;
export declare const TTFB_WORST_MS = 5000;
export declare const SPEED_PRIOR = 0.6;
/**
 * Blend throughput and TTFB into a single [0,1] speed score.
 * `tokPerSec <= 0` means no successful samples → return the exploration prior.
 * `ttfbMs === null` means we have throughput but no first-byte timing → fall
 * back to throughput alone rather than guessing latency.
 */
export declare function speedScore(tokPerSec: number, ttfbMs: number | null): number;
export declare function intelligenceScore(composite: number, min: number, max: number): number;
export declare const HEADROOM_FLOOR = 0.1;
export declare const HEADROOM_RAMP_START = 0.2;
export declare function headroomFactor(usedTokens: number, budgetTokens: number): number;
export declare const MAX_PENALTY = 10;
export declare const RATE_LIMIT_MAX_DAMP = 0.6;
export declare function rateLimitFactor(penalty: number): number;
export declare function sampleBeta(alpha: number, beta: number): number;
export interface ScoreInputs {
    reliability: number;
    speed: number;
    intelligence: number;
    headroom: number;
    rateLimit: number;
}
/**
 * Convex base (∈[0,1]) × the two guardrail multipliers. The weights are assumed
 * to sum to 1; if a caller passes a non-normalized vector we renormalize so the
 * base never escapes [0,1].
 */
export declare function combineScore(inputs: ScoreInputs, weights: RoutingWeights): number;
//# sourceMappingURL=scoring.d.ts.map