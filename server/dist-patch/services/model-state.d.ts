import type { Db } from '../db/types.js';
export type CatalogModelKind = 'chat' | 'media';
export interface ModelOverridePatch {
    displayName?: string;
    intelligenceRank?: number;
    speedRank?: number;
    sizeLabel?: string;
    rpmLimit?: number | null;
    rpdLimit?: number | null;
    tpmLimit?: number | null;
    tpdLimit?: number | null;
    monthlyTokenBudget?: string;
    contextWindow?: number | null;
    supportsVision?: boolean;
    supportsTools?: boolean;
}
type StoredOverrides = Partial<ModelOverridePatch>;
export declare function isCatalogManagedModel(row: {
    platform: string;
    key_id?: number | null;
}): boolean;
export declare function isCatalogModelTombstoned(db: Db, kind: CatalogModelKind, platform: string, modelId: string): boolean;
export declare function recordCatalogModelTombstone(db: Db, kind: CatalogModelKind, platform: string, modelId: string): void;
export declare function clearCatalogModelTombstone(db: Db, kind: CatalogModelKind, platform: string, modelId: string): void;
export declare function upsertModelOverrides(db: Db, platform: string, modelId: string, patch: ModelOverridePatch): StoredOverrides;
export declare function getModelOverrides(db: Db, platform: string, modelId: string): StoredOverrides;
export declare function applyModelOverrides(db: Db, platform: string, modelId: string): boolean;
export declare function applyAllModelOverrides(db: Db): number;
export declare function deleteTombstonedCatalogModels(db: Db): number;
export {};
//# sourceMappingURL=model-state.d.ts.map