import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { failureAttributionFor, getRoutingScores, refreshStatsCache, routeRequest, setProviderMomentAttribution, setRoutingStrategy } from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';
import { addToActiveChain } from '../helpers/chain.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return { ...actual, canMakeRequest: vi.fn(() => true), canUseTokens: vi.fn(() => true), isOnCooldown: vi.fn(() => false) };
});
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const original = { dev: process.env.DEV_MODE, node: process.env.NODE_ENV, pm: process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION };
const local = 'local_attempt_ttfb_timeout';

describe('local attempt first-byte timeout scoring', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;

  });
  afterEach(() => {
    for (const [key, value] of Object.entries({ DEV_MODE: original.dev, NODE_ENV: original.node, ROUTER_PROVIDER_MOMENT_ATTRIBUTION: original.pm })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it.each([false, true])('attributes only trusted direct or immediate cause markers (provider moment %s)', enabled => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = enabled ? '1' : '0';
    const marked = Object.assign(new Error('first-byte timeout'), { attemptTtfbTimeout: true });
    expect(failureAttributionFor(marked)).toBe(local);
    expect(failureAttributionFor(new Error('wrapper', { cause: marked }))).toBe(local);
    expect(failureAttributionFor({ message: 'first-byte timeout', attemptTtfbTimeout: 'true' })).toBe(enabled ? 'provider_moment' : null);
    expect(failureAttributionFor(new Error('upstream stalled: no first byte (first-byte timeout)'))).toBe(enabled ? 'provider_moment' : null);
    expect(failureAttributionFor({ message: 'other', cause: { cause: marked } })).toBeNull();
  });

  it.each([false, true])('excludes local events from model and key scoring, preserving upstream watchdog (provider moment %s)', enabled => {
    initDb(':memory:');
    const db = getDb();
    db.exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    setRoutingStrategy('balanced');
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled) VALUES ('groq', 'local-test', 'Local Test', 3, 1, 'Large', '~50M', 1)").run();
    const id = (db.prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'local-test'").get() as { id: number }).id;
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
    addToActiveChain(id, 1);
    const ins = db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', ?, 'enc', 'iv', 'tag', 'healthy', 1)");
    const a = Number(ins.run('a').lastInsertRowid);
    const b = Number(ins.run('b').lastInsertRowid);
    setProviderMomentAttribution(enabled);
    for (let i = 0; i < 30; i++) logRequest('groq', 'local-test', a, 'error', 5000000, 0, 15000, 'first-byte timeout', null, null, null, null, local);
    refreshStatsCache(db, true);
    expect(getRoutingScores().scores.find(s => s.modelDbId === id)!.totalRequests).toBe(0);
    // Even locally timed-out attempts may consume upstream tokens and count toward monthly headroom.
    expect(getRoutingScores().scores.find(s => s.modelDbId === id)!.headroom).toBe(0.1);
    const counts: Record<number, number> = {};
    for (let i = 0; i < 40; i++) { const r = routeRequest(100); counts[r.keyId] = (counts[r.keyId] ?? 0) + 1; r.release(); }
    expect(counts[a]).toBe(20);
    expect(counts[b]).toBe(20);
    // A genuine upstream watchdog is still counted when no provider-moment tag was written.
    logRequest('groq', 'local-test', b, 'error', 0, 0, 60000, 'upstream stalled: no first byte (first-byte timeout)');
    refreshStatsCache(db, true);
    expect(getRoutingScores().scores.find(s => s.modelDbId === id)!.totalRequests).toBe(1);
  });
});
