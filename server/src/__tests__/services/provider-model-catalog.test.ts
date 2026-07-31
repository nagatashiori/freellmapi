import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { providerModelCatalog } from '../../services/provider-model-catalog.js';
import { getDefaultProfileId } from '../../services/routing-groups.js';

function insertKey(
  platform: string,
  key: string,
  opts: { label?: string; baseUrl?: string; enabled?: boolean; status?: string } = {},
): number {
  const encrypted = encrypt(key);
  const result = getDb().prepare(`
    INSERT INTO api_keys
      (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform,
    opts.label ?? platform,
    encrypted.encrypted,
    encrypted.iv,
    encrypted.authTag,
    opts.status ?? 'healthy',
    opts.enabled === false ? 0 : 1,
    opts.baseUrl ?? null,
  );
  return Number(result.lastInsertRowid);
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
}

describe('provider model catalog service', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM profile_models WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'catalog-refactor-%')").run();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE model_id LIKE 'catalog-refactor-%')").run();
    db.prepare("DELETE FROM models WHERE model_id LIKE 'catalog-refactor-%'").run();
    db.prepare("DELETE FROM catalog_model_tombstones WHERE model_id LIKE 'catalog-refactor-%'").run();
    db.prepare('DELETE FROM api_keys').run();
  });

  it('exposes separate custom discovery sources instead of collapsing endpoints', () => {
    insertKey('custom', 'key-a', { label: 'Local A', baseUrl: 'http://127.0.0.1:6101/v1' });
    insertKey('custom', 'key-b', { label: 'Local B', baseUrl: 'http://127.0.0.1:6102/v1' });

    const custom = providerModelCatalog.listSources(getDb()).filter(source => source.platform === 'custom');
    expect(custom).toHaveLength(2);
    expect(new Set(custom.map(source => source.sourceId)).size).toBe(2);
    expect(custom.map(source => source.listUrl).sort()).toEqual([
      'http://127.0.0.1:6101/v1/models',
      'http://127.0.0.1:6102/v1/models',
    ]);
  });

  it('treats multiple keys for the same custom endpoint as one local source', () => {
    insertKey('custom', 'key-a', { label: 'Local A', baseUrl: 'http://127.0.0.1:6101/v1' });
    const secondKey = insertKey('custom', 'key-b', { label: 'Local B', baseUrl: 'http://127.0.0.1:6101/v1' });

    const modelId = 'catalog-refactor-same-endpoint';
    const info = getDb().prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, key_id)
      VALUES ('custom', ?, ?, 30, 35, 'medium', 0, ?)
    `).run(modelId, modelId, secondKey);
    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 9999, 0)')
      .run(Number(info.lastInsertRowid));

    const sources = providerModelCatalog.listSources(getDb()).filter(source => source.platform === 'custom');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.modelCount).toBe(1);
    expect(providerModelCatalog.listLocal(getDb(), sources[0]!.sourceId).models.map(model => model.id))
      .toContain(modelId);
  });

  it('does not offer a custom model that is already bound to another endpoint', async () => {
    const firstKey = insertKey('custom', 'key-a', { label: 'Local A', baseUrl: 'http://127.0.0.1:6101/v1' });
    insertKey('custom', 'key-b', { label: 'Local B', baseUrl: 'http://127.0.0.1:6102/v1' });
    const sources = providerModelCatalog.listSources(getDb()).filter(source => source.platform === 'custom');
    const first = sources.find(source => source.label === 'Local A');
    const second = sources.find(source => source.label === 'Local B');
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const modelId = 'catalog-refactor-shared-custom';
    const info = getDb().prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, key_id)
      VALUES ('custom', ?, ?, 30, 35, 'medium', 0, ?)
    `).run(modelId, modelId, firstKey);
    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 9999, 0)')
      .run(Number(info.lastInsertRowid));

    const discovered = await providerModelCatalog.discoverRemote(getDb(), second!.sourceId, jsonFetch({ data: [{ id: modelId }] }));
    expect(discovered.models[0]).toMatchObject({ alreadyRegistered: true, existsOtherSource: true });
    expect(providerModelCatalog.importMissing(getDb(), second!.sourceId, [modelId])).toMatchObject({ added: 0, skipped: 1 });
  });

  it('parses Google model names and strips the models/ prefix', async () => {
    insertKey('google', 'google-test-key');

    const result = await providerModelCatalog.discoverRemote(getDb(), 'platform:google', jsonFetch({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        { name: 'models/gemma-3-27b-it', displayName: 'Gemma 3 27B' },
      ],
    }));

    expect(result.remoteState).toBe('ok');
    expect(result.models.map(model => model.id)).toEqual(['gemini-2.5-flash', 'gemma-3-27b-it']);
    expect(result.listUrl).not.toContain('google-test-key');
    expect(result.listUrl).toContain('%5Bredacted%5D');

    const source = providerModelCatalog.listSources(getDb()).find(item => item.platform === 'google');
    expect(source?.listUrl).not.toContain('google-test-key');
  });

  it('treats an empty upstream list as non-destructive evidence', async () => {
    insertKey('groq', 'groq-test-key');
    const before = (getDb().prepare("SELECT COUNT(*) AS count FROM models WHERE platform = 'groq'").get() as { count: number }).count;

    const result = await providerModelCatalog.discoverRemote(getDb(), 'platform:groq', jsonFetch({ data: [] }));

    expect(result.remoteState).toBe('empty');
    expect(result.warning).toMatch(/本地模型没有被标记、禁用或删除/);
    const after = (getDb().prepare("SELECT COUNT(*) AS count FROM models WHERE platform = 'groq'").get() as { count: number }).count;
    expect(after).toBe(before);
  });

  it('imports only missing models with all three enable switches off', () => {
    insertKey('groq', 'groq-test-key');
    const result = providerModelCatalog.importMissing(getDb(), 'platform:groq', [
      'catalog-refactor-new-model',
      'catalog-refactor-new-model',
    ]);

    expect(result.added).toBe(1);
    const row = getDb().prepare(`
      SELECT m.id, m.enabled AS model_enabled,
             f.enabled AS fallback_enabled,
             pm.enabled AS profile_enabled
        FROM models m
        JOIN fallback_config f ON f.model_db_id = m.id
        JOIN profile_models pm ON pm.model_db_id = m.id AND pm.profile_id = ?
       WHERE m.platform = 'groq' AND m.model_id = 'catalog-refactor-new-model'
    `).get(getDefaultProfileId(getDb())) as {
      id: number;
      model_enabled: number;
      fallback_enabled: number;
      profile_enabled: number;
    };
    expect(row).toMatchObject({ model_enabled: 0, fallback_enabled: 0, profile_enabled: 0 });
  });

  it('records a tombstone on explicit deletion and clears it on deliberate re-import', () => {
    insertKey('groq', 'groq-test-key');
    providerModelCatalog.importMissing(getDb(), 'platform:groq', ['catalog-refactor-tombstone']);

    const removed = providerModelCatalog.removeLocal(getDb(), 'platform:groq', ['catalog-refactor-tombstone']);
    expect(removed.removed).toBe(1);
    expect(removed.models[0]?.tombstoned).toBe(true);
    expect(getDb().prepare(`
      SELECT 1 FROM catalog_model_tombstones
       WHERE kind = 'chat' AND platform = 'groq' AND model_id = 'catalog-refactor-tombstone'
    `).get()).toBeDefined();

    providerModelCatalog.importMissing(getDb(), 'platform:groq', ['catalog-refactor-tombstone']);
    expect(getDb().prepare(`
      SELECT 1 FROM catalog_model_tombstones
       WHERE kind = 'chat' AND platform = 'groq' AND model_id = 'catalog-refactor-tombstone'
    `).get()).toBeUndefined();
  });

  it('lists local models without contacting the upstream provider', () => {
    insertKey('groq', 'groq-test-key');
    providerModelCatalog.importMissing(getDb(), 'platform:groq', ['catalog-refactor-local-list']);

    const local = providerModelCatalog.listLocal(getDb(), 'platform:groq');
    const target = local.models.find(model => model.id === 'catalog-refactor-local-list');
    expect(target).toMatchObject({
      localEnabled: false,
      routingEnabled: false,
      catalogManaged: true,
    });
  });
});
