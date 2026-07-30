import type { Db } from '../types.js';

/**
 * Performance index for routing decisions that query recent real (non-probe) traffic
 * failure rates per model (getRecentlyFailingModels in router.ts).
 */
export function up(db: Db): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_platform_model_created
      ON requests(platform, model_id, created_at DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_requests_platform_model_created;
  `);
}
