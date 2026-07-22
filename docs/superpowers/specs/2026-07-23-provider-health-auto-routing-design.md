# Provider Health and AUTO Routing Design

Date: 2026-07-23

## Goal

Make health detection and AUTO routing behave as one understandable system:

- each provider has its own operator-controlled automatic health-check setting;
- every provider is unconfigured and disabled by default, without provider-specific exceptions;
- probes avoid competing with customer traffic;
- a successful model probe makes that provider/model member eligible in the active routing profile;
- an unhealthy member is removed from routing after confirmed repeated failures;
- AUTO preserves the operator's profile priority between logical model groups and standalone models;
- members inside one logical model group are tried from lowest measured latency to highest.

## User-visible contract

### Provider automatic detection

The WebUI displays one health-detection control for every provider currently represented by an API key:

- `Automatic detection`: on/off;
- `Interval`: a positive number plus `minutes` or `hours`;
- last automatic check time and next eligible check time.

No provider receives a hard-coded default. A provider with no saved setting is returned as disabled. The operator must explicitly enable it in the WebUI.

Manual `Check` and `Check all` actions remain available and ignore the automatic schedule, because they are explicit operator actions.

Enabling a provider schedule explicitly authorizes health results to maintain AUTO participation for that provider's registered chat models. The WebUI explains that a later successful probe can re-enable a model the operator previously switched off while that provider schedule remains enabled.

### Unified AUTO participation

The user-facing routing control is `Participates in AUTO`. For the active routing profile it represents both internal fields:

- `models.enabled`;
- `profile_models.enabled` for the active profile.

The database fields remain separate for compatibility, but automatic probe transitions update them together in one transaction. Other inactive profiles are not changed.

### Logical model groups

A logical model group contains equivalent model routes from different providers. The profile's manually assigned `priority` determines the position of the group or standalone model in AUTO. Health latency never reorders different groups.

When AUTO expands a logical group, eligible members are ordered by successful probe latency from low to high. Disabled, unhealthy, or cooled members are not selected ahead of healthy members. Existing manual priority is the stable tie-breaker when latency is unavailable or equal.

## Persistence and API

Provider schedules are stored in the existing `settings` table as one versioned JSON value, avoiding a schema migration:

```json
{
  "version": 1,
  "providers": {
    "groq": {
      "enabled": true,
      "intervalMs": 3600000,
      "lastRunAt": "2026-07-23T00:00:00.000Z",
      "nextRunAt": "2026-07-23T01:07:12.000Z"
    }
  }
}
```

The API is hosted under `/api/health/provider-schedules`:

- `GET` returns every provider present in `api_keys`, merging missing entries with `enabled=false`;
- `PUT /:platform` accepts `{ enabled, intervalMs }`;
- `intervalMs` is required when enabling and must be between one minute and seven days;
- unknown platform names are rejected unless they already exist in `api_keys`;
- responses never contain keys, tokens, base URLs, or other credentials.

The old global model-probe interval endpoint remains readable for compatibility during this change, but the WebUI stops presenting it as the automatic provider-health control.

## Scheduler behavior

The scheduler wakes on an inexpensive one-minute tick. On each tick it:

1. loads enabled provider schedules;
2. selects only providers whose persisted `nextRunAt` is due;
3. checks whether customer traffic occurred in the preceding 60 seconds;
4. if busy, postpones due checks without issuing upstream traffic;
5. otherwise chooses one due provider at random;
6. checks that provider's enabled keys and registered chat-model members with bounded concurrency;
7. persists `lastRunAt` and a new randomized `nextRunAt`.

The random jitter is 0–20% of the configured interval and is recalculated after every run. Only one provider is automatically checked per scheduler tick. This avoids synchronized probe bursts.

Customer traffic means a non-probe request recorded within the preceding 60 seconds. Probe rows never count as customer traffic. Manual checks do not use the busy guard. Disabled model rows are still eligible for an automatic probe so that a later success can restore them; disabled API keys remain excluded.

## Probe state transitions

### API key validation

- automatic checks only inspect enabled keys belonging to the selected provider;
- successful validation writes `healthy`;
- confirmed invalid credentials retain the existing three-consecutive-failure disable rule;
- DNS, TLS, timeout, and other transport errors write `error` but do not count as confirmed invalid credentials;
- the provider schedule never silently enables a manually disabled API key.

### Model validation

- `ok`: immediately set `models.enabled=1` and the active profile's `profile_models.enabled=1` in one transaction;
- `error` or `timeout`: disable both fields only when the newest three model-probe rows are all failures;
- `rate_limited`: retain cooldown behavior and do not disable the model;
- a later successful probe immediately restores both active-profile switches;
- inactive profiles are never rewritten.

The probe result returned to the WebUI reflects the post-transition effective AUTO participation state.

Probe history stores the specific probe status (`ok`, `rate_limited`, `timeout`, or `error`) in `requests.status`. Probe rows remain excluded from customer Analytics. This makes the consecutive-failure rule durable across process restarts without confusing rate limiting with an unhealthy model.

## Failure handling

- invalid schedule payloads return HTTP 400 without changing saved configuration;
- malformed saved JSON is treated as all providers disabled and logged once;
- an exception while probing one provider does not block later scheduler ticks;
- schedule timestamps are updated only after the selected provider run finishes;
- if the active profile does not exist, the probe is recorded but no routing switch is changed;
- all writes affecting model and active-profile switches are transactional.

## Expected implementation scope

Server production files:

- `server/src/services/health.ts`
- `server/src/services/model-probe.ts`
- `server/src/services/model-probe-scheduler.ts`
- `server/src/routes/health.ts`
- `server/src/index.ts`

Client production files:

- `client/src/components/keys/provider-list.tsx`
- `client/src/components/keys/shared.tsx`
- `client/src/pages/StatusPage.tsx`

Tests may add or update focused files under:

- `server/src/__tests__/services/`
- `server/src/__tests__/routes/`
- the existing client test location if the project has a matching harness.

`server/src/providers/index.ts` is explicitly out of scope because it contains pre-existing user work.

## Verification

Automated checks must prove:

1. an unconfigured provider is disabled by default;
2. provider schedules round-trip through the API without exposing credentials;
3. a due provider is selected independently and the next run receives jitter;
4. recent customer traffic prevents an automatic probe;
5. a successful model probe enables the model and its active-profile membership only;
6. three consecutive model failures disable those two active switches;
7. `rate_limited` does not disable the model;
8. a later success restores AUTO participation;
9. logical-group members are ordered by successful latency while group-to-group priority remains unchanged;
10. server and client builds pass.

The real-path acceptance is: configure one provider in the WebUI, confirm it remains persisted after restart, observe a scheduled check outside a busy window, and verify that a successful member becomes routable in the active profile without changing another profile or global AUTO priority.

## Non-goals

- no hard-coded Google behavior;
- no automatic profile switching;
- no bulk ranking, recalibration, or rewriting of profile priority;
- no automatic enabling of disabled API keys;
- no database, key, `.env`, secret, or personal data in the handoff archive.
