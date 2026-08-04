import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import { authRouter } from '../../routes/auth.js';
import { initDb, getDb } from '../../db/index.js';
import { generateSetupCode, getSetupCode } from '../../lib/setup-code.js';

// FIX 1: first-run setup is frictionless from the local machine (loopback) but
// a remote caller must present the one-time setup code minted at boot. The real
// connection here is always loopback, so a middleware overrides req.socket with
// the address under test. The route resolves the caller through Express (req.ip,
// which with trust proxy off is the socket peer), so a forged X-Forwarded-For
// must never fake loopback.

function appWithRemote(remoteAddr: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress: remoteAddr }, configurable: true });
    next();
  });
  app.use('/api/auth', authRouter);
  return app;
}

// Simulates the public deployment: a reverse proxy on the same host (socket
// peer is loopback) that trusts one hop and OVERWRITES the client-supplied
// X-Forwarded-For with the real client address before forwarding.
function appWithTrustedLocalProxy(realClient: string, peer = '127.0.0.1'): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'socket', { value: { remoteAddress: peer }, configurable: true });
    req.headers['x-forwarded-for'] = realClient;
    next();
  });
  app.use('/api/auth', authRouter);
  return app;
}

async function postSetup(app: Express, body: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const CREDS = { email: 'admin@example.com', password: 'supersecret' };

describe('First-run setup code gate (FIX 1)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    // Reset to an unclaimed dashboard and mint a fresh code for each case.
    const db = getDb();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM users').run();
    generateSetupCode();
  });

  it('allows setup from IPv4 loopback without a code', async () => {
    const { status, body } = await postSetup(appWithRemote('127.0.0.1'), CREDS);
    expect(status).toBe(201);
    expect(typeof body.token).toBe('string');
  });

  it('allows setup from IPv6 loopback without a code', async () => {
    const { status } = await postSetup(appWithRemote('::1'), CREDS);
    expect(status).toBe(201);
  });

  it('allows setup from an IPv4-mapped IPv6 loopback without a code', async () => {
    const { status } = await postSetup(appWithRemote('::ffff:127.0.0.1'), CREDS);
    expect(status).toBe(201);
  });

  it('rejects remote setup with no code (403 setup_code_required)', async () => {
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), CREDS);
    expect(status).toBe(403);
    expect(body.error.type).toBe('setup_code_required');
    // No account was created.
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('rejects remote setup with a wrong code', async () => {
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), { ...CREDS, setupCode: 'WRONGCODE9' });
    expect(status).toBe(403);
    expect(body.error.type).toBe('setup_code_required');
  });

  it('rejects remote setup even with a forged X-Forwarded-For: 127.0.0.1', async () => {
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), CREDS, {
      'x-forwarded-for': '127.0.0.1',
    });
    expect(status).toBe(403);
    expect(body.error.type).toBe('setup_code_required');
  });

  it('requires the setup code for a remote client behind a trusted proxy that overwrites the header', async () => {
    // nginx on the same host (socket peer is loopback) trusts one hop and
    // overwrites the client's forged header with the real remote address.
    const { status, body } = await postSetup(appWithTrustedLocalProxy('203.0.113.7'), CREDS, {
      'x-forwarded-for': '127.0.0.1',
    });
    expect(status).toBe(403);
    expect(body.error.type).toBe('setup_code_required');
  });

  it('allows setup without a code for a loopback client behind a trusted local proxy', async () => {
    const { status } = await postSetup(appWithTrustedLocalProxy('127.0.0.1'), CREDS);
    expect(status).toBe(201);
  });

  it('allows remote setup with the correct code', async () => {
    const code = getSetupCode();
    expect(code).toBeTruthy();
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), { ...CREDS, setupCode: code });
    expect(status).toBe(201);
    expect(typeof body.token).toBe('string');
  });

  it('still 409s a second setup once an account exists (remote, even with a code)', async () => {
    // Claim locally first.
    expect((await postSetup(appWithRemote('127.0.0.1'), CREDS)).status).toBe(201);
    const { status, body } = await postSetup(appWithRemote('203.0.113.7'), { email: 'second@example.com', password: 'supersecret', setupCode: getSetupCode() ?? 'x' });
    expect(status).toBe(409);
    expect(body.error.type).toBe('setup_complete');
  });
});
