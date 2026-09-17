import type { Db } from '../types.js';
import { endpointHandle } from '../../lib/endpoint-scope.js';

// The pre-v0.11 local fork shipped a short, divergent migration line. The
// v0.11 official tree now implements most of those features under different
// migration filenames. Before the official runner decides what is pending we
// translate that old bookkeeping (and its user data) into the official shape.

const LEGACY_PROFILE_SOURCE = '20260716_000001_routing_profile_source.ts';
const LEGACY_MODEL_SCOPE = '20260808_000002_api_key_model_scope.ts';
const LEGACY_ENDPOINT_SCOPE = '20260808_000003_model_endpoint_scope.ts';

const OFFICIAL_PROFILE_BACKFILL = '20260714_000001_profile_chain_backfill.ts';
const OFFICIAL_ENDPOINT_IDENTITY = '20260729_000001_custom_model_endpoint_identity.ts';
const OFFICIAL_MODEL_SCOPE = '20260805_000001_key_model_scope.ts';

const AIHUB_BASE_URL = 'https://aihub.071129.xyz/v1';

function hasTable(db: Db, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function hasColumn(db: Db, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all() as Array<{ name: string }>)
    .some(row => row.name === column);
}

function wasApplied(db: Db, filename: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM migrations WHERE filename = ?').get(filename));
}

function markApplied(db: Db, filename: string): void {
  db.prepare('INSERT OR IGNORE INTO migrations (filename) VALUES (?)').run(filename);
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function firstKeyIdForEndpoint(db: Db, baseUrl: string): number | null {
  const row = db.prepare(`
    SELECT id FROM api_keys
     WHERE platform = 'custom' AND RTRIM(COALESCE(base_url, ''), '/') = ?
     ORDER BY id ASC LIMIT 1
  `).get(baseUrl) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Re-point routing rows when a legacy named-platform model collides with an
 * already-existing official custom row for the same endpoint/model. */
function mergeModelIdentity(db: Db, fromId: number, intoId: number): void {
  if (hasTable(db, 'fallback_config')) {
    const row = db.prepare('SELECT priority, enabled FROM fallback_config WHERE model_db_id = ?')
      .get(fromId) as { priority: number; enabled: number } | undefined;
    if (row) {
      db.prepare(`
        INSERT INTO fallback_config (model_db_id, priority, enabled)
        VALUES (?, ?, ?)
        ON CONFLICT(model_db_id) DO NOTHING
      `).run(intoId, row.priority, row.enabled);
      db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(fromId);
    }
  }

  if (hasTable(db, 'profile_models')) {
    const rows = db.prepare('SELECT profile_id, priority, enabled FROM profile_models WHERE model_db_id = ?')
      .all(fromId) as Array<{ profile_id: number; priority: number; enabled: number }>;
    const insert = db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, model_db_id) DO NOTHING
    `);
    for (const row of rows) insert.run(row.profile_id, intoId, row.priority, row.enabled);
    db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(fromId);
  }

  db.prepare('DELETE FROM models WHERE id = ?').run(fromId);
}

function rewriteMemberToken(token: string, endpoints: ReadonlyMap<string, string>): string {
  for (const [platform, baseUrl] of endpoints) {
    const prefix = `${platform}:`;
    if (token.toLowerCase().startsWith(prefix.toLowerCase())) {
      const legacyMember = token.slice(prefix.length);
      // A v15 custom/named-platform token may already carry a legacy endpoint
      // suffix. Replace it rather than stacking two '#...' qualifiers: official
      // v0.11 identifies the endpoint from the normalized base_url itself.
      const separator = legacyMember.lastIndexOf('#');
      const modelId = separator > 0 ? legacyMember.slice(0, separator) : legacyMember;
      return `custom:${modelId}#${endpointHandle(baseUrl)}`;
    }
  }
  return token;
}

/** Convert the v14/v15 manualMembers extension into official v0.11 merges. */
function migrateUnifyOverrides(db: Db, endpoints: ReadonlyMap<string, string>): void {
  if (!hasTable(db, 'settings')) return;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'model_unify_overrides'")
    .get() as { value: string } | undefined;
  if (!row) return;

  try {
    const raw = JSON.parse(row.value) as {
      merges?: Array<{ into?: unknown; keys?: unknown }>;
      splits?: Array<{ member?: unknown; groupKey?: unknown }>;
      manualMembers?: Array<{
        member?: unknown;
        targetCanonicalId?: unknown;
        targetGroupKey?: unknown;
        targetLabel?: unknown;
      }>;
    };

    const merges: Array<{ into: string; keys: string[] }> = [];
    for (const merge of Array.isArray(raw.merges) ? raw.merges : []) {
      if (typeof merge?.into !== 'string' || !Array.isArray(merge.keys)) continue;
      const keys = merge.keys
        .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
        .map(key => rewriteMemberToken(key, endpoints));
      if (keys.length > 0) merges.push({ into: merge.into, keys });
    }

    for (const manual of Array.isArray(raw.manualMembers) ? raw.manualMembers : []) {
      if (typeof manual?.member !== 'string' || manual.member.trim() === '') continue;
      const into = [manual.targetLabel, manual.targetGroupKey, manual.targetCanonicalId]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (!into) continue;
      const member = rewriteMemberToken(manual.member, endpoints);
      const existing = merges.find(merge => merge.into.trim().toLowerCase() === into.trim().toLowerCase());
      if (existing) {
        if (!existing.keys.includes(member)) existing.keys.push(member);
      } else {
        merges.push({ into, keys: [member] });
      }
    }

    const splits = (Array.isArray(raw.splits) ? raw.splits : [])
      .filter(split => typeof split?.member === 'string' && split.member.trim().length > 0)
      .map(split => ({
        member: rewriteMemberToken(split.member as string, endpoints),
        ...(typeof split.groupKey === 'string' && split.groupKey.trim() ? { groupKey: split.groupKey } : {}),
      }));

    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('model_unify_overrides', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify({ merges, splits }));
  } catch {
    // Keep a corrupt legacy setting untouched; official model-groups already
    // falls back safely, and migration must never block startup over UI state.
  }
}

