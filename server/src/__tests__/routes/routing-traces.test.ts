import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
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
      events: [
        { event: 'start', platform: 'mapleleaf', modelId: 'z-ai/glm-5.2' },
        { event: 'fail', error: '429 rate limited' },
        { event: 'next', platform: 'locedge' },
        { event: 'ok', latencyMs: 842 },
      ],
    });
  });
});
