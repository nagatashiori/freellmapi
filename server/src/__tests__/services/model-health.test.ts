import { describe, expect, it } from 'vitest';
import {
  getModelRoutingState,
  rankModelGroupCandidates,
  type ModelProbeHealth,
} from '../../services/model-health.js';

describe('model probe health ordering', () => {
  const now = Date.UTC(2026, 6, 17, 12, 0, 0);

  it('keeps ready providers first by lowest successful probe latency, then cooling, stale, failed, and operator-disabled', () => {
    const rows = [
      { model_db_id: 1, priority: 1, enabled: 1 },
      { model_db_id: 2, priority: 2, enabled: 1 },
      { model_db_id: 3, priority: 3, enabled: 1 },
      { model_db_id: 4, priority: 4, enabled: 1 },
      { model_db_id: 5, priority: 5, enabled: 1 },
      { model_db_id: 6, priority: 6, enabled: 0 },
    ];
    const health = new Map<number, ModelProbeHealth>([
      [1, { lastStatus: 'success', lastProbedAt: new Date(now - 60_000).toISOString(), avgLatencyMs: 900, sampleCount: 3, cooldownUntilMs: null, usableKeyCount: 1, coolingKeyCount: 0 }],
      [2, { lastStatus: 'ok', lastProbedAt: new Date(now - 60_000).toISOString(), avgLatencyMs: 180, sampleCount: 2, cooldownUntilMs: null, usableKeyCount: 1, coolingKeyCount: 0 }],
      [3, { lastStatus: 'rate_limited', lastProbedAt: new Date(now - 30_000).toISOString(), avgLatencyMs: 40, sampleCount: 4, cooldownUntilMs: now + 90_000, usableKeyCount: 1, coolingKeyCount: 1 }],
      [4, { lastStatus: 'success', lastProbedAt: new Date(now - 25 * 60 * 60_000).toISOString(), avgLatencyMs: 100, sampleCount: 1, cooldownUntilMs: null, usableKeyCount: 1, coolingKeyCount: 0 }],
      [5, { lastStatus: 'timeout', lastProbedAt: new Date(now - 60_000).toISOString(), avgLatencyMs: 15_000, sampleCount: 0, cooldownUntilMs: null, usableKeyCount: 1, coolingKeyCount: 0 }],
      [6, { lastStatus: 'success', lastProbedAt: new Date(now - 60_000).toISOString(), avgLatencyMs: 20, sampleCount: 5, cooldownUntilMs: null, usableKeyCount: 1, coolingKeyCount: 0 }],
    ]);

    expect(rankModelGroupCandidates(rows, health, now).map(row => row.model_db_id)).toEqual([2, 1, 3, 4, 5, 6]);
  });

  it('does not leave an expired rate-limit result in the cooling lane', () => {
    const state = getModelRoutingState({
      lastStatus: 'rate_limited',
      lastProbedAt: new Date(now - 60_000).toISOString(),
      avgLatencyMs: 0,
      sampleCount: 0,
      cooldownUntilMs: now - 1,
      usableKeyCount: 1,
      coolingKeyCount: 0,
    }, true, now);

    expect(state).toBe('stale');
  });

  it('does not rank a route with no usable key as healthy', () => {
    const state = getModelRoutingState({
      lastStatus: 'ok',
      lastProbedAt: new Date(now - 60_000).toISOString(),
      avgLatencyMs: 10,
      sampleCount: 1,
      cooldownUntilMs: null,
      usableKeyCount: 0,
      coolingKeyCount: 0,
    }, true, now);

    expect(state).toBe('unhealthy');
  });

});
