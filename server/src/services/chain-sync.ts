/**
 * Keep the AUTO routing chain (profile_models for active_profile_id) in lockstep
 * with the manual chain the dashboard edits (fallback_config).
 *
 * Without this, PUT /api/fallback only mutates fallback_config while
 * resolveRoutingChain('auto') reads profile_models — so toggles/order on
 * /models/chat never affect auto, and disabled "garbage" models keep getting
 * selected after cooldowns push higher rows out of the way.
 */
import type { Db } from '../db/types.js';

export type ChainEntry = {
  modelDbId: number;
  priority: number;
  enabled: boolean | number;
};

function resolveActiveProfileId(db: Db): number | null {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as
    | { value: string }
    | undefined;
  if (!setting) return null;
  const profileId = parseInt(setting.value, 10);
  if (!Number.isInteger(profileId)) return null;
  const exists = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId);
  return exists ? profileId : null;
}

function asFlag(enabled: boolean | number): number {
  return enabled ? 1 : 0;
}

/**
 * Upsert priority + enabled for each entry into the active profile's
 * profile_models. No-op when no active profile is configured (AUTO then
 * already reads fallback_config directly).
 *
 * Must be called inside the caller's transaction when the caller has one.
 */
export function syncChainEntriesToActiveProfile(db: Db, entries: ChainEntry[]): number {
  const profileId = resolveActiveProfileId(db);
  if (profileId == null || entries.length === 0) return 0;

  const update = db.prepare(
    'UPDATE profile_models SET priority = ?, enabled = ? WHERE profile_id = ? AND model_db_id = ?',
  );
  const insert = db.prepare(
    'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)',
  );

  let touched = 0;
  for (const entry of entries) {
    const flag = asFlag(entry.enabled);
    const result = update.run(entry.priority, flag, profileId, entry.modelDbId);
    if (result.changes === 0) {
      insert.run(profileId, entry.modelDbId, entry.priority, flag);
    }
    touched++;
  }
  return touched;
}

/** Sync a single model's enabled flag into the active profile chain. */
export function syncOneModelEnabledToActiveProfile(db: Db, modelDbId: number, enabled: boolean | number): void {
  const profileId = resolveActiveProfileId(db);
  if (profileId == null) return;

  const flag = asFlag(enabled);
  const result = db.prepare(
    'UPDATE profile_models SET enabled = ? WHERE profile_id = ? AND model_db_id = ?',
  ).run(flag, profileId, modelDbId);

  if (result.changes === 0) {
    // Model was never in the active profile — append at the tail so a future
    // enable still participates in AUTO instead of being silently dropped.
    const max = db.prepare(
      'SELECT COALESCE(MAX(priority), 0) AS m FROM profile_models WHERE profile_id = ?',
    ).get(profileId) as { m: number };
    db.prepare(
      'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)',
    ).run(profileId, modelDbId, max.m + 1, flag);
  }
}

/**
 * Mirror the entire current fallback_config table into the active profile.
 * Used after bulk priority rewrites (sort presets) where only fallback_config
 * was rewritten and the profile would otherwise keep a stale order.
 */
export function mirrorFallbackConfigToActiveProfile(db: Db): number {
  const rows = db.prepare(
    'SELECT model_db_id AS modelDbId, priority, enabled FROM fallback_config ORDER BY priority ASC',
  ).all() as ChainEntry[];
  return syncChainEntriesToActiveProfile(db, rows);
}
