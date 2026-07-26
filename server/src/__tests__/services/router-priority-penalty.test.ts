// Priority-mode chain ordering under the runtime failure penalty.
//
// Production evidence (2026-07-26, active profile "Default", 208 enabled
// models): a model at manual priority 5 with 0/12 successful real requests over
// seven days still led EVERY request. The old ordering was
// `priority + penalty` with MAX_PENALTY = 10, so the worst possible demotion
// moved it from slot 5 to slot 15 of 208 — still the head of the chain. Each
// request therefore burned a ~20-30s hop on a dead route before reaching a
// working model (observed: 5 wasted hops / ~110s before the first success).
//
// The fix keeps manual priority as the truth source for ORDER but sorts models
// that just exhausted every key into a band BEHIND every unpenalized model.
// Nothing is written to profile_models; the penalty still decays.

import { describe, expect, it } from 'vitest';
import { orderChainByPriority } from '../../services/router.js';

function entry(model_db_id: number, priority: number) {
  return { model_db_id, priority };
}

describe('orderChainByPriority', () => {
  it('keeps manual priority order when nothing is penalized', () => {
    const chain = [entry(3, 30), entry(1, 5), entry(2, 12)];
    expect(orderChainByPriority(chain, () => 0).map(e => e.model_db_id))
      .toEqual([1, 2, 3]);
  });

  it('sinks a penalized head-of-chain model behind every healthy model in a long chain', () => {
    // Mirrors production: priority 5 is dead, 200 healthy models follow.
    const chain = [entry(1, 5), ...Array.from({ length: 200 }, (_, i) => entry(i + 2, i + 6))];
    const penaltyOf = (id: number) => (id === 1 ? 3 : 0);

    const ordered = orderChainByPriority(chain, penaltyOf);

    expect(ordered[0].model_db_id).toBe(2);          // first healthy model leads
    expect(ordered[ordered.length - 1].model_db_id).toBe(1); // dead model is last
  });

  it('orders penalized models among themselves by penalty, then manual priority', () => {
    const chain = [entry(1, 5), entry(2, 6), entry(3, 7), entry(4, 8)];
    const penalties: Record<number, number> = { 1: 6, 2: 3, 3: 0, 4: 3 };

    expect(orderChainByPriority(chain, id => penalties[id] ?? 0).map(e => e.model_db_id))
      .toEqual([3, 2, 4, 1]);
  });

  it('restores a recovered model to its manual slot once its penalty decays to 0', () => {
    const chain = [entry(1, 5), entry(2, 6), entry(3, 7)];
    expect(orderChainByPriority(chain, () => 0).map(e => e.model_db_id)).toEqual([1, 2, 3]);
  });

  it('is stable for equal priority and equal penalty', () => {
    const chain = [entry(9, 10), entry(8, 10), entry(7, 10)];
    expect(orderChainByPriority(chain, () => 0).map(e => e.model_db_id)).toEqual([9, 8, 7]);
  });
});
