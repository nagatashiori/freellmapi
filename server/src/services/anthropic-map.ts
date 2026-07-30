import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdToMembers } from './model-groups.js';

// Claude Code model mapping. Claude Code keeps its built-in model names
// (e.g. `claude-sonnet-4-5` as the main model, `claude-3-5-haiku` as the
// small/fast background model) and sends them verbatim to `/v1/messages`.
// Since this proxy serves a free model pool (not the real Claude cloud
// models), we map each Claude family to either "auto" (let the router pick —
// the default and the common case) or a specific catalog model the operator
// pins. A concrete catalog model id sent directly (e.g. the user set
// ANTHROPIC_MODEL to one of our models) bypasses the map and pins as-is.
//
// Stored as a JSON blob in the `settings` table — no migration needed.

const SETTING_KEY = 'anthropic_model_map';

export const CLAUDE_FAMILIES = ['default', 'opus', 'sonnet', 'haiku'] as const;
export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];
// Each value is either the sentinel 'auto' or a catalog model_id.
export type AnthropicModelMap = Record<ClaudeFamily, string>;

const DEFAULT_MAP: AnthropicModelMap = { default: 'auto', opus: 'auto', sonnet: 'auto', haiku: 'auto' };

// Some Anthropic clients advertise a provider-prefixed StepFun id while the
// catalog stores the provider-neutral id. Keep this compatibility alias narrow
// and route it through the ordinary logical-model group, never Default auto.
const CATALOG_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'stepfun-step-3.7-flash': 'step-3.7-flash',
};

export const anthropicModelMapSchema = z.object({
  default: z.string().min(1).optional(),
  opus: z.string().min(1).optional(),
  sonnet: z.string().min(1).optional(),
  haiku: z.string().min(1).optional(),
}).strict();

export function getClaudeModelMap(): AnthropicModelMap {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return { ...DEFAULT_MAP };
  try {
    const p = JSON.parse(raw) as Partial<AnthropicModelMap>;
    return {
      default: typeof p.default === 'string' && p.default ? p.default : 'auto',
      opus: typeof p.opus === 'string' && p.opus ? p.opus : 'auto',
      sonnet: typeof p.sonnet === 'string' && p.sonnet ? p.sonnet : 'auto',
      haiku: typeof p.haiku === 'string' && p.haiku ? p.haiku : 'auto',
    };
  } catch {
    return { ...DEFAULT_MAP };
  }
}

export function setClaudeModelMap(input: unknown): AnthropicModelMap {
  const patch = anthropicModelMapSchema.parse(input);
  const current = getClaudeModelMap();
  const next: AnthropicModelMap = {
    default: patch.default ?? current.default,
    opus: patch.opus ?? current.opus,
    sonnet: patch.sonnet ?? current.sonnet,
    haiku: patch.haiku ?? current.haiku,
  };
  setSetting(SETTING_KEY, JSON.stringify(next));
  return next;
}

// Classify a requested model into a Claude family, or null when it's not a
// Claude alias at all (a concrete catalog id meant to pin directly).
export function classifyClaudeFamily(model?: string): ClaudeFamily | null {
  const m = (model ?? '').trim().toLowerCase();
  if (!m || m === 'auto' || m === 'default' || m === 'freellmapi-auto') return 'default';
  // Claude Code's planning alias is opus-ish by name but must hit the catch-all,
  // so match it before the substring family checks below.
  if (m === 'opusplan' || m === 'opusplan-4') return 'default';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  // Any other claude-ish alias → the catch-all.
  if (m.startsWith('claude')) return 'default';
  return null;
}

export interface ResolvedAnthropicModel {
  // The catalog model db id to pin, or undefined to auto-route.
  preferredModelDbId?: number;
  // True when we resolved to a specific model (for analytics/pinned labels).
  pinned: boolean;
  // When target starts with 'auto:', carry the profile name so the caller can
  // resolve the correct chain via resolveRoutingChain() instead of using the
  // active profile.
  profileName?: string;
  // A concrete, non-Claude model id that is not present in the catalog. The
  // route must reject this instead of treating a typo as an auto request.
  unknownModel?: string;
  // The catalog id used to resolve a known client alias to its model group.
  // The route still records the original requested id in analytics.
  catalogModelId?: string;
}

// Resolve the model a `/v1/messages` request should route to, honoring the
// operator's family map. Returns undefined preferredModelDbId to mean
// "auto-route" (the default for every family unless the operator pinned one).
// When target is 'auto:<profile>' the caller should resolve the chain via
// resolveRoutingChain() and pass it as the groupChain to routeRequest().
export function resolveAnthropicModel(model?: string): ResolvedAnthropicModel {
  const db = getDb();
  const lookupEnabled = (modelId: string): number | undefined => {
    const row = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(modelId) as { id: number } | undefined;
    return row?.id;
  };

  // 'auto:<profile>' — let the routing system pick the named profile chain
  // (e.g. 'auto:high' → high profile, 'auto:mid' → mid profile).
  // Must come before classifyClaudeFamily so 'auto:' doesn't fall through to
  // the concrete-model-ID lookup path.
  if (model && model.toLowerCase().startsWith('auto:')) {
    return { pinned: false, profileName: model.toLowerCase().slice('auto:'.length).trim() };
  }

  const family = classifyClaudeFamily(model);
  if (family) {
    const target = getClaudeModelMap()[family];
    if (!target || target === 'auto') return { pinned: false };
    // Map values may be profile routes (auto:high / auto:mid / auto:light),
    // not catalog model ids. Without this branch, lookupEnabled('auto:high')
    // fails and we silently fall back to the active Default profile — so the
    // Keys page Anthropic mapping (Opus→auto:high etc.) never actually fires.
    const lowerTarget = target.toLowerCase();
    if (lowerTarget.startsWith('auto:')) {
      const profileName = lowerTarget.slice('auto:'.length).trim();
      return profileName
        ? { pinned: false, profileName }
        : { pinned: false };
    }
    const id = lookupEnabled(target);
    // A pinned-but-now-disabled/removed target degrades gracefully to auto.
    return id != null ? { preferredModelDbId: id, pinned: true } : { pinned: false };
  }

  // Not a Claude alias: treat as a concrete catalog model id and pin it if it
  // exists and is enabled; otherwise auto-route (lenient, like the OpenAI route).
  const concreteModel = (model ?? '').trim();
  const catalogModelId = CATALOG_MODEL_ALIASES[concreteModel.toLowerCase()] ?? concreteModel;
  const id = lookupEnabled(catalogModelId);
  if (id != null) return { preferredModelDbId: id, pinned: true, catalogModelId };

  if (isUnifyEnabled()) {
    const groupMembers = resolveRequestedIdToMembers(catalogModelId, getModelGroups());
    if (groupMembers && groupMembers.length > 0) {
      return { pinned: true, catalogModelId };
    }
  }

  // Keep the existing graceful fallback for catalog models that are currently
  // disabled, but never silently substitute an unrelated default-route model
  // for an id the gateway does not know at all.
  const exists = db.prepare('SELECT 1 FROM models WHERE model_id = ?').get(catalogModelId);
  return exists ? { pinned: false } : { pinned: false, unknownModel: concreteModel };
}
