/**
 * Model grouping — "unify" the same logical model that several providers serve
 * into ONE item. The `models` table keeps one row per (platform, model_id); a
 * model offered by N providers is N rows. This module computes a logical group
 * for those rows at runtime (NO schema change) from the curated `display_name`,
 * plus operator overrides stored as JSON in the existing `settings` table.
 *
 * Pure by design: the core functions (normalizeGroupKey / groupRows /
 * resolveRequestedIdToMembers) take rows as arguments and touch no globals, so
 * they're trivially unit-testable. Only the settings getters/setters and the
 * getModelGroups() convenience touch the DB.
 *
 * Gated by the `unify_models_enabled` setting (default ON). When OFF, callers
 * keep their pre-unification behavior.
 */
import { z } from 'zod';
export declare const UNIFY_ENABLED_KEY = "unify_models_enabled";
export declare const UNIFY_OVERRIDES_KEY = "model_unify_overrides";
export declare const unifyOverridesSchema: z.ZodDefault<z.ZodObject<{
    merges: z.ZodDefault<z.ZodArray<z.ZodObject<{
        into: z.ZodString;
        keys: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        keys: string[];
        into: string;
    }, {
        keys: string[];
        into: string;
    }>, "many">>;
    splits: z.ZodDefault<z.ZodArray<z.ZodObject<{
        member: z.ZodString;
        groupKey: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        member: string;
        groupKey?: string | undefined;
    }, {
        member: string;
        groupKey?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    merges: {
        keys: string[];
        into: string;
    }[];
    splits: {
        member: string;
        groupKey?: string | undefined;
    }[];
}, {
    merges?: {
        keys: string[];
        into: string;
    }[] | undefined;
    splits?: {
        member: string;
        groupKey?: string | undefined;
    }[] | undefined;
}>>;
export type UnifyOverrides = z.infer<typeof unifyOverridesSchema>;
export interface GroupableRow {
    model_db_id: number;
    platform: string;
    model_id: string;
    display_name: string;
    intelligence_rank?: number;
}
export interface ModelGroup {
    groupKey: string;
    canonicalId: string;
    groupLabel: string;
    members: GroupableRow[];
}
export declare function isUnifyEnabled(): boolean;
export declare function setUnifyEnabled(on: boolean): void;
export declare function getUnifyOverrides(): UnifyOverrides;
export declare function setUnifyOverrides(input: unknown): UnifyOverrides;
export declare function stripProviderSuffix(displayName: string): string;
export declare function normalizeGroupKey(displayName: string): string;
export declare function slugifyGroupLabel(label: string): string;
/**
 * Group catalog rows into logical models. Pure — pass overrides explicitly in
 * tests; defaults to the persisted overrides.
 */
export declare function groupRows(rows: GroupableRow[], ov: UnifyOverrides): ModelGroup[];
/**
 * Resolve a requested model id to the db ids of its group members, or null.
 * Accepts the canonical slug OR any member's `model_id`/"platform:model_id"
 * (back-compat: an old per-provider id resolves to the whole group). Member
 * order here is incidental — the router re-orders by the active strategy.
 */
export declare function resolveRequestedIdToMembers(requested: string, groups: ModelGroup[]): number[] | null;
/**
 * Group the whole catalog (enabled + disabled rows so availability can be shown
 * and resolution is complete), applying the persisted overrides.
 */
export declare function getModelGroups(): ModelGroup[];
//# sourceMappingURL=model-groups.d.ts.map