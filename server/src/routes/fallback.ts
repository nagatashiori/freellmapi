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
import { decrypt } from '../lib/crypto.js';
import { resolveProvider, getProvider } from '../providers/index.js';

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
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit, m.context_window,
           m.monthly_token_budget, m.supports_vision, m.supports_tools,
           m.key_id, ak.label AS key_label,
           mo.overrides_json IS NOT NULL AS has_overrides
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    WHERE m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as any[];

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

  // Logical-model grouping per row, so the dashboard can collapse the same
  // model served by several providers into one expandable group. Always sent
  // (cheap); the client renders grouped only when its unify toggle is on.
  const groupByDbId = new Map<number, { groupKey: string; canonicalId: string; groupLabel: string }>();
  for (const g of getModelGroups()) {
    for (const m of g.members) {
      groupByDbId.set(m.model_db_id, { groupKey: g.groupKey, canonicalId: g.canonicalId, groupLabel: g.groupLabel });
    }
  }

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    const group = groupByDbId.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      groupKey: group?.groupKey,
      canonicalId: group?.canonicalId,
      groupLabel: group?.groupLabel,
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
  const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();

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

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });
  reorder();

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

  // Check if there is an active profile
  const settingRow = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  const activeProfileId = settingRow ? (parseInt(settingRow.value) || null) : null;

  // Verify active profile still exists
  const activeProfile = activeProfileId
    ? db.prepare('SELECT id FROM profiles WHERE id = ?').get(activeProfileId) as any
    : null;

  let rawModels: { model_db_id: number; platform: string; model_id: string; display_name: string; monthly_token_budget: string; priority: number; enabled: number; rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null }[];

  if (activeProfile) {
    // Profile mode: use profile_models chain (all models in profile, checked against enabled)
    rawModels = db.prepare(`
      SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
             pm.priority, pm.enabled,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
      WHERE pm.profile_id = ? AND m.enabled = 1
      ORDER BY pm.priority ASC
    `).all(activeProfileId) as any[];
  } else {
    // Default mode: use fallback_config (only include enabled models)
    rawModels = db.prepare(`
      SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
             fc.priority, fc.enabled,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      WHERE m.enabled = 1
      ORDER BY fc.priority ASC
    `).all() as any[];
  }

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

