import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  runFallbackLoop,
  newFallbackState,
  type FallbackState,
  ATTEMPT_TTFB_TIMEOUT_SETTING,
  getAttemptTtfbTimeoutMs,
  newAttemptTtfbTimeoutError,
  isAttemptTtfbTimeoutError,
  recordRetryableFailure,
} from '../../lib/fallback-loop.js';
import { isRetryableError, isClientAbortError, isHedgeAbortError, newClientAbortError } from '../../lib/error-classify.js';
import { acquireLease, releaseLease, resetLeases } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

let keySeq = 1000;
function leasedRoute(name = 'fake-model'): { route: RouteResult; keyId: number } {
  const keyId = ++keySeq;
  const id = acquireLease('fake', name, keyId, 100);
  return {
    keyId,
    route: {
      provider: {} as any,
      modelId: name,
      modelDbId: 900000 + keyId,
      apiKey: 'test-key',
      keyId,
      platform: 'fake',
      displayName: `Fake ${name}`,
      rpdLimit: null,
      tpdLimit: null,
      release: () => releaseLease(id),
    },
  };
}

function hooks(state: FallbackState, overrides: Record<string, unknown>) {
  return {
    state,
    timeBudgetMs: 0,
    logFailure: vi.fn(),
    onFatal: vi.fn(),
    onRoutingExhausted: vi.fn(),
    onExhausted: vi.fn(),
    ...overrides,
  } as any;
}

