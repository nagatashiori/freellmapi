import type { Db } from '../types.js';

/**
 * Durable per-attempt routing timeline. `requests` remains the analytics row
 * for each finished attempt; this table also stores the pre-dispatch event, so
 * operators can see that a selected provider was actually sent an upstream
 * request before it later timed out or fell back.
 */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      event TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      requested_model TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_routing_events_request ON routing_events(request_id, id);
    CREATE INDEX IF NOT EXISTS idx_routing_events_created ON routing_events(created_at DESC);
    -- Probe-health ranking is on the hot routing path for unified model groups.
    -- This covers its per-model latest-probe and 24h-success lookups without
    -- scanning the full request history for every candidate.
    CREATE INDEX IF NOT EXISTS idx_requests_probe_model_recent
      ON requests(request_type, platform, LOWER(model_id), created_at DESC, id DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_requests_probe_model_recent;
    DROP TABLE IF EXISTS routing_events;
  `);
}