// ── Health probe helpers (direct upstream, bypass local routing) ───────────
// Probes one provider model by hitting its upstream /chat/completions with a
// 3-token "Say OK" request, a 15s wall-clock budget, and records the result
// into the requests table (request_type='probe'). Auto-enables the channel on
// success and disables on hard failure (error/timeout); rate-limited leaves
// the enabled flag alone.
async function probeModelUpstream(modelDbId: number) {
  const db = getDb();
  const model = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.display_name, m.key_id, m.enabled AS model_enabled,
           COALESCE(fc.enabled, 0) AS chain_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.id = ?
  `).get(modelDbId) as {
    id: number; platform: string; model_id: string; display_name: string;
    key_id: number | null; model_enabled: number; chain_enabled: number;
  } | undefined;
  if (!model) return { ok: false, httpStatus: 404, error: 'Model not found', latency: 0, model: null };

  // Pick a key for this platform (prefer model.key_id, else any enabled key)
  let keyRow = null as {
    id: number; platform: string; encrypted_key: string; iv: string;
    auth_tag: string; base_url: string | null; enabled: number; status: string;
  } | null;
  if (model.key_id) {
    keyRow = db.prepare("SELECT id, platform, encrypted_key, iv, auth_tag, base_url, enabled, status FROM api_keys WHERE id = ?").get(model.key_id) as typeof keyRow;
  }
  if (!keyRow) {
    keyRow = db.prepare("SELECT id, platform, encrypted_key, iv, auth_tag, base_url, enabled, status FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY id DESC LIMIT 1").get(model.platform) as typeof keyRow;
  }
  if (!keyRow) {
    return { ok: false, httpStatus: 0, error: 'No API key for platform ' + model.platform, latency: 0, model, status: 'error' };
  }

  let apiKey: string;
  try {
    apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch (e: any) {
    return { ok: false, httpStatus: 0, error: 'Key decrypt failed: ' + e.message, latency: 0, model, status: 'error' };
  }

  const provider = resolveProvider(model.platform, keyRow.base_url) || getProvider(model.platform);
  if (!provider || !provider.baseUrl) {
    return { ok: false, httpStatus: 0, error: 'No provider/baseUrl for platform ' + model.platform, latency: 0, model, status: 'error' };
  }

  const url = provider.baseUrl.replace(/\/$/, '') + '/chat/completions';
  // Hard total wall-clock budget for ONE probe. AbortController alone is not
  // enough: some upstreams accept the TCP connection then stall on body, and
  // a bare await resp.text() can outlive the intended 15s UX budget.
  const PROBE_TIMEOUT_MS = 15000;
  const start = Date.now();
  const ctrl = new AbortController();
  let result: { status: number; body: string };
  try {
    let tmr: NodeJS.Timeout | undefined;
    const fetchPromise = (async () => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          ...(provider.extraHeaders || {}),
        },
        body: JSON.stringify({
          model: model.model_id,
          messages: [{ role: 'user', content: 'Say OK' }],
          max_tokens: 3,
          temperature: 0,
        }),
        signal: ctrl.signal,
      });
      const body = await resp.text();
      return { status: resp.status, body };
    })();
    const timeoutPromise = new Promise<{ status: number; body: string }>((_, reject) => {
      tmr = setTimeout(() => {
        try { ctrl.abort(); } catch (_) {}
        const e = new Error('timeout');
        e.name = 'AbortError';
        reject(e);
      }, PROBE_TIMEOUT_MS);
    });
    try {
      result = await Promise.race([fetchPromise, timeoutPromise]);
    } finally {
      if (tmr) clearTimeout(tmr);
    }
  } catch (fetchErr: any) {
    result = { status: 0, body: (fetchErr && fetchErr.name === 'AbortError') ? 'timeout' : String((fetchErr && fetchErr.message) || fetchErr) };
  }

  const latency = Math.min(Date.now() - start, PROBE_TIMEOUT_MS + 50);
  let status = 'error';
  let error = '';
  if (result.status === 200) {
    try {
      const j = JSON.parse(result.body);
      if (j.choices && j.choices[0]) status = 'ok';
      else { status = 'error'; error = 'No choices in response'; }
    } catch (e) { status = 'error'; error = 'Parse error: ' + result.body.substring(0, 100); }
  } else if (result.status === 0) {
    status = result.body === 'timeout' ? 'timeout' : 'error';
    error = result.body;
  } else if (result.status === 429) {
    status = 'rate_limited';
    try { const j = JSON.parse(result.body); error = j.error?.message || j.message || result.body.substring(0, 200); }
    catch (e) { error = result.body.substring(0, 200); }
  } else {
    status = 'error';
    try { const j = JSON.parse(result.body); error = j.error?.message || j.message || j.error?.code || result.body.substring(0, 200); }
    catch (e) { error = result.body.substring(0, 200); }
  }

  // Persist request log
  try {
    db.prepare(`
      INSERT INTO requests (platform, model_id, requested_model, status, latency_ms, error, created_at, request_type)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'probe')
    `).run(model.platform, model.model_id, model.model_id, status === 'ok' ? 'success' : (status === 'rate_limited' ? 'error' : 'error'), latency, error || null);
  } catch (e) { /* best effort */ }

  // Auto enable/disable THIS channel (one provider model row) everywhere it matters
  let finalEnabled = (status === 'ok');
  try {
    if (status === 'ok') {
      db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(modelDbId);
      db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(modelDbId);
      db.prepare('UPDATE profile_models SET enabled = 1 WHERE model_db_id = ?').run(modelDbId);
      const hasDefault = db.prepare('SELECT 1 AS x FROM profile_models WHERE profile_id = 1 AND model_db_id = ?').get(modelDbId);
      if (!hasDefault) {
        const maxP = db.prepare('SELECT COALESCE(MAX(priority),0)+1 AS p FROM profile_models WHERE profile_id = 1').get() as { p: number };
        db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (1, ?, ?, 1)').run(modelDbId, maxP.p);
      }
      finalEnabled = true;
    } else if (status === 'error' || status === 'timeout') {
      db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(modelDbId);
      db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(modelDbId);
      finalEnabled = false;
    } else if (status === 'rate_limited') {
      const row = db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(modelDbId) as { enabled: number } | undefined;
      finalEnabled = !!(row && row.enabled);
    }
  } catch (e) { /* best effort */ }

  return {
    ok: status === 'ok',
    modelDbId,
    platform: model.platform,
    modelId: model.model_id,
    displayName: model.display_name,
    status,
    latency,
    error: (error || '').substring(0, 300),
    enabled: finalEnabled,
  };
}

// ── Health: per-model status from recent requests ──────────────────────────
// Returns the latest request status per (platform, model_id) joined to the
// fallback_config rows. Uses model_id (the actual routed model) — not
// requested_model (what the client typed, usually NULL) — and matches
// case-insensitively against models.model_id. Without LOWER(), mapleleaf and
// other platforms whose model_id casing diverges from the requests log show
// as 'unknown' (gray) on the dashboard. (#376)
fallbackRouter.get('/health', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const db = getDb();
  const lastReqs = db.prepare(
    "SELECT platform, LOWER(model_id) as lmodel, status FROM requests WHERE id IN (SELECT MAX(id) FROM requests WHERE model_id IS NOT NULL AND model_id != '' GROUP BY platform, LOWER(model_id))"
  ).all() as { platform: string; lmodel: string; status: string }[];
  const healthMap = new Map<string, string>();
  for (const r of lastReqs) healthMap.set(r.platform + ':' + r.lmodel, r.status);
  const rows = db.prepare(
    "SELECT fc.model_db_id, m.platform, LOWER(m.model_id) as lmodel FROM fallback_config fc JOIN models m ON m.id = fc.model_db_id"
  ).all() as { model_db_id: number; platform: string; lmodel: string }[];
  const result = rows.map(r => ({
    modelDbId: r.model_db_id,
    healthStatus: healthMap.get(r.platform + ':' + r.lmodel) || 'unknown',
    lastProbedAt: null,
  }));
  res.json(result);
});

// ── Probe: test a specific model ───────────────────────────────────────────
fallbackRouter.post('/probe/:id', async (req: Request, res: Response) => {
  const modelDbId = parseInt(req.params.id, 10);
  if (isNaN(modelDbId)) { res.status(400).json({ error: 'Invalid id' }); return; }
  try {
    const result = await probeModelUpstream(modelDbId);
    if (!result.model && result.httpStatus === 404) { res.status(404).json({ error: 'Model not found' }); return; }
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
    models = db.prepare(`SELECT m.id, m.platform, m.model_id FROM models m WHERE m.id IN (${placeholders})`).all(...body.ids.map(Number));
  } else {
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 600);
    const onlyEnabled = !!body.onlyEnabled;
    models = db.prepare(`
      SELECT m.id, m.platform, m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE EXISTS (
        SELECT 1 FROM api_keys ak WHERE ak.platform = m.platform AND ak.enabled = 1
      )
      ${onlyEnabled ? 'AND fc.enabled = 1 AND m.enabled = 1' : ''}
      ORDER BY fc.enabled DESC, m.intelligence_rank ASC
      LIMIT ?
    `).all(limit);
  }

  // Concurrent but bounded. Serial 200x15s feels stuck forever on dashboard.
  // Keep low concurrency so we do not stampede one provider while probing.
  const results = new Array<any>(models.length);
  const CONCURRENCY = Math.min(Math.max(parseInt(body.concurrency, 10) || 2, 1), 5);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= models.length) return;
      const m = models[i];
      try {
        const r = await probeModelUpstream(m.id) as any;
        results[i] = {
          modelDbId: r.modelDbId || m.id,
          platform: r.platform || m.platform,
          modelId: r.modelId || m.model_id,
          status: r.status || 'error',
          latency: r.latency || 0,
          error: (r.error || '').substring(0, 150),
          enabled: !!r.enabled,
        };
      } catch (err: any) {
        results[i] = { modelDbId: m.id, platform: m.platform, modelId: m.model_id, status: 'error', latency: 0, error: err.message, enabled: false };
      }
      await new Promise(r => setTimeout(r, 80));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, models.length || 1) }, () => worker()));
  // stamp last run
  try {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT value FROM settings WHERE key='health_check_last_run'").pluck(true).get();
    if (existing !== undefined && existing !== null) {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'health_check_last_run'").run(now);
    } else {
      db.prepare("INSERT INTO settings (key, value) VALUES ('health_check_last_run', ?)").run(now);
    }
  } catch (e) { /* best effort */ }
  res.json({ total: results.length, results });
});

// ── Get/set health check interval ─────────────────────────────────────────
fallbackRouter.get('/probe-settings', (_req: Request, res: Response) => {
  const db = getDb();
  const interval = parseInt(db.prepare("SELECT value FROM settings WHERE key='health_check_interval_ms'").pluck(true).get() as string || '3600000', 10);
  const lastRun = db.prepare("SELECT value FROM settings WHERE key='health_check_last_run'").pluck(true).get() as string | null || null;
  res.json({ intervalMs: interval, lastRun });
});

fallbackRouter.put('/probe-settings', (req: Request, res: Response) => {
  const db = getDb();
  const { intervalMs } = req.body;
  if (typeof intervalMs !== 'number' || intervalMs < 60000) {
    res.status(400).json({ error: 'Interval must be >= 60000ms' });
    return;
  }
  const existing = db.prepare("SELECT value FROM settings WHERE key='health_check_interval_ms'").pluck(true).get();
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
