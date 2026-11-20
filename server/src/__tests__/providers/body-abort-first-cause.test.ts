import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { isRetryableError } from '../../lib/error-classify.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('body failure before a later caller abort', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([
    [200, 'aborted'], [200, 'aborted-reset'], [200, 'reset'],
    [503, 'aborted'], [503, 'aborted-reset'], [503, 'reset'],
  ] as const)('preserves first body error or HTTP %s (%s)', async (status, kind) => {
    const upstream = Object.assign(new Error(kind === 'reset' ? 'socket hang up' : 'aborted'), kind !== 'aborted' ? { code: 'ECONNRESET' } : {});
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), {
      status, headers: { 'content-type': 'application/json' },
    });
    const json = response.json.bind(response);
    vi.spyOn(response, 'json').mockImplementation(() => { const result = json(); reading(); return result; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const caller = new AbortController();
    const local = Object.assign(new Error('local timeout'), { attemptTtfbTimeout: true });
    const provider = new OpenAICompatProvider({ platform: 'groq', name: 'FirstCause', baseUrl: 'http://unused.invalid' });
    const pending = provider.chatCompletion('key', messages, 'model', { signal: caller.signal });
    await started;
    body.error(upstream);
    caller.abort(local);
    const error = await pending.then(() => null, err => err);
    expect(error).not.toBe(local);
    if (status === 200) {
      expect(error).toBe(upstream);
      expect(isRetryableError(error)).toBe(true);
    } else {
      expect(error.status).toBe(503);
    }
  });

  it.each([200, 503] as const)('keeps direct and immediate-cause marker identities for HTTP %s', async status => {
    for (const wrapped of [false, true]) {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      let reading!: () => void;
      const started = new Promise<void>(resolve => { reading = resolve; });
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { status });
      const json = response.json.bind(response);
      vi.spyOn(response, 'json').mockImplementation(() => { const result = json(); reading(); return result; });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      const caller = new AbortController();
      const local = Object.assign(new Error('local timeout'), { attemptTtfbTimeout: true });
      const original = wrapped ? new Error('body failure', { cause: local }) : local;
      const provider = new OpenAICompatProvider({ platform: 'groq', name: 'FirstCause', baseUrl: 'http://unused.invalid' });
      const pending = provider.chatCompletion('key', messages, 'model', { signal: caller.signal });
      await started;
      body.error(original);
      caller.abort(local);
      expect(await pending.then(() => null, err => err)).toBe(original);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it.each([
    [200, 'clientAbort', false], [200, 'clientAbort', true],
    [200, 'hedgeAbort', false], [200, 'hedgeAbort', true],
    [503, 'clientAbort', false], [503, 'clientAbort', true],
    [503, 'hedgeAbort', false], [503, 'hedgeAbort', true],
  ] as const)('preserves HTTP %s %s marker identity (wrapped=%s)', async (status, marker, wrapped) => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { status });
    const json = response.json.bind(response);
    vi.spyOn(response, 'json').mockImplementation(() => { const result = json(); reading(); return result; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const marked = Object.assign(new Error('marked'), { [marker]: true });
    const original = wrapped ? new Error('wrapper', { cause: marked }) : marked;
    const provider = new OpenAICompatProvider({ platform: 'groq', name: 'FirstCause', baseUrl: 'http://unused.invalid' });
    const pending = provider.chatCompletion('key', messages, 'model');
    await started;
    body.error(original);
    expect(await pending.then(() => null, err => err)).toBe(original);
  });

  it.each(['clientAbort', 'hedgeAbort', 'attemptTtfbTimeout'] as const)('does not trust a deep or non-boolean %s marker', async marker => {
    for (const wrapped of [false, true]) {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      let reading!: () => void;
      const started = new Promise<void>(resolve => { reading = resolve; });
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { status: 503 });
      const json = response.json.bind(response);
      vi.spyOn(response, 'json').mockImplementation(() => { const result = json(); reading(); return result; });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      const marked = Object.assign(new Error('marked'), { [marker]: wrapped ? true : 'true' });
      const original = wrapped ? new Error('outer', { cause: new Error('inner', { cause: marked }) }) : marked;
      const provider = new OpenAICompatProvider({ platform: 'groq', name: 'FirstCause', baseUrl: 'http://unused.invalid' });
      const pending = provider.chatCompletion('key', messages, 'model');
      await started;
      body.error(original);
      const error = await pending.then(() => null, err => err);
      expect(error.status).toBe(503);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