describe('fallback loop attempt-level TTFB timeout and fast failover', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    delete process.env.ATTEMPT_TTFB_TIMEOUT_MS;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetLeases();
    delete process.env.ATTEMPT_TTFB_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it('classifies the attempt TTFB timeout error as retryable timeout, not client abort or hedge abort', () => {
    const err = newAttemptTtfbTimeoutError('google', 'gemini-3.8-flash', 15000);
    expect(isAttemptTtfbTimeoutError(err)).toBe(true);
    expect(isRetryableError(err)).toBe(true);
    expect(isClientAbortError(err)).toBe(false);
    expect(isHedgeAbortError(err)).toBe(false);
  });

  it.each(['direct', 'immediate cause'] as const)('exempts trusted attempt timeout marker: %s', (shape) => {
    const state = newFallbackState();
    const { route } = leasedRoute();
    const marked = newAttemptTtfbTimeoutError('fake', route.modelId, 10);
    const err = shape === 'direct' ? marked : new Error('wrapped timeout', { cause: marked });
    expect(recordRetryableFailure(route, err, state)).toBe(true);
    expect(state.skipKeys.has(`fake:${route.modelId}:${route.keyId}`)).toBe(true);
    expect(state.skipPlatforms.size).toBe(0);
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(0);
    route.release?.();
  });

  it('reads setting and env var with setting taking precedence', () => {
    expect(getAttemptTtfbTimeoutMs()).toBe(0);

    process.env.ATTEMPT_TTFB_TIMEOUT_MS = '20000';
    expect(getAttemptTtfbTimeoutMs()).toBe(20000);

    getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(ATTEMPT_TTFB_TIMEOUT_SETTING, '15000');
    expect(getAttemptTtfbTimeoutMs()).toBe(15000);
  });

  it('aborts attempt 0 when first-byte timeout expires, and succeeds on attempt 1 (fast failover)', async () => {
    const state = newFallbackState();
    const route0 = leasedRoute('frontier-model-1').route;
    const route1 = leasedRoute('frontier-model-2').route;

    const dispatch = vi.fn().mockImplementation(async (route, attempt, ctx) => {
      if (attempt === 0) {
        // Attempt 0 hangs waiting for first byte until ctx.signal aborts
        return await new Promise((_resolve, reject) => {
          if (ctx.signal) {
            ctx.signal.addEventListener('abort', () => {
              reject(ctx.signal.reason);
            }, { once: true });
          }
        });
      }
      // Attempt 1 receives first byte, disarms hedge and finishes
      ctx.disarmHedge();
      return 'done';
    });

    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 5000,
      attemptTtfbTimeoutMs: 30, // 30ms for test
      route: (att: number) => (att === 0 ? route0 : route1),
      dispatch,
    });

    await runFallbackLoop(h);

    // Attempt 0 timed out and failed over; Attempt 1 succeeded
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(h.logFailure).toHaveBeenCalledTimes(1);

    // Verifies key 0 was added to skipKeys for this request
    expect(state.skipKeys.has(`fake:frontier-model-1:${route0.keyId}`)).toBe(true);
  });

  it('keeps other same-platform models available without global cooldown or breaker penalties', async () => {
    const state = newFallbackState();
    const routes = [leasedRoute('slow-a').route, leasedRoute('slow-b').route, leasedRoute('fast-c').route];
    const route = vi.fn(() => {
      const next = routes.find(r => !state.skipPlatforms.has(r.platform) && !state.skipModels.has(r.modelDbId) && !state.skipKeys.has(`${r.platform}:${r.modelId}:${r.keyId}`));
      if (!next) throw new Error("no candidates");
      return next;
    });
    const dispatch = vi.fn(async (r, _attempt, ctx) => {
      if (r === routes[2]) return 'done';
      return await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }));
    });
    const h = hooks(state, { maxRetries: 8, breakerLimit: 1, timeBudgetMs: 1000, attemptTtfbTimeoutMs: 10, route, dispatch });
    await runFallbackLoop(h);
    expect(dispatch.mock.calls.map(call => call[0].modelId)).toEqual(['slow-a', 'slow-b', 'fast-c']);
    expect(state.skipPlatforms.size).toBe(0);
    expect(state.skipKeys.size).toBe(2);
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(0);
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(h.onRoutingExhausted).not.toHaveBeenCalled();
    const nextState = newFallbackState();
    expect(nextState.skipKeys.size).toBe(0);
    expect(nextState.skipPlatforms.size).toBe(0);
  });

  it('retries an opaque error wrapping a trusted attempt timeout without health penalties', async () => {
    const state = newFallbackState();
    const routes = [leasedRoute('wrapped-slow').route, leasedRoute('wrapped-next').route];
    const dispatch = vi.fn(async (_route, attempt) => {
      if (attempt === 0) throw new Error('dispatch failed', { cause: newAttemptTtfbTimeoutError('fake', 'wrapped-slow', 10) });
      return 'done';
    });
    const h = hooks(state, { maxRetries: 3, breakerLimit: 1, route: (attempt: number) => routes[attempt], dispatch });
    await runFallbackLoop(h);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(state.skipKeys.has(`fake:wrapped-slow:${routes[0].keyId}`)).toBe(true);
    expect(state.skipPlatforms.size).toBe(0);
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(0);
    expect(h.onFatal).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
  });

  it.each(['401 unauthorized', 'fallback time budget expired', 'client disconnected'])(
    'retries a trusted attempt timeout despite misleading outer message %s', async (message) => {
      const state = newFallbackState();
      const routes = [leasedRoute('collision').route, leasedRoute('collision-next').route];
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const dispatch = vi.fn(async (_route, attempt) => {
        if (attempt === 0) {
          now += 800;
          throw new Error(message, { cause: newAttemptTtfbTimeoutError('fake', 'collision', 10) });
        }
        return 'done';
      });
      const h = hooks(state, { maxRetries: 3, timeBudgetMs: 1000, breakerLimit: 1, route: (attempt: number) => routes[attempt], dispatch });
      await runFallbackLoop(h);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(state.skipKeys.has('fake:collision:' + routes[0].keyId)).toBe(true);
      expect(state.skipPlatforms.size).toBe(0);
      expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(0);
      expect(h.onExhausted).not.toHaveBeenCalled();
      expect(h.onFatal).not.toHaveBeenCalled();
    },
  );

  it('gives an explicit hedge marker precedence over a wrapped trusted attempt timeout', async () => {
    const state = newFallbackState();
    const route = leasedRoute('hedge-first').route;
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const err = Object.assign(new Error('hedge'), { hedgeAbort: true, cause: newAttemptTtfbTimeoutError('fake', 'hedge-first', 10) });
    const dispatch = vi.fn(async () => { now += 800; throw err; });
    const h = hooks(state, { maxRetries: 3, timeBudgetMs: 1000, breakerLimit: 1, route: () => route, dispatch });
    await runFallbackLoop(h);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.onExhausted).toHaveBeenCalledOnce();
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all().length).toBeGreaterThan(0);
  });

  it('gives client abort precedence over a wrapped trusted attempt timeout', async () => {
    const state = newFallbackState();
    const route = leasedRoute('client-first').route;
    const err = Object.assign(newClientAbortError(), { cause: newAttemptTtfbTimeoutError('fake', 'client-first', 10) });
    const dispatch = vi.fn(async () => { throw err; });
    const h = hooks(state, { maxRetries: 3, breakerLimit: 1, route: () => route, dispatch });
    await runFallbackLoop(h);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.logFailure).not.toHaveBeenCalled();
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(state.skipKeys.size).toBe(0);
    expect(state.skipPlatforms.size).toBe(0);
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(0);
  });

  it('does not bench a trusted attempt timeout that mentions an in-band error', async () => {
    const state = newFallbackState();
    const routes = [leasedRoute('local-in-band').route, leasedRoute('local-next').route];
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const dispatch = vi.fn(async (_route, attempt) => {
      if (attempt === 0) {
        now += 800;
        const err = newAttemptTtfbTimeoutError('fake', 'local-in-band', 10);
        err.message += ' in-band provider error';
        throw err;
      }
      return 'done';
    });
    const h = hooks(state, { maxRetries: 3, timeBudgetMs: 1000, breakerLimit: 1, route: (attempt: number) => routes[attempt], dispatch });
    await runFallbackLoop(h);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(0);
    expect(state.skipPlatforms.size).toBe(0);
    expect(h.onExhausted).not.toHaveBeenCalled();
  });

  it('exhausts candidates once each when all attempts time out', async () => {
    const state = newFallbackState();
    const routes = [leasedRoute('only-a').route, leasedRoute('only-b').route];
    const route = vi.fn(() => {
      const next = routes.find(r => !state.skipPlatforms.has(r.platform) && !state.skipKeys.has(`${r.platform}:${r.modelId}:${r.keyId}`));
      if (!next) throw new Error("no candidates");
      return next;
    });
    const dispatch = vi.fn(async (_r, _attempt, ctx) => await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })));
    const h = hooks(state, { maxRetries: 20, timeBudgetMs: 1000, attemptTtfbTimeoutMs: 10, route, dispatch });
    await runFallbackLoop(h);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(h.onRoutingExhausted).toHaveBeenCalledTimes(1);
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(0);
  });

  it.each(['upstream timeout', 'Fake stream: no first byte within 1000ms (first-byte timeout)'])(
    'preserves upstream timeout cooldown and breaker behavior: %s', async (message) => {
    const state = newFallbackState();
    const route = leasedRoute('upstream-timeout').route;
    const dispatch = vi.fn(async () => { throw new Error(message); });
    const h = hooks(state, { maxRetries: 10, breakerLimit: 1, route: () => route, dispatch });
    await runFallbackLoop(h);
    expect(state.skipPlatforms.has('fake')).toBe(true);
    expect(getDb().prepare('SELECT * FROM rate_limit_cooldowns').all()).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.onExhausted).toHaveBeenCalledTimes(1);
  });

  it('clears attempt timer when disarmHedge is called before timeout and does not abort mid-stream', async () => {
    const state = newFallbackState();
    const route0 = leasedRoute('frontier-model-1').route;

    const dispatch = vi.fn().mockImplementation(async (route, attempt, ctx) => {
      // First byte arrives after 10ms (before 40ms threshold)
      await new Promise(r => setTimeout(r, 10));
      ctx.disarmHedge();
      // Mid-stream generation takes another 60ms (well past the 40ms threshold)
      await new Promise(r => setTimeout(r, 60));
      return 'done';
    });

    const h = hooks(state, {
      maxRetries: 5,
      timeBudgetMs: 5000,
      attemptTtfbTimeoutMs: 40,
      route: () => route0,
      dispatch,
    });

    await runFallbackLoop(h);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(h.onExhausted).not.toHaveBeenCalled();
    expect(h.logFailure).not.toHaveBeenCalled();
  });
});
