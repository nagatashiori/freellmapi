import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

// Rate limiter identity behind a reverse proxy: with trust proxy off (default)
// a forged X-Forwarded-For must not change the caller's bucket, and with
// TRUST_PROXY_HOPS=1 the limiter must tell two real clients apart instead of
// folding everyone into the nginx address.

async function request(app: Express, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}/v1/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });

  const text = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(text); } catch {}

  return { status: res.status, body: json, headers: res.headers };
}

const originalRpm = process.env.PROXY_RATE_LIMIT_RPM;
const originalHops = process.env.TRUST_PROXY_HOPS;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

afterAll(() => {
  if (originalRpm === undefined) delete process.env.PROXY_RATE_LIMIT_RPM;
  else process.env.PROXY_RATE_LIMIT_RPM = originalRpm;
  if (originalHops === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = originalHops;
});

describe('Proxy rate limiting behind a reverse proxy', () => {
  it('treats a forged X-Forwarded-For as the socket peer when trust proxy is off', async () => {
    process.env.PROXY_RATE_LIMIT_RPM = '2';
    delete process.env.TRUST_PROXY_HOPS;
    const app = createApp();

    // Two requests with different forged headers share the same socket bucket.
    for (let i = 0; i < 2; i++) {
      const res = await request(app, { 'X-Forwarded-For': '203.0.113.7' });
      expect(res.status).not.toBe(429);
    }
    // A third request with yet another forged header still trips the window,
    // proving the header never changes the limiter's identity.
    const limited = await request(app, { 'X-Forwarded-For': '198.51.100.9' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.type).toBe('rate_limit_error');
  });

  it('distinguishes two real clients behind a single trusted proxy hop', async () => {
    process.env.PROXY_RATE_LIMIT_RPM = '2';
    process.env.TRUST_PROXY_HOPS = '1';
    const app = createApp();

    // Client A exhausts its own budget...
    for (let i = 0; i < 2; i++) {
      const res = await request(app, { 'X-Forwarded-For': '10.0.0.1' });
      expect(res.status).not.toBe(429);
    }
    const aLimited = await request(app, { 'X-Forwarded-For': '10.0.0.1' });
    expect(aLimited.status).toBe(429);

    // ...while client B is unaffected: it is a separate identity, not the
    // nginx address (which would be shared by every caller).
    const bFirst = await request(app, { 'X-Forwarded-For': '10.0.0.2' });
    expect(bFirst.status).not.toBe(429);
  });
});
