import type { Db } from '../types.js';
export interface MigrationModule {
    up(db: Db): void;
    down(db: Db): void;
}
export interface DefaultMigration {
    filename: string;
    module: MigrationModule;
}
export declare const LEGACY_BASELINE_FILENAME = "20260101_000000_legacy_baseline.ts";
export declare const CUSTOM_PROVIDER_MODALITIES_FILENAME = "20260627_000001_custom_provider_modalities.ts";
export declare const CATALOG_MODEL_STATE_FILENAME = "20260627_000002_catalog_model_state.ts";
export declare const REQUEST_AGGREGATES_FILENAME = "20260628_120000_request_aggregates.ts";
export declare const GITHUB_GPT41_CONTEXT_FILENAME = "20260630_000001_github_gpt41_context.ts";
export declare const REQUEST_CLIENT_INFO_FILENAME = "20260706_000001_request_client_info.ts";
export declare const CUSTOM_MODEL_TOOL_SUPPORT_FILENAME = "20260706_000002_custom_model_tool_support.ts";
export declare const DEFAULT_MIGRATIONS: readonly DefaultMigration[];
//# sourceMappingURL=defaults.d.ts.map