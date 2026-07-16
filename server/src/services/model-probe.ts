import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider, resolveProvider } from '../providers/index.js';
import { getDefaultProfileId } from './routing-groups.js';

export const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeResult {
  ok: boolean;
  modelDbId?: number;
  platform?: string;
  modelId?: string;
  displayName?: string;
  status: 'ok' | 'rate_limited' | 'timeout' | 'error';
  latency: number;
  error: string;
  enabled?: boolean;
  httpStatus?: number;
  model?: unknown;
}

/**
 * Direct provider probe. It records durable probe history but never rewrites a
 * profile switch: a failed probe is a runtime signal, not permission to undo an
 * operator's choice; a successful probe is not permission to silently enable a
 * provider the operator intentionally turned off.
 */
export async function probeModelUpstream(modelDbId: number): Promise<ProbeResult> {
  const db = getDb();
  const defaultProfileId = getDefaultProfileId(db);
  const model = db.prepare(`
    SELECT m.id, m.platform, m.model_id, m.display_name, m.key_id, m.enabled AS model_enabled,
           COALESCE(pm.enabled, 0) AS chain_enabled
    FROM models m
    LEFT JOIN profile_models pm
      ON pm.model_db_id = m.id AND pm.profile_id = ?
    WHERE m.id = ?
  `).get(defaultProfileId, modelDbId) as {
    id: number; platform: string; model_id: string; display_name: string;
    key_id: number | null; model_enabled: number; chain_enabled: number;
  } | undefined;
  if (!model) return { ok: false, httpStatus: 404, error: 'Model not found', latency: 0, model: null, status: 'error' };

  let keyRow = null as {
    id: number; platform: string; encrypted_key: string; iv: string;
    auth_tag: string; base_url: string | null; enabled: number; status: string;
  } | null;
  if (model.key_id) {
    keyRow = db.prepare('SELECT id, platform, encrypted_key, iv, auth_tag, base_url, enabled, status FROM api_keys WHERE id = ?').get(model.key_id) as typeof keyRow;
  }
  if (!keyRow) {
    keyRow = db.prepare("SELECT id, platform, encrypted_key, iv, auth_tag, base_url, enabled, status FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY id DESC LIMIT 1").get(model.platform) as typeof keyRow;
  }
  if (!keyRow) {
    return { ok: false, httpStatus: 0, error: `No API key for platform ${model.platform}`, latency: 0, model, status: 'error', enabled: model.chain_enabled === 1 && model.model_enabled === 1 };
  }

  let apiKey: string;
  try {
    apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch (e: any) {
    return { ok: false, httpStatus: 0, error: `Key decrypt failed: ${e.message}`, latency: 0, model, status: 'error', enabled: model.chain_enabled === 1 && model.model_enabled === 1 };
  }

  const provider = resolveProvider(model.platform, keyRow.base_url) || getProvider(model.platform);
  if (!provider) {
    return { ok: false, httpStatus: 0, error: `No provider for platform ${model.platform}`, latency: 0, model, status: 'error', enabled: model.chain_enabled === 1 && model.model_enabled === 1 };
  }

  const start = Date.now();
  let status: ProbeResult['status'] = 'error';
  let error = '';
  let httpStatus = 0;
  try {
    const response = await provider.chatCompletion(
      apiKey,
      [{ role: 'user', content: 'Say OK' }],
      model.model_id,
      { max_tokens: 3, temperature: 0, timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (response.choices?.[0]) {
      status = 'ok';
      httpStatus = 200;
    } else {
      error = 'No choices in response';
    }
  } catch (probeError: any) {
    httpStatus = Number(probeError?.status) || 0;
    error = String(probeError?.message || probeError || 'Probe failed');
    if (httpStatus === 429) status = 'rate_limited';
    else if (/abort|timeout/i.test(error)) status = 'timeout';
  }

  const latency = Math.min(Date.now() - start, PROBE_TIMEOUT_MS + 50);
  try {
    db.prepare(`
      INSERT INTO requests (platform, model_id, requested_model, status, latency_ms, error, created_at, request_type)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'probe')
    `).run(model.platform, model.model_id, model.model_id, status === 'ok' ? 'success' : 'error', latency, error || null);
  } catch { /* request history is observability, never a probe blocker */ }

  return {
    ok: status === 'ok',
    modelDbId,
    platform: model.platform,
    modelId: model.model_id,
    displayName: model.display_name,
    status,
    latency,
    error: error.substring(0, 300),
    enabled: model.chain_enabled === 1 && model.model_enabled === 1,
    httpStatus,
  };
}

export async function runModelProbes(modelDbIds: readonly number[], concurrency = 2): Promise<ProbeResult[]> {
  const ids = [...new Set(modelDbIds.filter(Number.isInteger))];
  const results = new Array<ProbeResult>(ids.length);
  const workerCount = Math.min(Math.max(Math.floor(concurrency) || 2, 1), 5, ids.length || 1);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= ids.length) return;
      const modelDbId = ids[index];
      try {
        results[index] = await probeModelUpstream(modelDbId);
      } catch (err: any) {
        results[index] = { ok: false, modelDbId, status: 'error', latency: 0, error: String(err?.message || err), enabled: false };
      }
      // Avoid stampeding one provider when several group members share it.
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function markProbeRun(at = new Date().toISOString()): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('health_check_last_run', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(at);
}
