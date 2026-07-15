import { getDb } from '../db/index.js';
type RetentionDb = ReturnType<typeof getDb>;
export interface RequestAnalyticsRetentionConfig {
    retentionDays: number;
    maxRows: number;
}
export declare function getRequestAnalyticsRetentionConfig(): RequestAnalyticsRetentionConfig;
export declare function pruneRequestAnalytics(options?: {
    db?: RetentionDb;
    force?: boolean;
    now?: Date;
}): {
    deleted: number;
    skipped: boolean;
};
export {};
//# sourceMappingURL=request-retention.d.ts.map