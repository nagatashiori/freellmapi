import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { getDb } from '../db/index.js';
import {
  resolveProvider,
  rememberUserPlatform,
  isValidUserPlatformSlug,
  isReservedPlatformSlug,
  isUserPlatform,
} from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { parseKeysFromFile, stripJsoncComments, stripTrailingCommas } from '../lib/key-parser.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import { calibrateModelMeta, niceDisplayName } from '../lib/model-intel.js';

export const keysRouter = Router();

// Active providers — must match providers/index.ts registrations + shared/types.ts Platform.
// Moonshot and MiniMax direct integrations were dropped in V4. HuggingFace
// was dropped in V4 and re-added in V13 via the router.huggingface.co route.
// SambaNova was dropped in V23 (free tier permanently retired).
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface', 'opencode', 'ovh', 'agnes', 'reka', 'siliconflow',
  'routeway', 'bazaarlink', 'ainative', 'aion', 'requesty', 'nara', 'aihorde', 'custom',
  // Local modification: AiHub third-party relay (see providers/index.ts).
  'aihub',
] as const;

const ALLOWED_IMPORT_EXTENSIONS = new Set(['.env', '.json', '.jsonc', '.md', '.txt', '.csv']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMPORT_EXTENSIONS.has(ext)) {
      cb(new Error('Unsupported file type'));
      return;
    }
    cb(null, true);
  },
});

// `key` is optional so keyless providers (Kilo's anonymous gateway) can be added
// without one; the handler enforces a non-empty key for everyone else.
// Built-in platforms OR user-defined OpenAI slugs (locedge, etc.) already
// registered via POST /custom with platformId.
const addKeySchema = z.object({
  platform: z.string().min(1),
  key: z.string().optional(),
  label: z.string().optional(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined, {
  message: 'At least one of enabled or label must be provided',
});

const importKeySchema = z.object({
  keyName: z.string().optional(),
  keyValue: z.string().min(1),
  platform: z.enum(PLATFORMS),
});

function handleUploadError(err: any, res: Response, next: NextFunction): boolean {
  if (!err) return false;
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { message: 'File too large. Maximum size is 5MB' } });
    return true;
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    res.status(413).json({ error: { message: 'Too many files. Maximum is 10' } });
    return true;
  }
  if (err.message?.includes('Unsupported file type')) {
    res.status(400).json({ error: { message: 'Unsupported file type' } });
    return true;
  }
  next(err);
  return true;
}

function parseUpload(file: Express.Multer.File) {
  const content = file.buffer.toString('utf8');
  if (!content.trim()) {
    throw Object.assign(new Error('File contains no data'), { status: 400 });
  }

  if (/\.jsonc?$/i.test(file.originalname)) {
    try {
      JSON.parse(stripTrailingCommas(stripJsoncComments(content)));
    } catch {
      throw Object.assign(new Error('Invalid JSON format'), { status: 400 });
    }
  }

  return parseKeysFromFile(content, file.originalname);
}

function splitRawKey(rawKey: string) {
  const eqIndex = rawKey.indexOf('=');
  return {
    keyName: eqIndex === -1 ? rawKey : rawKey.slice(0, eqIndex),
    keyValue: eqIndex === -1 ? '' : rawKey.slice(eqIndex + 1),
  };
}

function insertImportedKey(platform: (typeof PLATFORMS)[number], keyName: string, keyValue: string) {
  if (platform === 'custom') {
    throw new Error('Custom providers must be added with a base URL');
  }
  if (!resolveProvider(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(keyValue.trim());
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, keyName, encrypted, iv, authTag);
}

// Count enabled catalog models for a platform. Used to warn when a key is
// added for a provider that has zero models in the operator's current catalog
// tier — the Agnes case (#438): the provider is registered and selectable, but
// its models ship in the premium/live catalog and only appear for free-tier
// installs once they age into the monthly catalog, so a fresh install adds the
// key and silently sees nothing.
function enabledModelCount(platform: string): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM models WHERE platform = ? AND enabled = 1',
  ).get(platform) as { c: number };
  return row.c;
}

