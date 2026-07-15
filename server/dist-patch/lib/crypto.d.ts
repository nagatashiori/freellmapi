import type { Db } from '../db/types.js';
/**
 * Initialize encryption key from env or an explicit local-dev fallback.
 * Must be called after DB is initialized.
 *
 * Precedence (dev fallback): ENCRYPTION_KEY env > existing key file next to the
 * DB > legacy `settings` table row (migrated to the file, then deleted) >
 * freshly generated key written to the file.
 */
export declare function initEncryptionKey(db: Db): void;
export declare function isEncryptionKeyInitialized(): boolean;
export declare function encrypt(text: string): {
    encrypted: string;
    iv: string;
    authTag: string;
};
export declare function decrypt(encrypted: string, iv: string, authTag: string): string;
export declare function maskKey(key: string): string;
//# sourceMappingURL=crypto.d.ts.map