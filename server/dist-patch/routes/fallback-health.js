// ── Health probe: per-model status from recent requests ────────────────────
fallbackRouter.get('/health', (_req, res) => {
    const db = getDb();
    // Get latest request per (platform, requested_model)
    const lastReqs = db.prepare(`
        SELECT r.platform, r.requested_model, r.status, r.id
        FROM requests r
        WHERE r.id IN (
            SELECT MAX(r2.id) FROM requests r2
            WHERE r2.requested_model IS NOT NULL AND r2.requested_model != ''
            GROUP BY r2.platform, r2.requested_model
        )
    `).all();
    const healthMap = new Map();
    for (const r of lastReqs) {
        const key = r.platform + ':' + (r.requested_model || '');
        healthMap.set(key, r.status);
    }
    // Build response for all models in fallback_config
    const rows = db.prepare(`
        SELECT fc.model_db_id, m.platform, m.model_id, m.display_name
        FROM fallback_config fc
        JOIN models m ON m.id = fc.model_db_id
    `).all();
    const result = rows.map(r => {
        const key = r.platform + ':' + r.model_id;
        const displayKey = r.platform + ':' + r.display_name;
        const status = healthMap.get(key) || healthMap.get(displayKey) || 'unknown';
        return {
            modelDbId: r.model_db_id,
            healthStatus: status,
            lastProbedAt: null,
        };
    });
    res.json(result);
});
