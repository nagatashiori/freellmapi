import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

// Request-scoped caller identity, readable from anywhere below the middleware
// without threading parameters through every logRequest() call site (the chat
// proxy, responses, anthropic, fusion, embeddings and media paths all log).
const storage = new AsyncLocalStorage<ClientContext>();

// Express-resolved client address. With the app's `trust proxy` unset (the
// default, TRUST_PROXY_HOPS=0) req.ip is the socket peer and a forged
// X-Forwarded-For is ignored; when TRUST_PROXY_HOPS is configured for a public
// reverse proxy, req.ip is the real client taken from the trusted hop. Never
// read X-Forwarded-For directly here — it is attacker-controlled until the
// trusted proxy layer has overwritten it (see app.ts).
function resolveClientIp(req: Request): string | null {
  const raw = req.ip ?? req.socket.remoteAddress ?? null;
  // Normalize IPv4-mapped IPv6 ("::ffff:192.168.0.5" -> "192.168.0.5").
  return raw?.replace(/^::ffff:/i, '') ?? null;
}

// Privacy opt-out: REQUEST_ANALYTICS_LOG_CLIENT=false stores nulls instead of
// the caller's IP/UA. Read per request (not at module load) so tests and
// embedders can toggle it without re-importing.
function clientLoggingEnabled(): boolean {
  return process.env.REQUEST_ANALYTICS_LOG_CLIENT !== 'false';
}

export function clientContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (!clientLoggingEnabled()) {
    storage.run({ ip: null, userAgent: null }, next);
    return;
  }
  const ua = req.headers['user-agent'];
  storage.run({ ip: resolveClientIp(req), userAgent: typeof ua === 'string' ? ua.slice(0, 256) : null }, next);
}

export function getClientContext(): ClientContext {
  return storage.getStore() ?? { ip: null, userAgent: null };
}
