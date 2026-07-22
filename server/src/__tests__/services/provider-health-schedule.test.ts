import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb, setSetting } from '../../db/index.js';
import {
  MAX_PROVIDER_HEALTH_INTERVAL_MS,
  MIN_PROVIDER_HEALTH_INTERVAL_MS,
  PROVIDER_HEALTH_SCHEDULE_SETTING_KEY,
  calculateProviderHealthNextRunAt,
  getDueProviderHealthSchedules,
  hasRecentCustomerTraffic,
  listProviderHealthSchedules,
  saveProviderHealthSchedule,
} from '../../services/provider-health-schedule.js';

function addKey(platform: string, enabled = 1, baseUrl: string | null = null): number {
  const result = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, 'test', 'secret-ciphertext', 'secret-iv', 'secret-tag', 'unknown', ?, ?)
  `).run(platform, enabled, baseUrl);
  return Number(result.lastInsertRowid);
}

describe('provider health schedules', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM api_keys WHERE platform LIKE 'schedule-test-%'").run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM settings WHERE key = ?').run(PROVIDER_HEALTH_SCHEDULE_SETTING_KEY);
  });

  it('returns every configured provider disabled by default', () => {
    addKey('schedule-test-default');
    expect(listProviderHealthSchedules()).toContainEqual({
      platform: 'schedule-test-default',
      enabled: false,
      intervalMs: null,
      lastRunAt: null,
      nextRunAt: null,
    });
  });

  it('round-trips a schedule and applies 0-20% jitter', () => {
    addKey('schedule-test-roundtrip', 1, 'https://credentials-must-not-leak.invalid');
    const now = Date.UTC(2026, 6, 23, 0, 0, 0);
    const schedule = saveProviderHealthSchedule(
      'schedule-test-roundtrip',
      { enabled: true, intervalMs: 60_000 },
      now,
      () => 0.5,
    );

    expect(schedule.enabled).toBe(true);
    expect(schedule.intervalMs).toBe(60_000);
    expect(schedule.nextRunAt).toBe(new Date(now + 66_000).toISOString());
    expect(listProviderHealthSchedules().find(row => row.platform === schedule.platform)).toEqual(schedule);
  });

  it('strictly validates interval numbers and boundaries', () => {
    addKey('schedule-test-validation');
    expect(() => saveProviderHealthSchedule('schedule-test-validation', {
      enabled: true,
      intervalMs: String(MIN_PROVIDER_HEALTH_INTERVAL_MS),
    })).toThrow(/intervalMs/);
    expect(() => saveProviderHealthSchedule('schedule-test-validation', {
      enabled: true,
      intervalMs: MIN_PROVIDER_HEALTH_INTERVAL_MS - 1,
    })).toThrow(/intervalMs/);
    expect(() => saveProviderHealthSchedule('schedule-test-validation', {
      enabled: true,
      intervalMs: MAX_PROVIDER_HEALTH_INTERVAL_MS + 1,
    })).toThrow(/intervalMs/);
  });

  it('treats malformed saved JSON as disabled and logs it once', () => {
    addKey('schedule-test-malformed');
    setSetting(PROVIDER_HEALTH_SCHEDULE_SETTING_KEY, '{not-json');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(listProviderHealthSchedules().find(row => row.platform === 'schedule-test-malformed')?.enabled).toBe(false);
    expect(listProviderHealthSchedules().find(row => row.platform === 'schedule-test-malformed')?.enabled).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('selects only schedules whose persisted nextRunAt is due', () => {
    addKey('schedule-test-due');
    const now = Date.UTC(2026, 6, 23, 0, 0, 0);
    saveProviderHealthSchedule('schedule-test-due', { enabled: true, intervalMs: 60_000 }, now, () => 0);
    expect(getDueProviderHealthSchedules(now + 59_999).map(row => row.platform)).not.toContain('schedule-test-due');
    expect(getDueProviderHealthSchedules(now + 60_000).map(row => row.platform)).toContain('schedule-test-due');
  });

  it('counts recent customer traffic but excludes probe rows', () => {
    const db = getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, request_type, created_at)
      VALUES ('schedule-test-traffic', 'm', 'ok', 1, 'probe', ?)
    `).run(new Date(now - 1_000).toISOString());
    expect(hasRecentCustomerTraffic(now)).toBe(false);

    db.prepare(`
      INSERT INTO requests (platform, model_id, status, latency_ms, request_type, created_at)
      VALUES ('schedule-test-traffic', 'm', 'success', 1, 'chat', ?)
    `).run(new Date(now - 1_000).toISOString());
    expect(hasRecentCustomerTraffic(now)).toBe(true);
  });

  it('clamps random jitter input without exceeding twenty percent', () => {
    const now = Date.UTC(2026, 6, 23, 0, 0, 0);
    expect(calculateProviderHealthNextRunAt(100_000, now, () => 99))
      .toBe(new Date(now + 120_000).toISOString());
    expect(calculateProviderHealthNextRunAt(100_000, now, () => Number.NaN))
      .toBe(new Date(now + 100_000).toISOString());
  });
});
