import { getDb, getSetting, setSetting } from '../db/index.js';

export const PROVIDER_HEALTH_SCHEDULE_SETTING_KEY = 'provider_health_schedules';
export const PROVIDER_HEALTH_SCHEDULE_VERSION = 1 as const;
export const MIN_PROVIDER_HEALTH_INTERVAL_MS = 60_000;
export const MAX_PROVIDER_HEALTH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROVIDER_HEALTH_BUSY_WINDOW_MS = 60_000;
export const PROVIDER_HEALTH_BUSY_POSTPONE_MS = 60_000;

// How far past its real due time a schedule may be deferred by customer traffic
// before it runs anyway. Yielding to traffic is a 60s postpone, and the busy
// check looks back 60s, so a gateway serving more than one request per minute
// would postpone every provider forever — which is exactly how the whole chain
// went stale. Past this grace period a probe pass wins over the courtesy delay:
// one "Say OK" per model is cheaper than routing blind.
export const PROVIDER_HEALTH_MAX_DEFER_MS = 30 * 60 * 1000;

export interface ProviderHealthSchedule {
  platform: string;
  enabled: boolean;
  intervalMs: number | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  // When the busy-window courtesy first pushed this schedule back. Set on the
  // first postpone, cleared on a completed run — so it measures one continuous
  // stretch of being crowded out, which is what the starvation guard needs.
  deferredSince: string | null;
}

interface StoredProviderHealthSchedule {
  enabled: boolean;
  intervalMs: number | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  deferredSince: string | null;
}

interface ProviderHealthScheduleStore {
  version: typeof PROVIDER_HEALTH_SCHEDULE_VERSION;
  providers: Record<string, StoredProviderHealthSchedule>;
}

export class ProviderHealthScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderHealthScheduleValidationError';
  }
}

let malformedStoreLogged = false;

function emptyStore(): ProviderHealthScheduleStore {
  return { version: PROVIDER_HEALTH_SCHEDULE_VERSION, providers: {} };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeStoredSchedule(value: unknown): StoredProviderHealthSchedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const intervalMs = typeof row.intervalMs === 'number'
    && Number.isInteger(row.intervalMs)
    && row.intervalMs >= MIN_PROVIDER_HEALTH_INTERVAL_MS
    && row.intervalMs <= MAX_PROVIDER_HEALTH_INTERVAL_MS
    ? row.intervalMs
    : null;

  return {
    // Invalid saved data cannot authorize automatic upstream traffic.
    enabled: row.enabled === true && intervalMs != null,
    intervalMs,
    lastRunAt: isTimestamp(row.lastRunAt) ? row.lastRunAt : null,
    nextRunAt: isTimestamp(row.nextRunAt) ? row.nextRunAt : null,
    deferredSince: isTimestamp(row.deferredSince) ? row.deferredSince : null,
  };
}

function readStore(): ProviderHealthScheduleStore {
  const raw = getSetting(PROVIDER_HEALTH_SCHEDULE_SETTING_KEY);
  if (!raw) return emptyStore();

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.version !== PROVIDER_HEALTH_SCHEDULE_VERSION
      || !parsed.providers
      || typeof parsed.providers !== 'object'
      || Array.isArray(parsed.providers)
    ) {
      throw new Error('unsupported provider health schedule format');
    }

    const providers: Record<string, StoredProviderHealthSchedule> = {};
    for (const [platform, value] of Object.entries(parsed.providers as Record<string, unknown>)) {
      const normalized = normalizeStoredSchedule(value);
      if (normalized) providers[platform] = normalized;
    }
    return { version: PROVIDER_HEALTH_SCHEDULE_VERSION, providers };
  } catch (err: any) {
    if (!malformedStoreLogged) {
      malformedStoreLogged = true;
      console.error(`[ProviderHealth] Ignoring malformed saved schedule JSON: ${err?.message ?? err}`);
    }
    return emptyStore();
  }
}

function writeStore(store: ProviderHealthScheduleStore): void {
  setSetting(PROVIDER_HEALTH_SCHEDULE_SETTING_KEY, JSON.stringify(store));
}

function disabledSchedule(platform: string): ProviderHealthSchedule {
  return {
    platform,
    enabled: false,
    intervalMs: null,
    lastRunAt: null,
    nextRunAt: null,
    deferredSince: null,
  };
}

function toView(platform: string, value: StoredProviderHealthSchedule | undefined): ProviderHealthSchedule {
  return value ? { platform, ...value } : disabledSchedule(platform);
}

export function validateProviderHealthInterval(intervalMs: unknown): number {
  if (
    typeof intervalMs !== 'number'
    || !Number.isInteger(intervalMs)
    || intervalMs < MIN_PROVIDER_HEALTH_INTERVAL_MS
    || intervalMs > MAX_PROVIDER_HEALTH_INTERVAL_MS
  ) {
    throw new ProviderHealthScheduleValidationError(
      `intervalMs must be an integer between ${MIN_PROVIDER_HEALTH_INTERVAL_MS} and ${MAX_PROVIDER_HEALTH_INTERVAL_MS}`,
    );
  }
  return intervalMs;
}

export function calculateProviderHealthNextRunAt(
  intervalMs: number,
  now = Date.now(),
  random: () => number = Math.random,
): string {
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  const jitter = Math.floor(normalized * intervalMs * 0.2);
  return new Date(now + intervalMs + jitter).toISOString();
}

