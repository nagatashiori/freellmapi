// Real-traffic health signal.
//
// Two weaknesses had the same root cause — routing trusted only probes, and the
// only signal from REAL traffic was an in-memory penalty:
//
//   1. A probe saying "ok" does not mean real requests succeed.
//      `mapleleaf/gemini-3.5-flash` probed ok while live traffic got Cloudflare
//      522s (25/43 over seven days, four consecutive failures inside one minute).
//   2. The in-memory penalty is process state: it decays 1 per 2 minutes from a
//      cap of 10 and is wiped by every container restart, so a dead model leads
//      the chain again after a restart or ~20 idle minutes.
//
// The `requests` table already persists every real attempt, so the fix is to
// read the failure signal from there: it contradicts an over-optimistic probe AND
// survives restarts. Deliberately conservative — a model needs a minimum number
// of recent attempts before its success rate can demote it, so one unlucky
// failure cannot exile a good model.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  REAL_FAILURE_MIN_ATTEMPTS,
  REAL_FAILURE_WINDOW_MS,
  REAL_FAILURE_MAX_SUCCESS_RATE,
  getRecentlyFailingModels,
  demoteUnhealthyRoutes,
} from '../../services/router.js';
import type { ModelProbeHealth } from '../../services/model-health.js';

let nextId = 9000;
function addModel(platform: string): number {
  const id = nextId++;
  getDb().prepare(`
    INSERT INTO models (id, platform, model_id, display_name, intelligence_rank,
      speed_rank, size_label, enabled)
    VALUES (?, ?, ?, ?, 1, 1, 'test', 1)
  `).run(id, platform, `m-${id}`, `M ${id}`);
  return id;
}

function addRequest(modelDbId: number, status: string, minutesAgo: number, type = 'chat') {
  const row = getDb().prepare('SELECT platform, model_id FROM models WHERE id = ?').get(modelDbId) as
    { platform: string; model_id: string };
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, request_type, created_at)
    VALUES (?, ?, ?, ?, datetime('now', ?))
  `).run(row.platform, row.model_id, status, type, `-${minutesAgo} minutes`);
}

describe('getRecentlyFailingModels', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM requests WHERE platform LIKE 'rt-test-%'").run();
    getDb().prepare("DELETE FROM models WHERE platform LIKE 'rt-test-%'").run();
  });

  it('flags a model whose recent real requests almost all failed', () => {
    const id = addModel('rt-test-dead');
    for (let i = 0; i < 5; i++) addRequest(id, 'error', 5);
    expect(getRecentlyFailingModels(getDb(), [id])).toEqual(new Set([id]));
  });

  it('does not flag a model with too few attempts to judge', () => {
    const id = addModel('rt-test-quiet');
    for (let i = 0; i < REAL_FAILURE_MIN_ATTEMPTS - 1; i++) addRequest(id, 'error', 5);
    expect(getRecentlyFailingModels(getDb(), [id])).toEqual(new Set());
  });

  it('does not flag a model that is mostly succeeding', () => {
    const id = addModel('rt-test-ok');
    for (let i = 0; i < 8; i++) addRequest(id, 'success', 5);
    addRequest(id, 'error', 5);
    expect(getRecentlyFailingModels(getDb(), [id])).toEqual(new Set());
  });

  it('ignores failures older than the window', () => {
    const id = addModel('rt-test-recovered');
    const staleMinutes = Math.round(REAL_FAILURE_WINDOW_MS / 60_000) + 30;
    for (let i = 0; i < 6; i++) addRequest(id, 'error', staleMinutes);
    expect(getRecentlyFailingModels(getDb(), [id])).toEqual(new Set());
  });

  it('ignores probe rows — probes are a separate signal', () => {
    const id = addModel('rt-test-probeonly');
    for (let i = 0; i < 6; i++) addRequest(id, 'error', 5, 'probe');
    expect(getRecentlyFailingModels(getDb(), [id])).toEqual(new Set());
  });

  it('treats both ok and success as successful outcomes', () => {
    const id = addModel('rt-test-okword');
    for (let i = 0; i < 6; i++) addRequest(id, 'ok', 5);
    expect(getRecentlyFailingModels(getDb(), [id])).toEqual(new Set());
  });

  it('uses the documented success-rate threshold', () => {
    // 1 success out of 8 = 12.5%, below the threshold → flagged.
    const id = addModel('rt-test-threshold');
    addRequest(id, 'success', 5);
    for (let i = 0; i < 7; i++) addRequest(id, 'error', 5);
    expect(REAL_FAILURE_MAX_SUCCESS_RATE).toBeLessThan(0.5);
    expect(getRecentlyFailingModels(getDb(), [id])).toEqual(new Set([id]));
  });

  it('returns an empty set for an empty input', () => {
    expect(getRecentlyFailingModels(getDb(), [])).toEqual(new Set());
  });
});

describe('demoteUnhealthyRoutes with the real-traffic signal', () => {
  const NOW = Date.parse('2026-07-26T08:00:00Z');
  function health(over: Partial<ModelProbeHealth> = {}): ModelProbeHealth {
    return {
      lastStatus: 'ok', lastProbedAt: '2026-07-26 07:50:00', lastLatencyMs: 100,
      avgLatencyMs: 100, sampleCount: 1, cooldownUntilMs: null,
      usableKeyCount: 1, coolingKeyCount: 0, ...over,
    };
  }

  it('demotes a model whose probe says ok but whose real traffic is failing', () => {
    const map = new Map([[1, health()], [2, health()]]);
    const ordered = [{ model_db_id: 1 }, { model_db_id: 2 }];
    expect(demoteUnhealthyRoutes(ordered, map, new Set([1]), NOW).map(e => e.model_db_id))
      .toEqual([2, 1]);
  });

  it('leaves the order alone when nothing is failing', () => {
    const map = new Map([[1, health()], [2, health()]]);
    const ordered = [{ model_db_id: 1 }, { model_db_id: 2 }];
    expect(demoteUnhealthyRoutes(ordered, map, new Set(), NOW).map(e => e.model_db_id))
      .toEqual([1, 2]);
  });

  it('keeps probe-unhealthy and traffic-failing models in the same last band', () => {
    const map = new Map([
      [1, health({ lastStatus: 'error' })], // probe-unhealthy
      [2, health()],                        // healthy
      [3, health()],                        // healthy probe, failing traffic
    ]);
    const ordered = [{ model_db_id: 1 }, { model_db_id: 2 }, { model_db_id: 3 }];
    expect(demoteUnhealthyRoutes(ordered, map, new Set([3]), NOW).map(e => e.model_db_id))
      .toEqual([2, 1, 3]);
  });
});
