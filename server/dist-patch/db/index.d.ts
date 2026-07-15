import type { Db, DbFactory } from './types.js';
export type { Db, DbFactory } from './types.js';
export declare function getDb(): Db;
export declare function getDefaultDbPath(): string;
export declare function connectDb(dbPath?: string, opts?: {
    /** Create the parent directory if absent. Default: true. Set false in
     *  environments that do not have a writable local filesystem. */
    ensureDir?: boolean;
    /** Factory that constructs the raw Db connection. Default: better-sqlite3. */
    factory?: DbFactory;
}): Db;
export declare function initDb(dbPath?: string, opts?: {
    ensureDir?: boolean;
    factory?: DbFactory;
}): Db;
export declare function getUnifiedApiKey(): string;
export declare function regenerateUnifiedKey(): string;
export declare function getSetting(key: string): string | undefined;
export declare function setSetting(key: string, value: string): void;
//# sourceMappingURL=index.d.ts.map