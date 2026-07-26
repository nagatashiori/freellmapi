// Health-aware demotion of the OUTER auto chain.
//
// Probe health used to reach routing only INSIDE a unify group
// (orderLogicalModelGroupCandidates), so a model the probes had just proven
// broken still led the global chain. Production evidence (2026-07-26, after the
// provider health schedules were switched back on): 61 of 235 chain entries were
// `unhealthy` and every one of them was still routed to, because the automatic
// switch-off needs three consecutive failed probes — at a 6h probe interval that
// is ~18h of routing to models already known to be down.
//
// Demotion is deliberately narrow: it sinks known-bad routes, it does NOT
// promote by latency, and it never writes profile_models. `stale`/`unknown`
// (not probed recently, or never probed) keep their manual slot — an absent
// measurement is not evidence of failure.

import { describe, expect, it } from 'vitest';
import { demoteUnhealthyRoutes } from '../../services/router.js';
import type { ModelProbeHealth } from '../../services/model-health.js';

const NOW = Date.parse('2026-07-26T08:00:00Z');
const FRESH = '2026-07-26 07:50:00';
const OLD = '2026-07-20 07:50:00';

function health(over: Partial<ModelProbeHealth>): ModelProbeHealth {
  return {
    lastStatus: 'ok',
    lastProbedAt: FRESH,
    lastLatencyMs: 100,
    avgLatencyMs: 100,
    sampleCount: 1,
    cooldownUntilMs: null,
    usableKeyCount: 1,
    coolingKeyCount: 0,
    ...over,
  };
}

function chain(...ids: number[]) {
  return ids.map(model_db_id => ({ model_db_id }));
}

describe('demoteUnhealthyRoutes', () => {
  it('sinks probe-unhealthy models behind healthy ones, preserving incoming order', () => {
    const map = new Map<number, ModelProbeHealth>([
      [1, health({ lastStatus: 'error' })],
      [2, health({})],
      [3, health({ lastStatus: 'timeout' })],
      [4, health({})],
    ]);
    expect(demoteUnhealthyRoutes(chain(1, 2, 3, 4), map, new Set(), NOW).map(e => e.model_db_id))
      .toEqual([2, 4, 1, 3]);
  });

  it('sinks a model whose provider has no usable key at all', () => {
    const map = new Map<number, ModelProbeHealth>([
      [1, health({ usableKeyCount: 0 })],
      [2, health({})],
    ]);
    expect(demoteUnhealthyRoutes(chain(1, 2), map, new Set(), NOW).map(e => e.model_db_id))
      .toEqual([2, 1]);
  });

  it('keeps stale and never-probed models in their manual slot', () => {
    // Absence of a fresh measurement is not evidence of failure: only models the
    // probes actually FAILED get demoted.
    const map = new Map<number, ModelProbeHealth>([
      [1, health({ lastProbedAt: OLD })],   // stale
      [2, health({ lastStatus: 'error' })], // unhealthy
      [3, health({})],                      // ready
    ]);
    expect(demoteUnhealthyRoutes(chain(1, 2, 3), map, new Set(), NOW).map(e => e.model_db_id))
      .toEqual([1, 3, 2]);

    const noHealth = new Map<number, ModelProbeHealth>();
    expect(demoteUnhealthyRoutes(chain(7, 8, 9), noHealth, new Set(), NOW).map(e => e.model_db_id))
      .toEqual([7, 8, 9]);
  });

  it('places fully-cooling models after healthy ones but ahead of unhealthy ones', () => {
    const map = new Map<number, ModelProbeHealth>([
      [1, health({ lastStatus: 'error' })],
      [2, health({ coolingKeyCount: 1, cooldownUntilMs: NOW + 60_000 })],
      [3, health({})],
    ]);
    expect(demoteUnhealthyRoutes(chain(1, 2, 3), map, new Set(), NOW).map(e => e.model_db_id))
      .toEqual([3, 2, 1]);
  });

  it('is a no-op when every model is healthy', () => {
    const map = new Map<number, ModelProbeHealth>([
      [5, health({})], [6, health({})], [7, health({})],
    ]);
    expect(demoteUnhealthyRoutes(chain(5, 6, 7), map, new Set(), NOW).map(e => e.model_db_id))
      .toEqual([5, 6, 7]);
  });

  it('does not reorder healthy models by latency', () => {
    // 9 is much slower than 8 but was placed first by manual priority — routing
    // order is the operator's, not the stopwatch's.
    const map = new Map<number, ModelProbeHealth>([
      [9, health({ avgLatencyMs: 9000 })],
      [8, health({ avgLatencyMs: 50 })],
    ]);
    expect(demoteUnhealthyRoutes(chain(9, 8), map, new Set(), NOW).map(e => e.model_db_id))
      .toEqual([9, 8]);
  });
});
