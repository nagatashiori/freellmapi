import { getDb } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';
import { checkProviderKeys } from './health.js';
import { markProbeRun, runModelProbes } from './model-probe.js';
import {
  getDueProviderHealthSchedules,
  hasRecentCustomerTraffic,
  markProviderHealthScheduleFinished,
  postponeProviderHealthSchedules,
  type ProviderHealthSchedule,
} from './provider-health-schedule.js';

export const PROVIDER_HEALTH_SCHEDULER_TICK_MS = 60 * 1000;
// Kept as an export alias for callers/tests that referenced the old name.
export const MODEL_PROBE_SCHEDULER_TICK_MS = PROVIDER_HEALTH_SCHEDULER_TICK_MS;

export function getProviderModelProbeTargets(platform: string): number[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id
    FROM models m
    WHERE m.platform = ?
      AND EXISTS (
        SELECT 1
        FROM api_keys ak
        WHERE ak.platform = m.platform
          AND ak.enabled = 1
          AND ak.status IN ('healthy', 'unknown')
          AND (m.key_id IS NULL OR ak.id = m.key_id)
      )
    ORDER BY m.id
  `).all(platform) as Array<{ id: number }>;
  // Disabled models are intentionally included so a later successful probe can
  // restore their AUTO participation in the active profile.
  return rows.map(row => row.id);
}

export interface ProviderHealthSchedulerTickResult {
  kind: 'idle' | 'busy' | 'checked';
  platform?: string;
  keyCount?: number;
  modelCount?: number;
}

interface TickDependencies {
  now?: number;
  random?: () => number;
  dueSchedules?: ProviderHealthSchedule[];
  isBusy?: (now: number) => boolean;
  checkKeys?: typeof checkProviderKeys;
  probeModels?: typeof runModelProbes;
  modelTargets?: (platform: string) => number[];
  finishedAt?: () => number;
}

/** One inexpensive scheduler iteration. At most one provider is selected. */
export async function runProviderHealthSchedulerTick(
  dependencies: TickDependencies = {},
): Promise<ProviderHealthSchedulerTickResult> {
  const now = dependencies.now ?? Date.now();
  const random = dependencies.random ?? Math.random;
  const due = dependencies.dueSchedules ?? getDueProviderHealthSchedules(now);
  if (due.length === 0) return { kind: 'idle' };

  const busy = dependencies.isBusy ?? hasRecentCustomerTraffic;
  if (busy(now)) {
    postponeProviderHealthSchedules(due.map(schedule => schedule.platform), now);
    return { kind: 'busy' };
  }

  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(0.999999999999, Math.max(0, sample)) : 0;
  const selected = due[Math.floor(normalized * due.length)];
  const checkKeys = dependencies.checkKeys ?? checkProviderKeys;
  const probeModels = dependencies.probeModels ?? runModelProbes;
  const modelTargets = dependencies.modelTargets ?? getProviderModelProbeTargets;
  let keyCount = 0;
  let modelCount = 0;

  try {
    const keyResults = await checkKeys(selected.platform, 2);
    keyCount = keyResults.length;

    // Only a key that validated successfully (or is still explicitly unknown)
    // may back a model probe. Invalid/transport-error keys are excluded by the
    // target query, so key failures cannot be miscounted as model failures.
    if (keyCount > 0) {
      const targets = modelTargets(selected.platform);
      modelCount = targets.length;
      if (targets.length > 0) await probeModels(targets, 2);
    }
    markProbeRun();
    return { kind: 'checked', platform: selected.platform, keyCount, modelCount };
  } finally {
    const finishedAt = dependencies.finishedAt?.() ?? Date.now();
    markProviderHealthScheduleFinished(selected.platform, finishedAt, random);
  }
}

let cancelProviderHealthScheduler: (() => void) | null = null;
let scheduledRunInFlight: Promise<void> | null = null;

export function runScheduledProviderHealthChecks(): Promise<void> {
  if (scheduledRunInFlight) return scheduledRunInFlight;
  scheduledRunInFlight = runProviderHealthSchedulerTick()
    .then(result => {
      if (result.kind === 'checked') {
        console.log(
          `[ProviderHealth] ${result.platform}: checked ${result.keyCount ?? 0} key(s), ` +
          `${result.modelCount ?? 0} model route(s)`,
        );
      }
    })
    .catch(err => {
      console.error(`[ProviderHealth] scheduled provider check failed: ${err?.message ?? err}`);
    })
    .finally(() => {
      scheduledRunInFlight = null;
    });
  return scheduledRunInFlight;
}

export function startProviderHealthScheduler(scheduler: Scheduler): void {
  if (cancelProviderHealthScheduler) return;
  console.log(`[ProviderHealth] starting provider scheduler (tick ${PROVIDER_HEALTH_SCHEDULER_TICK_MS / 1000}s)`);
  cancelProviderHealthScheduler = scheduler.every(
    PROVIDER_HEALTH_SCHEDULER_TICK_MS,
    () => runScheduledProviderHealthChecks(),
  );
}

export function stopProviderHealthScheduler(): void {
  if (!cancelProviderHealthScheduler) return;
  cancelProviderHealthScheduler();
  cancelProviderHealthScheduler = null;
}

// Compatibility aliases while downstream imports migrate to the provider name.
export const startModelProbeScheduler = startProviderHealthScheduler;
export const stopModelProbeScheduler = stopProviderHealthScheduler;
export const runScheduledModelProbes = runScheduledProviderHealthChecks;
