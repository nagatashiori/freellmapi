import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider, resolveProvider } from '../providers/index.js';
import { getDefaultProfileId, setRoutingModelEnabled } from './routing-groups.js';
import { setCooldown } from './ratelimit.js';

export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_RATE_LIMIT_COOLDOWN_MS = 90_000;

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

interface ProbeModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  key_id: number | null;
}

export interface ProbeOutcome {
  status: ProbeResult['status'];
  latency: number;
  error: string;
  httpStatus: number;
}

function activeProfileIdOrNull(db: ReturnType<typeof getDb>): number | null {
  const setting = db.prepare(
    "SELECT value FROM settings WHERE key = 'active_profile_id'",
  ).get() as { value: string } | undefined;

  if (setting) {
    const configured = Number(setting.value);
    if (!Number.isInteger(configured)) return null;
    const exists = db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(configured);
    return exists ? configured : null;
  }

  try {
    return getDefaultProfileId(db);
  } catch {
    return null;
  }
}

/**
 * Persist one probe result and apply the AUTO participation transition in one
 * synchronous transaction. No async provider work is kept inside the SQLite
 * transaction.
 */
function persistProbeOutcome(model: ProbeModelRow, outcome: ProbeOutcome): boolean {
  const db = getDb();
  const apply = db.transaction(() => {
    db.prepare(`
      INSERT INTO requests (platform, model_id, requested_model, status, latency_ms, error, created_at, request_type)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'probe')
    `).run(
      model.platform,
      model.model_id,
      model.model_id,
      outcome.status,
      outcome.latency,
      outcome.error || null,
    );

    const activeProfileId = activeProfileIdOrNull(db);
    if (activeProfileId != null) {
      if (outcome.status === 'ok') {
        db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(model.id);
        // Existing membership keeps its operator-assigned priority. A missing
        // membership is appended rather than rewriting any existing priority.
        setRoutingModelEnabled(db, activeProfileId, model.id, 1);
      } else if (outcome.status === 'error' || outcome.status === 'timeout') {
        const recent = db.prepare(`
          SELECT status
          FROM requests
          WHERE request_type = 'probe'
            AND platform = ?
            AND LOWER(model_id) = LOWER(?)
          ORDER BY created_at DESC, id DESC
          LIMIT 3
        `).all(model.platform, model.model_id) as Array<{ status: string }>;

        if (recent.length === 3 && recent.every(row => row.status === 'error' || row.status === 'timeout')) {
          db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(model.id);
          db.prepare(`
            UPDATE profile_models
            SET enabled = 0
            WHERE profile_id = ? AND model_db_id = ?
          `).run(activeProfileId, model.id);
        }
      }
      // rate_limited deliberately retains the current switches; cooldown state
      // remains the router's temporary exclusion mechanism.
    }

    if (activeProfileId == null) return false;
    const effective = db.prepare(`
      SELECT m.enabled AS model_enabled, COALESCE(pm.enabled, 0) AS profile_enabled
      FROM models m
      LEFT JOIN profile_models pm
        ON pm.model_db_id = m.id AND pm.profile_id = ?
      WHERE m.id = ?
    `).get(activeProfileId, model.id) as { model_enabled: number; profile_enabled: number } | undefined;
    return effective?.model_enabled === 1 && effective.profile_enabled === 1;
  });

  // Let a transaction failure surface to the caller. Returning a successful
  // upstream result after the durable transition failed would make the WebUI
  // report an AUTO state that was never committed.
  return apply();
}

function currentAutoParticipation(modelDbId: number): boolean {
  const db = getDb();
  const activeProfileId = activeProfileIdOrNull(db);
  if (activeProfileId == null) return false;
  const row = db.prepare(`
    SELECT m.enabled AS model_enabled, COALESCE(pm.enabled, 0) AS profile_enabled
    FROM models m
    LEFT JOIN profile_models pm
      ON pm.model_db_id = m.id AND pm.profile_id = ?
    WHERE m.id = ?
  `).get(activeProfileId, modelDbId) as { model_enabled: number; profile_enabled: number } | undefined;
  return row?.model_enabled === 1 && row.profile_enabled === 1;
}

