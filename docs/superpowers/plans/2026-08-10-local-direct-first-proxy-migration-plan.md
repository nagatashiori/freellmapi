# Local direct-first proxy migration implementation plan

> **For the implementation agent:** REQUIRED SUB-SKILL: Use `test-driven-development` for each behavior change and run the listed verification after every task.

**Goal:** Run FreeLLMAPI on `192.168.1.111:3001` with direct-first outbound routing, falling back to the local Mihomo proxy only for transport failures, while preserving the existing database and Provider behavior.

**Design:** `docs/superpowers/specs/2026-08-10-local-direct-first-proxy-migration-design.md`

## Task 1: Add direct-first routing tests and a narrow route-mode seam

**Files:**
- Modify: `server/src/__tests__/lib/proxy.test.ts`
- Modify: `server/src/lib/proxy.ts`
- Modify: `server/src/__tests__/routes/settings.test.ts` if the existing settings test harness covers proxy settings

**Steps:**

1. Add a failing test where direct `fetch` rejects, the proxy attempt receives an undici dispatcher, and the successful response is returned.
2. Add a failing test proving a direct HTTP 401 is returned without a proxy retry.
3. Add a failing test proving a local/private target never uses the proxy, even when direct transport fails.
4. Add a failing test proving an already-aborted caller signal never starts the proxy attempt.
5. Preserve tests for explicit bypass and disabled proxy behavior.
6. Implement the smallest state/accessor seam: default `direct-first`, compatibility modes `proxy-only` and `direct-only`, and persisted `proxy_mode` hydration/update without changing existing settings defaults.
7. Run `npm run test -w server -- --run server/src/__tests__/lib/proxy.test.ts` and confirm the new tests pass.

## Task 2: Implement direct-first dispatch with safe fallback

**Files:**
- Modify: `server/src/lib/proxy.ts`
- Modify: `server/src/__tests__/lib/proxy.test.ts`

**Steps:**

1. Add destination classification for loopback, link-local, private IPv4/IPv6, and the configured LAN host; keep custom-provider SSRF checks intact.
2. Split one request into direct and proxy dispatch paths without changing the caller's `RequestInit` body, headers, signal, or redirect behavior.
3. In `direct-first`, return any direct HTTP response immediately; retry through proxy only for a transport rejection/timeout and only if proxy is enabled/configured and the caller signal is not aborted.
4. Do not retry a direct `Response` with any status, preventing duplicate POST side effects for authentication or business errors.
5. Log only platform, request type, destination host, and route outcome; never log URL query values, Authorization headers, request bodies, or proxy credentials.
6. Run the focused proxy tests, then the full server test suite.

## Task 3: Route remaining external fetch call sites through the shared policy

**Files:**
- Modify: `server/src/services/catalog-sync.ts`
- Modify: `server/src/routes/premium.ts`
- Modify: `server/src/routes/keys.ts`
- Modify: `server/src/lib/db-backup.ts`
- Add or modify focused tests for catalog, premium, custom discovery, and DB backup request routing where coverage exists

**Steps:**

1. Replace only external-service bare `fetch` calls with `proxyFetch`, passing a stable platform label and the appropriate request type/timeout.
2. Keep local test-server fetches, documentation-page browser fetches, and test code unchanged.
3. Preserve redirect-manual behavior for custom discovery and all existing response/error handling.
4. Run focused tests for each touched module and then `npm run test -w server`.

## Task 4: Build and prepare a reversible local runtime

**Files:**
- Modify: `HANDOVER.md`
- Add: local runtime unit/configuration only if required by the host

**Steps:**

1. Run `npm test` and `npm run build` from a clean source worktree.
2. Back up the VPS database, `-wal`, `-shm`, compose/environment metadata, and container state without printing secrets.
3. Copy the built project, database files, and secret environment material to `192.168.1.111` without committing or displaying them.
4. Install/use a user-local Node.js runtime compatible with `>=20.18.0 <25.0.0`; do not require a new system package unless the user supplies elevated access.
5. Start a user-level service with `HOST=192.168.1.111`, `PORT=3001`, the copied DB path, cleared generic proxy variables, and the app proxy URL `http://127.0.0.1:7890`.
6. Verify local `/api/ping`, WebUI HTML/assets, authentication setup state, and service restart behavior.

## Task 5: Validate Provider/API routing and stop only the VPS application container

**Files:**
- Modify: `HANDOVER.md`

**Steps:**

1. From the local host, test every configured Provider/API with its migrated credentials using the existing validation paths; record direct success, direct-to-proxy fallback, authentication/business failure, and unavailable cases.
2. Test embeddings, media, catalog/license calls, custom model discovery, and the WebUI API path where configured.
3. Confirm the local database still has the same Provider/model/priority state and no routing reorder occurred.
4. From the user LAN, open `http://192.168.1.111:3001` and perform one real chat request.
5. Only after local verification succeeds, run `docker stop freellmapi-freellmapi-1` on the VPS. Do not remove the container, volume, image, or host.
6. Verify VPS SSH/host health, container stopped state, and retained data; verify local WebUI remains available.
7. Append the final Session to `HANDOVER.md`, then commit/push named source and handover files only.
