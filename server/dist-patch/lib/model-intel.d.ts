/**
 * Calibrate size_label + intelligence_rank from model name.
 *
 * FreeLLMAPI scoring:
 *   intelligenceComposite = tierValue(size_label)*1000 - intelligence_rank
 *   (lower rank = smarter within tier; Frontier > Large > Medium > Small)
 *
 * Philosophy (operator preference):
 *   - True flagships (GPT-5.5 / frontier agent) → Frontier, top ranks
 *   - DeepSeek-V4-Flash etc. → Large / ~passing band (~60 when mixed with Frontier)
 *   - Mid 30–80B → Medium
 *   - Lite / 1–14B → Small
 * Do NOT mark everything Frontier/100.
 */
export type SizeLabel = 'Frontier' | 'Large' | 'Medium' | 'Small';
export interface ModelMeta {
    sizeLabel: SizeLabel;
    /** Lower = smarter within size_label tier. */
    intelligenceRank: number;
    /** Rough absolute skill 0–100 for docs / scripts (not stored unless needed). */
    skillHint: number;
}
export declare function calibrateModelMeta(modelId: string, displayName?: string): ModelMeta;
/** Prefer a human groupable display name for unify (match catalog labels). */
export declare function niceDisplayName(modelId: string, explicit?: string): string;
//# sourceMappingURL=model-intel.d.ts.map