// Non-null when the just-added key has no usable models yet, so the client can
// explain the silence instead of leaving the user staring at an empty list.
function noModelsNotice(platform: string): string | undefined {
  if (enabledModelCount(platform) > 0) return undefined;
  return (
    `Key saved, but no ${platform} models are in your current catalog yet. ` +
    `Newer providers are published to the premium catalog first and appear ` +
    `for free-tier installs once they age into the monthly catalog. Add a ` +
    `Premium license key to use them now, or add ${platform} as a custom ` +
    `OpenAI-compatible provider with its base URL.`
  );
}

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  // Classic custom: models bound to key_id. Named user platforms (modelscope,
  // locedge…): models have platform=<slug> and key_id NULL — attach by platform.
  const customModels = [
    ...db.prepare(`
      SELECT key_id, id, 'chat' AS kind, model_id, display_name, NULL AS family
        FROM models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
    ...db.prepare(`
      SELECT key_id, id, 'embedding' AS kind, model_id, display_name, family
        FROM embedding_models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
    ...db.prepare(`
      SELECT key_id, id, modality AS kind, model_id, display_name, NULL AS family
        FROM media_models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
  ];
  const modelsByKeyId = new Map<number, any[]>();
  for (const m of customModels) {
    const keyId = Number(m.key_id);
    if (!Number.isInteger(keyId)) continue;
    const list = modelsByKeyId.get(keyId) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      modelId: m.model_id,
      displayName: m.display_name,
      family: m.family ?? null,
    });
    modelsByKeyId.set(keyId, list);
  }

  // Named OpenAI platforms (modelscope, locedge…): models share platform slug, key_id NULL
  const modelsByPlatform = new Map<string, any[]>();
  const platformModelRows = db.prepare(`
    SELECT m.platform, m.id, 'chat' AS kind, m.model_id, m.display_name
      FROM models m
     WHERE m.platform != 'custom'
       AND EXISTS (
         SELECT 1 FROM api_keys k
          WHERE k.platform = m.platform
            AND k.base_url IS NOT NULL AND TRIM(k.base_url) != ''
       )
     ORDER BY m.display_name
  `).all() as any[];
  for (const m of platformModelRows) {
    const list = modelsByPlatform.get(m.platform) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      modelId: m.model_id,
      displayName: m.display_name,
      family: null,
    });
    modelsByPlatform.set(m.platform, list);
  }

  for (const list of modelsByKeyId.values()) {
    list.sort((a, b) => {
      const ka = ['chat', 'embedding', 'image', 'audio'].indexOf(a.kind);
      const kb = ['chat', 'embedding', 'image', 'audio'].indexOf(b.kind);
      return (ka - kb) || String(a.displayName).localeCompare(String(b.displayName));
    });
  }

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    let models: any[] | undefined;
    if (row.platform === 'custom') {
      models = modelsByKeyId.get(row.id) ?? [];
    } else if (modelsByPlatform.has(row.platform)) {
      // Named OpenAI platforms (modelscope, aihub-as-user, locedge…)
      models = modelsByPlatform.get(row.platform);
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      baseUrl: row.base_url ?? null,
      status: row.status,
      enabled: row.enabled === 1,
      keyless: resolveProvider(row.platform)?.keyless === true,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
      models,
    };
  });

  res.json(keys);
});

// Export keys — returns plaintext keys in the requested format.
// GET /api/keys/export?format=json|env|csv&healthy=true
// The response is the raw file download (Content-Type varies by format).
keysRouter.get('/export', (req: Request, res: Response) => {
  const db = getDb();
  const format = (req.query.format as string) ?? 'json';
  const healthyOnly = req.query.healthy === 'true';

  let whereClause = '';
  if (healthyOnly) {
    whereClause = "WHERE status = 'healthy'";
  }

  const rows = db.prepare(`SELECT * FROM api_keys ${whereClause} ORDER BY platform, created_at ASC`).all() as any[];

  // Decrypt and filter — only export keys with a real value
  const decryptedKeys = rows
    .map(row => {
      let key = '';
      try {
        key = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      } catch {
        key = '';
      }
      return {
        platform: row.platform,
        key,
        label: row.label || '',
        baseUrl: row.base_url || undefined,
      };
    })
    .filter(k => {
      const v = k.key.trim();
      return v.length > 0 && v !== 'no-key';
    });

  if (decryptedKeys.length === 0) {
    res.status(404).json({ error: { message: 'No keys to export' } });
    return;
  }

  if (format === 'env') {
    // .env format: GOOGLE_KEY=xxx\nGROQ_KEY=yyy
    const lines = decryptedKeys.map(k => {
      const envKey = `${k.platform.toUpperCase()}_KEY=${k.key}`;
      return k.label ? `# ${k.label}\n${envKey}` : envKey;
    });
    const content = lines.join('\n\n') + '\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.env"');
    res.send(content);
    return;
  }

  if (format === 'csv') {
    // CSV format: platform,key,label
    const escCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
    // CSV formula-injection guard: a spreadsheet treats a cell that starts with
    // =, +, -, @, tab or CR as a live formula, so a label like `=HYPERLINK(...)`
    // would execute on open. Prefix such cells with a single quote to force them
    // to be read as text. Applied only to free-text fields the user controls
    // (labels); the key value must round-trip verbatim for re-import, and the
    // platform is one of our own fixed enum values.
    const neutralize = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const header = 'platform,key,label';
    const lines = decryptedKeys.map(k =>
      [escCsv(k.platform), escCsv(k.key), escCsv(neutralize(k.label))].join(',')
    );
    const content = [header, ...lines].join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.csv"');
    res.send(content);
    return;
  }

  // Default: JSON format (round-trip safe — can be imported directly)
  const jsonExport = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'freellmapi',
    keys: decryptedKeys,
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.json"');
  res.json(jsonExport);
});

