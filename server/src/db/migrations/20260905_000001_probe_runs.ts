import type { Db } from '../types.js';

/**
 * Unified key-pool health testing (v15):
 *  - `probe_runs` persists one async health-test batch (the /api/fallback/probe-runs
 *    API): its kind, live progress counters, and the final summary JSON. The
 *    in-memory manager is authoritative while a run is active; this table makes
 *    finished runs (and runs interrupted by a restart) inspectable afterwards.
 *  - `requests.probe_run_id` ties every per-(model, key) probe row written to
 *    `requests` back to its batch, so a run's matrix can be replayed/audited and
 *    per-key probe history is queryable. `requests.key_id` (already present since
 *    the baseline) is now MANDATORY for probe writes — the probe engine resolves
 *    the pool through the unified key pool and probes EVERY applicable key.
 */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS probe_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      total_combos INTEGER NOT NULL DEFAULT 0,
      completed_combos INTEGER NOT NULL DEFAULT 0,
      ok_count INTEGER NOT NULL DEFAULT 0,
      partial_count INTEGER NOT NULL DEFAULT 0,
      rate_limited_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      result_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_probe_runs_created ON probe_runs(created_at DESC);
  `);

  const cols = db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'probe_run_id')) {
    db.exec('ALTER TABLE requests ADD COLUMN probe_run_id TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_probe_run ON requests(probe_run_id) WHERE probe_run_id IS NOT NULL;
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_requests_probe_run;
    DROP INDEX IF EXISTS idx_probe_runs_created;
    DROP TABLE IF EXISTS probe_runs;
  `);
  // The roundtrip migration test requires down() to restore the exact prior
  // schema, so the nullable column has to go too. DROP COLUMN needs SQLite
  // >= 3.35 (better-sqlite3 bundles a far newer SQLite) and no surviving
  // index may reference the column — idx_requests_probe_run is dropped above.
  const cols = db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>;
  if (cols.some(c => c.name === 'probe_run_id')) {
    db.exec('ALTER TABLE requests DROP COLUMN probe_run_id');
  }
}
