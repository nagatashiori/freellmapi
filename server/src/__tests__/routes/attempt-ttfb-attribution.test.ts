import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';

const env = { key: process.env.ENCRYPTION_KEY, timeout: process.env.ATTEMPT_TTFB_TIMEOUT_MS, pm: process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION };

describe('attempt TTFB attribution through the responses route', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    mockRouteRequest.mockReset();
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('attempt_ttfb_timeout_ms', '10') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  });

  afterAll(() => {
    for (const [name, value] of Object.entries({ ENCRYPTION_KEY: env.key, ATTEMPT_TTFB_TIMEOUT_MS: env.timeout, ROUTER_PROVIDER_MOMENT_ATTRIBUTION: env.pm })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it.each([['direct', '0'], ['cause', '0'], ['direct', '1'], ['cause', '1']] as const)('persists %s timeout rejection with provider moment %s', async (shape, pm) => {
    process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = pm;
    let reason: any;
    const provider = {
      chatCompletion: vi.fn((_key: string, _messages: unknown, _model: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        const abort = () => {
          reason = options.signal.reason;
          reject(shape === 'direct' ? reason : new Error('wrapped', { cause: reason }));
        };
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
      })),
    };
    mockRouteRequest.mockImplementation((_estimated: number, skipKeys?: Set<string>) => {
      if (skipKeys?.size) throw Object.assign(new Error('All models exhausted'), { status: 429 });
      return { provider, modelId: 'fake-model', modelDbId: 9999, apiKey: 'k', keyId: 1, platform: 'fake', displayName: 'Fake Model', rpdLimit: null, tpdLimit: null };
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ input: 'hi', stream: false }),
      });
      await response.text();
      expect(response.status).toBe(502);
      expect(provider.chatCompletion).toHaveBeenCalledTimes(1);
      expect(mockRouteRequest).toHaveBeenCalledTimes(2);
      expect(reason?.attemptTtfbTimeout).toBe(true);
      const rows = getDb().prepare("SELECT status, failure_attribution FROM requests WHERE platform = 'fake' AND model_id = 'fake-model'").all();
      expect(rows).toEqual([{ status: 'error', failure_attribution: 'local_attempt_ttfb_timeout' }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });
});
