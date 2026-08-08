import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { getDefaultProfileId, replaceRoutingChain } from '../../services/routing-groups.js';

describe('router API-key pool', () => {
  let modelDbId = 0;
  let modelId = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setRoutingStrategy('priority');
    const db = getDb();
    modelId = `router-key-pool-${Date.now()}`;
    const result = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, endpoint_scope)
      VALUES ('groq', ?, 'Router Key Pool', 1, 1, 'small', NULL, NULL, NULL, NULL, '', NULL, 1, 0, 1, '')
    `).run(modelId);
    modelDbId = Number(result.lastInsertRowid);
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM profile_models').run();
    replaceRoutingChain(db, getDefaultProfileId(db), [{ modelDbId, priority: 1, enabled: 1 }]);
    delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY;
    delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
  });

  function addKey(label: string, modelScope: string | null = null): number {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt(`router-${label}`);
    const row = db.prepare(`
      INSERT INTO api_keys
        (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
      VALUES ('groq', ?, ?, ?, ?, 'healthy', 1, ?)
    `).run(label, encrypted, iv, authTag, modelScope);
    return Number(row.lastInsertRowid);
  }

  it('skips a key whose model scope excludes the requested model', () => {
    const excluded = addKey('excluded', JSON.stringify(['different-model']));
    const allowed = addKey('allowed');

    const route = routeRequest(100);
    expect(route.modelId).toBe(modelId);
    expect(route.keyId).toBe(allowed);
    expect(route.keyId).not.toBe(excluded);
    route.release?.();
  });

  it('round-robins keys when there is no account history', () => {
    const first = addKey('first');
    const second = addKey('second');

    const routeA = routeRequest(100);
    routeA.release?.();
    const routeB = routeRequest(100);
    routeB.release?.();

    expect(new Set([routeA.keyId, routeB.keyId])).toEqual(new Set([first, second]));
  });

  it('avoids a key already holding its concurrency lease', () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '1';
    const first = addKey('busy-first');
    const second = addKey('free-second');

    const held = routeRequest(100);
    const next = routeRequest(100);
    expect(new Set([held.keyId, next.keyId])).toEqual(new Set([first, second]));
    expect(next.keyId).not.toBe(held.keyId);

    next.release?.();
    held.release?.();
  });
});
