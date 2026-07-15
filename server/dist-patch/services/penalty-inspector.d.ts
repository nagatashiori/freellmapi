export type InspectorReason = 'penalty' | 'cooldown' | 'recent_errors';
export interface InspectorRow {
    modelDbId: number | null;
    platform: string;
    modelId: string;
    displayName: string;
    enabled: boolean;
    fallbackEnabled: boolean;
    priority: number | null;
    penalty: {
        hits: number;
        value: number;
        rateLimitFactor: number;
    };
    cooldowns: Array<{
        keyId: number;
        keyLabel: string | null;
        keyStatus: string | null;
        expiresAtMs: number;
        expiresInMs: number;
    }>;
    recentErrors: Array<{
        id: number;
        keyId: number | null;
        keyLabel: string | null;
        error: string;
        latencyMs: number;
        createdAt: string;
    }>;
    recentErrorCount: number;
    reasons: InspectorReason[];
}
export interface PenaltyInspectorSnapshot {
    generatedAtMs: number;
    lookbackMinutes: number;
    rows: InspectorRow[];
}
export declare function getPenaltyInspector(): PenaltyInspectorSnapshot;
//# sourceMappingURL=penalty-inspector.d.ts.map