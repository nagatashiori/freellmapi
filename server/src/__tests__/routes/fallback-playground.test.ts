import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getDefaultProfileId } from '../../services/routing-groups.js';
import { mintDashboardToken } from '../helpers/auth.js';

describe('Playground fallback model source', () => {
  let app: Express;
  let dashboardToken = '';
  let activeModelDbId = 0;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashboardToken = mintDashboardToken();

    const db = getDb();
    const defaultProfileId = getDefaultProfileId(db);
    const profileId = Number(db.prepare(`
      INSERT INTO profiles (name, emoji, color, type, sort_order)
      VALUES ('playground-active', '', '#000000', 'custom', 999)
    `).run().lastInsertRowid);
    const secret = encrypt('playground-active-key');
    const platform = 'playground-active-provider';
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'playground', ?, ?, ?, 'healthy', 1)
    `).run(platform, secret.encrypted, secret.iv, secret.authTag);
    activeModelDbId = Number(db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
      VALUES (?, 'playground-active-model', 'Playground Active Model', 1, 1, 'Small', 1)
    `).run(platform).lastInsertRowid);
    db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      VALUES (?, ?, 1, 1)
    `).run(profileId, activeModelDbId);
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(profileId));

    // Keep the default profile intentionally different. The Playground must
    // follow the profile used by Auto, not silently fall back to Default.
    expect(profileId).not.toBe(defaultProfileId);
  });

  it('returns active-profile models when profile=active is requested', async () => {
    const server = app.listen(0);
    const address = server.address() as { port: number };
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/fallback?profile=active`, {
        headers: { Authorization: `Bearer ${dashboardToken}` },
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.map((row: { modelDbId: number }) => row.modelDbId)).toEqual([activeModelDbId]);
      expect(body[0]).toMatchObject({
        modelDbId: activeModelDbId,
        keyCount: 1,
        enabled: true,
        routingHealth: { usableKeyCount: 1 },
      });
    } finally {
      server.close();
    }
  });
});
