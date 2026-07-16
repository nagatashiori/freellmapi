import { encrypt } from '../../lib/crypto.js';
import { getDb } from '../../db/index.js';

export function insertHealthyKey(platform: string, key: string, label = 'test'): number {
  const { encrypted, iv, authTag } = encrypt(key);
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, label, encrypted, iv, authTag);
  return Number(result.lastInsertRowid);
}
