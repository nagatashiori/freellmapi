import type { RouteResult } from '../services/router.js';
export declare const FALLBACK_MAX_RETRIES = 20;
export declare const DEFAULT_FALLBACK_TIME_BUDGET_MS = 45000;
export declare const FALLBACK_TIME_BUDGET_SETTING = "fallback_time_budget_ms";
export declare function getFallbackTimeBudgetMs(): number;
export interface FallbackState {
    skipKeys: Set<string>;
    skipModels: Set<number>;
}
export declare function newFallbackState(): FallbackState;
export declare function msUntilNextUtcMidnight(now?: number): number;
/**
 * The one true cooldown-duration selection after a retryable upstream failure:
 *   - 402 out-of-credits  → a full day (PAYMENT_REQUIRED_COOLDOWN_MS)
 *   - 403 model-not-on-tier → a full day (MODEL_FORBIDDEN_COOLDOWN_MS), because a
 *     tier/subscription gate won't clear on the next minute window (issue #256)
 *   - a 429 that says the DAILY free allocation is spent (Cloudflare "used up
 *     your daily free allocation of 10,000 neurons") → benched until the next
 *     UTC midnight, like the 402 path. The old transient 90s cooldown made the
 *     router re-pick a dead-for-the-day provider all day long. An explicit
 *     provider Retry-After wins over the midnight heuristic: rolling daily
 *     windows (Groq RPD "try again in 7m12s" with a Retry-After header) reset
 *     well before midnight, and the provider knows its own reset time best.
 *   - anything else → the transient/daily escalation ladder, honoring the
 *     provider's Retry-After as a floor (getCooldownDurationForLimit).
 */
export declare function cooldownForError(route: RouteResult, err: any): number;
/**
 * Apply the full per-key failure bookkeeping shared by every surface after a
 * retryable failure:
 *   - rule out the WHOLE model for the rest of the request on a 404 (removed
 *     upstream) or 403 (off this key's tier) — a sibling key would fail it the
 *     same way (PR #111 / issue #256);
 *   - bench this model+key via cooldownForError;
 *   - demote the model in the scorer ONLY when the failure exhausted it — i.e.
 *     no sibling key can still serve it (#454 gate). skipKeys already contains
 *     the just-failed key here, preserving #479's "count budget across keys"
 *     semantics: hasOtherUsableKey excludes both the failed key and skipKeys;
 *   - learn a provider-reported ceiling (e.g. a Groq 413 "TPM: Limit 30000")
 *     from the error body so the next pre-check fails over before the 413.
 *
 * Reasoning-truncation exemption: an error thrown with `skipBench: true` (a
 * reasoning model that spent the whole max_tokens budget on hidden reasoning,
 * finish_reason 'length') still fails over — the key is skipped for THIS
 * request — but is NOT a provider-health signal, so no cooldown, no model
 * penalty, and no limit-learning are recorded. Benching those was costing
 * healthy models a 90s cooldown + a scorer penalty per truncated turn.
 *
 * Callers add the just-failed key to skipKeys via this function (do not pre-add).
 */
export declare function recordRetryableFailure(route: RouteResult, err: any, state: FallbackState): void;
export declare const AUTH_FAILURE_COOLDOWN_MS: number;
/**
 * Bookkeeping for an auth-fatal (401 / invalid key) attempt: skip the key for
 * this request, bench the model+key for the health-cycle window, and start an
 * immediate revalidation. Deliberately NO model penalty and NO limit-learning —
 * a bad key says nothing about the model's health.
 */
export declare function recordAuthFailure(route: RouteResult, state: FallbackState): void;
/**
 * The success-side accounting every surface runs after a completed attempt:
 * count the request + its tokens against the model+key's rate-limit windows and
 * clear the model's 429 penalty. `rateLimitTokens` is whatever the surface metered
 * (the provider's usage.total_tokens for non-stream, an estimate for stream).
 */
export declare function recordUpstreamSuccess(route: RouteResult, rateLimitTokens: number): void;
export type AttemptErrorClass = 'auth' | 'out_of_credits' | 'daily_quota_exhausted' | 'model_not_found' | 'forbidden' | 'provider_bad_request' | 'empty_completion' | 'format_ignored' | 'timeout' | 'rate_limited' | 'upstream_error' | 'error';
export interface AttemptRecord {
    platform: string;
    modelId: string;
    keyOrdinal: number;
    errorClass: AttemptErrorClass;
}
export declare function classifyAttemptError(err: any): AttemptErrorClass;
export declare function formatAttemptTrail(attempts: AttemptRecord[]): string;
/**
 * Set the failover diagnostics headers every surface stamps on its responses:
 * X-Fallback-Attempts (how many hops failed before this response) and
 * X-Fallback-Trail (what each hop was and why it failed). Until now the trail
 * only reached clients inside exhaustion error MESSAGES — a request that
 * eventually succeeded gave no hint that it burned five hops first, which is
 * exactly the case an operator wants to notice. Control characters are
 * scrubbed so a hostile model id can't inject header lines.
 */