// Add a key
keysRouter.post('/', async (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const platform = parsed.data.platform.trim().toLowerCase();
  const { label } = parsed.data;
  const isBuiltin = (PLATFORMS as readonly string[]).includes(platform);
  const db = getDb();

  // Named platforms may exist only in DB (base_url keys) even if the in-memory
  // userPlatforms set was not hydrated yet — treat that as a user platform too.
  const existingUserUrl = db.prepare(
    `SELECT base_url FROM api_keys
      WHERE platform = ? AND base_url IS NOT NULL AND TRIM(base_url) != ''
      LIMIT 1`,
  ).get(platform) as { base_url: string } | undefined;
  const isUser = isUserPlatform(platform) || !!existingUserUrl?.base_url;
  if (isUser && existingUserUrl?.base_url) {
    rememberUserPlatform(platform);
  }

  if (!isBuiltin && !isUser) {
    res.status(400).json({
      error: {
        message: isValidUserPlatformSlug(platform)
          ? `Unknown platform "${platform}". Create it first via Custom provider with platformId=${platform}, then add more keys here.`
          : `Invalid platform "${platform}"`,
      },
    });
    return;
  }
  if (platform === 'custom') {
    res.status(400).json({ error: { message: 'Custom providers must be added with a base URL (Custom section)' } });
    return;
  }

  const isKeyless = resolveProvider(platform)?.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  // Keyless providers (Kilo anon) store a sentinel so routing sees the platform
  // as configured; the provider omits the auth header on outgoing calls.
  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  // A keyless provider needs only one sentinel row — re-enable an existing one
  // instead of piling up duplicates each time the user clicks "Add".
  if (isKeyless) {
    const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);
      res.status(200).json({
        id: existing.id,
        platform,
        label: label ?? '',
        maskedKey: maskKey(keyToStore),
        status: 'unknown',
        enabled: true,
        modelsAvailable: enabledModelCount(platform),
        notice: noModelsNotice(platform),
      });
      return;
    }
  }

  // User platforms: inherit base_url from existing keys so the new key hits
  // the same OpenAI-compatible endpoint (multi-account rotation).
  let baseUrl: string | null = null;
  if (isUser) {
    if (!existingUserUrl?.base_url) {
      res.status(400).json({
        error: { message: `User platform "${platform}" has no base_url yet. Re-add via Custom provider with platformId.` },
      });
      return;
    }
    baseUrl = existingUserUrl.base_url;
  }

  const { encrypted, iv, authTag } = encrypt(keyToStore);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1, ?)
  `).run(platform, label ?? '', encrypted, iv, authTag, baseUrl);

  const newId = Number(result.lastInsertRowid);

  // Immediately probe the key so the UI doesn't show a stale/optimistic
  // "healthy" from a later vague check. Import lazily to avoid circular deps.
  let status: string = 'unknown';
  try {
    const { checkKeyHealth } = await import('../services/health.js');
    status = await checkKeyHealth(newId);
  } catch {
    /* leave unknown — scheduled health will retry */
  }

  res.status(201).json({
    id: newId,
    platform,
    label: label ?? '',
    baseUrl,
    maskedKey: maskKey(keyToStore),
    status,
    enabled: true,
    modelsAvailable: enabledModelCount(platform),
    notice: noModelsNotice(platform),
  });
});

// ── Custom OpenAI-compatible providers (#117, #212) ───────────────────────
// User-configured endpoints (llama.cpp / LM Studio / vLLM / Ollama / any
// OpenAI-compatible base_url). Each DISTINCT base_url gets its own 'custom'
// api_keys row, and every registered model binds to its endpoint's key via
// models.key_id — so several custom providers coexist without overwriting
// each other (#212). Re-submitting an existing base_url updates its key/label;
// re-registering an existing model id re-binds it to the submitted endpoint.
// A model can be given as a bare id ("qwen3:4b") or as {model, displayName}.
// `model`/`displayName` (singular) stay supported for older clients; `models`
// (plural) lets one submit bind several model ids to the same endpoint. (#281)
// A custom model can declare its capabilities at registration. `supportsTools`
// defaults to 1 (modern OpenAI-compatible servers — Ollama, vLLM, LM Studio —
// all emit tool calls), `supportsVision` defaults to 0 unless declared. Leaving
// a flag unset keeps the DB default on insert and preserves the stored value on
// re-registration, so a capability the user later toggled isn't clobbered. (#470)
const modelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    displayName: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
  }),
]);
const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().optional(),
  models: z.array(modelEntrySchema).optional(),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  // Optional user platform slug (e.g. "locedge"). When set, keys/models use
  // platform=<slug> instead of "custom", so you can add MULTIPLE API keys for
  // the same OpenAI-compatible endpoint (account rotation) like nvidia/groq.
  // Omit to keep classic one-key-per-baseUrl `custom` behaviour.
  platformId: z.string().optional(),
  // Top-level defaults applied to every model in this submit; a per-entry flag
  // (object form) overrides them for that one model.
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
}).refine(
  d => (d.model && d.model.trim().length > 0) || (d.models && d.models.length > 0),
  { message: 'model or models is required' },
);

function ensureModelInProfile(db: ReturnType<typeof getDb>, modelDbId: number, profileId: number): void {
  const exists = db.prepare(
    'SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?',
  ).get(profileId, modelDbId);
  if (exists) return;
  const max = db.prepare(
    'SELECT COALESCE(MAX(priority), 0) AS m FROM profile_models WHERE profile_id = ?',
  ).get(profileId) as { m: number };
  db.prepare(
    'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)',
  ).run(profileId, modelDbId, max.m + 1);
}

// Discover models from a third-party OpenAI-compatible /v1/models so the user
// can pick which ids to register as custom (instead of typing them by hand).
const discoverSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  apiKey: z.string().optional(),
});

keysRouter.post('/custom/discover', async (req: Request, res: Response) => {
  const parsed = discoverSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');
  const verdict = await assessProviderUrl(baseUrl);
  if (!verdict.allowed) {
    res.status(400).json({ error: { message: `baseUrl rejected: ${verdict.reason}` } });
    return;
  }

  const apiKey = parsed.data.apiKey?.trim();
  const modelsUrl = `${baseUrl}/models`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'FreeLLMAPI-custom-discover/1.0',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: { message: `Failed to reach ${modelsUrl}: ${msg}` } });
    return;
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    res.status(400).json({
      error: { message: 'Redirects are not followed for custom providers; point baseUrl directly at the API root (…/v1)' },
    });
    return;
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    res.status(502).json({
      error: {
        message: `Upstream /models returned ${upstream.status}: ${text.slice(0, 300)}`,
      },
    });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    res.status(502).json({ error: { message: 'Upstream /models did not return JSON' } });
    return;
  }

  // OpenAI shape: { data: [{ id, … }] }; some gateways return a bare array.
  const rawList: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : Array.isArray((body as { models?: unknown }).models)
        ? ((body as { models: unknown[] }).models)
        : [];

  const models: { id: string; ownedBy?: string; alreadyRegistered: boolean }[] = [];
  const seen = new Set<string>();
  const db = getDb();
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as { id?: unknown; model?: unknown }).id
      ?? (item as { model?: unknown }).model
      ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = (item as { owned_by?: unknown }).owned_by;
    const already = db.prepare(
      'SELECT 1 FROM models WHERE model_id = ? LIMIT 1',
    ).get(id);
    models.push({
      id,
      ownedBy: typeof ownedBy === 'string' ? ownedBy : undefined,
      alreadyRegistered: !!already,
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  res.json({
    baseUrl,
    count: models.length,
    models,
  });
});

keysRouter.post('/custom', async (req: Request, res: Response) => {
  const parsed = customProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');

  // SSRF guard (#440): a base_url is the one user-controlled outbound target.
  // Cloud metadata / link-local addresses are rejected outright; private
  // ranges too when FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS is set. Re-checked
  // at request time in proxyFetch for URLs already in the DB.
  const verdict = await assessProviderUrl(baseUrl);
  if (!verdict.allowed) {
    res.status(400).json({ error: { message: `baseUrl rejected: ${verdict.reason}` } });
    return;
  }
  // Local servers often need no key; keep a sentinel so there's always a bearer.
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const label = parsed.data.label?.trim() || undefined;

  // Optional named platform (multi-key). Empty → classic `custom` (1 key / URL).
  const rawPlatformId = parsed.data.platformId?.trim().toLowerCase() || '';
  let platform = 'custom';
  let multiKey = false;
  if (rawPlatformId) {
    if (!isValidUserPlatformSlug(rawPlatformId)) {
      res.status(400).json({
        error: { message: 'platformId must match /^[a-z][a-z0-9_-]{0,31}$/ (e.g. locedge)' },
      });
      return;
    }
    if (isReservedPlatformSlug(rawPlatformId) || (PLATFORMS as readonly string[]).includes(rawPlatformId)) {
      res.status(400).json({
        error: { message: `platformId "${rawPlatformId}" is reserved; pick another slug` },
      });
      return;
    }
    platform = rawPlatformId;
    multiKey = true;
    rememberUserPlatform(platform);
  }

  // Flatten singular + plural inputs into one list, dedupe by model id, drop
  // blanks. The singular `displayName` only applies to a lone `model` (it can't
  // sensibly fan out across many ids). Capability flags resolve per-entry first,
  // then fall back to the submit-level defaults, then to undefined (DB default).
  const topTools = parsed.data.supportsTools;
  const topVision = parsed.data.supportsVision;
  const entries: { modelId: string; displayName: string; supportsTools?: boolean; supportsVision?: boolean }[] = [];
  const seen = new Set<string>();
  const addEntry = (rawId: string, rawDisplay?: string, tools?: boolean, vision?: boolean) => {
    const modelId = rawId.trim();
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    entries.push({
      modelId,
      // Prefer explicit name; else nice name so Unify groups with catalog rows
      displayName: niceDisplayName(modelId, rawDisplay),
      supportsTools: tools ?? topTools,
      supportsVision: vision ?? topVision,
    });
  };
  if (parsed.data.model?.trim()) addEntry(parsed.data.model, parsed.data.displayName);
  for (const m of parsed.data.models ?? []) {
    if (typeof m === 'string') addEntry(m);
    else addEntry(m.model, m.displayName, m.supportsTools, m.supportsVision);
  }

  if (entries.length === 0) {
    res.status(400).json({ error: { message: 'model or models is required' } });
    return;
  }

  const db = getDb();
  const upsert = db.transaction(() => {
    // ── Key row ────────────────────────────────────────────────────────────
    // classic custom: one key per base_url (re-submit overwrites credentials)
    // named platformId: ALWAYS insert a new key → multi-account rotation
    let keyId: number;
    let storedKeyForMask = providedKey ?? 'no-key';

    if (multiKey) {
      // Enforce one base_url per user platform (all accounts share the endpoint).
      const existingUrl = db.prepare(
        `SELECT base_url FROM api_keys
          WHERE platform = ? AND base_url IS NOT NULL AND TRIM(base_url) != ''
          LIMIT 1`,
      ).get(platform) as { base_url: string } | undefined;
      if (existingUrl && existingUrl.base_url.replace(/\/+$/, '') !== baseUrl) {
        throw new Error(
          `platform "${platform}" already uses base_url ${existingUrl.base_url}; `
          + `use that URL or a different platformId`,
        );
      }
      const keyToStore = providedKey ?? 'no-key';
      const { encrypted, iv, authTag } = encrypt(keyToStore);
      const r = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES (?, ?, ?, ?, ?, 'unknown', 1, ?)
      `).run(platform, label ?? platform, encrypted, iv, authTag, baseUrl);
      keyId = Number(r.lastInsertRowid);
      storedKeyForMask = keyToStore;
    } else {
      // One 'custom' key row PER ENDPOINT (matched on base_url). (#212)
      const existing = db.prepare(
        "SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'custom' AND base_url = ? LIMIT 1",
      ).get(baseUrl) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;
      if (existing) {
        keyId = existing.id;
        if (providedKey) {
          const { encrypted, iv, authTag } = encrypt(providedKey);
          db.prepare(
            "UPDATE api_keys SET label = COALESCE(?, label), encrypted_key = ?, iv = ?, auth_tag = ?, status = 'unknown', enabled = 1 WHERE id = ?",
          ).run(label ?? null, encrypted, iv, authTag, existing.id);
          storedKeyForMask = providedKey;
        } else {
          try {
            storedKeyForMask = decrypt(existing.encrypted_key, existing.iv, existing.auth_tag);
          } catch {
            storedKeyForMask = 'no-key';
          }
          db.prepare(
            "UPDATE api_keys SET label = COALESCE(?, label), status = 'unknown', enabled = 1 WHERE id = ?",
          ).run(label ?? null, existing.id);
        }
      } else {
        const keyToStore = providedKey ?? 'no-key';
        const { encrypted, iv, authTag } = encrypt(keyToStore);
        const r = db.prepare(`
          INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
          VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
        `).run(label ?? 'Custom', encrypted, iv, authTag, baseUrl);
        keyId = Number(r.lastInsertRowid);
        storedKeyForMask = keyToStore;
      }
    }

    const registered: { modelDbId: number; model: string; displayName: string; supportsTools: boolean; supportsVision: boolean }[] = [];
    for (const { modelId, displayName, supportsTools, supportsVision } of entries) {
      // Capability flags: unset → NULL so COALESCE keeps insert default / prior. (#470)
      // Named platforms: key_id NULL so ANY key on that platform can serve the model.
      // Classic custom: bind to this endpoint's key_id.
      const toolsParam = supportsTools === undefined ? null : (supportsTools ? 1 : 0);
      const visionParam = supportsVision === undefined ? null : (supportsVision ? 1 : 0);
      const meta = calibrateModelMeta(modelId, displayName);
      const bindKeyId = multiKey ? null : keyId;
      // Named platformId rows are operator-owned; keep real size_label for routing
      // intel tiers. Catalog prune is blocked by api_keys.base_url SQL guard.
      db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, key_id,
           supports_tools, supports_vision)
        VALUES (@platform, @modelId, @displayName, @intelRank, @speedRank, @sizeLabel, NULL, NULL, NULL, NULL, '', NULL, 1, @keyId,
           COALESCE(@tools, 1), COALESCE(@vision, 0))
        ON CONFLICT(platform, model_id)
        DO UPDATE SET
          display_name = excluded.display_name,
          key_id = excluded.key_id,
          intelligence_rank = excluded.intelligence_rank,
          speed_rank = excluded.speed_rank,
          size_label = excluded.size_label,
          enabled = 1,
          supports_tools = COALESCE(@tools, supports_tools),
          supports_vision = COALESCE(@vision, supports_vision)
      `).run({
        platform,
        modelId,
        displayName,
        intelRank: meta.intelligenceRank,
        // No official catalog speed → neutral 35 (not fake 50/100)
        speedRank: 35,
        sizeLabel: meta.sizeLabel,
        keyId: bindKeyId,
        tools: toolsParam,
        vision: visionParam,
      });

      const modelRow = db.prepare(
        'SELECT id, supports_tools, supports_vision FROM models WHERE platform = ? AND model_id = ?',
      ).get(platform, modelId) as { id: number; supports_tools: number; supports_vision: number };

      // User-registered models join Default only. high/mid/light and other
      // named routing groups are explicit operator-curated groups.
      const defaultProfile = db.prepare(
        "SELECT id FROM profiles WHERE type = 'default' OR LOWER(name) = 'default' ORDER BY CASE WHEN type = 'default' THEN 0 ELSE 1 END LIMIT 1",
      ).get() as { id: number } | undefined;
      if (defaultProfile) ensureModelInProfile(db, modelRow.id, defaultProfile.id);

      registered.push({
        modelDbId: modelRow.id,
        model: modelId,
        displayName,
        supportsTools: modelRow.supports_tools === 1,
        supportsVision: modelRow.supports_vision === 1,
      });
    }

    return { keyId, registered, storedKeyForMask };
  });

  let result: { keyId: number; registered: { modelDbId: number; model: string; displayName: string; supportsTools: boolean; supportsVision: boolean }[]; storedKeyForMask: string };
  try {
    result = upsert();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: { message: msg } });
    return;
  }
  const { keyId, registered, storedKeyForMask } = result;
  // `model`/`displayName`/`modelDbId` echo the first model for older clients;
  // `models` carries the full set registered in this call.
  const first = registered[0]!;
  res.status(201).json({
    success: true,
    keyId,
    modelDbId: first.modelDbId,
    platform,
    multiKey,
    baseUrl,
    model: first.model,
    displayName: first.displayName,
    supportsTools: first.supportsTools,
    supportsVision: first.supportsVision,
    models: registered,
    maskedKey: maskKey(storedKeyForMask),
  });
});

keysRouter.post('/import', (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, (err: any) => {
    if (handleUploadError(err, res, next)) return;

    try {
      if (!req.file) {
        res.status(400).json({ error: { message: 'No file uploaded' } });
        return;
      }

      const result = parseUpload(req.file);
      const imported: Array<{ keyName: string; platform: string }> = [];
      const skipped = [...result.skipped];
      const errors: Array<{ key: string; error: string }> = [];

      for (const parsedKey of result.keys) {
        const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
        if (!parsedKey.platform) {
          skipped.push(keyName);
          continue;
        }
        const platformParse = z.enum(PLATFORMS).safeParse(parsedKey.platform);
        if (!platformParse.success || platformParse.data === 'custom') {
          skipped.push(keyName);
          continue;
        }
        if (!keyValue.trim()) {
          errors.push({ key: keyName, error: 'keyValue must be at least 1 character' });
          continue;
        }

        try {
          insertImportedKey(platformParse.data, keyName, keyValue);
          imported.push({ keyName, platform: platformParse.data });
        } catch (insertErr) {
          errors.push({ key: keyName, error: (insertErr as Error).message });
        }
      }

      res.json({
        imported: imported.length,
        skipped,
        errors,
        total: result.keys.length + result.skipped.length,
      });
    } catch (handlerErr: any) {
      res.status(handlerErr.status ?? 500).json({ error: { message: handlerErr.message } });
    }
  });
});

keysRouter.post('/preview', (req: Request, res: Response, next: NextFunction) => {
  upload.array('files', 10)(req, res, (err: any) => {
    if (handleUploadError(err, res, next)) return;

    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        res.status(400).json({ error: { message: 'No files uploaded' } });
        return;
      }

      const keys: Array<{ keyName: string; keyValue: string; detectedPlatform: string | null; prefix: string; isDuplicate: boolean }> = [];
      const skipped: string[] = [];

      // Build a set of existing decrypted key values for duplicate detection
      const db = getDb();
      const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
      const existingKeys = new Set<string>();
      for (const row of existingRows) {
        try {
          existingKeys.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
        } catch { /* skip undecryptable rows */ }
      }

      let duplicateCount = 0;

      for (const file of files) {
        const result = parseUpload(file);
        for (const parsedKey of result.keys) {
          const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
          const isDuplicate = existingKeys.has(keyValue.trim());
          if (isDuplicate) duplicateCount++;
          keys.push({
            keyName,
            keyValue,
            detectedPlatform: parsedKey.platform,
            prefix: parsedKey.prefix,
            isDuplicate,
          });
        }
        skipped.push(...result.skipped);
      }

      res.json({ keys, total: keys.length, skipped, duplicates: duplicateCount });
    } catch (handlerErr: any) {
      res.status(handlerErr.status ?? 500).json({ error: { message: handlerErr.message } });
    }
  });
});

keysRouter.post('/import-selected', (req: Request, res: Response) => {
  const parsed = z.object({ keys: z.array(importKeySchema).max(100) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let imported = 0;
  let duplicateSkipped = 0;
  const errors: Array<{ key: string; error: string }> = [];

  // Build a set of existing decrypted key values for duplicate detection
  const db = getDb();
  const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
  const existingKeys = new Set<string>();
  for (const row of existingRows) {
    try {
      existingKeys.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
    } catch { /* skip undecryptable rows */ }
  }

  for (const key of parsed.data.keys) {
    const keyName = key.keyName?.trim() || key.platform;
    if (key.platform === 'custom') {
      errors.push({ key: keyName, error: 'Custom providers must be added with a base URL' });
      continue;
    }

    if (existingKeys.has(key.keyValue.trim())) {
      duplicateSkipped++;
      errors.push({ key: keyName, error: 'Duplicate key — already exists' });
      continue;
    }

    try {
      insertImportedKey(key.platform, keyName, key.keyValue);
      imported++;
      existingKeys.add(key.keyValue.trim());
    } catch (err) {
      errors.push({ key: keyName, error: (err as Error).message });
    }
  }

  res.json({
    imported,
    skipped: [],
    errors,
    total: parsed.data.keys.length,
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    // Custom models exist only because POST /custom registered them alongside
    // their endpoint key (#117) — they can't route without it. Cascade away
    // the models bound to THIS endpoint (#212); other custom providers keep
    // theirs. Legacy rows (key_id NULL) are swept once no custom keys remain,
    // so they never linger in the fallback chain forever (#189).
    if (row.platform === 'custom') {
      const defaultEmbedding = db.prepare("SELECT value FROM settings WHERE key = 'embeddings_default_family'").get() as { value: string } | undefined;
      db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom' AND key_id = ?)").run(id);
      db.prepare("DELETE FROM models WHERE platform = 'custom' AND key_id = ?").run(id);
      db.prepare("DELETE FROM embedding_models WHERE platform = 'custom' AND key_id = ?").run(id);
      db.prepare("DELETE FROM media_models WHERE platform = 'custom' AND key_id = ?").run(id);
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number };
      if (remaining.n === 0) {
        db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
        db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
        db.prepare("DELETE FROM embedding_models WHERE platform = 'custom'").run();
        db.prepare("DELETE FROM media_models WHERE platform = 'custom'").run();
      }
      if (defaultEmbedding) {
        const stillExists = db.prepare('SELECT 1 FROM embedding_models WHERE family = ? LIMIT 1').get(defaultEmbedding.value);
        if (!stillExists) {
          const replacement = db.prepare('SELECT family FROM embedding_models ORDER BY family, priority LIMIT 1').get() as { family: string } | undefined;
          if (replacement) {
            db.prepare("UPDATE settings SET value = ? WHERE key = 'embeddings_default_family'").run(replacement.family);
          }
        }
      }
    }
  });
  remove();

  res.json({ success: true });
});

// Toggle all keys for a platform
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);

  res.json({ success: true, enabled, updatedKeys: result.changes });
});

// Update key (toggle enable/disable or edit label)
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label } = parsed.data;
  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }

  values.push(id);

  const db = getDb();
  const result = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const response: Record<string, unknown> = { success: true };
  if (enabled !== undefined) response.enabled = enabled;
  if (label !== undefined) response.label = label;
  res.json(response);
});

// ── Model catalog sync (Status page "供应商模型更新") ─────────────────────
// These four endpoints power the StatusPage provider-model-update UI, which
// diffs each provider's remote /v1/models list against the local catalog so
// the operator can pull in new models or drop stale local ones without touching
// the upstream key. All four are read/_write on the SAME models + fallback_config
// + profile_models tables the rest of the app uses, so changes are immediately
// visible to Dashboard / Fallback / ModelDetail (which invalidate the shared
// ['fallback'] / ['models'] / ['health'] query keys).

interface CatalogPlatformOut {
  platform: string;
  keyCount: number;
  modelCount: number;
  canDiscover: boolean;
  baseUrl: string | null;
  listUrl: string | null;
  kind: 'channel' | 'builtin';
}

// Resolve the URL we should hit for GET /models on a given platform.
// - builtin catalog providers: the registered provider's baseUrl (or validateUrl)
// - named user platforms + classic custom + aihub: the base_url stored on api_keys
function catalogListUrlFor(platform: string): { listUrl: string | null; canDiscover: boolean; baseUrl: string | null } {
  const db = getDb();
  // user/named/custom/aihub: base_url lives on api_keys
  const keyRow = db.prepare(
    `SELECT base_url FROM api_keys
      WHERE platform = ? AND base_url IS NOT NULL AND TRIM(base_url) != ''
      LIMIT 1`,
  ).get(platform) as { base_url: string } | undefined;
  if (keyRow?.base_url) {
    const base = keyRow.base_url.replace(/\/+$/, '');
    return { listUrl: `${base}/models`, canDiscover: true, baseUrl: base };
  }
  // builtin: use the in-memory provider registration ( baseUrl or validateUrl )
  const prov = resolveProvider(platform as any);
  if (prov) {
    // OpenAICompatProvider keeps baseUrl private; validateUrl (if set) is the
    // catalog list endpoint, otherwise <baseUrl>/models. We don't have a public
    // accessor, so read the same constant from the providers/index registrations
    // mirror below to avoid changing BaseProvider.
    const known: Record<string, string> = {
      google: 'https://generativelanguage.googleapis.com/v1beta',
      groq: 'https://api.groq.com/openai/v1',
      cerebras: 'https://api.cerebras.ai/v1',
      nvidia: 'https://integrate.api.nvidia.com/v1',
      mistral: 'https://api.mistral.ai/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      github: 'https://models.github.ai/catalog/models',
      zhipu: 'https://open.bigmodel.cn/api/paas/v4',
      huggingface: 'https://router.huggingface.co/v1',
      ollama: 'https://ollama.com/v1',
      kilo: 'https://api.kilo.ai/api/gateway/v1',
      pollinations: 'https://text.pollinations.ai/openai/v1',
    };
    const url = known[platform];
    if (url) {
      // github validateUrl is the catalog endpoint itself (no /models suffix)
      if (platform === 'github') return { listUrl: url, canDiscover: true, baseUrl: null };
      return { listUrl: `${url}/models`, canDiscover: true, baseUrl: null };
    }
  }
  return { listUrl: null, canDiscover: false, baseUrl: null };
}

// GET /api/keys/model-catalog/platforms
// Lists every platform that has at least one key, with local model count and
// whether remote discovery is possible. This is what populates the platform
// dropdown on the Status page.
keysRouter.get('/model-catalog/platforms', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT k.platform,
           COUNT(DISTINCT k.id) AS key_count,
           (SELECT COUNT(*) FROM models m WHERE m.platform = k.platform) AS model_count
      FROM api_keys k
     GROUP BY k.platform
     ORDER BY k.platform
  `).all() as { platform: string; key_count: number; model_count: number }[];

  const platforms: CatalogPlatformOut[] = rows.map(r => {
    const { listUrl, canDiscover, baseUrl } = catalogListUrlFor(r.platform);
    const isChannel = !!(baseUrl || isUserPlatform(r.platform)) || r.platform === 'custom' || r.platform === 'aihub';
    return {
      platform: r.platform,
      keyCount: r.key_count,
      modelCount: r.model_count,
      canDiscover,
      baseUrl,
      listUrl,
      kind: isChannel ? 'channel' : 'builtin',
    };
  });

  res.json({ platforms });
});

