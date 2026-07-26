import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { refreshStatsCache, setRoutingStrategy, getRoutingScores } from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';

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

function addModel(platform: string, modelId: string): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
    VALUES (?, ?, ?, 50, 1, 'mid', '1000000', 1)
  `).run(platform, modelId, modelId);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)')
    .run(defaultProfileId(), id);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(platform);
  return id;
}

/** Probe rows record success as 'ok'; live traffic records 'success'. */
function addRows(
  platform: string,
  modelId: string,
  rows: Array<{ status: string; requestType: string | null; n: number }>,
) {
  const ins = getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, request_type)
    VALUES (?, ?, 1, ?, 0, 100, 1000, NULL, NULL, ?)
  `);
  for (const r of rows) for (let i = 0; i < r.n; i++) ins.run(platform, modelId, r.status, r.requestType);
}

function reliabilityOf(modelId: string): number {
  const found = getRoutingScores().scores.find(s => s.modelId === modelId);
  if (!found) throw new Error(`no score row for ${modelId}`);
  return found.reliability;
}

describe('routing stats exclude probe traffic', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    getDb().exec('DELETE FROM fallback_config; DELETE FROM profile_models; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    setRoutingStrategy('balanced');
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('does not count a successful probe as a live-traffic failure', () => {
    addModel('pa', 'clean');
    addModel('pb', 'probed');
    // Identical live traffic; 'probed' additionally carries successful probes,
    // which used to land in the denominator but never in the numerator.
    addRows('pa', 'clean', [{ status: 'success', requestType: 'chat', n: 8 }]);
    addRows('pb', 'probed', [
      { status: 'success', requestType: 'chat', n: 8 },
      { status: 'ok', requestType: 'probe', n: 40 },
    ]);

    refreshStatsCache(getDb(), true);
    expect(reliabilityOf('probed')).toBeCloseTo(reliabilityOf('clean'), 6);
  });

  it('ignores probe rows entirely, failures included', () => {
    addModel('pc', 'only-probes');
    addRows('pc', 'only-probes', [
      { status: 'ok', requestType: 'probe', n: 5 },
      { status: 'error', requestType: 'probe', n: 5 },
    ]);

    refreshStatsCache(getDb(), true);
    // No live traffic at all → the untouched prior, not a 50%-looking record.
    const noSample = reliabilityOf('only-probes');

    getDb().exec("DELETE FROM requests");
    refreshStatsCache(getDb(), true);
    expect(reliabilityOf('only-probes')).toBeCloseTo(noSample, 6);
  });

  // request_type is NOT NULL DEFAULT 'chat', so every live row carries a type.
  it('still counts live traffic', () => {
    addModel('pd', 'live');
    addRows('pd', 'live', [
      { status: 'success', requestType: 'chat', n: 9 },
      { status: 'error', requestType: 'chat', n: 1 },
    ]);

    refreshStatsCache(getDb(), true);
    const withTraffic = reliabilityOf('live');

    getDb().exec('DELETE FROM requests');
    refreshStatsCache(getDb(), true);
    expect(withTraffic).toBeGreaterThan(reliabilityOf('live'));
  });
});
