import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

const messages: any = [{ role: 'user', content: [
  { type: 'text', text: 'describe' },
  { type: 'image_url', image_url: { url: 'https://image.invalid/one' } },
  { type: 'image_url', image_url: { url: 'https://image.invalid/two' } },
] }];
const gemini = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } });
const image = () => new Response('image', { headers: { 'content-type': 'image/png' } });
const rejectedOnAbort = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const run = (stream: boolean, signal?: AbortSignal) => {
  const provider = new GoogleProvider();
  return stream
    ? provider.streamChatCompletion('key', messages, 'gemini-test', { signal }).next()
    : provider.chatCompletion('key', messages, 'gemini-test', { signal });
};
const bounded = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('test deadline')), 150))]);
afterEach(() => vi.restoreAllMocks());

describe.each([false, true])('Google image conversion stream=%s', stream => {
  it('passes first caller abort through a stalled second image and skips Gemini', async () => {
    const attempt = new AbortController(), client = new AbortController();
    const signal = AbortSignal.any([attempt.signal, client.signal]);
    const first = new Error('attempt deadline'), second = new Error('client gone');
    let started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/one')) return image();
      if (String(url).endsWith('/two')) { started(); return rejectedOnAbort(init!.signal as AbortSignal); }
      throw new Error('unexpected Gemini request');
    });
    const result = bounded(run(stream, signal));
    await ready; attempt.abort(first); client.abort(second);
    await expect(result).rejects.toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves client-first abort during image body read', async () => {
    const attempt = new AbortController(), client = new AbortController();
    const signal = AbortSignal.any([attempt.signal, client.signal]);
    const first = new Error('client gone'), second = new Error('attempt deadline');
    let started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => ({
      ok: true, headers: new Headers(), arrayBuffer: () => { started(); return rejectedOnAbort(init!.signal as AbortSignal); },
    }) as Response);
    const result = bounded(run(stream, signal));
    await ready; client.abort(first); attempt.abort(second);
    await expect(result).rejects.toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects if an image body resolves after abort despite ignoring the signal', async () => {
    const caller = new AbortController();
    const reason = new Error('abort while reading');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true, headers: new Headers(), arrayBuffer: async () => { caller.abort(reason); return new ArrayBuffer(1); },
    }) as Response);
    await expect(bounded(run(stream, caller.signal))).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a pre-aborted request without downloading', async () => {
    const reason = new Error('already aborted');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected fetch'); });
    await expect(bounded(run(stream, AbortSignal.abort(reason)))).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('skips ordinary image errors and keeps subsequent image and text', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).endsWith('/one')) throw new Error('network error');
    if (String(url).endsWith('/two')) return image();
    return gemini();
  });
  await run(false);
  expect(fetch).toHaveBeenCalledTimes(3);
  const body = JSON.parse((fetch.mock.calls[2][1] as RequestInit).body as string);
  expect(body.contents[0].parts).toEqual([{ text: 'describe' }, { inlineData: { mimeType: 'image/png', data: Buffer.from('image').toString('base64') } }]);
});

it('keeps the image-only timeout as a skippable failure', async () => {
  const imageTimeout = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(imageTimeout.signal);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/one')) { queueMicrotask(() => imageTimeout.abort(new DOMException('timeout', 'TimeoutError'))); return rejectedOnAbort(init!.signal as AbortSignal); }
    if (String(url).endsWith('/two')) return image();
    return gemini();
  });
  await run(false, new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(3);
});
