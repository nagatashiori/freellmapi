import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

const { mockRouteRequest } = vi.hoisted(() => ({ mockRouteRequest: vi.fn() }));
vi.mock('../../services/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/router.js')>();
  return { ...actual, routeRequest: mockRouteRequest };
});

import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { isAttemptTtfbTimeoutError } from '../../lib/fallback-loop.js';
import { applyProxyEnabled, isProxyEnabled } from '../../lib/proxy.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

const env = { ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, ATTEMPT_TTFB_TIMEOUT_MS: process.env.ATTEMPT_TTFB_TIMEOUT_MS, ROUTER_PROVIDER_MOMENT_ATTRIBUTION: process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION };

describe('responses route TTFB attribution through local HTTP', () => {
  let app: Express;
  let key: string;
  let upstream: http.Server | undefined;
  let gateway: http.Server | undefined;
  let proxyEnabled: boolean;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });
  beforeEach(() => {
    proxyEnabled = isProxyEnabled();
    applyProxyEnabled(false);
    mockRouteRequest.mockReset();
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('attempt_ttfb_timeout_ms', '1500') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  });
  afterEach(async () => {
    for (const server of [gateway, upstream]) {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      }
    }
    gateway = upstream = undefined;
    applyProxyEnabled(proxyEnabled);
    vi.restoreAllMocks();
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it.each([[200, '0'], [503, '0'], [200, '1'], [503, '1']] as const)(
    'records a stalled %i body timeout with provider moment %s', async (status, pm) => {
      process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION = pm;
      const events: string[] = [];
      const nativeFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Non-local fetch blocked by test');
        return nativeFetch(input, init);
      });
      const nativeJson = Response.prototype.json;
      vi.spyOn(Response.prototype, 'json').mockImplementation(function (this: Response) {
        events.push('json:' + this.status);
        return nativeJson.call(this);
      });
      const received: string[] = [];
      upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received.push(JSON.parse(Buffer.concat(chunks).toString()).model);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.write(status === 200 ? '{"choices":' : '{"error":');
        events.push('partial');
      });
      await new Promise<void>((resolve, reject) => {
        upstream!.once('error', reject);
        upstream!.listen(0, '127.0.0.1', resolve);
      });
      const port = (upstream.address() as { port: number }).port;
      const provider = new OpenAICompatProvider({ platform: 'groq', name: 'local', baseUrl: 'http://127.0.0.1:' + port, timeoutMs: 5000 });
      const original = provider.chatCompletion.bind(provider);
      let rawError: any;
      let abortReason: any;
      const dispatch = vi.spyOn(provider, 'chatCompletion').mockImplementation(async (...args) => {
        const signal = args[3]?.signal;
        signal?.addEventListener('abort', () => { events.push('abort'); abortReason = signal.reason; }, { once: true });
        try { return await original(...args); } catch (error) { rawError = error; throw error; }
      });
      mockRouteRequest.mockImplementation((_estimated: number, skipKeys?: Set<string>) => {
        if (skipKeys?.size) throw Object.assign(new Error('All models exhausted'), { status: 429 });
        return { provider, modelId: 'slow', modelDbId: 9999, apiKey: 'local-test-only', keyId: 1, platform: 'groq', displayName: 'Slow', rpdLimit: null, tpdLimit: null };
      });
      gateway = app.listen(0, '127.0.0.1');
      if (!gateway.listening) await new Promise<void>(resolve => gateway!.once('listening', resolve));
      const gatewayPort = (gateway.address() as { port: number }).port;
      const response = await fetch('http://127.0.0.1:' + gatewayPort + '/v1/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ input: 'hi', stream: false }),
      });
      await response.text();
      expect(response.status).toBe(502);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(received).toEqual(['slow']);
      expect(events).toEqual(['partial', 'json:' + status, 'abort']);
      expect(abortReason?.attemptTtfbTimeout).toBe(true);
      expect(isAttemptTtfbTimeoutError(rawError)).toBe(true);
      expect(rawError?.attemptTtfbTimeout === true || rawError?.cause?.attemptTtfbTimeout === true).toBe(true);
      expect(mockRouteRequest).toHaveBeenCalledTimes(2);
      expect(mockRouteRequest.mock.calls[1][1].has('groq:slow:1')).toBe(true);
      const rows = getDb().prepare("SELECT status, failure_attribution FROM requests WHERE platform = 'groq' AND model_id = 'slow'").all();
      expect(rows).toEqual([{ status: 'error', failure_attribution: 'local_attempt_ttfb_timeout' }]);
    }, 10000,
  );
});