function unavailableWithoutProbe(model: ProbeModelRow, error: string): ProbeResult {
  return {
    ok: false,
    modelDbId: model.id,
    platform: model.platform,
    modelId: model.model_id,
    displayName: model.display_name,
    status: 'error',
    latency: 0,
    error: error.substring(0, 300),
    enabled: currentAutoParticipation(model.id),
    httpStatus: 0,
  };
}

function finishKnownModelProbe(model: ProbeModelRow, outcome: ProbeOutcome): ProbeResult {
  const enabled = persistProbeOutcome(model, outcome);
  return {
    ok: outcome.status === 'ok',
    modelDbId: model.id,
    platform: model.platform,
    modelId: model.model_id,
    displayName: model.display_name,
    status: outcome.status,
    latency: outcome.latency,
    error: outcome.error.substring(0, 300),
    enabled,
    httpStatus: outcome.httpStatus,
  };
}

/**
 * Record a known probe outcome without issuing upstream traffic. This is the
 * single durable model-health state transition used by tests and by callers
 * that already performed a provider-specific probe elsewhere.
 */
export function recordModelProbeOutcome(modelDbId: number, outcome: ProbeOutcome): ProbeResult {
  const model = getDb().prepare(`
    SELECT id, platform, model_id, display_name, key_id
    FROM models
    WHERE id = ?
  `).get(modelDbId) as ProbeModelRow | undefined;
  if (!model) {
    return {
      ok: false,
      httpStatus: 404,
      error: 'Model not found',
      latency: 0,
      model: null,
      status: 'error',
    };
  }
  return finishKnownModelProbe(model, outcome);
}

/** Direct provider probe used by both manual and scheduled health checks. */
export async function probeModelUpstream(modelDbId: number): Promise<ProbeResult> {
  const db = getDb();
  const model = db.prepare(`
    SELECT id, platform, model_id, display_name, key_id
    FROM models
    WHERE id = ?
  `).get(modelDbId) as ProbeModelRow | undefined;
  if (!model) {
    return { ok: false, httpStatus: 404, error: 'Model not found', latency: 0, model: null, status: 'error' };
  }

  let keyRow = null as {
    id: number;
    platform: string;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
    base_url: string | null;
  } | null;

  if (model.key_id) {
    keyRow = db.prepare(`
      SELECT id, platform, encrypted_key, iv, auth_tag, base_url
      FROM api_keys
      WHERE id = ? AND enabled = 1 AND status IN ('healthy', 'unknown')
    `).get(model.key_id) as typeof keyRow;
  } else {
    keyRow = db.prepare(`
      SELECT id, platform, encrypted_key, iv, auth_tag, base_url
      FROM api_keys
      WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')
      ORDER BY id DESC
      LIMIT 1
    `).get(model.platform) as typeof keyRow;
  }

  if (!keyRow) {
    // Disabled, invalid, and transport-error keys are excluded rather than
    // being turned into durable model failures. No upstream model probe ran.
    return unavailableWithoutProbe(model, `No usable enabled API key for platform ${model.platform}`);
  }

  let apiKey: string;
  try {
    apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch (err: any) {
    return finishKnownModelProbe(model, {
      status: 'error',
      latency: 0,
      error: `Key decrypt failed: ${err?.message ?? err}`,
      httpStatus: 0,
    });
  }

  const provider = resolveProvider(model.platform as any, keyRow.base_url) || getProvider(model.platform as any);
  if (!provider) {
    return finishKnownModelProbe(model, {
      status: 'error',
      latency: 0,
      error: `No provider for platform ${model.platform}`,
      httpStatus: 0,
    });
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
    if (httpStatus === 429) {
      status = 'rate_limited';
      setCooldown(model.platform, model.model_id, keyRow.id, PROBE_RATE_LIMIT_COOLDOWN_MS);
    } else if (/abort|timeout/i.test(error)) status = 'timeout';
  }

  const latency = Math.min(Date.now() - start, PROBE_TIMEOUT_MS + 50);
  return finishKnownModelProbe(model, { status, latency, error, httpStatus });
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
        results[index] = {
          ok: false,
          modelDbId,
          status: 'error',
          latency: 0,
          error: String(err?.message || err),
          enabled: false,
        };
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/** Compatibility timestamp used by the old readable probe-settings endpoint. */
export function markProbeRun(at = new Date().toISOString()): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('health_check_last_run', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(at);
}
