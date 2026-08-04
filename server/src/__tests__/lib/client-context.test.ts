import { afterEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { clientContextMiddleware, getClientContext } from '../../lib/client-context.js';

// Minimal fake req: the middleware only touches headers and socket.
function fakeReq(headers: Record<string, string | string[]>, remoteAddress?: string): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

// Run the middleware and capture the context visible to downstream code
// (i.e. what logRequest would read inside the request's async scope).
function contextFor(req: Request): ReturnType<typeof getClientContext> {
  let seen = getClientContext();
  clientContextMiddleware(req, {} as Response, (() => { seen = getClientContext(); }) as NextFunction);
  return seen;
}

describe('clientContextMiddleware', () => {
  afterEach(() => {
    delete process.env.REQUEST_ANALYTICS_LOG_CLIENT;
  });

  it('captures the socket peer address and user agent', () => {
    const ctx = contextFor(fakeReq({ 'user-agent': 'curl/8.6.0' }, '192.168.0.42'));
    expect(ctx).toEqual({ ip: '192.168.0.42', userAgent: 'curl/8.6.0' });
  });

  it('ignores a forged X-Forwarded-For when no trusted proxy is configured', () => {
    const ctx = contextFor(fakeReq(
      { 'x-forwarded-for': '10.1.2.3, 172.16.0.1', 'user-agent': 'ua' },
      '127.0.0.1',
    ));
    expect(ctx.ip).toBe('127.0.0.1');
  });

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    const ctx = contextFor(fakeReq({}, '::ffff:192.168.0.5'));
    expect(ctx.ip).toBe('192.168.0.5');
  });

  it('truncates oversized user agents to 256 chars', () => {
    const ctx = contextFor(fakeReq({ 'user-agent': 'x'.repeat(1000) }, '1.2.3.4'));
    expect(ctx.userAgent).toHaveLength(256);
  });

  it('stores nulls when REQUEST_ANALYTICS_LOG_CLIENT=false', () => {
    process.env.REQUEST_ANALYTICS_LOG_CLIENT = 'false';
    const ctx = contextFor(fakeReq({ 'user-agent': 'curl/8.6.0' }, '192.168.0.42'));
    expect(ctx).toEqual({ ip: null, userAgent: null });
  });

  it('returns nulls outside any request scope', () => {
    expect(getClientContext()).toEqual({ ip: null, userAgent: null });
  });
});

// Behind a real Express app, req.ip reflects the app's `trust proxy` setting,
// so the middleware's resolved client address is proxy-aware without ever
// reading X-Forwarded-For directly.
function appWithTrustProxy(hops: number, proxyOverwriteXff?: string): Express {
  const app = express();
  app.set('trust proxy', hops);
  if (proxyOverwriteXff) {
    // Simulate a reverse proxy that overwrites (not appends) the
    // client-supplied header with the real client address.
    app.use((req, _res, next) => {
      req.headers['x-forwarded-for'] = proxyOverwriteXff;
      next();
    });
  }
  app.use(clientContextMiddleware);
  app.get('/ctx', (_req, res) => res.json(getClientContext()));
  return app;
}

async function contextFromApp(app: Express, xff?: string): Promise<{ ip: string | null }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const headers: Record<string, string> = xff ? { 'x-forwarded-for': xff } : {};
  const res = await fetch(`http://127.0.0.1:${addr.port}/ctx`, { headers });
  const body = await res.json() as { ip: string | null };
  server.close();
  return body;
}

describe('clientContextMiddleware behind a trusted proxy', () => {
  it('ignores X-Forwarded-For by default (trust proxy 0)', async () => {
    const ctx = await contextFromApp(appWithTrustProxy(0), '10.1.2.3, 172.16.0.1');
    expect(ctx.ip).toBe('127.0.0.1');
  });

  it('resolves the real client from a single trusted hop', async () => {
    const ctx = await contextFromApp(appWithTrustProxy(1), '10.1.2.3, 172.16.0.1');
    expect(ctx.ip).toBe('172.16.0.1');
  });

  it('resolves the real client from two trusted hops', async () => {
    const ctx = await contextFromApp(appWithTrustProxy(2), '10.1.2.3, 172.16.0.1');
    expect(ctx.ip).toBe('10.1.2.3');
  });

  it('uses the proxy-overwritten header as the real client, dropping a forged value', async () => {
    // The client sends a forged header; the trusted proxy overwrites it with
    // the real address, and that is what req.ip reports.
    const ctx = await contextFromApp(appWithTrustProxy(1, '203.0.113.7'), '127.0.0.1');
    expect(ctx.ip).toBe('203.0.113.7');
  });
});
