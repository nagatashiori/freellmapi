/**
 * The server test-suite is offline by design (loaded via vitest `setupFiles`).
 *
 * Several route tests exercise the real key-validation path — `POST /api/keys`
 * probes the new credential inline, and key import does it once per imported
 * key — which used to reach the public internet. That latency is unbounded
 * relative to vitest's 5s per-test timeout, which is exactly why a full run
 * failed once per run, in a different file each time, while every one of those
 * files passed when re-run on its own.
 *
 * Requests to the ephemeral 127.0.0.1 servers the tests spin up still go
 * through. Anything else fails the way an offline host does, which the
 * production code already handles (health check records `error`, the proxy
 * fails over) — so no test needs the network to reach a provider for real.
 */

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']);

const realFetch: typeof fetch = globalThis.fetch;

function targetUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function isLocal(url: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const offlineFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = targetUrl(input);
  if (isLocal(url)) {
    // A loopback call that fails says nothing useful on its own — "fetch failed"
    // with the URL hidden. Naming it turns a mystery into a readable cause
    // (a port of 0 means the caller read address() before the bind landed).
    return realFetch(input as any, init).catch((error: unknown) => {
      const cause = (error as { cause?: { message?: string } })?.cause?.message;
      console.warn(`[test-offline] loopback fetch failed -> ${url}${cause ? ` (${cause})` : ''}`);
      throw error;
    });
  }
  // Surfaced so an accidental new outbound dependency is visible in the run log
  // instead of silently reading as a provider outage.
  console.warn(`[test-offline] blocked outbound fetch -> ${url}`);
  return Promise.reject(new TypeError('fetch failed'));
}) as typeof fetch;

globalThis.fetch = offlineFetch;
