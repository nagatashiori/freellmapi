import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { recordModelProbeOutcome, type ProbeOutcome } from '../../services/model-probe.js';
import { getDefaultProfileId } from '../../services/routing-groups.js';

function outcome(status: ProbeOutcome['status'], latency = 25): ProbeOutcome {
  return {
    status,
    latency,
    error: status === 'ok' ? '' : status,
    httpStatus: status === 'ok' ? 200 : status === 'rate_limited' ? 429 : 500,
  };
}

describe('model probe AUTO transitions', () => {
  let modelId: number;
  let activeProfileId: number;
  let inactiveProfileId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    activeProfileId = getDefaultProfileId(db);
    const model = db.prepare(`
      SELECT pm.model_db_id AS id
      FROM profile_models pm
      WHERE pm.profile_id = ?
      ORDER BY pm.priority, pm.model_db_id
      LIMIT 1
    `).get(activeProfileId) as { id: number };
    modelId = model.id;
    inactiveProfileId = Number(db.prepare(`
      INSERT INTO profiles (name, type, sort_order) VALUES ('Probe Inactive', 'custom', 999)
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
      VALUES (?, ?, 1, 0)
    `).run(inactiveProfileId, modelId);
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests WHERE request_type = ?').run('probe');
    db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(modelId);
    db.prepare('UPDATE profile_models SET enabled = 1 WHERE profile_id = ? AND model_db_id = ?')
      .run(activeProfileId, modelId);
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE profile_id = ? AND model_db_id = ?')
      .run(inactiveProfileId, modelId);
    setSetting('active_profile_id', String(activeProfileId));
  });

  function switches() {
    const db = getDb();
    const model = db.prepare('SELECT enabled FROM models WHERE id = ?').get(modelId) as { enabled: number };
    const active = db.prepare('SELECT enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?')
      .get(activeProfileId, modelId) as { enabled: number };
    const inactive = db.prepare('SELECT enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?')
      .get(inactiveProfileId, modelId) as { enabled: number };
    return { model: model.enabled, active: active.enabled, inactive: inactive.enabled };
  }

  it('success enables the model and active-profile membership only', () => {
    const db = getDb();
    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(modelId);
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE profile_id = ? AND model_db_id = ?')
      .run(activeProfileId, modelId);

    const result = recordModelProbeOutcome(modelId, outcome('ok'));

    expect(result.enabled).toBe(true);
    expect(switches()).toEqual({ model: 1, active: 1, inactive: 0 });
  });

  it('three consecutive error/timeout probe rows disable both active switches', () => {
    recordModelProbeOutcome(modelId, outcome('error'));
    expect(switches()).toEqual({ model: 1, active: 1, inactive: 0 });
    recordModelProbeOutcome(modelId, outcome('timeout'));
    expect(switches()).toEqual({ model: 1, active: 1, inactive: 0 });
    const third = recordModelProbeOutcome(modelId, outcome('error'));

    expect(third.enabled).toBe(false);
    expect(switches()).toEqual({ model: 0, active: 0, inactive: 0 });
  });

  it('rate_limited records its exact status and does not disable the model', () => {
    const result = recordModelProbeOutcome(modelId, outcome('rate_limited'));
    const saved = getDb().prepare(`
      SELECT status FROM requests WHERE request_type = 'probe' ORDER BY id DESC LIMIT 1
    `).get() as { status: string };

    expect(result.enabled).toBe(true);
    expect(saved.status).toBe('rate_limited');
    expect(switches()).toEqual({ model: 1, active: 1, inactive: 0 });
  });

  it('a later success immediately restores AUTO participation', () => {
    recordModelProbeOutcome(modelId, outcome('error'));
    recordModelProbeOutcome(modelId, outcome('timeout'));
    recordModelProbeOutcome(modelId, outcome('error'));
    expect(switches().model).toBe(0);

    const restored = recordModelProbeOutcome(modelId, outcome('ok', 12));
    expect(restored.enabled).toBe(true);
    expect(switches()).toEqual({ model: 1, active: 1, inactive: 0 });
  });

  it('records the probe but changes no switch when the configured active profile does not exist', () => {
    const db = getDb();
    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(modelId);
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE profile_id = ? AND model_db_id = ?')
      .run(activeProfileId, modelId);
    setSetting('active_profile_id', '99999999');

    const result = recordModelProbeOutcome(modelId, outcome('ok'));

    expect(result.enabled).toBe(false);
    expect(switches()).toEqual({ model: 0, active: 0, inactive: 0 });
    const count = getDb().prepare("SELECT COUNT(*) AS count FROM requests WHERE request_type = 'probe'")
      .get() as { count: number };
    expect(count.count).toBe(1);
  });
});
