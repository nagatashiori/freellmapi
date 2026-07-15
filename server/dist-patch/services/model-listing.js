import { getDb } from '../db/index.js';
import { isUnifyEnabled, getModelGroups } from './model-groups.js';
export function buildModelListing() {
    const availableExpr = `
    (CASE WHEN m.enabled = 1 AND EXISTS (
        SELECT 1 FROM api_keys k
        WHERE k.platform = m.platform
          AND k.enabled = 1
          AND (m.key_id IS NULL OR k.id = m.key_id)
      ) THEN 1 ELSE 0 END)`;
    const db = getDb();
    let allListed;
    if (isUnifyEnabled()) {
        const rows = db.prepare(`
      SELECT m.id, m.platform, m.intelligence_rank, m.context_window, m.supports_tools,
             m.enabled AS enabled, ${availableExpr} AS available
      FROM models m
    `).all();
        const byId = new Map(rows.map(r => [r.id, r]));
        allListed = getModelGroups().map(g => {
            const infos = g.members.map(m => byId.get(m.model_db_id)).filter(Boolean);
            const ctxs = infos.map(i => i.context_window).filter((c) => c != null);
            return {
                id: g.canonicalId,
                name: g.groupLabel,
                ownedBy: 'freellmapi',
                available: infos.some(i => i.available === 1) ? 1 : 0,
                enabled: infos.some(i => i.enabled === 1) ? 1 : 0,
                contextWindow: ctxs.length ? Math.max(...ctxs) : null,
                intel: infos.length ? Math.min(...infos.map(i => i.intelligence_rank)) : Number.MAX_SAFE_INTEGER,
                platforms: [...new Set(infos.map(i => i.platform))],
                supportsTools: infos.some(i => i.supports_tools === 1),
            };
        });
    }
    else {
        // Unify OFF: one entry per model_id (dedup picks the available, smartest
        // representative row).
        const models = db.prepare(`
      SELECT platform, model_id, display_name, context_window, enabled, available, intelligence_rank, id, supports_tools
      FROM (
        SELECT m.platform, m.model_id, m.display_name, m.context_window, m.intelligence_rank, m.id, m.supports_tools,
               m.enabled AS enabled,
               ${availableExpr} AS available,
               ROW_NUMBER() OVER (
                 PARTITION BY m.model_id
                 ORDER BY ${availableExpr} DESC, m.intelligence_rank ASC, m.id ASC
               ) AS rn
        FROM models m
      )
      WHERE rn = 1
    `).all();
        allListed = models.map(m => ({
            id: m.model_id, name: m.display_name, ownedBy: m.platform,
            available: m.available, enabled: m.enabled, contextWindow: m.context_window,
            intel: m.intelligence_rank,
            platforms: [m.platform],
            supportsTools: m.supports_tools === 1,
        }));
    }
    // Stable order: usable first, then enabled, then smartest, then name.
    allListed.sort((a, b) => (b.available - a.available) || (b.enabled - a.enabled) || (a.intel - b.intel) || a.name.localeCompare(b.name));
    const availableContextWindows = allListed
        .filter(m => m.available === 1 && m.contextWindow != null)
        .map(m => m.contextWindow);
    const autoContextWindow = availableContextWindows.length > 0
        ? Math.max(...availableContextWindows)
        : null;
    return { models: allListed, autoContextWindow };
}
//# sourceMappingURL=model-listing.js.map