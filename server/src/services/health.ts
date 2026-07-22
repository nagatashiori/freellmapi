import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';
import { inferQuotaPoolKey } from './provider-quota.js';

const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

// Confirmed credential failures retain the existing three-check rule. Transport
// failures never increment this counter and a successful validation clears it.
const failureCount = new Map<number, number>();

async function checkKeyHealthOnce(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  if (!row) return 'error';

  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey, {
      platform: row.platform as Platform,
      keyId,
      quotaPoolKey: inferQuotaPoolKey(row.platform as Platform, null),
      endpoint: 'models',
      origin: 'health',
    });

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run(status, keyId);

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);
      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        // Health checks may disable confirmed-invalid credentials, but never
        // silently re-enable an API key the operator switched off.
        db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: any) {
    console.error(
      `[Health] Key ${keyId} (${row.platform}, base=${row.base_url ?? 'default'}) ` +
      `transport error: ${err.message}`,
    );
    db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
      .run('error', keyId);
    return 'error';
  }
}

const keyChecksInFlight = new Map<number, Promise<KeyStatus>>();

/** Join an in-flight validation for the same key instead of double-counting it. */
export function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const existing = keyChecksInFlight.get(keyId);
  if (existing) return existing;

  const run = checkKeyHealthOnce(keyId).finally(() => keyChecksInFlight.delete(keyId));
  keyChecksInFlight.set(keyId, run);
  return run;
}

export interface ProviderKeyHealthResult {
  keyId: number;
  status: KeyStatus;
}

const providerChecksInFlight = new Map<string, Promise<ProviderKeyHealthResult[]>>();

/** Automatic provider pass: only enabled keys for the selected provider. */
export function checkProviderKeys(
  platform: string,
  concurrency = 2,
  checker: (keyId: number) => Promise<KeyStatus> = checkKeyHealth,
): Promise<ProviderKeyHealthResult[]> {
  const existing = providerChecksInFlight.get(platform);
  if (existing) return existing;

  const run = (async () => {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY id',
    ).all(platform) as Array<{ id: number }>;
    const results = new Array<ProviderKeyHealthResult>(rows.length);
    const workers = Math.min(Math.max(Math.floor(concurrency) || 1, 1), 5, rows.length || 1);
    let cursor = 0;

    async function worker(): Promise<void> {
      while (true) {
        const index = cursor++;
        if (index >= rows.length) return;
        const keyId = rows[index].id;
        results[index] = { keyId, status: await checker(keyId) };
      }
    }

    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
  })().finally(() => providerChecksInFlight.delete(platform));

  providerChecksInFlight.set(platform, run);
  return run;
}

// Manual operator action. It intentionally ignores provider schedules.
let checkAllInFlight: Promise<void> | null = null;

export function checkAllKeys(): Promise<void> {
  if (checkAllInFlight) return checkAllInFlight;
  checkAllInFlight = (async () => {
    const db = getDb();
    const keys = db.prepare('SELECT id FROM api_keys WHERE enabled = 1 ORDER BY id').all() as Array<{ id: number }>;
    console.log(`[Health] Checking ${keys.length} keys...`);
    for (const key of keys) await checkKeyHealth(key.id);
    console.log('[Health] Check complete.');
  })().finally(() => {
    checkAllInFlight = null;
  });
  return checkAllInFlight;
}
