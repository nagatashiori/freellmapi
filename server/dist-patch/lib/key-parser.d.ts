export interface ParsedKey {
    rawKey: string;
    prefix: string;
    platform: string | null;
}
export interface ParseResult {
    keys: ParsedKey[];
    skipped: string[];
}
export declare const PREFIX_MAP: Record<string, string>;
export declare const AUTH_JSON_PROVIDER_MAP: Record<string, string>;
export declare function detectPlatform(prefix: string): string | null;
export declare function parseDotEnv(content: string): Array<{
    key: string;
    value: string;
}>;
export declare function stripJsoncComments(text: string): string;
export declare function stripTrailingCommas(text: string): string;
export declare function parseJson(content: string): Array<{
    key: string;
    value: string;
}>;
/**
 * Parse the FreeLLMAPI export JSON format:
 * { version: 1, exportedAt, source, keys: [{ platform, key, label, baseUrl? }] }
 * Returns key-value pairs compatible with toParsedKeys().
 */
export declare function parseExportJson(content: string): ParseResult | null;
/**
 * Parse CSV format: platform,key,label (with optional header row).
 */
export declare function parseCsv(content: string): Array<{
    key: string;
    value: string;
}>;
export declare function parseAuthJson(content: string): ParseResult;
export declare function looksLikeApiKey(value: string): boolean;
export declare function parseKeysFromFile(content: string, filename: string): ParseResult;
//# sourceMappingURL=key-parser.d.ts.map