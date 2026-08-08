import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { refreshStatsCache, routeRequest, setRoutingStrategy } from '../../services/router.js';
import { getDefaultProfileId, replaceRoutingChain } from '../../services/routing-groups.js';

describe('router API-key pool', () => {
  let modelDbId = 0;
  let modelId = '';
  let customModelDbId = 0;
  let customModelId = '';

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

    customModelId = `router-custom-key-pool-${Date.now()}`;
    const customResult = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
         enabled, supports_vision, supports_tools, key_id, endpoint_scope)
      VALUES ('custom', ?, 'Custom Router Key Pool', 1, 1, 'small', NULL, NULL, NULL, NULL, '', NULL, 1, 0, 1, NULL, '')
    `).run(customModelId);
    customModelDbId = Number(customResult.lastInsertRowid);
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM requests').run();
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

  function addCustomKey(label: string, baseUrl: string): number {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt(`router-${label}`);
    const row = db.prepare(`
      INSERT INTO api_keys
        (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES ('custom', ?, ?, ?, ?, 'healthy', 1, ?)
    `).run(label, encrypted, iv, authTag, baseUrl);
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

  it('keeps exploring both keys after history exists, using sampled account scores', () => {
    const first = addKey('history-first');
    const second = addKey('history-second');
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO requests
        (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
      VALUES ('groq', ?, ?, 'success', 0, 100, 1000, NULL, 'chat')
    `);
    insert.run(modelId, first);
    insert.run(modelId, first);
    insert.run(modelId, second);
    refreshStatsCache(db, true);

    let seed = 0x12345678;
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    });
    try {
      const used = new Set<number>();
      for (let i = 0; i < 24; i++) {
        const route = routeRequest(100);
        used.add(route.keyId);
        route.release?.();
      }
      expect(used).toEqual(new Set([first, second]));
    } finally {
      random.mockRestore();
    }
  });

  it('rotates two token files on the same custom endpoint', () => {
    const baseUrl = 'https://same-endpoint.example/v1';
    const first = addCustomKey('endpoint-first', baseUrl);
    const second = addCustomKey('endpoint-second', `${baseUrl}/`);
    const other = addCustomKey('different-endpoint', 'https://other-endpoint.example/v1');
    const db = getDb();
    db.prepare('UPDATE models SET key_id = ?, endpoint_scope = ? WHERE id = ?')
      .run(first, '', customModelDbId);
    replaceRoutingChain(db, getDefaultProfileId(db), [{ modelDbId: customModelDbId, priority: 1, enabled: 1 }]);

    const routeA = routeRequest(100);
    routeA.release?.();
    const routeB = routeRequest(100);
    routeB.release?.();
    expect(new Set([routeA.keyId, routeB.keyId])).toEqual(new Set([first, second]));
    expect(routeA.keyId).not.toBe(other);
    expect(routeB.keyId).not.toBe(other);
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
