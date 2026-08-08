import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some(item => item.name === column);
}

/** Optional per-account model allow-list. NULL keeps the legacy all-model behavior. */
export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'model_scope_json')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN model_scope_json TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'api_keys', 'model_scope_json')) {
    db.prepare('ALTER TABLE api_keys DROP COLUMN model_scope_json').run();
  }
}