// POST /api/keys/model-catalog/discover  { platform }
// Fetches the remote /v1/models for the chosen platform and diffs it against
// the local catalog. Returns the full remote list annotated with
// alreadyRegistered / localOnly / existsOtherPlatform so the UI can show
// "可更新" vs "已有" vs "远端已下架".
keysRouter.post('/model-catalog/discover', async (req: Request, res: Response) => {
  const parsed = z.object({ platform: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'platform is required' } });
    return;
  }
  const platform = parsed.data.platform.trim().toLowerCase();

  // Resolve list URL + an API key to authorize the request (first enabled key
  // for this platform). For builtin providers the key is still stored in
  // api_keys; for named/custom/aihub the base_url + key both live there.
  const { listUrl, canDiscover, baseUrl } = catalogListUrlFor(platform);
  if (!canDiscover || !listUrl) {
    res.status(400).json({ error: { message: `Platform "${platform}" does not support model discovery` } });
    return;
  }

  const db = getDb();
  const keyRow = db.prepare(
    `SELECT encrypted_key, iv, auth_tag FROM api_keys
      WHERE platform = ? AND enabled = 1
      ORDER BY CASE WHEN status = 'healthy' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1`,
  ).get(platform) as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  let apiKey = '';
  if (keyRow) {
    try { apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag); } catch { /* keyless */ }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'FreeLLMAPI-catalog-discover/1.0',
  };
  if (apiKey && apiKey !== 'no-key') headers.Authorization = `Bearer ${apiKey}`;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(listUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: { message: `Failed to reach ${listUrl}: ${msg}` } });
    return;
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    res.status(400).json({ error: { message: 'Redirects are not followed; point baseUrl directly at the API root (…/v1)' } });
    return;
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    res.status(502).json({ error: { message: `Upstream /models returned ${upstream.status}: ${text.slice(0, 300)}` } });
    return;
  }

  let body: unknown;
  try { body = JSON.parse(text); } catch {
    res.status(502).json({ error: { message: 'Upstream /models did not return JSON' } });
    return;
  }

  const rawList: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : Array.isArray((body as { models?: unknown }).models)
        ? ((body as { models: unknown[] }).models)
        : [];

  // Local model ids for THIS platform, and a global set for existsOtherPlatform
  const localIds = new Set(
    (db.prepare('SELECT model_id FROM models WHERE platform = ?').all(platform) as { model_id: string }[])
      .map(r => r.model_id),
  );
  const allLocalIds = new Set(
    (db.prepare('SELECT model_id FROM models').all() as { model_id: string }[]).map(r => r.model_id),
  );

  const models: Array<{
    id: string; name: string; ownedBy?: string;
    alreadyRegistered: boolean; modelDbId?: number | null;
    localEnabled?: boolean | null; localOnly?: boolean; existsOtherPlatform?: boolean;
  }> = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as any).id ?? (item as any).model ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = (item as any).owned_by;
    const localRow = db.prepare(
      'SELECT id, enabled FROM models WHERE platform = ? AND model_id = ? LIMIT 1',
    ).get(platform, id) as { id: number; enabled: number } | undefined;
    const alreadyOnThis = !!localRow;
    const onOther = allLocalIds.has(id) && !alreadyOnThis;
    models.push({
      id,
      name: String((item as any).name ?? id),
      ownedBy: typeof ownedBy === 'string' ? ownedBy : undefined,
      alreadyRegistered: alreadyOnThis,
      modelDbId: localRow?.id ?? null,
      localEnabled: localRow ? localRow.enabled === 1 : null,
      localOnly: false,
      existsOtherPlatform: onOther,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));

  // localOnly: local models this platform has but the remote list no longer lists.
  const remoteIds = new Set(models.map(m => m.id));
  const localOnlyRows = db.prepare(
    'SELECT id, model_id, display_name, enabled FROM models WHERE platform = ?',
  ).all(platform) as { id: number; model_id: string; display_name: string; enabled: number }[];
  const localOnly = localOnlyRows
    .filter(r => !remoteIds.has(r.model_id))
    .map(r => ({
      id: r.model_id,
      name: r.display_name,
      alreadyRegistered: true,
      modelDbId: r.id,
      localEnabled: r.enabled === 1,
      localOnly: true,
      existsOtherPlatform: false,
    }));

  const all = [...models, ...localOnly];
  res.json({
    platform,
    listUrl,
    total: models.length,
    registered: localIds.size,
    newCount: models.filter(m => !m.alreadyRegistered).length,
    localOnly: localOnly.length,
    models: all,
  });
});

