import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, type ChainRow } from '../../services/router.js';

describe('router prefetched group chain protection', () => {
  beforeAll(() => {
    delete process.env.ENCRYPTION_KEY;
    const db = initDb(':memory:');
    const enc = encrypt('test-secret-key-12345');
    db.prepare(`
      INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', ?, ?, ?, 'healthy', 1)
    `).run(enc.encrypted, enc.iv, enc.authTag);
  });

  it('does not inject off-group preferredModelDbId into a strict prefetched groupChain', () => {
    const db = getDb();
    // Suppose model 1 is in the prefetched groupChain, model 2 is an off-group model.
    const row1 = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get('groq', 'llama-3.3-70b-versatile') as { id: number };
    const row2 = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get('groq', 'llama-3.1-8b-instant') as { id: number };

    const groupChain: ChainRow[] = [{
      model_db_id: row1.id,
      priority: 1,
      enabled: 1,
      platform: 'groq',
      model_id: 'llama-3.3-70b-versatile',
      display_name: 'Llama 3.3 70B',
      intelligence_rank: 1,
      size_label: '70B',
      monthly_token_budget: '0',
      rpm_limit: null,
      rpd_limit: null,
      tpm_limit: null,
      tpd_limit: null,
      supports_vision: 0,
      supports_tools: 1,
      context_window: 128000,
      key_id: null,
    }];

    // Request routing with groupChain AND preferredModelDbId = row2.id (which is off-group).
    // It should route to row1 (the only group member), rather than injecting row2.
    const result = routeRequest(100, undefined, row2.id, false, false, undefined, groupChain);
    expect(result.modelDbId).toBe(row1.id);
  });
});
