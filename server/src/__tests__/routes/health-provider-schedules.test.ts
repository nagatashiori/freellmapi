import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { healthRouter } from '../../routes/health.js';

let server: Server;
let baseUrl: string;

function addKey(platform: string): void {
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, 'private-label', 'private-ciphertext', 'private-iv', 'private-tag', 'unknown', 1, 'https://private-endpoint.invalid')
  `).run(platform);
}

describe('provider health schedule routes', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const app = express();
    app.use(express.json());
    app.use('/api/health', healthRouter);
    server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM api_keys WHERE platform LIKE 'route-schedule-%'").run();
    db.prepare("DELETE FROM settings WHERE key = 'provider_health_schedules'").run();
  });

  it('returns disabled defaults without exposing credentials or base URLs', async () => {
    addKey('route-schedule-safe');
    const response = await fetch(`${baseUrl}/api/health/provider-schedules`);
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(body.schedules).toContainEqual({
      platform: 'route-schedule-safe', enabled: false, intervalMs: null, lastRunAt: null, nextRunAt: null,
    });
    expect(text).not.toContain('private-ciphertext');
    expect(text).not.toContain('private-endpoint');
    expect(text).not.toContain('private-label');
  });

  it('round-trips a valid provider schedule', async () => {
    addKey('route-schedule-roundtrip');
    const put = await fetch(`${baseUrl}/api/health/provider-schedules/route-schedule-roundtrip`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, intervalMs: 120_000 }),
    });
    const saved = await put.json() as any;

    expect(put.status).toBe(200);
    expect(saved.schedule.enabled).toBe(true);
    expect(saved.schedule.intervalMs).toBe(120_000);

    const get = await fetch(`${baseUrl}/api/health/provider-schedules`);
    const listed = await get.json() as any;
    expect(listed.schedules.find((row: any) => row.platform === 'route-schedule-roundtrip').enabled).toBe(true);
  });

  it('returns 400 for unknown providers or invalid interval payloads without changing configuration', async () => {
    const unknown = await fetch(`${baseUrl}/api/health/provider-schedules/route-schedule-missing`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, intervalMs: 60_000 }),
    });
    expect(unknown.status).toBe(400);

    addKey('route-schedule-invalid');
    const invalid = await fetch(`${baseUrl}/api/health/provider-schedules/route-schedule-invalid`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, intervalMs: '60000' }),
    });
    expect(invalid.status).toBe(400);

    const get = await fetch(`${baseUrl}/api/health/provider-schedules`);
    const body = await get.json() as any;
    expect(body.schedules.find((row: any) => row.platform === 'route-schedule-invalid').enabled).toBe(false);
  });
});
