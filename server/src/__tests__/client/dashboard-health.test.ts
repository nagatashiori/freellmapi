import { describe, expect, it } from 'vitest';
import {
  dashboardHealthTone,
  isDashboardHealthy,
  isDashboardIssue,
  isDashboardLimited,
} from '../../../../client/src/lib/dashboard-health.js';

describe('dashboard health status mapping', () => {
  it('treats router health states as dashboard colors and counts', () => {
    expect(isDashboardHealthy('ready')).toBe(true);
    expect(isDashboardHealthy('ok')).toBe(true);
    expect(isDashboardHealthy('success')).toBe(true);

    expect(isDashboardIssue('unhealthy')).toBe(true);
    expect(isDashboardIssue('error')).toBe(true);
    expect(isDashboardIssue('timeout')).toBe(true);

    expect(isDashboardLimited('cooling')).toBe(true);
    expect(isDashboardLimited('rate_limited')).toBe(true);

    expect(dashboardHealthTone('ready')).toMatchObject({ key: 'ok', color: '#4ade80' });
    expect(dashboardHealthTone('unhealthy')).toMatchObject({ key: 'error', color: '#f87171' });
    expect(dashboardHealthTone('cooling')).toMatchObject({ key: 'limited', color: '#fbbf24' });
    expect(dashboardHealthTone('stale')).toMatchObject({ key: 'unknown', color: '#60a5fa' });
    expect(dashboardHealthTone('disabled')).toMatchObject({ key: 'disabled', color: '#6b7280' });
  });
});
