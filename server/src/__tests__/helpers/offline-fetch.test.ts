import { describe, it, expect } from 'vitest';
import http from 'node:http';

/**
 * Locks in the offline guard installed by `offline-fetch.ts`. Without it a
 * slow public-internet handshake inside a route test blows the 5s per-test
 * timeout, which is what made full runs fail once per run in a random file.
 */
describe('test-suite offline guard', () => {
  it('rejects an outbound request to a public host', async () => {
    await expect(fetch('https://api.groq.com/openai/v1/models')).rejects.toThrow('fetch failed');
  });

  it('still allows requests to a loopback test server', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });
});
