import { randomUUID } from 'node:crypto';

import { getDb } from '../db/index.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { logRequest } from '../lib/request-log.js';
import { withKeyProxy } from '../lib/proxy.js';
import { checkAllKeys } from './health.js';
import { recordRequest, recordTokens } from './ratelimit.js';
import { routePinnedModel } from './router.js';

export type ProbeRunKind = 'full' | 'keys';
export type ProbeRunStatus = 'running' | 'completed' | 'cancelled' | 'failed';

interface RunController {
  cancelled: boolean;
}

interface ProbeRunRow {
  id: string;
  kind: ProbeRunKind;
  status: ProbeRunStatus;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  total_combos: number;
  completed_combos: number;
  ok_count: number;
  partial_count: number;
  rate_limited_count: number;
  failed_count: number;
  result_json: string | null;
}

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
}

interface ModelProbeResult {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  status: 'ok' | 'unavailable' | 'rate_limited' | 'failed';
  latencyMs: number;
  error: string | null;
}

export interface ProbeRunSnapshot {
  runId: string;
  kind: ProbeRunKind;
  status: ProbeRunStatus;
  createdAt: string;
  finishedAt: string | null;
  progress: {
    totalCombos: number;
    completedCombos: number;
    okCount: number;
    partialCount: number;
    rateLimitedCount: number;
    failedCount: number;
  };
  result: {
    keys?: Array<{
      keyId: number;
      platform: string;
      label: string | null;
      enabled: boolean;
      status: string;
    }>;
    models?: ModelProbeResult[];
  } | null;
}

const activeRuns = new Map<string, RunController>();

function nowIso(): string {
  return new Date().toISOString();
}

function readRunRow(runId: string): ProbeRunSnapshot | null {
  const row = getDb().prepare('SELECT * FROM probe_runs WHERE id = ?').get(runId) as ProbeRunRow | undefined;
  if (!row) return null;
  let result: ProbeRunSnapshot['result'] = null;
  if (row.result_json) {
    try { result = JSON.parse(row.result_json) as ProbeRunSnapshot['result']; } catch { result = null; }
  }
  return {
    runId: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    progress: {
      totalCombos: row.total_combos,
      completedCombos: row.completed_combos,
      okCount: row.ok_count,
      partialCount: row.partial_count,
      rateLimitedCount: row.rate_limited_count,
      failedCount: row.failed_count,
    },
    result,
  };
}

function sweepOrphanedRuns(): void {
  const rows = getDb().prepare("SELECT id FROM probe_runs WHERE status = 'running'").all() as Array<{ id: string }>;
  const finishedAt = nowIso();
  const fail = getDb().prepare(`
    UPDATE probe_runs
       SET status = 'failed', updated_at = ?, finished_at = ?
     WHERE id = ? AND status = 'running'
  `);
  for (const row of rows) {
    if (!activeRuns.has(row.id)) fail.run(finishedAt, finishedAt, row.id);
  }
}

function bumpRun(runId: string, outcome: 'ok' | 'partial' | 'rate_limited' | 'failed', count = 1): void {
  const column = outcome === 'ok'
    ? 'ok_count'
    : outcome === 'partial'
      ? 'partial_count'
      : outcome === 'rate_limited'
        ? 'rate_limited_count'
        : 'failed_count';
  getDb().prepare(`
    UPDATE probe_runs
       SET completed_combos = completed_combos + ?, ${column} = ${column} + ?, updated_at = ?
     WHERE id = ?
  `).run(count, count, nowIso(), runId);
}

function setRunResult(
  runId: string,
  status: Exclude<ProbeRunStatus, 'running'>,
  result: NonNullable<ProbeRunSnapshot['result']>,
): void {
  const finishedAt = nowIso();
  getDb().prepare(`
    UPDATE probe_runs
       SET status = ?, updated_at = ?, finished_at = ?, result_json = ?
     WHERE id = ?
  `).run(status, finishedAt, finishedAt, JSON.stringify(result), runId);
}

function keySnapshot(): NonNullable<ProbeRunSnapshot['result']>['keys'] {
  const rows = getDb().prepare(`
    SELECT id, platform, label, enabled, status FROM api_keys ORDER BY platform, id
  `).all() as Array<{ id: number; platform: string; label: string | null; enabled: number; status: string }>;
  return rows.map(row => ({
    keyId: row.id,
    platform: row.platform,
    label: row.label,
    enabled: row.enabled === 1,
    status: row.status,
  }));
}

function classifyFailure(err: unknown): 'rate_limited' | 'failed' {
  const anyErr = err as { status?: unknown; message?: unknown } | null;
  const status = typeof anyErr?.status === 'number' ? anyErr.status : 0;
  const message = String(anyErr?.message ?? '').toLowerCase();
  return status === 429 || message.includes('429') || message.includes('rate limit') || message.includes('quota')
    ? 'rate_limited'
    : 'failed';
}

