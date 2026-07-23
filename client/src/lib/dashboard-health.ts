export type DashboardHealthKey = 'ok' | 'error' | 'limited' | 'probing' | 'disabled' | 'unknown';

export interface DashboardHealthTone {
  key: DashboardHealthKey;
  color: string;
}

export function isDashboardHealthy(status: string | undefined | null): boolean {
  return status === 'ok' || status === 'success' || status === 'ready';
}

export function isDashboardIssue(status: string | undefined | null): boolean {
  return status === 'error' || status === 'timeout' || status === 'unhealthy';
}

export function isDashboardLimited(status: string | undefined | null): boolean {
  return status === 'rate_limited' || status === 'cooling';
}

export function dashboardHealthTone(status: string | undefined | null): DashboardHealthTone {
  if (status === 'probing') return { key: 'probing', color: '#6b7280' };
  if (isDashboardHealthy(status)) return { key: 'ok', color: '#4ade80' };
  if (isDashboardIssue(status)) return { key: 'error', color: '#f87171' };
  if (isDashboardLimited(status)) return { key: 'limited', color: '#fbbf24' };
  if (status === 'stale') return { key: 'unknown', color: '#60a5fa' };
  if (status === 'disabled') return { key: 'disabled', color: '#6b7280' };
  return { key: 'unknown', color: '#6b7280' };
}