export function listProviderHealthSchedules(): ProviderHealthSchedule[] {
  const rows = getDb().prepare(
    'SELECT DISTINCT platform FROM api_keys ORDER BY platform',
  ).all() as Array<{ platform: string }>;
  const store = readStore();
  return rows.map(row => toView(row.platform, store.providers[row.platform]));
}

export function getProviderHealthSchedule(platform: string): ProviderHealthSchedule {
  return toView(platform, readStore().providers[platform]);
}

export function saveProviderHealthSchedule(
  platform: string,
  input: { enabled: boolean; intervalMs?: unknown },
  now = Date.now(),
  random: () => number = Math.random,
): ProviderHealthSchedule {
  const exists = getDb().prepare(
    'SELECT 1 FROM api_keys WHERE platform = ? LIMIT 1',
  ).get(platform);
  if (!exists) {
    throw new ProviderHealthScheduleValidationError(`Unknown provider platform: ${platform}`);
  }
  if (typeof input.enabled !== 'boolean') {
    throw new ProviderHealthScheduleValidationError('enabled must be a boolean');
  }

  const store = readStore();
  const previous = store.providers[platform];
  let intervalMs: number | null = previous?.intervalMs ?? null;
  if (input.intervalMs !== undefined) {
    intervalMs = validateProviderHealthInterval(input.intervalMs);
  }
  if (input.enabled && intervalMs == null) {
    throw new ProviderHealthScheduleValidationError(
      'intervalMs is required when enabling automatic detection',
    );
  }

  const next: StoredProviderHealthSchedule = {
    enabled: input.enabled,
    intervalMs,
    lastRunAt: previous?.lastRunAt ?? null,
    nextRunAt: input.enabled && intervalMs != null
      ? calculateProviderHealthNextRunAt(intervalMs, now, random)
      : null,
    // An explicit operator save is a fresh start, not a continued deferral.
    deferredSince: null,
  };
  store.providers[platform] = next;
  writeStore(store);
  return toView(platform, next);
}

/**
 * Whether customer traffic has crowded this schedule out for so long that the
 * busy-window courtesy must give way.
 *
 * Measured from `deferredSince` — the first postpone of the current stretch —
 * rather than from `nextRunAt`, which postponeProviderHealthSchedules rewrites on
 * every busy tick and would therefore make a starved schedule look permanently
 * "not yet due". A completed run clears the stamp, so this only ever reports one
 * continuous stretch of being pushed back.
 */
export function isProviderHealthScheduleOverdue(
  schedule: ProviderHealthSchedule,
  now = Date.now(),
): boolean {
  if (!schedule.enabled || schedule.intervalMs == null) return false;
  if (schedule.deferredSince == null) return false;
  const since = Date.parse(schedule.deferredSince);
  if (!Number.isFinite(since)) return false;
  return now - since > PROVIDER_HEALTH_MAX_DEFER_MS;
}

export function getDueProviderHealthSchedules(now = Date.now()): ProviderHealthSchedule[] {
  return listProviderHealthSchedules().filter(schedule => {
    if (!schedule.enabled || schedule.intervalMs == null) return false;
    if (schedule.nextRunAt == null) return true;
    const nextRun = Date.parse(schedule.nextRunAt);
    return !Number.isFinite(nextRun) || nextRun <= now;
  });
}

export function markProviderHealthScheduleFinished(
  platform: string,
  finishedAt = Date.now(),
  random: () => number = Math.random,
): ProviderHealthSchedule {
  // Re-read after the async probe. If an operator changed/disabled the schedule
  // while the probe was running, their newest setting wins.
  const store = readStore();
  const current = store.providers[platform];
  if (!current) return disabledSchedule(platform);

  const next: StoredProviderHealthSchedule = {
    ...current,
    lastRunAt: new Date(finishedAt).toISOString(),
    nextRunAt: current.enabled && current.intervalMs != null
      ? calculateProviderHealthNextRunAt(current.intervalMs, finishedAt, random)
      : null,
    // The run happened, so the starvation clock restarts from zero.
    deferredSince: null,
  };
  store.providers[platform] = next;
  writeStore(store);
  return toView(platform, next);
}

export function postponeProviderHealthSchedules(
  platforms: readonly string[],
  now = Date.now(),
  delayMs = PROVIDER_HEALTH_BUSY_POSTPONE_MS,
): void {
  const store = readStore();
  let changed = false;
  for (const platform of new Set(platforms)) {
    const current = store.providers[platform];
    if (!current?.enabled) continue;
    current.nextRunAt = new Date(now + delayMs).toISOString();
    // Stamp only the FIRST postpone of a stretch: this is the clock the
    // starvation guard reads, so re-stamping it every busy tick would reset it
    // forever and reintroduce the starvation it exists to prevent.
    if (current.deferredSince == null) current.deferredSince = new Date(now).toISOString();
    changed = true;
  }
  if (changed) writeStore(store);
}

export function hasRecentCustomerTraffic(
  now = Date.now(),
  windowMs = PROVIDER_HEALTH_BUSY_WINDOW_MS,
): boolean {
  const threshold = new Date(now - windowMs).toISOString();
  return Boolean(getDb().prepare(`
    SELECT 1
    FROM requests
    WHERE (request_type IS NULL OR request_type != 'probe')
      AND datetime(created_at) >= datetime(?)
    LIMIT 1
  `).get(threshold));
}
