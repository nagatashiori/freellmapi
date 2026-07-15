const OVERRIDE_COLUMNS = {
    displayName: 'display_name',
    intelligenceRank: 'intelligence_rank',
    speedRank: 'speed_rank',
    sizeLabel: 'size_label',
    rpmLimit: 'rpm_limit',
    rpdLimit: 'rpd_limit',
    tpmLimit: 'tpm_limit',
    tpdLimit: 'tpd_limit',
    monthlyTokenBudget: 'monthly_token_budget',
    contextWindow: 'context_window',
    supportsVision: 'supports_vision',
    supportsTools: 'supports_tools',
};
function parseOverrides(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
function toDbValue(key, value) {
    if (key === 'supportsVision' || key === 'supportsTools')
        return value ? 1 : 0;
    return value;
}
function cleanPatch(patch) {
    const cleaned = {};
    for (const key of Object.keys(OVERRIDE_COLUMNS)) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
            cleaned[key] = patch[key];
        }
    }
    return cleaned;
}
export function isCatalogManagedModel(row) {
    return row.platform !== 'custom' && row.key_id == null;
}
export function isCatalogModelTombstoned(db, kind, platform, modelId) {
    return !!db
        .prepare('SELECT 1 FROM catalog_model_tombstones WHERE kind = ? AND platform = ? AND model_id = ?')
        .get(kind, platform, modelId);
}
export function recordCatalogModelTombstone(db, kind, platform, modelId) {
    db.prepare(`
    INSERT INTO catalog_model_tombstones (kind, platform, model_id)
    VALUES (?, ?, ?)
    ON CONFLICT(kind, platform, model_id) DO UPDATE SET created_at = datetime('now')
  `).run(kind, platform, modelId);
    if (kind === 'chat') {
        db.prepare('DELETE FROM model_overrides WHERE platform = ? AND model_id = ?').run(platform, modelId);
    }
}
export function clearCatalogModelTombstone(db, kind, platform, modelId) {
    db.prepare('DELETE FROM catalog_model_tombstones WHERE kind = ? AND platform = ? AND model_id = ?')
        .run(kind, platform, modelId);
}
export function upsertModelOverrides(db, platform, modelId, patch) {
    const cleaned = cleanPatch(patch);
    if (Object.keys(cleaned).length === 0)
        return {};
    const existing = db
        .prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
        .get(platform, modelId);
    const merged = { ...parseOverrides(existing?.overrides_json), ...cleaned };
    db.prepare(`
    INSERT INTO model_overrides (platform, model_id, overrides_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(platform, model_id)
    DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at
  `).run(platform, modelId, JSON.stringify(merged));
    return merged;
}
export function getModelOverrides(db, platform, modelId) {
    const row = db
        .prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
        .get(platform, modelId);
    return parseOverrides(row?.overrides_json);
}
export function applyModelOverrides(db, platform, modelId) {
    const overrides = getModelOverrides(db, platform, modelId);
    const keys = Object.keys(overrides);
    if (keys.length === 0)
        return false;
    const assignments = [];
    const values = [];
    for (const key of keys) {
        assignments.push(`${OVERRIDE_COLUMNS[key]} = ?`);
        values.push(toDbValue(key, overrides[key]));
    }
    values.push(platform, modelId);
    db.prepare(`UPDATE models SET ${assignments.join(', ')} WHERE platform = ? AND model_id = ?`).run(...values);
    return true;
}
export function applyAllModelOverrides(db) {
    const rows = db.prepare('SELECT platform, model_id FROM model_overrides').all();
    let applied = 0;
    for (const row of rows) {
        if (applyModelOverrides(db, row.platform, row.model_id))
            applied++;
    }
    return applied;
}
export function deleteTombstonedCatalogModels(db) {
    const chatRows = db.prepare(`
    SELECT m.id, m.platform, m.model_id
      FROM models m
      JOIN catalog_model_tombstones t
        ON t.kind = 'chat' AND t.platform = m.platform AND t.model_id = m.model_id
     WHERE m.platform != 'custom' AND m.key_id IS NULL
  `).all();
    const mediaRows = db.prepare(`
    SELECT mm.id
      FROM media_models mm
      JOIN catalog_model_tombstones t
        ON t.kind = 'media' AND t.platform = mm.platform AND t.model_id = mm.model_id
  `).all();
    const deleteChatFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
    const deleteChat = db.prepare('DELETE FROM models WHERE id = ?');
    const deleteMedia = db.prepare('DELETE FROM media_models WHERE id = ?');
    for (const row of chatRows) {
        deleteChatFallback.run(row.id);
        deleteChat.run(row.id);
    }
    for (const row of mediaRows) {
        deleteMedia.run(row.id);
    }
    return chatRows.length + mediaRows.length;
}
//# sourceMappingURL=model-state.js.map