/**
 * Keeps the test-suite's ephemeral servers on ports `fetch()` will actually
 * talk to (loaded via vitest `setupFiles`).
 *
 * 52 call sites across 42 test files do `app.listen(0)` and then fetch
 * `http://127.0.0.1:${address().port}`. `fetch()` refuses a fixed list of
 * ports outright — undici rejects them with `TypeError: fetch failed` /
 * `Caused by: Error: bad port`, before any connection is attempted. That is
 * normally invisible, because the default Windows dynamic port range starts at
 * 49152 and the blocklist tops out at 10080. This host's range is 1024-15000
 * (`netsh int ipv4 show dynamicport tcp`), so the OS can and does hand out a
 * blocked port: 1 hit per ~300 binds, measured.
 *
 * A full run makes hundreds of binds, so that surfaced as exactly one or two
 * failures per run, in a different file each time, with every one of those
 * files passing when re-run on its own — the same signature as the unbounded
 * provider latency that `offline-fetch.ts` fixed, but a separate cause.
 *
 * So: when the OS offers a blocked port, hand it back and ask for another one.
 * `close()` drops the handle synchronously, which is what lets callers keep
 * reading `server.address()` on the line after `listen()` returns.
 */

import http from 'node:http';

/** https://fetch.spec.whatwg.org/#bad-port — mirrored by undici. */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

const nativeListen = http.Server.prototype.listen;

function boundPort(server: http.Server): number {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : 0;
}

/**
 * `isBlocked` and `maxAttempts` exist so the behaviour is testable without
 * waiting for the OS to volunteer a blocked port.
 */
export function installFetchablePortPatch(
  isBlocked: (port: number) => boolean = port => FETCH_BLOCKED_PORTS.has(port),
  maxAttempts = 25,
): void {
  http.Server.prototype.listen = function patchedListen(
    this: http.Server,
    ...args: unknown[]
  ) {
    // Only an OS-assigned port can surprise us; an explicit one is the caller's call.
    if (args[0] !== 0) return nativeListen.apply(this, args as never);

    // We drive the caller's callback ourselves, so a discarded bind can't fire it.
    const onListening = args.find(arg => typeof arg === 'function') as
      | ((...cbArgs: unknown[]) => void)
      | undefined;
    const bindArgs = onListening ? args.filter(arg => arg !== onListening) : args;

    const bind = (attempt: number): void => {
      nativeListen.apply(this, bindArgs as never);

      const settle = (alreadyListening: boolean): void => {
        const port = boundPort(this);
        // Out of attempts: keep the bind and let the test report the real
        // failure rather than hiding it behind a helper that gave up quietly.
        if (port && isBlocked(port) && attempt + 1 < maxAttempts) {
          this.close();
          bind(attempt + 1);
          return;
        }
        if (!onListening) return;
        if (alreadyListening) onListening();
        else this.once('listening', onListening);
      };

      // A bare numeric port binds synchronously; a host argument goes through
      // dns.lookup first, so the port only exists once 'listening' fires.
      if (boundPort(this)) settle(false);
      else this.once('listening', () => settle(true));
    };

    bind(0);
    return this;
  } as typeof http.Server.prototype.listen;
}

installFetchablePortPatch();
