import type { Db } from '../db/types.js';
import type { Scheduler } from './scheduler.js';
export interface DbBackupResult {
    ok: boolean;
    target?: string;
    bytes?: number;
    restored?: boolean;
    skipped?: string;
}
export declare function isDbBackupConfigured(): boolean;
export declare function restoreDbBackupIfNeeded(dbPath?: string): Promise<DbBackupResult>;
export declare function backupDbNow(db: Db, dbPath?: string): Promise<DbBackupResult>;
export declare function startDbBackupPump(db: Db, scheduler: Scheduler, dbPath?: string): (() => void) | null;
//# sourceMappingURL=db-backup.d.ts.map