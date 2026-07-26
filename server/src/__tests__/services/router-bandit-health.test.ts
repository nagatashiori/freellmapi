// The health demotion must survive a switch to a bandit strategy.
//
// The operator is moving off `priority` (which makes profile_models.priority the
// truth source) onto a scored strategy, which deliberately overrides that manual
// order. Everything the health work bought must still hold in that mode:
// demoteUnhealthyRoutes and the real-traffic signal are applied AFTER orderChain
// in routeRequest, so they are strategy-independent — this test is what keeps
// that true, because a bandit score alone would happily put a dead model first
// (a broken model is often the "smartest" one in the catalog).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest, setRoutingStrategy, refreshStatsCache } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function defaultProfileId(): number {
  return (getDb().prepare(`
    SELECT id FROM profiles
    WHERE type = 'default' OR LOWER(name) = 'default'
    ORDER BY CASE WHEN type = 'default' THEN 0 ELSE 1 END, id ASC LIMIT 1
  `).get() as { id: number }).id;
}

function addModel(platform: string, modelId: string, intelligenceRank: number, priority: number): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled)
    VALUES (?, ?, ?, ?, 1, 'large', '', 1)
  `).run(platform, modelId, modelId, intelligenceRank);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number }).id;
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
    .run(defaultProfileId(), id, priority);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(platform);
  return id;
}

function addProbe(platform: string, modelId: string, status: string) {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, latency_ms, request_type, created_at)
    VALUES (?, ?, ?, 100, 'probe', datetime('now'))
  `).run(platform, modelId, status);
}

function addRealRequests(platform: string, modelId: string, successes: number, failures: number) {
  const ins = getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, latency_ms, request_type, created_at)
    VALUES (?, ?, ?, 100, 'chat', datetime('now'))
  `);
  for (let i = 0; i < successes; i++) ins.run(platform, modelId, 'success');
  for (let i = 0; i < failures; i++) ins.run(platform, modelId, 'error');
}

function pickedModels(runs: number): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < runs; i++) seen.add(routeRequest(100).modelId);
  return seen;
}

describe('health demotion under a bandit strategy', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM profile_models; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('never picks a probe-unhealthy model under "smartest", even though it scores highest', () => {
    // rank 1 = the smartest model in the catalog, so `smartest` would put it
    // first on score alone. Its probe says it is down.
    addModel('google', 'dead-genius', 1, 1);
    addModel('groq', 'live-workhorse', 50, 2);
    addProbe('google', 'dead-genius', 'error');
    addProbe('groq', 'live-workhorse', 'ok');

    setRoutingStrategy('smartest');
    refreshStatsCache(getDb());

    expect(pickedModels(25)).toEqual(new Set(['live-workhorse']));
  });

  it('never picks a model whose real traffic is failing under "smartest"', () => {
    addModel('google', 'probes-ok-but-522s', 1, 1);
    addModel('groq', 'live-workhorse', 50, 2);
    // The exact production shape: probe says ok, live traffic says otherwise.
    addProbe('google', 'probes-ok-but-522s', 'ok');
    addProbe('groq', 'live-workhorse', 'ok');
    addRealRequests('google', 'probes-ok-but-522s', 0, 6);
    addRealRequests('groq', 'live-workhorse', 6, 0);

    setRoutingStrategy('smartest');
    refreshStatsCache(getDb());

    expect(pickedModels(25)).toEqual(new Set(['live-workhorse']));
  });

  it('still reaches the demoted model when it is the ONLY candidate left', () => {
    // Demotion reorders; it must never remove a route, or a single-model install
    // whose probe failed would 429 with a healthy provider sitting right there.
    addModel('google', 'sole-model', 1, 1);
    addProbe('google', 'sole-model', 'error');

    setRoutingStrategy('balanced');
    refreshStatsCache(getDb());

    expect(routeRequest(100).modelId).toBe('sole-model');
  });

  it('applies the same demotion in priority mode, so switching strategy changes nothing about it', () => {
    addModel('google', 'dead-genius', 1, 1);
    addModel('groq', 'live-workhorse', 50, 2);
    addProbe('google', 'dead-genius', 'timeout');
    addProbe('groq', 'live-workhorse', 'ok');

    setRoutingStrategy('priority');
    expect(pickedModels(10)).toEqual(new Set(['live-workhorse']));
  });
});