async function testModel(model: ModelRow): Promise<ModelProbeResult> {
  const inputEstimate = 16;
  const outputLimit = 4;
  const started = Date.now();
  let route: ReturnType<typeof routePinnedModel> = null;
  try {
    route = routePinnedModel(model.id, inputEstimate + outputLimit);
    if (!route) {
      return {
        modelDbId: model.id,
        platform: model.platform,
        modelId: model.model_id,
        displayName: model.display_name,
        status: 'unavailable',
        latencyMs: 0,
        error: 'No enabled key is currently routable for this model.',
      };
    }

    const selected = route;
    const response = await withKeyProxy(selected.proxyUrl, () => selected.provider.chatCompletion(
      selected.apiKey,
      [{ role: 'user', content: 'ping' }],
      selected.modelId,
      { max_tokens: outputLimit, timeoutMs: 15_000 },
    ));
    const latencyMs = Date.now() - started;
    const outputTokens = response.usage?.completion_tokens
      ?? Math.ceil((response.choices?.[0]?.message?.content?.length ?? 0) / 4);
    const inputTokens = response.usage?.prompt_tokens
      ?? Math.max(0, (response.usage?.total_tokens ?? inputEstimate + outputTokens) - outputTokens);
    recordRequest(route.platform, route.modelId, route.keyId);
    recordTokens(route.platform, route.modelId, route.keyId, response.usage?.total_tokens ?? inputTokens + outputTokens);
    logRequest(route.platform, route.modelId, route.keyId, 'success', inputTokens, outputTokens,
      latencyMs, null, null, route.modelId, null, 'full-model-test');
    return {
      modelDbId: model.id,
      platform: route.platform,
      modelId: route.modelId,
      displayName: model.display_name,
      status: 'ok',
      latencyMs,
      error: null,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const error = sanitizeProviderErrorMessage(err instanceof Error ? err.message : String(err));
    if (route) {
      logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0,
        latencyMs, error, null, route.modelId, null, 'full-model-test');
    }
    const status = classifyFailure(err);
    return {
      modelDbId: model.id,
      platform: route?.platform ?? model.platform,
      modelId: route?.modelId ?? model.model_id,
      displayName: model.display_name,
      status,
      latencyMs,
      error,
    };
  } finally {
    route?.release?.();
  }
}

async function runModels(
  runId: string,
  controller: RunController,
  models: ModelRow[],
  concurrency: number,
): Promise<ModelProbeResult[]> {
  const results: ModelProbeResult[] = [];
  let cursor = 0;
  const worker = async () => {
    while (!controller.cancelled) {
      const index = cursor++;
      if (index >= models.length) return;
      const result = await testModel(models[index]!);
      results.push(result);
      bumpRun(runId,
        result.status === 'ok'
          ? 'ok'
          : result.status === 'rate_limited'
            ? 'rate_limited'
            : result.status === 'unavailable'
              ? 'partial'
              : 'failed');
    }
  };
  const workers = Math.max(1, Math.min(concurrency, models.length || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results.sort((a, b) => a.modelDbId - b.modelDbId);
}

export function createProbeRun(
  kind: ProbeRunKind = 'full',
  opts: { concurrency?: number } = {},
): { runId: string; totalCombos: number } {
  sweepOrphanedRuns();
  const db = getDb();
  const enabledKeys = (db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE enabled = 1').get() as { count: number }).count;
  const models = kind === 'full'
    ? db.prepare(`
        SELECT id, platform, model_id, display_name
          FROM models WHERE enabled = 1 ORDER BY id ASC
      `).all() as ModelRow[]
    : [];
  const totalCombos = enabledKeys + models.length;
  const runId = randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO probe_runs
      (id, kind, status, created_at, updated_at, total_combos)
    VALUES (?, ?, 'running', ?, ?, ?)
  `).run(runId, kind, createdAt, createdAt, totalCombos);

  const controller: RunController = { cancelled: false };
  activeRuns.set(runId, controller);
  const concurrency = Math.min(Math.max(Math.floor(opts.concurrency ?? 2) || 2, 1), 5);

  void (async () => {
    const result: NonNullable<ProbeRunSnapshot['result']> = {};
    try {
      const health = await checkAllKeys({ force: true });
      // Forced health passes normally probe every enabled key. Count whatever
      // the official scheduler actually completed so this stays correct if its
      // policy changes later.
      const keyChecks = health.checkedKeyIds.length + health.skippedKeyIds.length;
      if (keyChecks > 0) {
        const keys = keySnapshot() ?? [];
        const byId = new Map(keys.map(key => [key.keyId, key]));
        for (const id of [...health.checkedKeyIds, ...health.skippedKeyIds]) {
          const key = byId.get(id);
          bumpRun(runId, key?.status === 'healthy' ? 'ok' : key?.status === 'rate_limited' ? 'rate_limited' : 'failed');
        }
      }
      result.keys = keySnapshot();

      if (controller.cancelled) {
        setRunResult(runId, 'cancelled', result);
        return;
      }

      if (kind === 'full') result.models = await runModels(runId, controller, models, concurrency);
      setRunResult(runId, controller.cancelled ? 'cancelled' : 'completed', result);
    } catch (err) {
      console.error(`[ProbeRun ${runId}] failed:`, err);
      setRunResult(runId, controller.cancelled ? 'cancelled' : 'failed', result);
    } finally {
      activeRuns.delete(runId);
    }
  })();

  return { runId, totalCombos };
}

export function getProbeRun(runId: string): ProbeRunSnapshot | null {
  sweepOrphanedRuns();
  return readRunRow(runId);
}

export function listProbeRuns(limit = 20): ProbeRunSnapshot[] {
  sweepOrphanedRuns();
  const rows = getDb().prepare('SELECT id FROM probe_runs ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(Math.min(Math.max(Math.floor(limit) || 20, 1), 100)) as Array<{ id: string }>;
  return rows.map(row => readRunRow(row.id)).filter((run): run is ProbeRunSnapshot => run !== null);
}

export function cancelProbeRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (controller) {
    controller.cancelled = true;
    return true;
  }
  const run = readRunRow(runId);
  if (!run || run.status !== 'running') return false;
  setRunResult(runId, 'cancelled', run.result ?? {});
  return true;
}
