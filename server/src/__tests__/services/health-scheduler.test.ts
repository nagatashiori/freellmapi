import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { checkProviderKeys } from '../../services/health.js';

function addKey(platform: string, enabled: number): number {
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', 'cipher', 'iv', 'tag', 'unknown', ?)
  `).run(platform, enabled);
  return Number(result.lastInsertRowid);
}

describe('provider key health pass', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM api_keys WHERE platform LIKE 'health-test-%'").run();
  });

  it('checks only enabled keys belonging to the selected provider', async () => {
    const enabledA = addKey('health-test-a', 1);
    addKey('health-test-a', 0);
    addKey('health-test-b', 1);
    const checker = vi.fn(async () => 'healthy' as const);

    const result = await checkProviderKeys('health-test-a', 2, checker);

    expect(checker).toHaveBeenCalledTimes(1);
    expect(checker).toHaveBeenCalledWith(enabledA);
    expect(result).toEqual([{ keyId: enabledA, status: 'healthy' }]);
  });

  it('deduplicates overlapping automatic checks for one provider', async () => {
    addKey('health-test-dedupe', 1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const checker = vi.fn(async () => {
      await gate;
      return 'healthy' as const;
    });

    const first = checkProviderKeys('health-test-dedupe', 1, checker);
    const second = checkProviderKeys('health-test-dedupe', 1, checker);
    expect(second).toBe(first);
    release();
    await expect(first).resolves.toHaveLength(1);
    expect(checker).toHaveBeenCalledOnce();
  });
});
