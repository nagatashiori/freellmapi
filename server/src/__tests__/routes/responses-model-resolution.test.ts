import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw };
}

describe('/v1/responses requested model and group resolution', () => {
  let app: Express;
  let apiKey: string;

  beforeAll(() => {
    delete process.env.ENCRYPTION_KEY;
    const db = initDb(':memory:');
    apiKey = getUnifiedApiKey();
    const enc = encrypt('test-secret-key-12345');
    db.prepare(`
      INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', ?, ?, ?, 'healthy', 1)
    `).run(enc.encrypted, enc.iv, enc.authTag);

    app = createApp();
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
  });

  it('returns 400 invalid_request_error if requested model is not in catalog', async () => {
    const res = await post(app, '/v1/responses', {
      model: 'completely-nonexistent-model-xyz',
      input: 'hello',
    }, apiKey);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('model_not_found');
    expect(res.body.error.message).toContain('is not in the catalog');
  });

  it('routes to specific requested catalog model when requested', async () => {
    chatCompletion.mockResolvedValueOnce({
      id: 'resp-1',
      choices: [{ message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });

    const res = await post(app, '/v1/responses', {
      model: 'llama-3.3-70b-versatile',
      input: 'hello',
    }, apiKey);

    expect(res.status).toBe(200);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });
});
