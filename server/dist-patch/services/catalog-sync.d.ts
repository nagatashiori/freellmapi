import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
export declare const MIN_CATALOG_VERSION = "2026.06.07";
export declare const SETTING_LICENSE_KEY = "premium_license_key";
export declare const SETTING_LICENSE_STATUS = "premium_license_status";
export declare function catalogBaseUrl(): string;
export interface LicenseStatus {
    valid: boolean;
    plan: 'annual' | 'lifetime' | null;
    status: string | null;
    expiresAt: string | null;
    cancelAtPeriodEnd?: boolean;
    reason?: string;
    checkedAtMs: number;
}
interface CatalogQuirk {
    slug: string;
    title: string;
    body: string;
    severity: 'blocker' | 'warning' | 'info';
    targets: {
        platform: string | null;
        modelGlob: string | null;
    }[];
}
interface CatalogModel {
    platform: string;
    modelId: string;
    displayName: string;
    intelligenceRank: number;
    speedRank: number;
    sizeLabel: string;
    limits: {
        rpm: number | null;
        rpd: number | null;
        tpm: number | null;
        tpd: number | null;
    };
    monthlyTokenBudget: string | null;
    contextWindow: number | null;
    enabled: boolean;
    supportsVision: boolean;
    supportsTools: boolean;
    /** 'text' (default/absent) routes to the chat `models` table; 'image'/'audio'
     *  route to the separate `media_models` table. */
    modality?: string;
    /** Short display note for media models (e.g. "Keyless - up to 1024x1024"). */
    mediaNote?: string;
}
interface Catalog {
    version: string;
    generatedAt: string;
    tier: 'live' | 'monthly';
    models: CatalogModel[];
    quirks: CatalogQuirk[];
}
export interface SyncResult {
    ok: boolean;
    action: 'applied' | 'up_to_date' | 'skipped_older' | 'error';
    version?: string;
    tier?: string;
    detail?: string;
    counts?: {
        updated: number;
        inserted: number;
        removed: number;
        skippedUnknownPlatform: number;
        quirks: number;
    };
}
/**
 * Apply a verified catalog to the local DB inside one transaction.
 *
 * Rules of engagement with user data:
 *  - metadata (name, ranks, limits, context, capabilities) tracks the catalog
 *    unless the user has an explicit local override;
 *  - catalog enabled=false force-disables (the model is dead upstream), but
 *    enabled=true never re-enables a model the user turned off themselves;
 *  - models the user added via custom providers (platform='custom' or bound to
 *    a key) are never touched;
 *  - catalog models the user deleted stay deleted via tombstones;
 *  - models that vanished from the catalog are deleted, exactly like the
 *    dead-model migrations do (fallback_config row first, FK order).
 */
export declare function applyCatalog(db: Db, catalog: Catalog): NonNullable<SyncResult['counts']>;
/**
 * Fetch the catalog, verify its signature, and apply it if it moves us forward.
 * `force` skips the `since` short-circuit — used right after a license key is
 * added or removed, where the tier can change without the version changing.
 */
export declare function syncCatalog(force?: boolean): Promise<SyncResult>;
/** Revalidate the stored license against the catalog service and cache the result. */
export declare function refreshLicenseStatus(): Promise<LicenseStatus | null>;
export declare function getCachedLicenseStatus(): LicenseStatus | null;
export interface CatalogSyncState {
    baseUrl: string;
    appliedVersion: string | null;
    appliedTier: string | null;
    lastSyncMs: number | null;
    lastError: string | null;
}
export declare function getSyncState(): CatalogSyncState;
/**
 * Re-apply the cached (already signature-verified) catalog after boot.
 *
 * Migrations run on every boot and re-assert the bundled baseline — they
 * INSERT OR IGNORE baseline models the catalog may have deleted and re-run
 * the family-rule resets — while the boot-time network sync 304s on an
 * unchanged version and so would NOT re-apply. Without this step every
 * restart drifts the DB back toward the baseline until the next catalog
 * version bump. Re-applying from the local cache is synchronous, needs no
 * network, and keeps the catalog authoritative even offline.
 *
 * Legacy upgrade path: installs that applied a catalog before the cache
 * existed have an applied-version setting but no cached document. Clearing
 * the applied version makes the next poll fetch the full catalog (no `since`
 * short-circuit), which re-applies it and populates the cache.
 */
export declare function reapplyCachedCatalog(): {
    reapplied: boolean;
    version?: string;
};
export declare function startCatalogSync(scheduler: Scheduler): void;
export declare function stopCatalogSync(): void;
export {};
//# sourceMappingURL=catalog-sync.d.ts.map