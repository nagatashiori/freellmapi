import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FETCH_BLOCKED_PORTS, installFetchablePortPatch } from './fetchable-port.js';

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

function close(server: http.Server): Promise<void> {
  return new Promise<void>(resolve => server.close(() => resolve()));
}

afterEach(() => {
  // Back to the real blocklist for the rest of the process.
  installFetchablePortPatch();
});

describe('fetchable ephemeral ports', () => {
  it('rebinds when the OS hands back a port fetch() refuses to talk to', async () => {
    const offered: number[] = [];
    installFetchablePortPatch(port => {
      offered.push(port);
      return offered.length === 1;
    });

    const server = http.createServer((_req, res) => res.end('ok'));
    server.listen(0);
    const port = portOf(server);

    expect(offered).toHaveLength(2);
    expect(port).toBe(offered[1]);
    expect(port).not.toBe(offered[0]);
    expect(server.listening).toBe(true);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);

    await close(server);
  });

  it('runs a bare listen(0, cb) callback exactly once across a rebind', async () => {
    const offered: number[] = [];
    installFetchablePortPatch(port => {
      offered.push(port);
      return offered.length === 1;
    });

    const server = http.createServer((_req, res) => res.end('ok'));
    let calls = 0;
    await new Promise<void>(resolve => {
      server.listen(0, () => {
        calls += 1;
        resolve();
      });
    });

    expect(offered).toHaveLength(2);
    expect(portOf(server)).toBe(offered[1]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(1);

    await close(server);
  });

  it('runs a host-qualified listen callback exactly once across a rebind', async () => {
    const offered: number[] = [];
    installFetchablePortPatch(port => {
      offered.push(port);
      return offered.length < 3;
    });

    const server = http.createServer((_req, res) => res.end('ok'));
    let calls = 0;
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        calls += 1;
        resolve();
      });
    });

    expect(offered).toHaveLength(3);
    expect(calls).toBe(1);
    // The discarded binds must not leave stale 'listening' listeners behind.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(1);

    await close(server);
  });

  it('leaves an explicitly requested port alone', async () => {
    const probe = http.createServer();
    probe.listen(0);
    const explicit = portOf(probe);
    await close(probe);

    const offered: number[] = [];
    installFetchablePortPatch(port => {
      offered.push(port);
      return false;
    });

    const server = http.createServer();
    const errors: Error[] = [];
    server.on('error', error => errors.push(error));
    server.listen(explicit);

    expect(portOf(server)).toBe(explicit);
    expect(offered).toEqual([]);
    expect(errors).toEqual([]);

    await close(server);
  });

  it('blocks the ports undici rejects inside this host’s dynamic range', () => {
    // Measured: binding these and fetching them fails with `bad port`.
    expect(FETCH_BLOCKED_PORTS.has(2049)).toBe(true);
    expect(FETCH_BLOCKED_PORTS.has(6000)).toBe(true);
    expect(FETCH_BLOCKED_PORTS.has(10080)).toBe(true);
    // Measured: these answer 200, so rebinding off them would be pointless churn.
    expect(FETCH_BLOCKED_PORTS.has(1234)).toBe(false);
    expect(FETCH_BLOCKED_PORTS.has(9999)).toBe(false);
  });
});