export declare function setFallbackHeaders(res: {
    setHeader(name: string, value: string): void;
}, failedAttempts: number, trail: AttemptRecord[] | undefined): void;
export interface ExhaustionBody {
    status: number;
    type: string;
    message: string;
    kind: 'auth' | 'bad_request' | 'rate_limit' | 'unavailable';
}
export interface ExhaustionContext {
    attempts?: AttemptRecord[];
    timedOut?: boolean;
    budgetMs?: number;
    breakerFails?: number;
}
/**
 * The shared exhaustion response body.
 *   - Every attempt failed auth (401/invalid key) → 502 provider_error saying the
 *     PROVIDER keys are bad — distinct from a rate-limit exhaustion, and never
 *     'authentication_error' (which would wrongly blame the CLIENT's key).
 *   - A request every routed provider rejected as invalid → 400
 *     invalid_request_error, not a misleading rate-limit exhaustion.
 *   - Otherwise → 429 rate_limit_error.
 * All bodies carry the attempt trail (what was tried, per attempt) and the
 * soonest-cooldown-reset hint that previously only reached clients when routing
 * failed before any attempt (summarizeExhaustion) — after one attempt they got a
 * terse "Last error" line with none of that context.
 */
export declare function exhaustedRetryError(lastError: any, maxRetries?: number, ctx?: ExhaustionContext): ExhaustionBody;
export type DispatchOutcome = 'done' | 'committed';
export interface ExhaustionInfo {
    attempts: AttemptRecord[];
    timedOut: boolean;
}
export interface FallbackHooks {
    maxRetries?: number;
    timeBudgetMs?: number;
    breakerLimit?: number;
    attemptLog?: AttemptRecord[];
    clientGone?: () => boolean;
    state: FallbackState;
    /**
     * Pick a route for this attempt. Reads state.skipKeys / state.skipModels.
     * Throws the router's RouteError when the pool is exhausted before any
     * upstream is tried (caught by the loop → onRoutingExhausted).
     */
    route(attempt: number): RouteResult;
    /**
     * Run one attempt against the chosen route. Return 'done' on success or
     * 'committed' when a stream already sent bytes and handled its own mid-stream
     * error. THROW a (possibly synthetic) provider error — an upstream HTTP error,
     * or an "empty completion" / "unparseable inline tool-call dialect" Error the
     * classifier already treats as retryable — to trigger failover; a
     * non-retryable throw becomes onFatal. A pre-commit failure MUST throw (not
     * return 'committed') so the loop can fail over invisibly. The loop enforces
     * this contract: any other return value is a programming error and fails
     * loudly instead of silently swallowing the request.
     */
    dispatch(route: RouteResult, attempt: number): Promise<DispatchOutcome>;
    /** Trace + log a per-attempt failure (per-surface scope + logRequest args). */
    logFailure(route: RouteResult, err: any, attempt: number): void;
    /** Render a non-retryable provider error (per-surface body/status). `attempt`
     *  is the failing attempt's index = the number of prior fallback hops. */
    onFatal(route: RouteResult, err: any, attempt: number): void;
    /**
     * Render exhaustion when route() threw. `exhaustion` is the shared body when
     * at least one attempt ran (render it); null when routing gave up before any
     * upstream was tried (render routeErr as a routing error instead).
     */
    onRoutingExhausted(lastError: any, routeErr: any, exhaustion: ExhaustionBody | null, info: ExhaustionInfo): void;
    /** Render exhaustion after the attempt cap or the time budget was hit. */
    onExhausted(exhaustion: ExhaustionBody, info: ExhaustionInfo): void;
}
/**
 * The shared attempt loop. Owns iteration, the wall-clock retry budget, the
 * routeRequest-exhaustion path, the auth/retryable/fatal classification, the
 * per-failure bookkeeping (recordRetryableFailure / recordAuthFailure), the
 * attempt trail, and the final exhaustion body. Everything surface-specific —
 * request translation, stream framing, error-body shape, context handoff, group
 * routing — lives in the hooks.
 */
export declare function runFallbackLoop(hooks: FallbackHooks): Promise<void>;
//# sourceMappingURL=fallback-loop.d.ts.map