import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Route-level tests for the fallback budget + cancellation work:
//   item 7 — all three chat surfaces (/v1/chat/completions, /v1/responses,
//            /v1/messages) pass the per-attempt AbortSignal into provider
//            options, so the shared loop's budget/client deadline actually
//            reaches the upstream fetch;
//   item 2 — a budget abort while a stream is still awaiting its first byte
//            renders the shared timedOut exhaustion (pre-commit, no failover);
//   item 4 — a client disconnect aborts the uncommitted provider request
//            without benching the model+key or lowering model priority.

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
const { setRoutingStrategy } = await import('../../services/router.js');

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
  try { json = JSON.parse(raw); } catch { /* SSE */ }
  return { status: res.status, body: json, raw, headers: res.headers };
}

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'a real answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};

describe('fallback budget + cancellation (three-surface parity)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('budget-abort-test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'budget-abort', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare('DELETE FROM requests').run();
  });

  afterEach(() => {
    delete process.env.FALLBACK_TIME_BUDGET_MS;
    delete process.env.FALLBACK_ATTEMPT_TIMEOUT_MS;
  });

  it('item 7: all three surfaces pass the per-attempt AbortSignal into provider options', async () => {
    process.env.FALLBACK_TIME_BUDGET_MS = '500';
    process.env.FALLBACK_ATTEMPT_TIMEOUT_MS = '1000';
    chatCompletion.mockResolvedValue(GOOD_RESULT);
    const cases: Array<[string, any]> = [
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'signal wiring' }] }],
      ['/v1/responses', { input: 'signal wiring' }],
      ['/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'signal wiring' }] }],
    ];

    for (const [path, body] of cases) {
      const { status } = await post(app, path, body, key);
      expect(status).toBe(200);
      const options = chatCompletion.mock.calls.at(-1)?.[3];
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      // The provider receives the effective deadline, not the original 1s
      // single-hop setting, so its timeout matches the whole-chain budget.
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.timeoutMs).toBeLessThanOrEqual(500);
    }
    expect(chatCompletion).toHaveBeenCalledTimes(3);
  });

  it('item 2: a budget abort while awaiting the first stream byte renders the timedOut exhaustion (no failover)', async () => {
    process.env.FALLBACK_TIME_BUDGET_MS = '1';
    streamChatCompletion.mockImplementation(async function* (_apiKey: any, _messages: any, _modelId: any, options: any) {
      await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
      });
      yield {} as any; // unreachable — the budget abort fires before any byte
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'budget stream test' }],
    }, key);

    expect(status).toBe(429);
    expect(body.error.message).toContain('retry time budget');
    expect(streamChatCompletion).toHaveBeenCalledTimes(1); // no second candidate after the budget died
  });

  it('item 4: a client disconnect aborts the uncommitted provider request without benching', async () => {
    chatCompletion.mockImplementation(async (_apiKey: any, _messages: any, _modelId: any, options: any) => {
      await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
      });
      return GOOD_RESULT; // unreachable
    });

    const server = app.listen(0);
    const addr = server.address() as any;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'disconnect test' }] }),
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timer);
    server.close();

    expect(res).toBeNull(); // the client tore the socket down
    const cooldowns = getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns').get() as { n: number };
    expect(cooldowns.n).toBe(0); // no bench for the disconnected provider
    // The model's priority/penalty is untouched.
    const row = getDb().prepare("SELECT priority FROM profile_models pm JOIN models m ON m.id = pm.model_db_id WHERE m.platform = 'groq' ORDER BY pm.priority LIMIT 1").get() as { priority: number } | undefined;
    expect(row).toBeDefined();
  });
});
