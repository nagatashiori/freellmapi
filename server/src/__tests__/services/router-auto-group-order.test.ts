import { describe, expect, it } from 'vitest';
import type { ChainRow } from '../../services/router.js';
import { orderLogicalModelGroupCandidates } from '../../services/model-health.js';
import type { ModelGroup } from '../../services/model-groups.js';
import type { ModelProbeHealth } from '../../services/model-health.js';

function row(id: number, priority: number): ChainRow {
  return {
    model_db_id: id,
    priority,
    enabled: 1,
    platform: `provider-${id}`,
    model_id: `model-${id}`,
    display_name: `Model ${id}`,
    intelligence_rank: 1,
    size_label: 'test',
    monthly_token_budget: '',
    rpm_limit: null,
    rpd_limit: null,
    tpm_limit: null,
    tpd_limit: null,
    supports_vision: 0,
    supports_tools: 0,
    context_window: null,
    key_id: null,
  };
}

function health(latency: number, now: number): ModelProbeHealth {
  return {
    lastStatus: 'ok',
    lastProbedAt: new Date(now - 1_000).toISOString(),
    lastLatencyMs: latency,
    avgLatencyMs: latency,
    sampleCount: 1,
    cooldownUntilMs: null,
    usableKeyCount: 1,
    coolingKeyCount: 0,
  };
}

describe('AUTO logical-group ordering', () => {
  it('keeps unit priority while ordering equivalent provider members by successful latency', () => {
    const now = Date.UTC(2026, 6, 23, 12, 0, 0);
    const chain = [row(1, 1), row(3, 2), row(2, 3), row(4, 4), row(5, 5)];
    const groups: ModelGroup[] = [
      {
        groupKey: 'logical-a', canonicalId: 'logical-a', groupLabel: 'Logical A',
        members: [chain[0], chain[2]],
      },
      {
        groupKey: 'logical-b', canonicalId: 'logical-b', groupLabel: 'Logical B',
        members: [chain[3], chain[4]],
      },
    ];
    const healthById = new Map<number, ModelProbeHealth>([
      [1, health(800, now)],
      [2, health(100, now)],
      [4, health(500, now)],
      [5, health(200, now)],
    ]);

    expect(orderLogicalModelGroupCandidates(chain, groups, healthById, now).map(item => item.model_db_id))
      .toEqual([2, 1, 3, 5, 4]);
  });

  it('uses profile priority as the stable tie-breaker when latency is equal', () => {
    const now = Date.UTC(2026, 6, 23, 12, 0, 0);
    const chain = [row(10, 1), row(11, 3)];
    const groups: ModelGroup[] = [{
      groupKey: 'tie', canonicalId: 'tie', groupLabel: 'Tie', members: chain,
    }];
    const healthById = new Map<number, ModelProbeHealth>([
      [10, health(100, now)],
      [11, health(100, now)],
    ]);

    expect(orderLogicalModelGroupCandidates(chain, groups, healthById, now).map(item => item.model_db_id))
      .toEqual([10, 11]);
  });
});
