import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';
import { CohereProvider } from '../../providers/cohere.js';
import { CloudflareProvider } from '../../providers/cloudflare.js';
import { AIHordeProvider } from '../../providers/aihorde.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { isClientAbortError, newClientAbortError } from '../../lib/error-classify.js';
import * as proxy from '../../lib/proxy.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

/**
 * AbortSignal-through-fetch coverage (P1, mined from the frankljlyy-ai and
 * MLuqmanBR forks): fetchWithTimeout used to bound only time-to-headers, so a
 * body/stream read was unbounded and a client disconnect never canceled the
 * upstream request. These tests run a REAL loopback HTTP upstream (not a fetch
 * mock) because the behavior under test is undici's signal wiring itself:
 * aborting the composed signal must tear down the upstream socket mid-body and
 * mid-stream, and reject the pending read with the marked client-abort reason.
 */

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

interface Upstream {
  url: string;
  /** Resolves when the upstream saw its response connection torn down. */
  closed: Promise<void>;
  stop: () => Promise<void>;
}

async function startUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Upstream> {
  let sawClose!: () => void;
  const closed = new Promise<void>(resolve => { sawClose = resolve; });
  const server = http.createServer((req, res) => {
    res.on('close', sawClose);
    handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    closed,
    stop: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function makeProvider(baseUrl: string): OpenAICompatProvider {
  return new OpenAICompatProvider({ platform: 'groq', name: 'TestCompat', baseUrl });
}

describe('AbortSignal through provider fetch + body/stream reads', () => {
  let upstream: Upstream | null = null;

  afterEach(async () => {
    await upstream?.stop();
    upstream = null;
  });

  it('client abort mid-body-read cancels the upstream fetch', async () => {
    // 200 + partial JSON body, then hold the connection open forever: the
    // request is stuck inside res.json(), past the header timeout's old reach.
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":"chatcmpl-hang","choices":[');
    });
    const provider = makeProvider(upstream.url);

    const clientAbort = new AbortController();
    const pending = provider.chatCompletion('test-key', MESSAGES, 'test-model', { signal: clientAbort.signal });
    setTimeout(() => clientAbort.abort(newClientAbortError()), 100);

    const err = await pending.then(() => null, e => e);
    expect(err).not.toBeNull();
    // The rejection must carry the marked client-abort reason (not a generic
    // parse/abort error), so the fallback loop can skip all failure bookkeeping.
    expect(isClientAbortError(err)).toBe(true);
    // And the upstream connection must actually be torn down — tokens stop
    // burning — not left to drain in the background.
    await upstream.closed;
  });

  it('client abort mid-stream stops iteration and rejects with the marked reason', async () => {
    // SSE headers + one real chunk, then hold: the consumer is parked inside
    // reader.read() when the client hangs up.
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n');
    });
    const provider = makeProvider(upstream.url);

    const clientAbort = new AbortController();
    const received: string[] = [];
    const err = await (async () => {
      for await (const chunk of provider.streamChatCompletion('test-key', MESSAGES, 'test-model', { signal: clientAbort.signal })) {
        received.push((chunk as any).choices?.[0]?.delta?.content ?? '');
        // Simulate the route pump's client vanishing after the first token.
        clientAbort.abort(newClientAbortError());
      }
      return null;
    })().catch(e => e);

    expect(received).toEqual(['hello']);
    expect(err).not.toBeNull();
    expect(isClientAbortError(err)).toBe(true);
    await upstream.closed;
  });

  it.each(['headers', 'body'] as const)('preserves a first-byte timeout reason during stalled %s', async (phase) => {
    upstream = await startUpstream((_req, res) => {
      if (phase === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{\"id\":\"chatcmpl-hang\",\"choices\":[');
      }
    });
    const controller = new AbortController();
    const reason = Object.assign(new Error('upstream stalled: no first byte (first-byte timeout)'), { attemptTtfbTimeout: true });
    const pending = makeProvider(upstream.url).chatCompletion('test-key', MESSAGES, 'test-model', { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 100);
    const err = await pending.then(() => null, e => e);
    expect(err).toBe(reason);
    await upstream.closed;
  });

  it.each(['non-stream', 'stream'] as const)('preserves timeout and client abort reasons while reading a stalled non-2xx %s body', async (mode) => {
    for (const reason of [
      Object.assign(new Error('upstream stalled: no first byte (first-byte timeout)'), { attemptTtfbTimeout: true }),
      newClientAbortError(),
    ]) {
      upstream = await startUpstream((_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.write('{"error":');
      });
      const provider = makeProvider(upstream.url);
      const controller = new AbortController();
      const pending = mode === 'stream'
        ? provider.streamChatCompletion('test-key', MESSAGES, 'test-model', { signal: controller.signal }).next()
        : provider.chatCompletion('test-key', MESSAGES, 'test-model', { signal: controller.signal });
      setTimeout(() => controller.abort(reason), 100);
      const err = await pending.then(() => null, e => e);
      expect(err).toBe(reason);
      await upstream.closed;
      await upstream.stop();
      upstream = null;
    }
  });

  it.each([
    ['Google', () => new GoogleProvider(), 'key', true],
    ['Cohere', () => new CohereProvider(), 'key', true],
    ['Cloudflare', () => new CloudflareProvider(), 'account:token', true],
    ['AI Horde', () => new AIHordeProvider(), 'key', false],
  ] as const)('%s preserves abort reasons in non-2xx body reads', async (_name, make, key, hasStream) => {
    for (const stream of hasStream ? [false, true] : [false]) {
      for (const reason of [
        Object.assign(new Error('first-byte timeout'), { attemptTtfbTimeout: true }),
        newClientAbortError(),
      ]) {
        const provider = make();
        if (provider instanceof CloudflareProvider) {
          vi.spyOn(provider as any, 'meterCall').mockReturnValue({ meter: { refund: vi.fn() }, inputTokens: 0 });
        }
        const controller = new AbortController();
        const response = {
          ok: false, status: 503, statusText: 'Service Unavailable', headers: new Headers(),
          json: async () => {
            controller.abort(reason);
            throw reason;
          },
        };
        vi.spyOn(provider as any, 'fetchWithTimeout').mockResolvedValue(response);
        const pending = stream
          ? provider.streamChatCompletion(key, MESSAGES, 'test-model', { signal: controller.signal }).next()
          : provider.chatCompletion(key, MESSAGES, 'test-model', { signal: controller.signal });
        expect(await pending.then(() => null, e => e)).toBe(reason);
      }
    }
  });

  it.each([200, 503] as const)('preserves the first abort cause during HTTP %s body reads', async (status) => {
    for (const winner of ['provider', 'caller'] as const) {
      const caller = new AbortController();
      const reason = newClientAbortError();
      let fetchSignal: AbortSignal | undefined;
      const spy = vi.spyOn(proxy, 'proxyFetch').mockImplementation(async (_url, init) => {
        fetchSignal = init?.signal as AbortSignal;
        return {
          ok: status === 200, status, statusText: 'Service Unavailable', headers: new Headers(),
          json: async () => {
            if (winner === 'caller') caller.abort(reason);
            else if (!fetchSignal!.aborted) await new Promise<void>(resolve => fetchSignal!.addEventListener('abort', () => resolve(), { once: true }));
            if (winner === 'provider') caller.abort(reason);
            // Let the later timeout fire before rejecting, exposing order races.
            await new Promise(resolve => setTimeout(resolve, 30));
            throw new DOMException('The operation was aborted', 'AbortError');
          },
        } as Response;
      });
      try {
        const err = await makeProvider('http://unused.invalid').chatCompletion('key', MESSAGES, 'test-model', { signal: caller.signal, timeoutMs: 10 }).then(() => null, e => e);
        expect(fetchSignal?.aborted).toBe(true);
        if (winner === 'caller') expect(err).toBe(reason);
        else {
          expect(err).not.toBe(reason);
          expect(isClientAbortError(err)).toBe(false);
          expect(err?.name).toBe('AbortError');
        }
      } finally {
        spy.mockRestore();
      }
    }
  });

  it.each([200, 503] as const)('does not infer caller ownership without a fetch signal for HTTP %s', async (status) => {
    const provider = makeProvider('http://unused.invalid');
    const caller = new AbortController();
    const reason = newClientAbortError();
    vi.spyOn(provider as any, 'fetchWithTimeout').mockResolvedValue({
      ok: status === 200, status, statusText: 'Service Unavailable', headers: new Headers(),
      json: async () => { caller.abort(reason); throw new DOMException('The operation was aborted', 'AbortError'); },
    });
    const err = await provider.chatCompletion('key', MESSAGES, 'test-model', { signal: caller.signal }).then(() => null, e => e);
    expect(err).not.toBe(reason);
    expect(isClientAbortError(err)).toBe(false);
  });

  it('does not replace an unrelated parse error when abort races with a non-2xx body read', async () => {
    const provider = makeProvider('http://unused.invalid');
    const controller = new AbortController();
    const reason = Object.assign(new Error('first-byte timeout'), { attemptTtfbTimeout: true });
    vi.spyOn(provider as any, 'fetchWithTimeout').mockResolvedValue({
      ok: false, status: 503, statusText: 'Service Unavailable', headers: new Headers(),
      json: async () => { controller.abort(reason); throw new SyntaxError('bad JSON'); },
    });
    const err = await provider.chatCompletion('key', MESSAGES, 'test-model', { signal: controller.signal }).then(() => null, e => e);
    expect(err).not.toBe(reason);
    expect(err.message).toContain('503');
  });

  it('per-attempt timeout still fires on slow headers', async () => {
    // Upstream never writes headers — the historical fetchWithTimeout contract.
    upstream = await startUpstream(() => { /* never respond */ });
    const provider = makeProvider(upstream.url);

    const startedAt = Date.now();
    const err = await provider
      .chatCompletion('test-key', MESSAGES, 'test-model', { timeoutMs: 300 })
      .then(() => null, e => e);

    expect(err).not.toBeNull();
    expect(/aborted/i.test(err.message)).toBe(true);
    // A timeout is a provider-health signal — it must NOT read as client-caused.
    expect(isClientAbortError(err)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('per-attempt timeout now also fires on a hung body read', async () => {
    // 200 arrives instantly (so the old header-scoped timer is disarmed), but
    // the JSON body never completes. The 'request'-bounds deadline must abort
    // res.json() instead of hanging the attempt forever.
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":"chatcmpl-hang","choices":[');
    });
    const provider = makeProvider(upstream.url);

    const startedAt = Date.now();
    const err = await provider
      .chatCompletion('test-key', MESSAGES, 'test-model', { timeoutMs: 300 })
      .then(() => null, e => e);

    expect(err).not.toBeNull();
    // Must surface as an abort/timeout, not as the "non-OpenAI-compatible
    // endpoint" body-parse diagnosis (isAbortLikeError rethrow in the adapter).
    expect(/aborted/i.test(err.message)).toBe(true);
    expect(isClientAbortError(err)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    await upstream.closed;
  });

  it('a completed request is unaffected by a later client abort', async () => {
    // Guard against over-eager wiring: abort AFTER the response is fully
    // consumed must not retro-fail anything (the timer in 'request' bounds is
    // never cleared, so this exercises the fire-after-completion no-op too).
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-ok', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
    const provider = makeProvider(upstream.url);

    const clientAbort = new AbortController();
    const result = await provider.chatCompletion('test-key', MESSAGES, 'test-model', { signal: clientAbort.signal });
    clientAbort.abort(newClientAbortError());
    expect(result.choices[0]?.message?.content).toBe('done');
  });
});
