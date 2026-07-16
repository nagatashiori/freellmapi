import { getDb, getSetting } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';
import { getModelGroups } from './model-groups.js';
import { getModelProbeHealth } from './model-health.js';
import { markProbeRun, runModelProbes } from './model-probe.js';
import { getDefaultProfileId } from './routing-groups.js';

export const DEFAULT_MODEL_PROBE_INTERVAL_MS = 30 * 60 * 1000;
export const MODEL_PROBE_SCHEDULER_TICK_MS = 60 * 1000;
const ACTIVE_GROUP_WINDOW_HOURS = 24;

function intervalMs(): number {
  const configured = Number.parseInt(getSetting('health_check_interval_ms') ?? '', 10);
  return Number.isFinite(configured) && configured >= 60_000
    ? configured
    : DEFAULT_MODEL_PROBE_INTERVAL_MS;
}

function toEpoch(value: string | null): number | null {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Only probe groups that real traffic used recently. A group may contain many
 * provider rows, but traffic to any member activates its whole group so the
 * next request has a measured fallback chain. This prevents a global catalog
 * sweep from consuming quota every 30 minutes.
 */
export function getScheduledProbeTargets(now = Date.now()): number[] {
  const db = getDb();
  const defaultProfileId = getDefaultProfileId(db);
  const enabledRows = db.prepare(`
    SELECT m.id, m.platform, m.model_id
    FROM models m
    JOIN profile_models pm
      ON pm.model_db_id = m.id AND pm.profile_id = ?
    WHERE m.enabled = 1 AND pm.enabled = 1
  `).all(defaultProfileId) as Array<{ id: number; platform: string; model_id: string }>;
  const enabledIds = new Set(enabledRows.map(row => row.id));
  if (enabledIds.size === 0) return [];

  const recentlyUsed = db.prepare(`
    SELECT DISTINCT m.id AS model_db_id
    FROM models m
    JOIN requests r
      ON r.platform = m.platform
     AND LOWER(r.model_id) = LOWER(m.model_id)
    WHERE r.request_type != 'probe'
      AND r.created_at > datetime('now', ?)
  `).all(`-${ACTIVE_GROUP_WINDOW_HOURS} hours`) as Array<{ model_db_id: number }>;
  const activeIds = new Set(recentlyUsed.map(row => row.model_db_id));
  if (activeIds.size === 0) return [];

  // Preserve the actually used row even if a legacy catalog row has no group
  // metadata; grouped siblings are added below when present.
  const groupTargets = new Set<number>([...activeIds].filter(id => enabledIds.has(id)));
  for (const group of getModelGroups()) {
    const active = group.members.some(member => activeIds.has(member.model_db_id));
    if (!active) continue;
    for (const member of group.members) {
      if (enabledIds.has(member.model_db_id)) groupTargets.add(member.model_db_id);
    }
  }

  const targetIds = [...groupTargets];
  const health = getModelProbeHealth(db, targetIds, now);
  const every = intervalMs();
  return targetIds.filter(modelDbId => {
    const last = toEpoch(health.get(modelDbId)?.lastProbedAt ?? null);
    return last == null || now - last >= every;
  });
}

let cancelScheduledProbes: (() => void) | null = null;
let scheduledRunInFlight: Promise<void> | null = null;

export function runScheduledModelProbes(): Promise<void> {
  if (scheduledRunInFlight) return scheduledRunInFlight;
  scheduledRunInFlight = (async () => {
    const targets = getScheduledProbeTargets();
    if (targets.length === 0) return;
    console.log(`[ModelProbe] probing ${targets.length} due provider route(s) from active logical groups`);
    const results = await runModelProbes(targets, 2);
    markProbeRun();
    const summary = results.reduce((acc, result) => {
      acc[result.status] = (acc[result.status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`[ModelProbe] scheduled probe complete: ${JSON.stringify(summary)}`);
  })().catch(err => {
    console.error('[ModelProbe] scheduled probe failed:', err?.message ?? err);
  }).finally(() => {
    scheduledRunInFlight = null;
  });
  return scheduledRunInFlight;
}

export function startModelProbeScheduler(scheduler: Scheduler): void {
  if (cancelScheduledProbes) return;
  console.log(`[ModelProbe] starting active-group scheduler (tick ${MODEL_PROBE_SCHEDULER_TICK_MS / 1000}s, default interval ${DEFAULT_MODEL_PROBE_INTERVAL_MS / 60_000}m)`);
  cancelScheduledProbes = scheduler.every(MODEL_PROBE_SCHEDULER_TICK_MS, () => runScheduledModelProbes());
}

export function stopModelProbeScheduler(): void {
  if (!cancelScheduledProbes) return;
  cancelScheduledProbes();
  cancelScheduledProbes = null;
}
