import type { Db } from '../db/types.js';

export interface RoutingChainEntry {
  modelDbId: number;
  priority: number;
  enabled: boolean | number;
}

export interface RoutingChainRow {
  model_db_id: number;
  priority: number;
  enabled: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  speed_rank?: number;
  size_label: string;
  monthly_token_budget: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  supports_vision: number;
  supports_tools: number;
  context_window: number | null;
  key_id: number | null;
}

function profileExists(db: Db, profileId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId));
}

export function getDefaultProfileId(db: Db): number {
  const profile = db.prepare(`
    SELECT id
    FROM profiles
    WHERE type = 'default' OR LOWER(name) = 'default'
    ORDER BY CASE WHEN type = 'default' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).get() as { id: number } | undefined;

  if (!profile) throw new Error('Default routing profile is missing');
  return profile.id;
}

export function getActiveRoutingProfileId(db: Db): number {
  const setting = db.prepare(
    "SELECT value FROM settings WHERE key = 'active_profile_id'",
  ).get() as { value: string } | undefined;
  const configured = setting ? Number.parseInt(setting.value, 10) : NaN;
  if (Number.isInteger(configured) && profileExists(db, configured)) return configured;
  return getDefaultProfileId(db);
}

export function getRoutingProfileIdByName(db: Db, name: string): number | null {
  const profile = db.prepare(
    'SELECT id FROM profiles WHERE LOWER(name) = LOWER(?) LIMIT 1',
  ).get(name.trim()) as { id: number } | undefined;
  return profile?.id ?? null;
}

export function getRoutingChain(db: Db, profileId: number): RoutingChainRow[] {
  return db.prepare(`
    SELECT pm.model_db_id, pm.priority, pm.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
           m.supports_vision, m.supports_tools, m.context_window, m.key_id
    FROM profile_models pm
    JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
    WHERE pm.profile_id = ?
    ORDER BY pm.priority ASC, pm.model_db_id ASC
  `).all(profileId) as RoutingChainRow[];
}

export function getActiveRoutingChain(db: Db): RoutingChainRow[] {
  return getRoutingChain(db, getActiveRoutingProfileId(db));
}

export function getDefaultRoutingChain(db: Db): RoutingChainRow[] {
  return getRoutingChain(db, getDefaultProfileId(db));
}

/**
 * Update/insert the supplied entries without deleting globally-disabled models
 * omitted by the dashboard catalog response.
 */
export function upsertRoutingEntries(db: Db, profileId: number, entries: RoutingChainEntry[]): number {
  if (!profileExists(db, profileId)) throw new Error(`Routing profile ${profileId} not found`);

  const update = db.prepare(`
    UPDATE profile_models
    SET priority = ?, enabled = ?
    WHERE profile_id = ? AND model_db_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    VALUES (?, ?, ?, ?)
  `);

  const apply = db.transaction(() => {
    let touched = 0;
    for (const entry of entries) {
      const enabled = entry.enabled ? 1 : 0;
      const result = update.run(entry.priority, enabled, profileId, entry.modelDbId);
      if (result.changes === 0) {
        insert.run(profileId, entry.modelDbId, entry.priority, enabled);
      }
      touched++;
    }
    return touched;
  });
  return apply();
}

/** Replace a named routing group's complete membership and order. */
export function replaceRoutingChain(db: Db, profileId: number, entries: RoutingChainEntry[]): number {
  if (!profileExists(db, profileId)) throw new Error(`Routing profile ${profileId} not found`);

  const replace = db.transaction(() => {
    db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profileId);
    const insert = db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      VALUES (?, ?, ?, ?)
    `);
    for (const entry of entries) {
      insert.run(profileId, entry.modelDbId, entry.priority, entry.enabled ? 1 : 0);
    }
    return entries.length;
  });
  return replace();
}

export function ensureModelInProfile(db: Db, profileId: number, modelDbId: number, enabled: boolean | number = 1): void {
  if (!profileExists(db, profileId)) throw new Error(`Routing profile ${profileId} not found`);

  const exists = db.prepare(
    'SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?',
  ).get(profileId, modelDbId);
  if (exists) return;

  const max = db.prepare(`
    SELECT COALESCE(MAX(priority), 0) AS priority
    FROM profile_models WHERE profile_id = ?
  `).get(profileId) as { priority: number };
  db.prepare(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    VALUES (?, ?, ?, ?)
  `).run(profileId, modelDbId, max.priority + 1, enabled ? 1 : 0);
}

export function setRoutingModelEnabled(
  db: Db,
  profileId: number,
  modelDbId: number,
  enabled: boolean | number,
): void {
  if (!profileExists(db, profileId)) throw new Error(`Routing profile ${profileId} not found`);

  const flag = enabled ? 1 : 0;
  const result = db.prepare(`
    UPDATE profile_models SET enabled = ?
    WHERE profile_id = ? AND model_db_id = ?
  `).run(flag, profileId, modelDbId);

  if (result.changes === 0) {
    ensureModelInProfile(db, profileId, modelDbId, flag);
  }
}

export function setDefaultRoutingModelEnabled(db: Db, modelDbId: number, enabled: boolean | number): void {
  setRoutingModelEnabled(db, getDefaultProfileId(db), modelDbId, enabled);
}

export function deleteRoutingModelMemberships(db: Db, modelDbId: number): void {
  db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(modelDbId);
}
