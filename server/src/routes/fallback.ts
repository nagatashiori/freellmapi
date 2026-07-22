/**
 * Express router handles model fallback configuration and token budget reporting.
 * It integrates named profiles dynamically into the fallback routing logic and aggregates
 * monthly token consumption and rate limits (RPM/RPD/TPM/TPD) across configured models.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties, getRoutingScores, getRoutingStrategy, setRoutingStrategy, setCustomWeights } from '../services/router.js';
import { BANDIT_PRESETS, type RoutingStrategy } from '../services/scoring.js';
import { parseBudget } from '../lib/budget.js';
import { getModelGroups } from '../services/model-groups.js';
import { getPenaltyInspector } from '../services/penalty-inspector.js';
import { getModelProbeHealth, getModelRoutingState, rankModelGroupCandidates } from '../services/model-health.js';
import { markProbeRun, probeModelUpstream, runModelProbes } from '../services/model-probe.js';
import {
  getActiveRoutingChain,
  getActiveRoutingProfileId,
  getDefaultProfileId,
  getDefaultRoutingChain,
  replaceRoutingChain,
  upsertRoutingEntries,
} from '../services/routing-groups.js';

export const fallbackRouter = Router();

// ── Bandit routing strategy ─────────────────────────────────────────────────
// GET  /routing → active strategy, preset weights, and the per-model score
//                 breakdown (reliability / speed / intelligence + guardrails).
fallbackRouter.get('/routing', (_req: Request, res: Response) => {
  res.json(getRoutingScores());
});

fallbackRouter.get('/penalty-inspector', (_req: Request, res: Response) => {
  res.json(getPenaltyInspector());
});

const routingSchema = z.object({
  strategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']),
  // Only meaningful with strategy 'custom': the user's weight vector. Any
  // non-negative vector is accepted; setCustomWeights renormalizes to sum 1.
  weights: z.object({
    reliability: z.number().nonnegative(),
    speed: z.number().nonnegative(),
    intelligence: z.number().nonnegative(),
  }).optional(),
});

// PUT /routing → switch strategy. Presets are just weight vectors over the three
// axes; 'priority' falls back to the legacy manual chain order; 'custom' uses
// the user's saved weights (optionally updated in the same request).
fallbackRouter.put('/routing', (req: Request, res: Response) => {
  const parsed = routingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  // Persist the weights before flipping the strategy so the new mode reads the
  // intended vector immediately. setCustomWeights throws on an all-zero vector.
  if (parsed.data.weights) {
    try {
      setCustomWeights(parsed.data.weights);
    } catch (err: any) {
      res.status(400).json({ error: { message: err?.message ?? 'Invalid custom weights' } });
      return;
    }
  }
  setRoutingStrategy(parsed.data.strategy as RoutingStrategy);
  res.json({ strategy: getRoutingStrategy(), presets: BANDIT_PRESETS });
});

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const defaultProfileId = getDefaultProfileId(db);
  const rows = db.prepare(`
    SELECT pm.model_db_id, pm.priority, pm.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit, m.context_window,
           m.monthly_token_budget, m.supports_vision, m.supports_tools,
           m.key_id, ak.label AS key_label,
           mo.overrides_json IS NOT NULL AS has_overrides
    FROM profile_models pm
    JOIN models m ON m.id = pm.model_db_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    WHERE pm.profile_id = ? AND m.enabled = 1
    ORDER BY pm.priority ASC
  `).all(defaultProfileId) as any[];

  // Count usable keys per platform — enabled AND healthy/unknown status. Unified
  // with /token-usage and the routing scorer (#456) so budget pooling is computed
  // from the same key set everywhere (a disabled or invalid key adds no capacity).
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  // Get current dynamic penalties
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));
  const probeHealthByDbId = getModelProbeHealth(db, rows.map(row => row.model_db_id));

  // 24h probe latency aggregate per model (success probes only). Backend
  // computes this so the dashboard / list / detail pages all share one value
  // without the client re-aggregating the probe-history time series.
  const latencyRows = db.prepare(`
    SELECT m.id AS model_db_id,
           AVG(r.latency_ms) AS avg_ms,
           COUNT(*) AS sample_count,
           MAX(r.id) AS last_id
    FROM requests r
    JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.request_type = 'probe'
      AND r.status IN ('ok', 'success')
      AND r.created_at > datetime('now', '-24 hours')
    GROUP BY m.id
  `).all() as { model_db_id: number; avg_ms: number; sample_count: number; last_id: number }[];

  // Latest probe per model (any status) — used to show "last seen: error 30s
  // ago" alongside the 24h average. Single subquery per model, no N+1.
  const lastRows = db.prepare(`
    SELECT r.platform, r.model_id, r.status, r.latency_ms, r.created_at
    FROM requests r
    JOIN (
      SELECT r2.platform, r2.model_id, MAX(r2.id) AS max_id
      FROM requests r2
      WHERE r2.request_type = 'probe'
        AND r2.created_at > datetime('now', '-24 hours')
      GROUP BY r2.platform, r2.model_id
    ) latest ON latest.platform = r.platform
            AND latest.model_id = r.model_id
            AND latest.max_id = r.id
    JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
  `).all() as { platform: string; model_id: string; status: string; latency_ms: number; created_at: string }[];

  const lastByDbId = new Map<number, { status: string; latency: number; at: string }>();
  for (const r of lastRows) {
    // We need model_db_id — re-derive from platform+model_id via the rows list.
    const hit = rows.find(x => x.platform === r.platform && x.model_id === r.model_id);
    if (!hit) continue;
    lastByDbId.set(hit.model_db_id, { status: r.status, latency: r.latency_ms, at: r.created_at });
  }

  const latencyByDbId = new Map<number, { avgMs: number; sampleCount: number }>();
  for (const lr of latencyRows) {
    latencyByDbId.set(lr.model_db_id, { avgMs: Math.round(lr.avg_ms), sampleCount: lr.sample_count });
  }

  // Logical-model grouping per row, so the dashboard can collapse the same
  // model served by several providers into one expandable group. Always sent
  // (cheap); the client renders grouped only when its unify toggle is on.
  const groupByDbId = new Map<number, { groupKey: string; canonicalId: string; groupLabel: string }>();
  const allGroups = getModelGroups();
  for (const g of allGroups) {
    for (const m of g.members) {
      groupByDbId.set(m.model_db_id, { groupKey: g.groupKey, canonicalId: g.canonicalId, groupLabel: g.groupLabel });
    }
  }

  // This rank is presentation + strict-group-routing metadata only. It is
  // never persisted into profile_models.priority, so a health probe cannot
  // overwrite the manual order on /models/chat.
  const effectiveGroupRankByDbId = new Map<number, number>();
  for (const group of allGroups) {
    const configured = rows.filter(row => group.members.some(member => member.model_db_id === row.model_db_id));
    rankModelGroupCandidates(configured, probeHealthByDbId).forEach((row, index) => {
      effectiveGroupRankByDbId.set(row.model_db_id, index + 1);
    });
  }

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    const group = groupByDbId.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      groupKey: group?.groupKey,
      canonicalId: group?.canonicalId,
      groupLabel: group?.groupLabel,
      effectiveGroupRank: effectiveGroupRankByDbId.get(r.model_db_id) ?? 1,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      tpmLimit: r.tpm_limit,
      tpdLimit: r.tpd_limit,
      // Max context length (tokens), used by the dashboard catalog filter. Null
      // for models whose context window the catalog doesn't record.
      contextWindow: r.context_window,
      monthlyTokenBudget: r.monthly_token_budget,
      // Parsed once here (single source of truth) so the dashboard never re-implements
      // budget-label parsing; 0 for rate-limited/placeholder labels. See lib/budget.ts.
      // Scaled by healthy/enabled key count for multi-account pooled capacity.
      monthlyTokenBudgetTokens: parseBudget(r.monthly_token_budget) * Math.max(1, keyCountMap.get(r.platform) ?? 1),
      supportsVision: r.supports_vision === 1,
      supportsTools: r.supports_tools === 1,
      source: r.platform === 'custom' || r.key_id != null ? 'custom' : 'catalog',
      keyId: r.key_id ?? null,
      keyLabel: r.key_label ?? null,
      hasOverrides: Boolean(r.has_overrides),
      keyCount: keyCountMap.get(r.platform) ?? 0,
      // 24h probe latency stats from the server (success probes only for the
      // average; `last` shows the most recent probe regardless of outcome).
      latencyStats: {
        avgMs: latencyByDbId.get(r.model_db_id)?.avgMs ?? 0,
        sampleCount: latencyByDbId.get(r.model_db_id)?.sampleCount ?? 0,
        lastStatus: lastByDbId.get(r.model_db_id)?.status ?? null,
        lastLatency: lastByDbId.get(r.model_db_id)?.latency ?? null,
        lastAt: lastByDbId.get(r.model_db_id)?.at ?? null,
      },
      routingHealth: (() => {
        const health = probeHealthByDbId.get(r.model_db_id);
        return {
          state: getModelRoutingState(health, r.enabled === 1),
          lastStatus: health?.lastStatus ?? null,
          lastProbedAt: health?.lastProbedAt ?? null,
          lastLatencyMs: health?.lastLatencyMs ?? null,
          avgLatencyMs: health?.avgLatencyMs ?? null,
          sampleCount: health?.sampleCount ?? 0,
          cooldownUntilMs: health?.cooldownUntilMs ?? null,
          usableKeyCount: health?.usableKeyCount ?? 0,
          coolingKeyCount: health?.coolingKeyCount ?? 0,
        };
      })(),
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// Update fallback chain (full replace)
fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const defaultProfileId = getDefaultProfileId(db);
  upsertRoutingEntries(db, defaultProfileId, parsed.data.map(entry => ({
    modelDbId: entry.modelDbId,
    priority: entry.priority,
    enabled: entry.enabled,
  })));

  res.json({ success: true });
});

// `intelligence_rank` is scoped to each provider's own catalog — a provider's
// #1 model is not globally #1 (see issue #135: MiniMax's top model outranking
// Gemini Pro because both read "Intel #1"). `size_label` IS a cross-provider
// capability tier, so normalize on it first and use intelligence_rank only as
// an in-tier tiebreaker. Unknown labels sort last.
const INTELLIGENCE_TIER =
  "CASE m.size_label WHEN 'Frontier' THEN 1 WHEN 'Large' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Small' THEN 4 ELSE 5 END";

// Sort presets — `orderBy` is selected from a fixed whitelist, never from
// user input directly, so the interpolation below is safe.
const SORT_PRESETS: Record<string, string> = {
  intelligence: `${INTELLIGENCE_TIER} ASC, m.intelligence_rank ASC`,
  speed: 'm.speed_rank ASC',
};

function getBudgetScore(m: { monthly_token_budget: string; tpd_limit: number | null }): number {
  if (m.tpd_limit != null) return m.tpd_limit * 30;
  
  const str = m.monthly_token_budget;
  if (!str) return 0;
  if (str.toLowerCase().includes('unlimited') || str.includes('∞')) return Infinity;
  
  const cleanStr = str.split('(')[0];
  const matches = cleanStr.match(/[\d.]+/g);
  let maxNum = 0;
  if (matches) {
    maxNum = Math.max(...matches.map(mStr => parseFloat(mStr)));
  }
  
  let mult = 1;
  const upper = cleanStr.toUpperCase();
  if (upper.includes('B')) mult = 1_000_000_000;
  else if (upper.includes('M')) mult = 1_000_000;
  else if (upper.includes('K')) mult = 1_000;

  return maxNum * mult;
}

fallbackRouter.post('/sort/:preset', (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const db = getDb();
  let models: { id: number }[] = [];

  if (preset === 'budget') {
    const allModels = db.prepare(`SELECT id, monthly_token_budget, tpd_limit FROM models`).all() as any[];
    allModels.sort((a, b) => getBudgetScore(b) - getBudgetScore(a));
    models = allModels.map(m => ({ id: m.id }));
  } else {
    const orderBy = SORT_PRESETS[preset];
    if (!orderBy) {
      res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
      return;
    }
    models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all() as { id: number }[];
  }

  const current = getDefaultRoutingChain(db);
  const enabledById = new Map(current.map(entry => [entry.model_db_id, entry.enabled]));
  replaceRoutingChain(db, getDefaultProfileId(db), models.map((model, index) => ({
    modelDbId: model.id,
    priority: index + 1,
    enabled: enabledById.get(model.id) ?? 0,
  })));

  res.json({ success: true, preset });
});

// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', (_req: Request, res: Response) => {
  const db = getDb();

  // Get platforms that have enabled keys
  const platforms = db.prepare(`
    SELECT DISTINCT ak.platform
    FROM api_keys ak
    WHERE ak.enabled = 1
  `).all() as { platform: string }[];
  const platformSet = new Set(platforms.map(p => p.platform));

  const rawModels = getActiveRoutingChain(db) as {
    model_db_id: number; platform: string; model_id: string; display_name: string;
    monthly_token_budget: string; priority: number; enabled: number;
    rpm_limit: number | null; rpd_limit: number | null;
    tpm_limit: number | null; tpd_limit: number | null;
  }[];

  // Build per-model breakdown (only platforms with keys), preserving enabled state
  const usageRows = db.prepare(`
    SELECT platform, model_id, COALESCE(SUM(input_tokens + output_tokens), 0) AS used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
      AND request_type = 'chat'
    GROUP BY platform, model_id
  `).all() as { platform: string; model_id: string; used: number }[];
  const usageByModel = new Map(usageRows.map(r => [`${r.platform}:${r.model_id}`, r.used]));

  const keyCountMap = new Map(
    (db.prepare("SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform").all() as { platform: string; count: number }[])
      .map(k => [k.platform, k.count])
  );

  const modelBudgets = rawModels
    .filter(m => platformSet.has(m.platform))
    .map(m => {
      const keys = Math.max(1, keyCountMap.get(m.platform) ?? 1);
      return {
        modelDbId: m.model_db_id,
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        budget: parseBudget(m.monthly_token_budget) * keys,
        used: usageByModel.get(`${m.platform}:${m.model_id}`) ?? 0,
        enabled: m.enabled === 1,
        rpmLimit: m.rpm_limit,
        rpdLimit: m.rpd_limit,
        tpmLimit: m.tpm_limit,
        tpdLimit: m.tpd_limit,
      };
    });

  // Total budget counts all models (both enabled and disabled — they contribute to the pool)
  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);
  const totalUsed = modelBudgets.reduce((s, m) => s + m.used, 0);

  res.json({
    totalBudget,
    totalUsed,
    models: modelBudgets,
  });
});

// Manual and scheduled probes share services/model-probe.ts so every path
// records the same durable status and applies the same transactional AUTO
// transition. Keep route code here limited to selection and serialization.

// ── Health: durable probe + cooling state for dashboard consumers ──────────
fallbackRouter.get('/health', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const db = getDb();
  const activeProfileId = getActiveRoutingProfileId(db);
  const rows = db.prepare(`
    SELECT pm.model_db_id, pm.enabled
    FROM profile_models pm
    JOIN models m ON m.id = pm.model_db_id
    WHERE pm.profile_id = ?
  `).all(activeProfileId) as { model_db_id: number; enabled: number }[];
  const healthByDbId = getModelProbeHealth(db, rows.map(row => row.model_db_id));
  const result = rows.map(r => ({
    modelDbId: r.model_db_id,
    healthStatus: getModelRoutingState(healthByDbId.get(r.model_db_id), r.enabled === 1),
    lastProbedAt: healthByDbId.get(r.model_db_id)?.lastProbedAt ?? null,
    cooldownUntilMs: healthByDbId.get(r.model_db_id)?.cooldownUntilMs ?? null,
  }));
  res.json(result);
});

// ── Probe: test a specific model ───────────────────────────────────────────
fallbackRouter.post('/probe/:id', async (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const modelDbId = parseInt(rawId, 10);
  if (isNaN(modelDbId)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const result = await probeModelUpstream(modelDbId);
    if (result.httpStatus === 404) { res.status(404).json({ error: 'Model not found' }); return; }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Probe all enabled models ──────────────────────────────────────────────
fallbackRouter.post('/probe-all', async (req: Request, res: Response) => {
  const db = getDb();
  // Probe ALL models that have a key for their platform (enabled or not).
  // Optional body: { onlyEnabled: true, limit: N, ids: number[] }
  const body = req.body || {};
  let models: { id: number; platform: string; model_id: string }[];
  if (Array.isArray(body.ids) && body.ids.length) {
    const placeholders = body.ids.map(() => '?').join(',');
    models = db.prepare(`SELECT m.id, m.platform, m.model_id FROM models m WHERE m.id IN (${placeholders})`)
      .all(...body.ids.map(Number)) as { id: number; platform: string; model_id: string }[];
  } else {
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 600);
    const onlyEnabled = !!body.onlyEnabled;
    const activeProfileId = getActiveRoutingProfileId(db);
    models = db.prepare(`
      SELECT m.id, m.platform, m.model_id
      FROM models m
      LEFT JOIN profile_models pm
        ON pm.model_db_id = m.id AND pm.profile_id = ?
      WHERE EXISTS (
        SELECT 1
        FROM api_keys ak
        WHERE ak.platform = m.platform
          AND ak.enabled = 1
          AND (m.key_id IS NULL OR ak.id = m.key_id)
      )
      ${onlyEnabled ? 'AND COALESCE(pm.enabled, 0) = 1 AND m.enabled = 1' : ''}
      ORDER BY COALESCE(pm.enabled, 0) DESC, COALESCE(pm.priority, 2147483647) ASC, m.id ASC
      LIMIT ?
    `).all(activeProfileId, limit) as { id: number; platform: string; model_id: string }[];
  }

  // Concurrent but bounded. The service owns status normalization and AUTO
  // transitions, so manual "Probe all" cannot diverge from scheduled checks.
  const concurrency = Math.min(Math.max(parseInt(body.concurrency, 10) || 2, 1), 5);
  const rawResults = await runModelProbes(models.map(model => model.id), concurrency);
  const byId = new Map(models.map(model => [model.id, model]));
  const results = rawResults.map(result => {
    const fallback = result.modelDbId == null ? undefined : byId.get(result.modelDbId);
    return {
      modelDbId: result.modelDbId ?? fallback?.id,
      platform: result.platform ?? fallback?.platform,
      modelId: result.modelId ?? fallback?.model_id,
      status: result.status,
      latency: result.latency,
      error: result.error.substring(0, 150),
      enabled: Boolean(result.enabled),
    };
  });
  markProbeRun();
  res.json({ total: results.length, results });
});

// ── Get/set health check interval ─────────────────────────────────────────
fallbackRouter.get('/probe-settings', (_req: Request, res: Response) => {
  const db = getDb();
  const intervalRow = db.prepare("SELECT value FROM settings WHERE key='health_check_interval_ms'").get() as { value: string } | undefined;
  const lastRow = db.prepare("SELECT value FROM settings WHERE key='health_check_last_run'").get() as { value: string } | undefined;
  const interval = parseInt(intervalRow?.value || '1800000', 10);
  const lastRun = lastRow?.value || null;
  res.json({ intervalMs: interval, lastRun });
});

fallbackRouter.put('/probe-settings', (req: Request, res: Response) => {
  const db = getDb();
  const { intervalMs } = req.body;
  if (typeof intervalMs !== 'number' || intervalMs < 60000) {
    res.status(400).json({ error: 'Interval must be >= 60000ms' });
    return;
  }
  const existing = db.prepare("SELECT value FROM settings WHERE key='health_check_interval_ms'").get() as { value: string } | undefined;
  if (existing) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'health_check_interval_ms'").run(String(intervalMs));
  } else {
    db.prepare("INSERT INTO settings (key, value) VALUES ('health_check_interval_ms', ?)").run(String(intervalMs));
  }
  res.json({ intervalMs });
});

// GET /probe-history — recent probe results for dashboard timeline
fallbackRouter.get('/probe-history', (req: Request, res: Response) => {
  const db = getDb();
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
  const maxPer = Math.min(Math.max(Number(req.query.perPlatform) || 600, 5), 1200);

  const rows = db.prepare(`
    SELECT r.platform, r.model_id, r.status, r.latency_ms, r.error, r.created_at,
           m.id as model_db_id
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.request_type = 'probe'
      AND r.created_at > datetime('now', ?)
    ORDER BY r.id DESC
  `).all(`-${hours} hours`) as {
    platform: string; model_id: string; status: string; latency_ms: number;
    error: string | null; created_at: string; model_db_id: number | null;
  }[];

  const byPlatform: Record<string, any[]> = {};
  for (const r of rows) {
    if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
    if (byPlatform[r.platform].length < maxPer) {
      byPlatform[r.platform].push({
        modelDbId: r.model_db_id,
        modelId: r.model_id,
        status: r.status,
        latency: r.latency_ms,
        error: r.error ? r.error.slice(0, 100) : null,
        time: r.created_at,
      });
    }
  }
  res.json({ hours, perPlatform: maxPer, platforms: byPlatform });
});

// GET /probe-stats?canonical=...&hours=24
// Per-model latency stats for a single logical model group, optionally
// reordered by latency. The detail page calls this after a "测全部提供方"
// pass to display the providers in fastest-first order.
fallbackRouter.get('/probe-stats', (req: Request, res: Response) => {
  const db = getDb();
  const canonical = String(req.query.canonical ?? '').trim();
  if (!canonical) {
    res.status(400).json({ error: { message: 'canonical is required' } });
    return;
  }
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);

  // Use the same model-groups service that /api/fallback uses, so the member
  // list always matches what the detail page shows — including ungrouped
  // models and custom overrides. The input may be either a canonical slug
  // (preferred) or a raw display_name / model_id.
  const groups = getModelGroups();
  let members: { model_db_id: number; platform: string; model_id: string; display_name: string }[] = [];
  for (const g of groups) {
    if (g.canonicalId === canonical) { members = g.members; break; }
  }
  if (members.length === 0) {
    // Fall back to a direct match for ungrouped models.
    members = db.prepare(`
      SELECT m.id AS model_db_id, m.platform, m.model_id, m.display_name
      FROM models m
      WHERE m.enabled = 1
        AND (m.display_name = ? OR m.model_id = ?)
    `).all(canonical, canonical) as any[];
  }

  if (members.length === 0) {
    res.json({ canonical, hours, members: [] });
    return;
  }

  const ids = members.map(m => m.model_db_id);
  const placeholders = ids.map(() => '?').join(',');

  const stats = db.prepare(`
    SELECT m.id AS model_db_id,
           AVG(r.latency_ms) AS avg_ms,
           COUNT(*) AS sample_count
    FROM requests r
    JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.request_type = 'probe'
      AND r.status IN ('ok', 'success')
      AND r.created_at > datetime('now', ?)
      AND m.id IN (${placeholders})
    GROUP BY m.id
  `).all(`-${hours} hours`, ...ids) as { model_db_id: number; avg_ms: number; sample_count: number }[];

  const statsMap = new Map(stats.map(s => [s.model_db_id, { avgMs: Math.round(s.avg_ms), sampleCount: s.sample_count }]));

  const out = members.map(m => ({
    modelDbId: m.model_db_id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    avgMs: statsMap.get(m.model_db_id)?.avgMs ?? 0,
    sampleCount: statsMap.get(m.model_db_id)?.sampleCount ?? 0,
  }));

  // Reorder: highest sample count first, then lowest avgMs. Ties preserve
  // original order. Models with no samples sink to the end.
  out.sort((a, b) => {
    if (a.sampleCount === 0 && b.sampleCount === 0) return 0;
    if (a.sampleCount === 0) return 1;
    if (b.sampleCount === 0) return -1;
    return a.avgMs - b.avgMs;
  });

  res.json({ canonical, hours, members: out });
});
