import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  mirrorFallbackConfigToActiveProfile,
  syncChainEntriesToActiveProfile,
  syncOneModelEnabledToActiveProfile,
} from '../../services/chain-sync.js';

describe('chain-sync', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function seedActiveProfile(profileId = 1) {
    const db = getDb();
    // profiles table is seeded by baseline; ensure Default exists and is active.
    const row = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId) as { id: number } | undefined;
    if (!row) {
      db.prepare("INSERT INTO profiles (id, name) VALUES (?, 'Default')").run(profileId);
    }
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as
      | { value: string }
      | undefined;
    if (existing) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'active_profile_id'").run(String(profileId));
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)").run(String(profileId));
    }
    return db;
  }

  function pickModel() {
    const db = getDb();
    return db.prepare('SELECT id FROM models ORDER BY id LIMIT 1').get() as { id: number };
  }

  it('syncChainEntriesToActiveProfile upserts priority+enabled into active profile', () => {
    const db = seedActiveProfile(1);
    const model = pickModel();

    // Stale profile row: different priority, disabled.
    db.prepare('DELETE FROM profile_models WHERE profile_id = 1 AND model_db_id = ?').run(model.id);
    db.prepare(
      'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (1, ?, 999, 0)',
    ).run(model.id);

    const touched = syncChainEntriesToActiveProfile(db, [
      { modelDbId: model.id, priority: 3, enabled: true },
    ]);
    expect(touched).toBe(1);

    const row = db.prepare(
      'SELECT priority, enabled FROM profile_models WHERE profile_id = 1 AND model_db_id = ?',
    ).get(model.id) as { priority: number; enabled: number };
    expect(row.priority).toBe(3);
    expect(row.enabled).toBe(1);
  });

  it('syncChainEntriesToActiveProfile inserts when profile row is missing', () => {
    const db = seedActiveProfile(1);
    const model = pickModel();
    db.prepare('DELETE FROM profile_models WHERE profile_id = 1 AND model_db_id = ?').run(model.id);

    syncChainEntriesToActiveProfile(db, [
      { modelDbId: model.id, priority: 7, enabled: false },
    ]);

    const row = db.prepare(
      'SELECT priority, enabled FROM profile_models WHERE profile_id = 1 AND model_db_id = ?',
    ).get(model.id) as { priority: number; enabled: number };
    expect(row.priority).toBe(7);
    expect(row.enabled).toBe(0);
  });

  it('syncChainEntriesToActiveProfile is a no-op without active_profile_id', () => {
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    const model = pickModel();
    const before = db.prepare(
      'SELECT COUNT(*) AS c FROM profile_models WHERE model_db_id = ?',
    ).get(model.id) as { c: number };

    const touched = syncChainEntriesToActiveProfile(db, [
      { modelDbId: model.id, priority: 1, enabled: true },
    ]);
    expect(touched).toBe(0);

    const after = db.prepare(
      'SELECT COUNT(*) AS c FROM profile_models WHERE model_db_id = ?',
    ).get(model.id) as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('syncOneModelEnabledToActiveProfile flips enabled and appends if missing', () => {
    const db = seedActiveProfile(1);
    const model = pickModel();
    db.prepare('DELETE FROM profile_models WHERE profile_id = 1 AND model_db_id = ?').run(model.id);

    syncOneModelEnabledToActiveProfile(db, model.id, true);
    let row = db.prepare(
      'SELECT enabled FROM profile_models WHERE profile_id = 1 AND model_db_id = ?',
    ).get(model.id) as { enabled: number };
    expect(row.enabled).toBe(1);

    syncOneModelEnabledToActiveProfile(db, model.id, false);
    row = db.prepare(
      'SELECT enabled FROM profile_models WHERE profile_id = 1 AND model_db_id = ?',
    ).get(model.id) as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('mirrorFallbackConfigToActiveProfile copies full fallback chain', () => {
    const db = seedActiveProfile(1);
    const models = db.prepare('SELECT id FROM models ORDER BY id LIMIT 3').all() as { id: number }[];
    expect(models.length).toBeGreaterThanOrEqual(2);

    // Wipe profile 1 and seed a contradictory fallback_config for these models.
    db.prepare('DELETE FROM profile_models WHERE profile_id = 1').run();
    for (const m of models) {
      db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(m.id);
    }
    models.forEach((m, i) => {
      db.prepare(
        'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)',
      ).run(m.id, (i + 1) * 10, i === 0 ? 1 : 0);
    });

    const touched = mirrorFallbackConfigToActiveProfile(db);
    expect(touched).toBeGreaterThanOrEqual(models.length);

    for (const [i, m] of models.entries()) {
      const pm = db.prepare(
        'SELECT priority, enabled FROM profile_models WHERE profile_id = 1 AND model_db_id = ?',
      ).get(m.id) as { priority: number; enabled: number };
      expect(pm.priority).toBe((i + 1) * 10);
      expect(pm.enabled).toBe(i === 0 ? 1 : 0);
    }
  });
});
