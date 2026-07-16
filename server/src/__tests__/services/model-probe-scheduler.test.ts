import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb, setSetting } from '../../db/index.js';
import type { Scheduler } from '../../lib/scheduler.js';
import {
  getScheduledProbeTargets,
  MODEL_PROBE_SCHEDULER_TICK_MS,
  startModelProbeScheduler,
  stopModelProbeScheduler,
} from '../../services/model-probe-scheduler.js';

function makeScheduler() {
  const every: { ms: number; fn: () => void | Promise<void> }[] = [];
  const scheduler: Scheduler = {
    every(ms, fn) {
      every.push({ ms, fn });
      return vi.fn();
    },
    after() { return vi.fn(); },
  };
  return { scheduler, every };
}

describe('model probe scheduler', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    stopModelProbeScheduler();
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    setSetting('health_check_interval_ms', String(30 * 60 * 1000));
  });

  it('only targets an enabled logical group that received real traffic and is overdue for a probe', () => {
    const db = getDb();
    const active = db.prepare(`
      SELECT m.id, m.platform, m.model_id
      FROM models m
      JOIN profile_models pm ON pm.model_db_id = m.id
      WHERE pm.enabled = 1 AND m.enabled = 1
      ORDER BY m.id
      LIMIT 1
    `).get() as { id: number; platform: string; model_id: string };
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, request_type, created_at)
      VALUES (?, ?, 'success', 1, 1, 10, 'chat', datetime('now'))
    `).run(active.platform, active.model_id);

    expect(getScheduledProbeTargets()).toContain(active.id);
  });

  it('registers one inexpensive tick instead of a global probe storm', () => {
    const { scheduler, every } = makeScheduler();
    startModelProbeScheduler(scheduler);

    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(MODEL_PROBE_SCHEDULER_TICK_MS);
  });
});
