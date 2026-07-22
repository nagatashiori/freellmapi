import type { Db } from '../db/types.js';
import type { ModelGroup } from './model-groups.js';

export const PROBE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type ModelRoutingState =
  | 'ready'
  | 'cooling'
  | 'stale'
  | 'unknown'
  | 'unhealthy'
  | 'disabled';

export interface ModelProbeHealth {
  lastStatus: string | null;
  lastProbedAt: string | null;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  sampleCount: number;
  cooldownUntilMs: number | null;
  usableKeyCount: number;
  coolingKeyCount: number;
}

export interface ModelRoutingCandidate {
  model_db_id: number;
  priority: number;
  enabled: number | boolean;
}

function parseDbTime(value: string | null): number | null {
  if (!value) return null;
  // SQLite datetime('now') has no timezone suffix but is UTC. Appending Z
  // avoids interpreting it as the server's local timezone.
  const iso = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Runtime state is deliberately separate from the operator's enabled switch:
 * probes describe whether a model is currently fit to lead a group, while the
 * switch still expresses whether the operator permits routing to it at all.
 */
export function getModelRoutingState(
  health: ModelProbeHealth | undefined,
  operatorEnabled: boolean,
  now = Date.now(),
): ModelRoutingState {
  if (!operatorEnabled) return 'disabled';
  if (!health) return 'unknown';
  if (health.usableKeyCount <= 0) return 'unhealthy';

  if (
    health.usableKeyCount > 0
    && health.coolingKeyCount >= health.usableKeyCount
    && health.cooldownUntilMs != null
    && health.cooldownUntilMs > now
  ) return 'cooling';

  const lastProbeMs = parseDbTime(health.lastProbedAt);
  if (health.lastStatus === 'ok' || health.lastStatus === 'success') {
    return lastProbeMs != null && now - lastProbeMs <= PROBE_STALE_AFTER_MS
      ? 'ready'
      : 'stale';
  }

  // A limit result whose actual cooldown has already elapsed must not remain
  // permanently yellow. It is eligible for the next scheduled probe/attempt.
  if (health.lastStatus === 'rate_limited') return 'stale';
  if (health.lastStatus === 'error' || health.lastStatus === 'timeout') return 'unhealthy';
  return 'unknown';
}

const STATE_ORDER: Record<ModelRoutingState, number> = {
  ready: 0,
  cooling: 1,
  stale: 2,
  unknown: 3,
  unhealthy: 4,
  disabled: 5,
};

/**
 * Effective ordering for one logical model group. It never writes profile
 * priority: manual priority is retained as a tie-breaker and for every state
 * where latency is not meaningful. A cooled route remains visible immediately
 * after ready routes, rather than looking like it disappeared from the group.
 */
export function rankModelGroupCandidates<T extends ModelRoutingCandidate>(
  rows: readonly T[],
  healthByModelId: ReadonlyMap<number, ModelProbeHealth>,
  now = Date.now(),
): T[] {
  return rows
    .map((row, index) => ({
      row,
      index,
      health: healthByModelId.get(row.model_db_id),
      state: getModelRoutingState(healthByModelId.get(row.model_db_id), Boolean(row.enabled), now),
    }))
    .sort((a, b) => {
      const stateDiff = STATE_ORDER[a.state] - STATE_ORDER[b.state];
      if (stateDiff !== 0) return stateDiff;

      if (a.state === 'ready') {
        const aLatency = a.health?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
        const bLatency = b.health?.avgLatencyMs ?? Number.MAX_SAFE_INTEGER;
        if (aLatency !== bLatency) return aLatency - bLatency;
      }
      if (a.state === 'cooling') {
        const aUntil = a.health?.cooldownUntilMs ?? Number.MAX_SAFE_INTEGER;
        const bUntil = b.health?.cooldownUntilMs ?? Number.MAX_SAFE_INTEGER;
        if (aUntil !== bUntil) return aUntil - bUntil;
      }
      return a.index - b.index;
    })
    .map(item => item.row);
}

/**
 * Expand an already ordered AUTO chain as logical model units. The outer unit
 * order is preserved exactly; only equivalent provider members inside one
 * logical group are reordered by runtime health and successful latency.
 */
export function orderLogicalModelGroupCandidates<T extends ModelRoutingCandidate>(
  orderedRows: readonly T[],
  groups: readonly ModelGroup[],
  healthByModelId: ReadonlyMap<number, ModelProbeHealth>,
  now = Date.now(),
): T[] {
  if (orderedRows.length < 2) return [...orderedRows];

  const groupKeyByModelId = new Map<number, string>();
  for (const group of groups) {
    for (const member of group.members) groupKeyByModelId.set(member.model_db_id, group.groupKey);
  }

  const units = new Map<string, T[]>();
  for (const row of orderedRows) {
    const groupKey = groupKeyByModelId.get(row.model_db_id);
    const unitKey = groupKey == null ? `model:${row.model_db_id}` : `group:${groupKey}`;
    const rows = units.get(unitKey);
    if (rows) rows.push(row);
    else units.set(unitKey, [row]);
  }

  const result: T[] = [];
  for (const rows of units.values()) {
    if (rows.length === 1) {
      result.push(rows[0]);
      continue;
    }
    const manualOrder = [...rows].sort((a, b) => a.priority - b.priority || a.model_db_id - b.model_db_id);
    result.push(...rankModelGroupCandidates(manualOrder, healthByModelId, now));
  }
  return result;
}

/**
 * One batched DB read shape per model. The requests table is the durable probe
 * history; rate_limit_cooldowns tells us whether every usable key for this
 * provider/model is currently benched. This lets the UI and strict group
 * router use the exact same state without mutating manual profile settings.
 */
export function getModelProbeHealth(db: Db, modelDbIds: readonly number[], now = Date.now()): Map<number, ModelProbeHealth> {
  const ids = [...new Set(modelDbIds.filter(Number.isInteger))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      m.id AS model_db_id,
      (
        SELECT r.status
        FROM requests r
        WHERE r.request_type = 'probe'
          AND r.platform = m.platform
          AND LOWER(r.model_id) = LOWER(m.model_id)
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1
      ) AS last_status,
      (
        SELECT r.created_at
        FROM requests r
        WHERE r.request_type = 'probe'
          AND r.platform = m.platform
          AND LOWER(r.model_id) = LOWER(m.model_id)
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1
      ) AS last_probed_at,
      (
        SELECT r.latency_ms
        FROM requests r
        WHERE r.request_type = 'probe'
          AND r.platform = m.platform
          AND LOWER(r.model_id) = LOWER(m.model_id)
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 1
      ) AS last_latency_ms,
      (
        SELECT AVG(r.latency_ms)
        FROM requests r
        WHERE r.request_type = 'probe'
          AND r.status IN ('ok', 'success')
          AND r.platform = m.platform
          AND LOWER(r.model_id) = LOWER(m.model_id)
          AND r.created_at > datetime('now', '-24 hours')
      ) AS avg_latency_ms,
      (
        SELECT COUNT(*)
        FROM requests r
        WHERE r.request_type = 'probe'
          AND r.status IN ('ok', 'success')
          AND r.platform = m.platform
          AND LOWER(r.model_id) = LOWER(m.model_id)
          AND r.created_at > datetime('now', '-24 hours')
      ) AS sample_count,
      (
        SELECT COUNT(*)
        FROM api_keys ak
        WHERE ak.platform = m.platform
          AND ak.enabled = 1
          AND ak.status IN ('healthy', 'unknown')
          AND (m.platform != 'custom' OR m.key_id IS NULL OR ak.id = m.key_id)
      ) AS usable_key_count,
      (
        SELECT COUNT(*)
        FROM api_keys ak
        JOIN rate_limit_cooldowns rc
          ON rc.key_id = ak.id
         AND rc.platform = m.platform
         AND LOWER(rc.model_id) = LOWER(m.model_id)
         AND rc.expires_at_ms > ?
        WHERE ak.platform = m.platform
          AND ak.enabled = 1
          AND ak.status IN ('healthy', 'unknown')
          AND (m.platform != 'custom' OR m.key_id IS NULL OR ak.id = m.key_id)
      ) AS cooling_key_count,
      (
        SELECT MIN(rc.expires_at_ms)
        FROM api_keys ak
        JOIN rate_limit_cooldowns rc
          ON rc.key_id = ak.id
         AND rc.platform = m.platform
         AND LOWER(rc.model_id) = LOWER(m.model_id)
         AND rc.expires_at_ms > ?
        WHERE ak.platform = m.platform
          AND ak.enabled = 1
          AND ak.status IN ('healthy', 'unknown')
          AND (m.platform != 'custom' OR m.key_id IS NULL OR ak.id = m.key_id)
      ) AS cooldown_until_ms
    FROM models m
    WHERE m.id IN (${placeholders})
  `).all(now, now, ...ids) as Array<{
    model_db_id: number;
    last_status: string | null;
    last_probed_at: string | null;
    last_latency_ms: number | null;
    avg_latency_ms: number | null;
    sample_count: number;
    cooldown_until_ms: number | null;
    usable_key_count: number;
    cooling_key_count: number;
  }>;

  return new Map(rows.map(row => [row.model_db_id, {
    lastStatus: row.last_status,
    lastProbedAt: row.last_probed_at,
    lastLatencyMs: row.last_latency_ms,
    avgLatencyMs: row.avg_latency_ms == null ? null : Math.round(row.avg_latency_ms),
    sampleCount: Number(row.sample_count) || 0,
    cooldownUntilMs: row.cooldown_until_ms == null ? null : Number(row.cooldown_until_ms),
    usableKeyCount: Number(row.usable_key_count) || 0,
    coolingKeyCount: Number(row.cooling_key_count) || 0,
  }]));
}
