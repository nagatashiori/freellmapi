import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

/** Add the selected API key identity to each durable routing attempt. */
export function up(db: Db): void {
  if (!hasColumn(db, 'routing_events', 'key_id')) {
    // Deliberately keep this as a nullable identity, not a foreign key:
    // deleted API keys must not erase or block historical routing events.
    db.exec('ALTER TABLE routing_events ADD COLUMN key_id INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_routing_events_key ON routing_events(key_id, created_at DESC)');
}

/** Rebuild the small append-only table so the migration remains reversible. */
export function down(db: Db): void {
  if (!hasColumn(db, 'routing_events', 'key_id')) return;

  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_routing_events_key');
    db.exec('ALTER TABLE routing_events RENAME TO routing_events_with_key_id');
    db.exec(`
      CREATE TABLE routing_events (
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
      )
    `);
    db.exec(`
      INSERT INTO routing_events
        (id, request_id, surface, attempt, event, platform, model_id,
         requested_model, latency_ms, input_tokens, output_tokens, error, created_at)
      SELECT id, request_id, surface, attempt, event, platform, model_id,
             requested_model, latency_ms, input_tokens, output_tokens, error, created_at
        FROM routing_events_with_key_id
    `);
    db.exec('DROP TABLE routing_events_with_key_id');
    db.exec('CREATE INDEX IF NOT EXISTS idx_routing_events_request ON routing_events(request_id, id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_routing_events_created ON routing_events(created_at DESC)');
  })();
}
