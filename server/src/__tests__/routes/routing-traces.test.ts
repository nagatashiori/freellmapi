import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { traceRouteEvent } from '../../routes/proxy.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function request(app: Express, token: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/analytics/routing-traces?range=7d`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  server.close();
  return { status: res.status, body };
}

describe('GET /api/analytics/routing-traces', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM routing_events').run();
  });

  it('groups one external request into a readable dispatched → failed → fallback → success chain', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO routing_events (request_id, surface, attempt, event, platform, model_id, requested_model, latency_ms, error, created_at)
      VALUES (?, 'Proxy', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    insert.run('trace-a', 0, 'start', 'mapleleaf', 'z-ai/glm-5.2', 'glm-5.2', null, null);
    insert.run('trace-a', 0, 'fail', 'mapleleaf', 'z-ai/glm-5.2', null, 315, '429 rate limited');
    insert.run('trace-a', 1, 'next', 'locedge', 'z-ai/glm-5.2', null, null, null);
    insert.run('trace-a', 1, 'ok', 'locedge', 'z-ai/glm-5.2', null, 842, null);

    const { status, body } = await request(app, token);

    expect(status).toBe(200);
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]).toMatchObject({
      requestId: 'trace-a',
      finalState: 'ok',
      requestedModel: 'glm-5.2',
      finalPlatform: 'locedge',
      finalModelId: 'z-ai/glm-5.2',
      events: [
        { event: 'start', platform: 'mapleleaf', modelId: 'z-ai/glm-5.2' },
        { event: 'fail', error: '429 rate limited', errorCategory: 'Rate limited or quota' },
        { event: 'next', platform: 'locedge' },
        { event: 'ok', latencyMs: 842 },
      ],
    });
  });

  it('returns the selected API label and ID for every dispatch event without exposing secrets', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag)
      VALUES (7, 'groq', 'Groq primary', 'encrypted-secret', 'iv-secret', 'tag-secret')
    `).run();
    const insert = db.prepare(`
      INSERT INTO routing_events (request_id, surface, attempt, event, platform, model_id, key_id, created_at)
      VALUES (?, 'Proxy', ?, ?, ?, ?, ?, datetime('now'))
    `);
    insert.run('trace-key', 0, 'start', 'groq', 'llama-3.3-70b-versatile', 7);
    insert.run('trace-key', 0, 'ok', 'groq', 'llama-3.3-70b-versatile', 7);

    const { status, body } = await request(app, token);

    expect(status).toBe(200);
    expect(body.traces[0].events).toEqual([
      expect.objectContaining({ event: 'start', keyId: 7, keyLabel: 'Groq primary' }),
      expect.objectContaining({ event: 'ok', keyId: 7, keyLabel: 'Groq primary' }),
    ]);
    expect(JSON.stringify(body)).not.toContain('encrypted-secret');
    expect(JSON.stringify(body)).not.toContain('iv-secret');
    expect(JSON.stringify(body)).not.toContain('tag-secret');
  });

  it('keeps a deleted API visible as Key #ID and keeps old events readable', async () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO routing_events (request_id, surface, attempt, event, platform, model_id, key_id, created_at)
      VALUES (?, 'Proxy', 0, 'start', ?, ?, ?, datetime('now'))
    `);
    insert.run('trace-deleted-key', 'groq', 'llama-3.3-70b-versatile', 99);

    const { status, body } = await request(app, token);

    expect(status).toBe(200);
    expect(body.traces[0].events[0]).toMatchObject({ keyId: 99, keyLabel: 'Key #99' });
  });

  it('persists the selected key ID when a route event is emitted', () => {
    traceRouteEvent('Proxy', {
      event: 'start', requestId: 'trace-emitter', attempt: 0,
      platform: 'groq', model: 'llama-3.3-70b-versatile', keyId: 7,
    });

    const row = getDb().prepare(`
      SELECT key_id FROM routing_events WHERE request_id = ?
    `).get('trace-emitter') as { key_id: number | null };
    expect(row.key_id).toBe(7);
  });
});
