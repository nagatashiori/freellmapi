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
} from '../../lib/fallback-loop.js';
import { isRetryableError, isClientAbortError, isHedgeAbortError } from '../../lib/error-classify.js';
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