/** v15 supported arbitrary named OpenAI-compatible platforms (plus AiHub as a
 * fixed first-class id). Official v0.11 models these as custom endpoints with
 * endpoint-scoped rows and multi-key pools. Convert the old representation in
 * place while preserving model ids and profile memberships. */
function migrateNamedCustomPlatforms(db: Db): Map<string, string> {
  const migrated = new Map<string, string>();
  if (!hasTable(db, 'api_keys') || !hasTable(db, 'models')) return migrated;

  const endpoints = new Map<string, string>();
  const rows = db.prepare(`
    SELECT platform, base_url
      FROM api_keys
     WHERE platform <> 'custom'
       AND base_url IS NOT NULL AND TRIM(base_url) <> ''
     ORDER BY id ASC
  `).all() as Array<{ platform: string; base_url: string }>;
  for (const row of rows) {
    if (!endpoints.has(row.platform)) endpoints.set(row.platform, normalizeBaseUrl(row.base_url));
  }

  const hasAiHub = Boolean(db.prepare("SELECT 1 FROM api_keys WHERE platform = 'aihub' LIMIT 1").get())
    || Boolean(db.prepare("SELECT 1 FROM models WHERE platform = 'aihub' LIMIT 1").get());
  if (hasAiHub && !endpoints.has('aihub')) endpoints.set('aihub', AIHUB_BASE_URL);

  for (const [platform, baseUrl] of endpoints) {
    migrated.set(platform, baseUrl);
    db.prepare(`
      UPDATE api_keys SET platform = 'custom', base_url = ? WHERE platform = ?
    `).run(baseUrl, platform);

    const anchorKeyId = firstKeyIdForEndpoint(db, baseUrl);
    const modelRows = db.prepare(`
      SELECT id, model_id FROM models WHERE platform = ? ORDER BY id ASC
    `).all(platform) as Array<{ id: number; model_id: string }>;

    for (const model of modelRows) {
      const existing = db.prepare(`
        SELECT id FROM models
         WHERE platform = 'custom' AND model_id = ?
           AND RTRIM(COALESCE(endpoint_scope, ''), '/') = ?
         ORDER BY id ASC LIMIT 1
      `).get(model.model_id, baseUrl) as { id: number } | undefined;

      if (existing && existing.id !== model.id) {
        mergeModelIdentity(db, model.id, existing.id);
        continue;
      }

      db.prepare(`
        UPDATE models
           SET platform = 'custom', endpoint_scope = ?,
               key_id = COALESCE(key_id, ?)
         WHERE id = ?
      `).run(baseUrl, anchorKeyId, model.id);
    }

    if (hasTable(db, 'model_overrides')) {
      const overrides = db.prepare(`
        SELECT model_id, overrides_json, updated_at FROM model_overrides WHERE platform = ?
      `).all(platform) as Array<{ model_id: string; overrides_json: string; updated_at: string }>;
      for (const override of overrides) {
        db.prepare(`
          INSERT INTO model_overrides (platform, model_id, overrides_json, updated_at)
          VALUES ('custom', ?, ?, ?)
          ON CONFLICT(platform, model_id) DO NOTHING
        `).run(override.model_id, override.overrides_json, override.updated_at);
      }
      db.prepare('DELETE FROM model_overrides WHERE platform = ?').run(platform);
    }
  }

  return migrated;
}

export function prepareForkV15MigrationTracking(db: Db): void {
  if (!hasTable(db, 'migrations')) return;

  const legacyProfile = wasApplied(db, LEGACY_PROFILE_SOURCE);
  const legacyScope = wasApplied(db, LEGACY_MODEL_SCOPE);
  const legacyEndpoint = wasApplied(db, LEGACY_ENDPOINT_SCOPE);
  if (!legacyProfile && !legacyScope && !legacyEndpoint) return;

  // Do the data conversion before official migrations run. Later official
  // migrations (notably models.source) then see the rows in their canonical
  // custom-endpoint shape and perform their normal backfills.
  const migratedPlatforms = migrateNamedCustomPlatforms(db);
  migrateUnifyOverrides(db, migratedPlatforms);

  // Equivalent schema work already happened under fork-specific filenames.
  // Mark only those official migrations whose re-execution would either be
  // destructive (profile backfill) or collide with an existing schema rebuild.
  if (legacyProfile) markApplied(db, OFFICIAL_PROFILE_BACKFILL);
  if (legacyEndpoint && hasColumn(db, 'models', 'endpoint_scope')) {
    markApplied(db, OFFICIAL_ENDPOINT_IDENTITY);
  }
  if (legacyScope && hasColumn(db, 'api_keys', 'model_scope_json')) {
    markApplied(db, OFFICIAL_MODEL_SCOPE);
  }
}
