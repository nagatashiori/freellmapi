import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some(item => item.name === column);
}

/**
 * Add endpoint identity to model rows without changing model ids or routing
 * rows. SQLite cannot remove the old UNIQUE(platform, model_id) constraint in
 * place, so this migration rebuilds the three related tables in one transaction
 * and recreates the original foreign keys after the new models table exists.
 */
export function up(db: Db): void {
  if (hasColumn(db, 'models', 'endpoint_scope')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_models_identity
        ON models(platform, model_id, endpoint_scope);
      CREATE INDEX IF NOT EXISTS idx_models_endpoint_scope
        ON models(platform, model_id, endpoint_scope);
    `);
    return;
  }

  db.exec(`
    CREATE TABLE fallback_config_endpoint_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );
    INSERT INTO fallback_config_endpoint_scope (id, model_db_id, priority, enabled)
      SELECT id, model_db_id, priority, enabled FROM fallback_config;

    CREATE TABLE profile_models_endpoint_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      model_db_id INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, model_db_id)
    );
    INSERT INTO profile_models_endpoint_scope (id, profile_id, model_db_id, priority, enabled)
      SELECT id, profile_id, model_db_id, priority, enabled FROM profile_models;

    DROP TABLE fallback_config;
    DROP TABLE profile_models;

    CREATE TABLE models_endpoint_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      supports_tools INTEGER NOT NULL DEFAULT 1,
      paid_input_per_m REAL,
      paid_output_per_m REAL,
      key_id INTEGER,
      endpoint_scope TEXT NOT NULL DEFAULT '',
      UNIQUE(platform, model_id, endpoint_scope)
    );
    INSERT INTO models_endpoint_scope
      (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
       enabled, supports_vision, supports_tools, paid_input_per_m, paid_output_per_m,
       key_id, endpoint_scope)
    SELECT id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
           enabled, supports_vision, supports_tools, paid_input_per_m, paid_output_per_m,
           key_id, ''
      FROM models;
    DROP TABLE models;
    ALTER TABLE models_endpoint_scope RENAME TO models;

    -- Existing custom and user-defined platform rows keep the endpoint they
    -- were already bound to. Built-in provider rows remain unscoped.
    UPDATE models
       SET endpoint_scope = RTRIM(COALESCE((
         SELECT base_url FROM api_keys WHERE api_keys.id = models.key_id
       ), (
         SELECT base_url FROM api_keys
          WHERE api_keys.platform = models.platform
            AND api_keys.base_url IS NOT NULL
            AND TRIM(api_keys.base_url) != ''
          ORDER BY api_keys.id ASC
          LIMIT 1
       ), ''), '/')
     WHERE key_id IS NOT NULL OR EXISTS (
       SELECT 1 FROM api_keys
        WHERE api_keys.platform = models.platform
          AND api_keys.base_url IS NOT NULL
          AND TRIM(api_keys.base_url) != ''
     );

    CREATE INDEX idx_models_endpoint_scope
      ON models(platform, model_id, endpoint_scope);

    -- Recreate the original foreign keys after the model ids are stable.
    CREATE TABLE fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );
    INSERT INTO fallback_config (id, model_db_id, priority, enabled)
      SELECT id, model_db_id, priority, enabled
        FROM fallback_config_endpoint_scope;
    DROP TABLE fallback_config_endpoint_scope;

    CREATE TABLE profile_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, model_db_id)
    );
    INSERT INTO profile_models (id, profile_id, model_db_id, priority, enabled)
      SELECT id, profile_id, model_db_id, priority, enabled
        FROM profile_models_endpoint_scope;
    DROP TABLE profile_models_endpoint_scope;
  `);
}

/**
 * Remove endpoint identity while preserving only the first row for duplicate
 * legacy identities. Dependent routing rows for discarded duplicate rows are
 * filtered before the final foreign-key tables are recreated.
 */
export function down(db: Db): void {
  if (!hasColumn(db, 'models', 'endpoint_scope')) return;

  db.exec(`
    CREATE TABLE models_without_endpoint_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      supports_tools INTEGER NOT NULL DEFAULT 1,
      paid_input_per_m REAL,
      paid_output_per_m REAL,
      key_id INTEGER,
      UNIQUE(platform, model_id)
    );
    INSERT OR IGNORE INTO models_without_endpoint_scope
      (id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
       enabled, supports_vision, supports_tools, paid_input_per_m, paid_output_per_m, key_id)
    SELECT id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
           enabled, supports_vision, supports_tools, paid_input_per_m, paid_output_per_m, key_id
      FROM models
     ORDER BY CASE WHEN endpoint_scope = '' THEN 0 ELSE 1 END, id;

    CREATE TABLE fallback_config_without_endpoint_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );
    INSERT INTO fallback_config_without_endpoint_scope
      (id, model_db_id, priority, enabled)
      SELECT fc.id, fc.model_db_id, fc.priority, fc.enabled
        FROM fallback_config fc
       WHERE EXISTS (
         SELECT 1 FROM models_without_endpoint_scope kept
          WHERE kept.id = fc.model_db_id
       );

    CREATE TABLE profile_models_without_endpoint_scope (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      model_db_id INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, model_db_id)
    );
    INSERT INTO profile_models_without_endpoint_scope
      (id, profile_id, model_db_id, priority, enabled)
      SELECT pm.id, pm.profile_id, pm.model_db_id, pm.priority, pm.enabled
        FROM profile_models pm
       WHERE EXISTS (
         SELECT 1 FROM models_without_endpoint_scope kept
          WHERE kept.id = pm.model_db_id
       );

    DROP TABLE fallback_config;
    DROP TABLE profile_models;
    DROP TABLE models;
    ALTER TABLE models_without_endpoint_scope RENAME TO models;

    CREATE TABLE fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );
    INSERT INTO fallback_config (id, model_db_id, priority, enabled)
      SELECT id, model_db_id, priority, enabled
        FROM fallback_config_without_endpoint_scope;
    DROP TABLE fallback_config_without_endpoint_scope;

    CREATE TABLE profile_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, model_db_id)
    );
    INSERT INTO profile_models (id, profile_id, model_db_id, priority, enabled)
      SELECT id, profile_id, model_db_id, priority, enabled
        FROM profile_models_without_endpoint_scope;
    DROP TABLE profile_models_without_endpoint_scope;
  `);
}
