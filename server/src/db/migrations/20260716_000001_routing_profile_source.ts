import type { Db } from '../types.js';

const SOURCE_VERSION_KEY = 'routing_profile_source_version';

/**
 * Promote profile_models to the single routing source while keeping the legacy
 * fallback_config table intact for rollback. The migration only fills missing
 * Default-profile rows; it never overwrites the profile order already curated
 * in production.
 */
export function up(db: Db): void {
  const defaultProfile = db.prepare(`
    SELECT id
    FROM profiles
    WHERE type = 'default' OR LOWER(name) = 'default'
    ORDER BY CASE WHEN type = 'default' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `).get() as { id: number } | undefined;

  if (!defaultProfile) throw new Error('Cannot promote routing profiles: Default profile is missing');

  db.prepare(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    SELECT ?, fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    LEFT JOIN profile_models pm
      ON pm.profile_id = ? AND pm.model_db_id = fc.model_db_id
    WHERE pm.model_db_id IS NULL
    ORDER BY fc.priority ASC
  `).run(defaultProfile.id, defaultProfile.id);

  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SOURCE_VERSION_KEY);

  const active = db.prepare(
    "SELECT value FROM settings WHERE key = 'active_profile_id'",
  ).get() as { value: string } | undefined;
  const activeId = active ? Number.parseInt(active.value, 10) : NaN;
  const activeExists = Number.isInteger(activeId)
    ? db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(activeId)
    : undefined;
  if (!activeExists) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(defaultProfile.id));
  }
}

export function down(db: Db): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(SOURCE_VERSION_KEY);
}
