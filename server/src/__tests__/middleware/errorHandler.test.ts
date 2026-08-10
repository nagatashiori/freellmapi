import { describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { errorHandler } from '../../middleware/errorHandler.js';

async function startApp(app: Express): Promise<{ server: ReturnType<Express['listen']>; url: string }> {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('errorHandler', () => {
  it('explains when an HTTP request line was sent as the JSON body', async () => {
    const app = express();
    app.use(express.json());
    app.post('/v1/messages', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    const { server, url } = await startApp(app);

    try {
      const response = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'POST http://127.0.0.1:3001/v1/messages HTTP/1.1',
      });
      const body = await response.json() as { error: { code: string; type: string; message: string } };

      expect(response.status).toBe(400);
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('invalid_json_body');
      expect(body.error.message).toContain('HTTP request line');
      expect(body.error.message).toContain('/v1/messages');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('returns a stable invalid_json_body error for other malformed JSON', async () => {
    const app = express();
    app.use(express.json());
    app.post('/v1/messages', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    const { server, url } = await startApp(app);

    try {
      const response = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"messages":',
      });
      const body = await response.json() as { error: { code: string; type: string; message: string } };

      expect(response.status).toBe(400);
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('invalid_json_body');
      expect(body.error.message).toContain('valid JSON');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
