// Probe starvation: the scheduler yields to customer traffic by postponing every
// due provider 60s, and `hasRecentCustomerTraffic` looks back 60s. On a gateway
// that serves a request more often than once a minute that postpone never
// resolves, so scheduled probes stop running indefinitely — which is how the
// whole 208-model chain went stale (last probe 2026-07-25, all states `stale`,
// zero `ready`).
//
// The courtesy delay is kept, but it is now bounded: `deferredSince` records the
// first postpone of a stretch, and once that stretch exceeds
// PROVIDER_HEALTH_MAX_DEFER_MS the provider runs even while traffic flows. A
// completed run clears the stamp.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  PROVIDER_HEALTH_MAX_DEFER_MS,
  getProviderHealthSchedule,
  isProviderHealthScheduleOverdue,
  markProviderHealthScheduleFinished,
  postponeProviderHealthSchedules,
  saveProviderHealthSchedule,
  type ProviderHealthSchedule,
} from '../../services/provider-health-schedule.js';
import { runProviderHealthSchedulerTick } from '../../services/model-probe-scheduler.js';

const INTERVAL = 6 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-26T12:00:00Z');

function view(over: Partial<ProviderHealthSchedule> = {}): ProviderHealthSchedule {
  return {
    platform: 'starve-test-a',
    enabled: true,
    intervalMs: INTERVAL,
    lastRunAt: null,
    nextRunAt: new Date(NOW).toISOString(),
    deferredSince: null,
    ...over,
  };
}

describe('isProviderHealthScheduleOverdue', () => {
  it('is false when the schedule has never been deferred', () => {
    expect(isProviderHealthScheduleOverdue(view(), NOW)).toBe(false);
  });

  it('is false while the deferral is inside the grace period', () => {
    const s = view({ deferredSince: new Date(NOW).toISOString() });
    expect(isProviderHealthScheduleOverdue(s, NOW + PROVIDER_HEALTH_MAX_DEFER_MS - 1000)).toBe(false);
  });

  it('is true once one continuous deferral exceeds the grace period', () => {
    const s = view({ deferredSince: new Date(NOW).toISOString() });
    expect(isProviderHealthScheduleOverdue(s, NOW + PROVIDER_HEALTH_MAX_DEFER_MS + 1000)).toBe(true);
  });

  it('is false for a disabled schedule however long it has waited', () => {
    const s = view({ enabled: false, deferredSince: new Date(NOW).toISOString() });
    expect(isProviderHealthScheduleOverdue(s, NOW + 10 * PROVIDER_HEALTH_MAX_DEFER_MS)).toBe(false);
  });
});

describe('deferredSince bookkeeping', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM api_keys WHERE platform LIKE 'starve-test-%'").run();
    db.prepare("DELETE FROM settings WHERE key = 'provider_health_schedules'").run();
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('starve-test-a', 'test', 'c', 'iv', 'tag', 'unknown', 1)
    `).run();
    saveProviderHealthSchedule('starve-test-a', { enabled: true, intervalMs: INTERVAL }, NOW, () => 0);
  });

  it('stamps the first postpone and does NOT re-stamp later ones', () => {
    postponeProviderHealthSchedules(['starve-test-a'], NOW);
    const first = getProviderHealthSchedule('starve-test-a').deferredSince;
    expect(first).toBe(new Date(NOW).toISOString());

    // Re-stamping every busy tick would reset the clock forever and reintroduce
    // the starvation this guard exists to prevent.
    postponeProviderHealthSchedules(['starve-test-a'], NOW + 20 * 60 * 1000);
    expect(getProviderHealthSchedule('starve-test-a').deferredSince).toBe(first);
  });

  it('clears the stamp once a run completes', () => {
    postponeProviderHealthSchedules(['starve-test-a'], NOW);
    expect(getProviderHealthSchedule('starve-test-a').deferredSince).not.toBeNull();

    markProviderHealthScheduleFinished('starve-test-a', NOW + 1000, () => 0);
    expect(getProviderHealthSchedule('starve-test-a').deferredSince).toBeNull();
  });

  it('becomes overdue after a continuous stretch of busy ticks', () => {
    postponeProviderHealthSchedules(['starve-test-a'], NOW);
    for (let t = 60_000; t <= PROVIDER_HEALTH_MAX_DEFER_MS + 120_000; t += 60_000) {
      postponeProviderHealthSchedules(['starve-test-a'], NOW + t);
    }
    const s = getProviderHealthSchedule('starve-test-a');
    expect(isProviderHealthScheduleOverdue(s, NOW + PROVIDER_HEALTH_MAX_DEFER_MS + 120_000)).toBe(true);
  });
});

describe('runProviderHealthSchedulerTick under customer traffic', () => {
  const deps = (dueSchedules: ProviderHealthSchedule[], now = NOW) => {
    const probed: string[] = [];
    return {
      probed,
      opts: {
        now,
        random: () => 0,
        dueSchedules,
        isBusy: () => true,
        checkKeys: async (platform: string) => { probed.push('keys:' + platform); return [{}] as any; },
        probeModels: async () => { probed.push('models'); return [] as any; },
        modelTargets: () => [1, 2],
        finishedAt: () => now,
      },
    };
  };

  it('still yields to traffic when no schedule is starved', async () => {
    const { probed, opts } = deps([view()]);
    const result = await runProviderHealthSchedulerTick(opts as any);
    expect(result.kind).toBe('busy');
    expect(probed).toEqual([]);
  });

  it('runs a starved provider even while customer traffic is flowing', async () => {
    const later = NOW + PROVIDER_HEALTH_MAX_DEFER_MS + 60_000;
    const { probed, opts } = deps([view({ deferredSince: new Date(NOW).toISOString() })], later);
    const result = await runProviderHealthSchedulerTick(opts as any);
    expect(result.kind).toBe('checked');
    expect(result.platform).toBe('starve-test-a');
    expect(probed).toEqual(['keys:starve-test-a', 'models']);
  });

  it('picks only from the starved subset, leaving the rest postponed', async () => {
    const later = NOW + PROVIDER_HEALTH_MAX_DEFER_MS + 60_000;
    const fresh = view({ platform: 'starve-test-fresh' });
    const starved = view({ platform: 'starve-test-b', deferredSince: new Date(NOW).toISOString() });
    const { probed, opts } = deps([fresh, starved], later);
    const result = await runProviderHealthSchedulerTick(opts as any);
    expect(result.platform).toBe('starve-test-b');
    expect(probed).toEqual(['keys:starve-test-b', 'models']);
  });
});
