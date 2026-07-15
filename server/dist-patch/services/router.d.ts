import { type RoutingStrategy, type RoutingWeights } from './scoring.js';
import type { BaseProvider } from '../providers/base.js';
import type { Db } from '../db/types.js';
export declare function formatResetEta(soonestResetMs: number | null | undefined, now?: number): string | null;
export declare function summarizeExhaustion(diag: string[] | undefined, soonestResetMs?: number | null, now?: number): string;
export interface ChainRow {
    model_db_id: number;
    priority: number;
    enabled: number;
    platform: string;
    model_id: string;
    display_name: string;
    intelligence_rank: number;
    size_label: string;
    monthly_token_budget: string;
    rpm_limit: number | null;
    rpd_limit: number | null;
    tpm_limit: number | null;
    tpd_limit: number | null;
    supports_vision: number;
    supports_tools: number;
    context_window: number | null;
    key_id: number | null;
}
export interface RouteResult {
    provider: BaseProvider;
    modelId: string;
    modelDbId: number;
    apiKey: string;
    keyId: number;
    platform: string;
    displayName: string;
    rpdLimit: number | null;
    tpdLimit: number | null;
}
export declare const OUTPUT_RESERVE_CAP = 2000;
/**
 * Output tokens to reserve for routing/filter purposes: the requested max_tokens
 * clamped to OUTPUT_RESERVE_CAP (default 1000 when the client omitted it, matching
 * the historical fallback). Callers add this to their INPUT estimate before
 * calling routeRequest / routePinnedModel.
 */
export declare function routingReserveTokens(requestedMaxTokens: number | null | undefined): number;
/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export declare function recordRateLimitHit(modelDbId: number): void;
/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export declare function recordSuccess(modelDbId: number): void;
/**
 * Get current penalties for all models (for the API/dashboard).
 */
export declare function getAllPenalties(): Array<{
    modelDbId: number;
    count: number;
    penalty: number;
}>;
export declare function getRoutingStrategy(): RoutingStrategy;
export declare function setRoutingStrategy(strategy: RoutingStrategy): void;
export declare function getCustomWeights(): RoutingWeights;
export declare function setCustomWeights(weights: RoutingWeights): void;
export declare function refreshStatsCache(db: Db, force?: boolean): void;
/**
 * Route a request to the best available model.
 *
 * Ordering depends on the configured strategy (see orderChain). Everything
 * downstream — key round-robin, cooldowns, token pre-checks, custom base_url
 * resolution, vision filtering, sticky sessions — is strategy-independent.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * @param estimatedTokens - estimated total tokens for rate limit check
 * @param skipKeys - set of "platform:modelId:keyId" to skip (failed on this request)
 * @param preferredModelDbId - try this model first (sticky session)
 * @param requireVision - only consider models that accept image input (#118)
 * @param requireTools - only consider models that emit structured tool_calls
 */
export interface ResolvedChain {
    chain: ChainRow[];
    strategyKey: string;
}
export declare function resolveRoutingChain(modelString: string | undefined): ResolvedChain;
/**
 * Whether the model still has ANOTHER key that could serve it right now, given
 * the key that just failed (excludingKeyId) and any keys already ruled out this
 * request (skipKeys, in the "platform:modelId:keyId" form). Applies the same
 * gates selectKeyForModel uses — enabled + healthy status, not on cooldown,
 * under the provider daily cap, and under rpm/rpd/tpm/tpd — so the answer means
 * "a real, dispatchable alternative exists".
 *
 * Used by the retry loops to decide whether a single key's 429 should demote the
 * WHOLE model (the model-level 429 penalty). It should not: the per-key cooldown
 * already isolates the failing key, so demoting the model while a sibling key can
 * still serve it wrongly sinks a healthy model in the scorer (#454). We only
 * record the model-level hit when this returns false — i.e. the 429 exhausted the
 * model, not just one of its keys.
 */
export declare function hasOtherUsableKey(modelDbId: number, excludingKeyId: number, skipKeys?: Set<string>): boolean;
/**
 * Route to ONE specific model, hard-pinned. Rotates across that model's keys
 * (cooldowns, quotas, decryption all honored) but NEVER substitutes a different
 * model — returns null if the pinned model can't serve right now. This is what
 * makes a fusion panel genuinely diverse: a rate-limited slot is dropped, not
 * silently collapsed onto whatever else is available. `skipKeys` lets a slot
 * exclude keys it already failed on this request.
 */
export declare function routePinnedModel(modelDbId: number, estimatedTokens?: number, skipKeys?: Set<string>): RouteResult | null;
/**
 * Resolve a logical model group's member db ids to an ordered ChainRow[] for
 * strict group-pin routing (the "unify" feature). Each enabled member is
 * hydrated as a ChainRow carrying its REAL fallback_config.priority, then
 * ordered by the active strategy via orderChain — so 'priority' honors the
 * manual within-group order and scored strategies use live scores (priority as
 * the tiebreaker). Members disabled in the chain (fallback_config.enabled = 0)
 * are dropped.
 *
 * Pass the result to routeRequest() as `prefetchedChain` and DO NOT pass a
 * `preferredModelDbId` that isn't already one of these rows — otherwise the
 * preferred-model injection in routeRequest would unshift an off-group model and
 * the pin would no longer be strict (it could answer with a different model).
 */
export declare function resolveModelGroupCandidates(memberDbIds: number[]): ChainRow[];
export interface FusionCandidate {
    modelDbId: number;
    platform: string;
    modelId: string;
    displayName: string;
    sizeLabel: string;
    supportsVision: number;
    supportsTools: number;
}
/**
 * The active fallback chain ordered by the current routing strategy, surfaced
 * for fusion panel selection. Same ordering the normal auto-router would walk,
 * so the panel's auto-pick draws from the highest-scored models first and the
 * fusion layer just needs to apply provider-diversity on top.
 */
export declare function getOrderedFusionChain(): FusionCandidate[];
/**
 * Resolve an explicit model id (as a client would type it) to a fusion
 * candidate, or null when it isn't a known enabled model. Prefers an enabled
 * row; dedupes a model id that exists on multiple platforms by intelligence
 * rank, matching how /v1/models picks a representative row.
 */
export declare function resolveFusionCandidate(modelId: string): FusionCandidate | null;
export declare function routeRequest(estimatedTokens?: number, skipKeys?: Set<string>, preferredModelDbId?: number, requireVision?: boolean, requireTools?: boolean, skipModels?: Set<number>, prefetchedChain?: ChainRow[], requireStructured?: boolean): RouteResult;
/**
 * Per-model routing scores for the dashboard. Deterministic (expected
 * reliability, not sampled) so the table is stable between polls. Returns the
 * axis breakdown plus the final score under the active strategy's weights.
 */
export interface RoutingScore {
    modelDbId: number;
    platform: string;
    modelId: string;
    displayName: string;
    enabled: boolean;
    reliability: number;
    speed: number;
    intelligence: number;
    headroom: number;
    rateLimit: number;
    score: number;
    totalRequests: number;
}
export declare function getRoutingScores(): {
    strategy: RoutingStrategy;
    weights: RoutingWeights | null;
    customWeights: RoutingWeights;
    scores: RoutingScore[];
};
export declare function hasEnabledVisionModel(): boolean;
export declare function hasEnabledToolsModel(): boolean;
//# sourceMappingURL=router.d.ts.map