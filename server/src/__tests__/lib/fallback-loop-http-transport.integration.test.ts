import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { isAttemptTtfbTimeoutError, newFallbackState, runFallbackLoop } from '../../lib/fallback-loop.js';
import { applyProxyEnabled, isProxyEnabled } from '../../lib/proxy.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import type { RouteResult } from '../../services/router.js';

// A real local socket and a partially delivered body exercise Node transport
// abort behavior, which a fetch mock or a promise rejecting signal.reason cannot.
describe('attempt timeout through local HTTP transport', () => {
  let server: http.Server | undefined;
  let proxyEnabled: boolean;

  beforeEach(() => {
    initDb(':memory:');
    proxyEnabled = isProxyEnabled();
    applyProxyEnabled(false);
  });

  afterEach(async () => {
    applyProxyEnabled(proxyEnabled);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    vi.restoreAllMocks();
  });

  it.each([200, 503])('retries a local timeout while reading a stalled %i response body', async status => {
    const jsonReads = vi.spyOn(Response.prototype, 'json');
    const requests: string[] = [];
    let partialSent = false;
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body.model);
      if (body.model === 'slow') {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.write(status === 200 ? '{"choices":' : '{"error":');
        partialSent = true;
        // Deliberately leave the body open until the client aborts.
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'local', object: 'chat.completion', created: 1, model: 'fast', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    const address = await new Promise<string>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + (server!.address() as { port: number }).port));
    });
    const provider = new OpenAICompatProvider({ platform: 'groq', name: 'local', baseUrl: address, timeoutMs: 5000 });
    const releases = [vi.fn(), vi.fn()];
    const routes = ['slow', 'fast'].map((modelId, i): RouteResult => ({
      provider, modelId, modelDbId: 100 + i, apiKey: 'local-test-only', keyId: 200 + i,
      platform: 'groq', displayName: modelId, keyLabel: null, contextWindow: null, endpointScope: '',
      rpdLimit: null, tpdLimit: null, release: releases[i],
    }));
    const state = newFallbackState();
    const logFailure = vi.fn();
    const onFatal = vi.fn();
    const onExhausted = vi.fn();
    const onRoutingExhausted = vi.fn();
    let answer: unknown = null;
    await runFallbackLoop({
      state, maxRetries: 3, timeBudgetMs: 0, breakerLimit: 1, attemptTtfbTimeoutMs: 1500,
      route: () => {
        const next = routes.find(r => !state.skipKeys.has('groq:' + r.modelId + ':' + r.keyId));
        if (!next) throw new Error('no candidates');
        return next;
      },
      dispatch: async (route, _attempt, ctx) => {
        const result = await provider.chatCompletion(route.apiKey, [{ role: 'user', content: 'hello' }], route.modelId, { signal: ctx.signal });
        answer = result.choices[0].message.content;
        return 'done';
      },
      logFailure, onFatal, onExhausted, onRoutingExhausted,
    });
    expect(partialSent).toBe(true);
    expect(requests).toEqual(['slow', 'fast']);
    // The first response reached the actual body reader before the timer fired.
    expect(jsonReads.mock.instances.map(response => (response as Response).status)).toEqual([status, 200]);
    expect(answer).toBe('ok');
    expect(logFailure).toHaveBeenCalledOnce();
    const error = logFailure.mock.calls[0][1];
    expect(isAttemptTtfbTimeoutError(error)).toBe(true);
    expect(error.attemptTtfbTimeout === true || error.cause?.attemptTtfbTimeout === true).toBe(true);
    expect(state.skipKeys.has('groq:slow:200')).toBe(true);
    expect(state.skipPlatforms.size).toBe(0);
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(0);
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
    expect(onFatal).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(onRoutingExhausted).not.toHaveBeenCalled();
  }, 10000);
});
