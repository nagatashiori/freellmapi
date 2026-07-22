import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { checkKeyHealth, checkAllKeys } from '../services/health.js';
import { hasProvider } from '../providers/index.js';
import { getQuotaStateForKeys } from '../services/provider-quota.js';
import {
  listProviderHealthSchedules,
  saveProviderHealthSchedule,
  ProviderHealthScheduleValidationError,
  PROVIDER_HEALTH_SCHEDULE_VERSION,
} from '../services/provider-health-schedule.js';

export const healthRouter = Router();

// Provider-level automatic health detection. Responses are derived only from
// platform names and schedule metadata; credentials and endpoint details are
// never selected or serialized here.
healthRouter.get('/provider-schedules', (_req: Request, res: Response) => {
  res.json({ version: PROVIDER_HEALTH_SCHEDULE_VERSION, schedules: listProviderHealthSchedules() });
});

healthRouter.put('/provider-schedules/:platform', (req: Request, res: Response) => {
  try {
    const platform = String(req.params.platform || '').trim();
    const body = req.body as { enabled?: unknown; intervalMs?: unknown } | undefined;
    if (!platform) throw new ProviderHealthScheduleValidationError('platform is required');
    if (!body || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
      throw new ProviderHealthScheduleValidationError('enabled must be a boolean');
    }

    const schedule = saveProviderHealthSchedule(platform, {
      enabled: body.enabled,
      intervalMs: body.intervalMs,
    });
    res.json({ schedule });
  } catch (err: any) {
    if (err instanceof ProviderHealthScheduleValidationError) {
      res.status(400).json({ error: { message: err.message } });
      return;
    }
    throw err;
  }
});

// Get health status for all platforms
healthRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const platforms = db.prepare(`
    SELECT
      platform,
      COUNT(*) as total_keys,
      SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_keys,
      SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_keys,
      SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid_keys,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_keys,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown_keys,
      SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_keys
    FROM api_keys
    GROUP BY platform
  `).all() as any[];

  const keys = db.prepare(`
    SELECT id, platform, label, status, enabled, created_at, last_checked_at
    FROM api_keys
    ORDER BY platform, created_at DESC
  `).all() as any[];

  res.json({
    platforms: platforms.map(p => ({
      platform: p.platform,
      hasProvider: hasProvider(p.platform),
      totalKeys: p.total_keys,
      healthyKeys: p.healthy_keys,
      rateLimitedKeys: p.rate_limited_keys,
      invalidKeys: p.invalid_keys,
      errorKeys: p.error_keys,
      unknownKeys: p.unknown_keys,
      enabledKeys: p.enabled_keys,
    })),
    keys: keys.map(k => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: k.enabled === 1,
      createdAt: k.created_at,
      lastCheckedAt: k.last_checked_at,
    })),
    quotaStates: getQuotaStateForKeys(),
  });
});

// Check a specific key
healthRouter.post('/check/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const status = await checkKeyHealth(keyId);
  res.json({ keyId, status });
});

// Check all keys
healthRouter.post('/check-all', async (_req: Request, res: Response) => {
  await checkAllKeys();
  res.json({ success: true });
});
