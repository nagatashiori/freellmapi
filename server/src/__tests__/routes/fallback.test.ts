import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { recordRateLimitHit } from '../../services/router.js';
import { setCooldown } from '../../services/ratelimit.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Fallback API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('GET /api/fallback returns fallback chain', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Should be sorted by priority
    for (let i = 1; i < body.length; i++) {
      expect(body[i].priority).toBeGreaterThanOrEqual(body[i - 1].priority);
    }
  });

  it('GET /api/fallback entries have expected fields', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const first = body[0];
    expect(first).toHaveProperty('modelDbId');
    expect(first).toHaveProperty('priority');
    expect(first).toHaveProperty('enabled');
    expect(first).toHaveProperty('platform');
    expect(first).toHaveProperty('displayName');
    expect(first).toHaveProperty('intelligenceRank');
    // contextWindow powers the dashboard catalog filter (#343); present even when
    // the catalog has no value for a model (null).
    expect(first).toHaveProperty('contextWindow');
  });

  it('GET /api/fallback keeps globally disabled models visible for management', async () => {
    const db = getDb();
    const target = db.prepare(`
      SELECT m.id, m.enabled AS model_enabled,
             pm.profile_id, pm.enabled AS profile_enabled
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
      WHERE m.enabled = 1
      ORDER BY pm.priority
      LIMIT 1
    `).get() as {
      id: number;
      model_enabled: number;
      profile_id: number;
      profile_enabled: number;
    };

    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(target.id);
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE profile_id = ? AND model_db_id = ?')
      .run(target.profile_id, target.id);

    try {
      const { status, body } = await request(app, 'GET', '/api/fallback');
      expect(status).toBe(200);
      expect(body.find((row: any) => row.modelDbId === target.id)).toMatchObject({
        modelDbId: target.id,
        enabled: false,
        routingHealth: { state: 'disabled' },
      });
    } finally {
      db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(target.model_enabled, target.id);
      db.prepare('UPDATE profile_models SET enabled = ? WHERE profile_id = ? AND model_db_id = ?')
        .run(target.profile_enabled, target.profile_id, target.id);
    }
  });

  it('GET /api/fallback/token-usage reports per-model chat usage for configured platforms', async () => {
    const db = getDb();
    const target = db.prepare(`
      SELECT id, platform, model_id FROM models
       WHERE platform = 'github' AND model_id = 'openai/gpt-4.1'
    `).get() as { id: number; platform: string; model_id: string };
    const other = db.prepare(`
      SELECT platform, model_id FROM models
       WHERE platform <> ?
       LIMIT 1
    `).get(target.platform) as { platform: string; model_id: string };
    const secret = encrypt('usage-test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'usage', ?, ?, ?, 'healthy', 1)
    `).run(target.platform, secret.encrypted, secret.iv, secret.authTag);
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
      VALUES (?, ?, NULL, 'success', 123, 45, 10, NULL, 'chat')
    `).run(target.platform, target.model_id);
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
      VALUES (?, ?, NULL, 'success', 1000, 1000, 10, NULL, 'chat')
    `).run(other.platform, other.model_id);
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
      VALUES (?, ?, NULL, 'success', 500, 500, 10, NULL, 'embedding')
    `).run(target.platform, target.model_id);

    const { status, body } = await request(app, 'GET', '/api/fallback/token-usage');

    expect(status).toBe(200);
    expect(body.totalUsed).toBe(168);
    const model = body.models.find((m: any) => m.modelDbId === target.id);
    expect(model).toMatchObject({
      platform: target.platform,
      modelId: target.model_id,
      used: 168,
    });
  });

  // Regression: GET /routing must always carry customWeights, even before the
  // user has saved any — the dashboard's custom-weight sliders dereference it
  // and a missing field white-screened the Fallback page.
  it('GET /api/fallback/routing always includes customWeights', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback/routing');
    expect(status).toBe(200);
    expect(body).toHaveProperty('strategy');
    expect(body).toHaveProperty('customWeights');
    for (const axis of ['reliability', 'speed', 'intelligence']) {
      expect(typeof body.customWeights[axis]).toBe('number');
    }
  });

  it('GET /api/fallback/penalty-inspector is empty when no model has active pressure', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback/penalty-inspector');
    expect(status).toBe(200);
    expect(body.lookbackMinutes).toBe(30);
    expect(body.rows).toEqual([]);
  });

  it('GET /api/fallback/penalty-inspector combines penalties, cooldowns and recent errors', async () => {
    const db = getDb();
    const target = db.prepare(`
      SELECT id, platform, model_id, display_name
        FROM models
       WHERE platform = 'groq' AND key_id IS NULL
       ORDER BY id
       LIMIT 1
    `).get() as { id: number; platform: string; model_id: string; display_name: string };
    const secret = encrypt('inspector-test-key');
    const keyId = Number(db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'inspector', ?, ?, ?, 'healthy', 1)
    `).run(target.platform, secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);

    recordRateLimitHit(target.id);
    recordRateLimitHit(target.id);
    setCooldown(target.platform, target.model_id, keyId, 60_000);
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, latency_ms, error)
      VALUES (?, ?, ?, 'error', 321, 'Groq API error 429: rate limit')
    `).run(target.platform, target.model_id, keyId);

    const { status, body } = await request(app, 'GET', '/api/fallback/penalty-inspector');
    expect(status).toBe(200);
    const row = body.rows.find((r: any) => r.modelDbId === target.id);
    expect(row).toBeDefined();
    expect(row.displayName).toBe(target.display_name);
    expect(row.reasons.sort()).toEqual(['cooldown', 'penalty', 'recent_errors']);
    expect(row.penalty.value).toBeGreaterThan(0);
    expect(row.penalty.hits).toBeGreaterThanOrEqual(2);
    expect(row.penalty.rateLimitFactor).toBeLessThan(1);
    expect(row.cooldowns).toHaveLength(1);
    expect(row.cooldowns[0]).toMatchObject({ keyId, keyLabel: 'inspector', keyStatus: 'healthy' });
    expect(row.cooldowns[0].expiresInMs).toBeGreaterThan(0);
    expect(row.recentErrorCount).toBe(1);
    expect(row.recentErrors[0]).toMatchObject({
      keyId,
      keyLabel: 'inspector',
      latencyMs: 321,
      error: 'Groq API error 429: rate limit',
    });
  });

  it('GET /api/fallback/penalty-inspector includes recent failures even without cooldowns', async () => {
    const db = getDb();
    const target = db.prepare(`
      SELECT id, platform, model_id
        FROM models
       WHERE platform != 'groq'
       ORDER BY id
       LIMIT 1
    `).get() as { id: number; platform: string; model_id: string };
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, latency_ms, error)
      VALUES (?, ?, NULL, 'error', 111, 'upstream 503 unavailable')
    `).run(target.platform, target.model_id);

    const { status, body } = await request(app, 'GET', '/api/fallback/penalty-inspector');
    expect(status).toBe(200);
    const row = body.rows.find((r: any) => r.modelDbId === target.id);
    expect(row).toBeDefined();
    expect(row.reasons).toEqual(['recent_errors']);
    expect(row.penalty.value).toBe(0);
    expect(row.cooldowns).toEqual([]);
    expect(row.recentErrorCount).toBe(1);
  });

  it('PUT /api/fallback/routing accepts the custom strategy with weights and persists them', async () => {
    const put = await request(app, 'PUT', '/api/fallback/routing', {
      strategy: 'custom',
      weights: { reliability: 50, speed: 30, intelligence: 20 },
    });
    expect(put.status).toBe(200);
    expect(put.body.strategy).toBe('custom');

    // Weights are renormalized to sum 1 and echoed back on the next GET.
    const { body } = await request(app, 'GET', '/api/fallback/routing');
    expect(body.strategy).toBe('custom');
    const w = body.customWeights;
    expect(w.reliability + w.speed + w.intelligence).toBeCloseTo(1, 5);
    expect(w.reliability).toBeCloseTo(0.5, 5);
    expect(w.speed).toBeCloseTo(0.3, 5);

    // Restore a neutral preset so later tests start clean.
    await request(app, 'PUT', '/api/fallback/routing', { strategy: 'balanced' });
  });

  it('PUT /api/fallback/routing rejects all-zero custom weights', async () => {
    const { status } = await request(app, 'PUT', '/api/fallback/routing', {
      strategy: 'custom',
      weights: { reliability: 0, speed: 0, intelligence: 0 },
    });
    expect(status).toBe(400);
    await request(app, 'PUT', '/api/fallback/routing', { strategy: 'balanced' });
  });

  it('PUT /api/fallback updates order', async () => {
    const { body: original } = await request(app, 'GET', '/api/fallback');

    // Reverse the order
    const reversed = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: original.length - i,
      enabled: e.enabled,
    }));

    const { status } = await request(app, 'PUT', '/api/fallback', reversed);
    expect(status).toBe(200);

    // Verify order changed
    const { body: after } = await request(app, 'GET', '/api/fallback');
    expect(after[0].modelDbId).toBe(original[original.length - 1].modelDbId);

    // Restore original order
    const restore = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: i + 1,
      enabled: e.enabled,
    }));
    await request(app, 'PUT', '/api/fallback', restore);
  });

  it('PUT /api/fallback updates the Default routing profile only', async () => {
    const db = getDb();
    const { body: original } = await request(app, 'GET', '/api/fallback');
    expect(original.length).toBeGreaterThan(1);

    // Ensure Default profile is active (the AUTO path).
    const profile = db.prepare("SELECT id FROM profiles WHERE LOWER(name) = 'default' LIMIT 1").get() as
      | { id: number }
      | undefined;
    expect(profile).toBeDefined();
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as
      | { value: string }
      | undefined;
    if (existing) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'active_profile_id'").run(String(profile!.id));
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)").run(String(profile!.id));
    }

    const target = original[0];
    const flipped = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: i === 0 ? 1 : e.priority + 1,
      // Flip the first entry's enabled flag so we can assert the profile write.
      enabled: i === 0 ? !e.enabled : e.enabled,
    }));

    const legacyBefore = db.prepare(
      'SELECT priority, enabled FROM fallback_config WHERE model_db_id = ?',
    ).get(target.modelDbId) as { priority: number; enabled: number };

    const { status } = await request(app, 'PUT', '/api/fallback', flipped);
    expect(status).toBe(200);

    const pm = db.prepare(
      'SELECT priority, enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?',
    ).get(profile!.id, target.modelDbId) as { priority: number; enabled: number };
    expect(pm).toBeDefined();
    expect(pm.priority).toBe(1);
    expect(pm.enabled).toBe(flipped[0].enabled ? 1 : 0);

    const legacyAfter = db.prepare(
      'SELECT priority, enabled FROM fallback_config WHERE model_db_id = ?',
    ).get(target.modelDbId) as { priority: number; enabled: number };
    expect(legacyAfter).toEqual(legacyBefore);

    // Restore original chain for later tests.
    const restore = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: i + 1,
      enabled: e.enabled,
    }));
    await request(app, 'PUT', '/api/fallback', restore);
  });

  it('POST /api/fallback/sort/intelligence sorts by cross-provider tier, then rank', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/intelligence');
    expect(status).toBe(200);

    const { body } = await request(app, 'GET', '/api/fallback');

    // intelligence_rank is per-provider, so the sort normalizes on the
    // cross-provider capability tier (size_label) first (issue #135).
    const tier: Record<string, number> = { Frontier: 1, Large: 2, Medium: 3, Small: 4 };
    const tierOf = (label: string) => tier[label] ?? 5;

    for (let i = 1; i < body.length; i++) {
      const prevTier = tierOf(body[i - 1].sizeLabel);
      const curTier = tierOf(body[i].sizeLabel);
      // Capability tier never decreases...
      expect(curTier).toBeGreaterThanOrEqual(prevTier);
      // ...and within the same tier, per-provider rank breaks the tie.
      if (curTier === prevTier) {
        expect(body[i].intelligenceRank).toBeGreaterThanOrEqual(body[i - 1].intelligenceRank);
      }
    }
  });

  it('intelligence sort never places a weaker tier above a Frontier model (#135)', async () => {
    await request(app, 'POST', '/api/fallback/sort/intelligence');
    const { body } = await request(app, 'GET', '/api/fallback');

    // The last Frontier model must come before the first non-Frontier model —
    // i.e. no "Intel #1 from a weaker provider" leaks above the frontier tier.
    const lastFrontier = body.map((m: any) => m.sizeLabel).lastIndexOf('Frontier');
    const firstNonFrontier = body.findIndex((m: any) => m.sizeLabel !== 'Frontier');
    if (lastFrontier !== -1 && firstNonFrontier !== -1) {
      expect(lastFrontier).toBeLessThan(firstNonFrontier);
    }
  });

  it('POST /api/fallback/sort/speed sorts by speed', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/speed');
    expect(status).toBe(200);

    const { body } = await request(app, 'GET', '/api/fallback');
    // Should be sorted ascending by speed rank
    for (let i = 1; i < body.length; i++) {
      expect(body[i].speedRank).toBeGreaterThanOrEqual(body[i - 1].speedRank);
    }
  });

  it('POST /api/fallback/sort/invalid returns 400', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/invalid');
    expect(status).toBe(400);
  });
});
