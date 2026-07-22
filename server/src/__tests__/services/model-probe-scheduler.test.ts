import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import type { Scheduler } from '../../lib/scheduler.js';
import {
  getProviderModelProbeTargets,
  PROVIDER_HEALTH_SCHEDULER_TICK_MS,
  runProviderHealthSchedulerTick,
  startProviderHealthScheduler,
  stopProviderHealthScheduler,
} from '../../services/model-probe-scheduler.js';
import {
  getProviderHealthSchedule,
  saveProviderHealthSchedule,
  type ProviderHealthSchedule,
} from '../../services/provider-health-schedule.js';

function addKey(platform: string, enabled = 1, status = 'unknown'): number {
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', 'cipher', 'iv', 'tag', ?, ?)
  `).run(platform, status, enabled);
  return Number(result.lastInsertRowid);
}

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

function due(platform: string, intervalMs = 60_000): ProviderHealthSchedule {
  return { platform, enabled: true, intervalMs, lastRunAt: null, nextRunAt: new Date(0).toISOString() };
}

describe('provider model probe scheduler', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    stopProviderHealthScheduler();
    const db = getDb();
    db.prepare("DELETE FROM models WHERE platform LIKE 'scheduler-test-%'").run();
    db.prepare("DELETE FROM api_keys WHERE platform LIKE 'scheduler-test-%'").run();
    db.prepare("DELETE FROM settings WHERE key = 'provider_health_schedules'").run();
  });

  it('includes disabled model rows for recovery but excludes a custom route bound to a disabled key', () => {
    const enabledKey = addKey('scheduler-test-custom', 1);
    const disabledKey = addKey('scheduler-test-custom', 0);
    const insert = getDb().prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        monthly_token_budget, enabled, key_id
      ) VALUES ('scheduler-test-custom', ?, ?, 1, 1, 'test', '', ?, ?)
    `);
    const recoverable = Number(insert.run('recoverable', 'Recoverable', 0, enabledKey).lastInsertRowid);
    insert.run('disabled-key', 'Disabled Key', 1, disabledKey);

    expect(getProviderModelProbeTargets('scheduler-test-custom')).toEqual([recoverable]);
  });

  it('does not convert an enabled but invalid key into model probe failures', () => {
    const invalidKey = addKey('scheduler-test-invalid', 1, 'invalid');
    getDb().prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        monthly_token_budget, enabled, key_id
      ) VALUES ('scheduler-test-invalid', 'blocked', 'Blocked', 1, 1, 'test', '', 1, ?)
    `).run(invalidKey);

    expect(getProviderModelProbeTargets('scheduler-test-invalid')).toEqual([]);
  });

  it('selects one due provider and persists a jittered next run after completion', async () => {
    addKey('scheduler-test-a');
    addKey('scheduler-test-b');
    const now = Date.UTC(2026, 6, 23, 0, 0, 0);
    saveProviderHealthSchedule('scheduler-test-a', { enabled: true, intervalMs: 60_000 }, now, () => 0);
    saveProviderHealthSchedule('scheduler-test-b', { enabled: true, intervalMs: 60_000 }, now, () => 0);
    const checkKeys = vi.fn(async () => [{ keyId: 1, status: 'healthy' as const }]);
    const probeModels = vi.fn(async () => []);

    const result = await runProviderHealthSchedulerTick({
      now: now + 60_000,
      dueSchedules: [due('scheduler-test-a'), due('scheduler-test-b')],
      random: () => 0.75,
      isBusy: () => false,
      checkKeys,
      probeModels,
      modelTargets: () => [101, 102],
      finishedAt: () => now + 70_000,
    });

    expect(result).toEqual({ kind: 'checked', platform: 'scheduler-test-b', keyCount: 1, modelCount: 2 });
    expect(checkKeys).toHaveBeenCalledOnce();
    expect(checkKeys).toHaveBeenCalledWith('scheduler-test-b', 2);
    expect(probeModels).toHaveBeenCalledWith([101, 102], 2);
    expect(getProviderHealthSchedule('scheduler-test-b').nextRunAt)
      .toBe(new Date(now + 70_000 + 60_000 + 9_000).toISOString());
  });

  it('postpones every due provider without upstream traffic while customer traffic is recent', async () => {
    addKey('scheduler-test-busy-a');
    addKey('scheduler-test-busy-b');
    const now = Date.UTC(2026, 6, 23, 0, 0, 0);
    for (const platform of ['scheduler-test-busy-a', 'scheduler-test-busy-b']) {
      saveProviderHealthSchedule(platform, { enabled: true, intervalMs: 60_000 }, now - 120_000, () => 0);
    }
    const checkKeys = vi.fn();

    const result = await runProviderHealthSchedulerTick({
      now,
      dueSchedules: [due('scheduler-test-busy-a'), due('scheduler-test-busy-b')],
      isBusy: () => true,
      checkKeys,
    });

    expect(result).toEqual({ kind: 'busy' });
    expect(checkKeys).not.toHaveBeenCalled();
    expect(getProviderHealthSchedule('scheduler-test-busy-a').nextRunAt).toBe(new Date(now + 60_000).toISOString());
    expect(getProviderHealthSchedule('scheduler-test-busy-b').nextRunAt).toBe(new Date(now + 60_000).toISOString());
  });

  it('registers one inexpensive one-minute tick and is idempotent', () => {
    const { scheduler, every } = makeScheduler();
    startProviderHealthScheduler(scheduler);
    startProviderHealthScheduler(scheduler);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(PROVIDER_HEALTH_SCHEDULER_TICK_MS);
  });
});
