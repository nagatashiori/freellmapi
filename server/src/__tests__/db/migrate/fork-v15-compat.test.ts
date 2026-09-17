import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { prepareForkV15MigrationTracking } from '../../../db/migrate/fork-v15-compat.js';

function seedMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const insert = db.prepare('INSERT INTO migrations (filename) VALUES (?)');
  insert.run('20260716_000001_routing_profile_source.ts');
  insert.run('20260808_000002_api_key_model_scope.ts');
  insert.run('20260808_000003_model_endpoint_scope.ts');
}

describe('v15 -> official v0.11 migration compatibility', () => {
  it('reuses official migration identities and converts named endpoints/unify data', () => {
    const db = new Database(':memory:');
    try {
      runLegacyBaseline(db);
      seedMigrationTable(db);

      // Minimal shape produced by the fork migrations that overlap official
      // v0.11 migrations under different filenames.
      db.exec("ALTER TABLE api_keys ADD COLUMN model_scope_json TEXT");
      db.exec("ALTER TABLE models ADD COLUMN endpoint_scope TEXT NOT NULL DEFAULT ''");

      const aihubKey = Number(db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES ('aihub', 'AiHub', 'x', 'x', 'x', 'healthy', 1, NULL)
      `).run().lastInsertRowid);
      db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           monthly_token_budget, enabled, key_id, endpoint_scope)
        VALUES ('aihub', 'test-aihub', 'Test AiHub', 1, 1, 'Large', '', 1, NULL, '')
      `).run();

      const locedgeKey = Number(db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES ('locedge', 'LocEdge A', 'x', 'x', 'x', 'healthy', 1, 'https://relay.example.test/v1/')
      `).run().lastInsertRowid);
      db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           monthly_token_budget, enabled, key_id, endpoint_scope)
        VALUES ('locedge', 'relay-model', 'Relay Model', 2, 2, 'Medium', '', 1, NULL, '')
      `).run();

      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('model_unify_overrides', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify({
        merges: [{ into: 'Existing Group', keys: ['locedge:relay-model#abc'] }],
        splits: [{ member: 'aihub:test-aihub' }],
        manualMembers: [{
          member: 'locedge:relay-model#abc',
          targetCanonicalId: 'target-slug',
          targetGroupKey: 'target group',
          targetLabel: 'Target Group',
        }],
      }));

      prepareForkV15MigrationTracking(db);

      const migrationNames = new Set((db.prepare('SELECT filename FROM migrations').all() as Array<{ filename: string }>).map(row => row.filename));
      expect(migrationNames).toContain('20260714_000001_profile_chain_backfill.ts');
      expect(migrationNames).toContain('20260729_000001_custom_model_endpoint_identity.ts');
      expect(migrationNames).toContain('20260805_000001_key_model_scope.ts');

      expect(db.prepare('SELECT platform, base_url FROM api_keys WHERE id = ?').get(aihubKey)).toEqual({
        platform: 'custom',
        base_url: 'https://aihub.071129.xyz/v1',
      });
      expect(db.prepare('SELECT platform, base_url FROM api_keys WHERE id = ?').get(locedgeKey)).toEqual({
        platform: 'custom',
        base_url: 'https://relay.example.test/v1',
      });

      expect(db.prepare("SELECT platform, endpoint_scope, key_id FROM models WHERE model_id = 'test-aihub'").get()).toEqual({
        platform: 'custom',
        endpoint_scope: 'https://aihub.071129.xyz/v1',
        key_id: aihubKey,
      });
      expect(db.prepare("SELECT platform, endpoint_scope, key_id FROM models WHERE model_id = 'relay-model'").get()).toEqual({
        platform: 'custom',
        endpoint_scope: 'https://relay.example.test/v1',
        key_id: locedgeKey,
      });

      const setting = db.prepare("SELECT value FROM settings WHERE key = 'model_unify_overrides'").get() as { value: string };
      const overrides = JSON.parse(setting.value) as {
        merges: Array<{ into: string; keys: string[] }>;
        splits: Array<{ member: string }>;
        manualMembers?: unknown;
      };
      expect(overrides.manualMembers).toBeUndefined();
      expect(overrides.merges).toContainEqual({
        into: 'Existing Group',
        keys: ['custom:relay-model#relay.example.test-v1'],
      });
      expect(overrides.merges).toContainEqual({
        into: 'Target Group',
        keys: ['custom:relay-model#relay.example.test-v1'],
      });
      expect(overrides.splits).toContainEqual({
        member: 'custom:test-aihub#aihub.071129.xyz-v1',
      });

      // Idempotent: startup/status repair may be invoked again.
      expect(() => prepareForkV15MigrationTracking(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
