import type { Platform } from '@freellmapi/shared/types.js';
import type { BaseProvider } from './base.js';
/** Valid user platform slug: starts with letter, 1–32 chars [a-z0-9_-]. */
export declare function isValidUserPlatformSlug(slug: string): boolean;
export declare function isReservedPlatformSlug(slug: string): boolean;
export declare function rememberUserPlatform(slug: string): void;
export declare function isUserPlatform(platform: string): boolean;
/** After initDb: treat any api_keys.platform with a base_url as a user platform
 *  if it is not a built-in registration (aihub is built-in with fixed URL). */
export declare function hydrateUserPlatformsFromDb(db: {
    prepare: (sql: string) => {
        all: (...a: unknown[]) => unknown[];
    };
}): void;
export declare function getProvider(platform: Platform | string): BaseProvider | undefined;
/**
 * Resolve the provider for a route. Built-in platforms return their registered
 * singleton; `custom` and user-defined platforms (platformId) build a fresh
 * OpenAICompatProvider bound to the key's base_url. Returns undefined when a
 * base_url-backed platform has no URL configured on the key.
 */
export declare function resolveProvider(platform: Platform | string, baseUrl?: string | null): BaseProvider | undefined;
export declare function getAllProviders(): BaseProvider[];
export declare function hasProvider(platform: Platform | string): boolean;
//# sourceMappingURL=index.d.ts.map