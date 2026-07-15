export type AddressClass = 'metadata' | 'link-local' | 'loopback' | 'private' | 'public';
export declare function classifyIp(ip: string): AddressClass;
export interface UrlAssessment {
    allowed: boolean;
    reason?: string;
}
export interface AssessOptions {
    resolve?: (hostname: string) => Promise<string[]>;
    blockPrivate?: boolean;
}
/**
 * Assess whether an outbound custom-provider URL is safe to contact.
 * Never throws on malformed input — a bad URL comes back as {allowed: false}.
 */
export declare function assessProviderUrl(rawUrl: string, opts?: AssessOptions): Promise<UrlAssessment>;
/**
 * Request-time enforcement: throws when the URL is blocked. Used by
 * proxyFetch for the custom platform so a base_url that slipped into the DB
 * (older install, direct DB edit, DNS change after save) still can't reach a
 * blocked address class.
 */
export declare function assertProviderUrlAllowed(rawUrl: string): Promise<void>;
//# sourceMappingURL=url-guard.d.ts.map