// POST /api/keys/model-catalog/import  { platform, modelIds, enable }
// Adds selected remote model ids to the local catalog for `platform`. Models
// are inserted disabled by default (enable:false) so the Dashboard probe can
// verify them before they enter the routing chain. Re-uses the same
// ensureModelInProfile + fallback_config invariant as POST /custom and
// catalog-sync, so the new rows show up on every page immediately.
keysRouter.post('/model-catalog/import', (req: Request, res: Response) => {
  const parsed = z.object({
    platform: z.string().min(1),
    modelIds: z.array(z.string().min(1)).max(500),
    enable: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const platform = parsed.data.platform.trim().toLowerCase();
  const enable = parsed.data.enable === true;
  const db = getDb();

  // The platform must already have a key (we discover via its credentials).
  const hasKey = db.prepare(
    'SELECT 1 FROM api_keys WHERE platform = ? LIMIT 1',
  ).get(platform);
  if (!hasKey) {
    res.status(400).json({ error: { message: `No key for platform "${platform}"` } });
    return;
  }

  // key_id binding: classic custom binds to its endpoint key; named/aihub keep NULL.
  const bindKeyId = platform === 'custom'
    ? (db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' ORDER BY created_at DESC LIMIT 1").get() as { id: number } | undefined)?.id ?? null
    : null;

  const defaultProfile = db.prepare(
    "SELECT id FROM profiles WHERE type = 'default' OR LOWER(name) = 'default' ORDER BY CASE WHEN type = 'default' THEN 0 ELSE 1 END LIMIT 1",
  ).get() as { id: number } | undefined;

  let added = 0;
  let skipped = 0;
  const inserted: { modelId: string; modelDbId: number }[] = [];

  const tx = db.transaction(() => {
    for (const rawId of parsed.data.modelIds) {
      const modelId = rawId.trim();
      if (!modelId) continue;
      const existing = db.prepare(
        'SELECT id FROM models WHERE platform = ? AND model_id = ?',
      ).get(platform, modelId) as { id: number } | undefined;
      if (existing) { skipped++; continue; }

      const meta = calibrateModelMeta(modelId);
      const displayName = niceDisplayName(modelId);
      const info = db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           enabled, key_id, supports_tools, supports_vision)
        VALUES (@platform, @modelId, @displayName, @intelRank, @speedRank, @sizeLabel,
           @enabled, @keyId, 1, 0)
      `).run({
        platform,
        modelId,
        displayName,
        intelRank: meta.intelligenceRank,
        speedRank: 35,
        sizeLabel: meta.sizeLabel,
        enabled: enable ? 1 : 0,
        keyId: bindKeyId,
      });
      const modelDbId = Number(info.lastInsertRowid);

      // fallback_config row — same invariant catalog-sync keeps (enabled=0 until probe).
      const maxPri = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)').run(modelDbId, maxPri + 1, enable ? 1 : 0);

      // profile membership: Default always; keeps it visible on Fallback page.
      if (defaultProfile) ensureModelInProfile(db, modelDbId, defaultProfile.id);

      added++;
      inserted.push({ modelId, modelDbId });
    }
  });
  tx();

  res.json({ added, skipped, platform, models: inserted });
});

// POST /api/keys/model-catalog/remove  { platform, modelIds }
// Deletes selected local model rows for `platform` (cascades fallback_config +
// profile_models). Mirrors DELETE /api/models/:id so the Fallback / Detail
// pages stay consistent after a Status-page cleanup.
keysRouter.post('/model-catalog/remove', (req: Request, res: Response) => {
  const parsed = z.object({
    platform: z.string().min(1),
    modelIds: z.array(z.string().min(1)).max(500),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const platform = parsed.data.platform.trim().toLowerCase();
  const db = getDb();

  const removed: { modelId: string }[] = [];
  let removedCount = 0;
  const tx = db.transaction(() => {
    for (const rawId of parsed.data.modelIds) {
      const modelId = rawId.trim();
      if (!modelId) continue;
      const row = db.prepare(
        'SELECT id FROM models WHERE platform = ? AND model_id = ? LIMIT 1',
      ).get(platform, modelId) as { id: number } | undefined;
      if (!row) continue;
      db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(row.id);
      db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(row.id);
      db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
      removedCount++;
      removed.push({ modelId });
    }
  });
  tx();

  res.json({ removed: removedCount, platform, models: removed });
});
