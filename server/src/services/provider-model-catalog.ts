/**
 * 供应商模型目录核心服务。
 *
 * 维护规则：
 * - 本文件是供应商模型管理的唯一业务入口；路由和页面不得复制这里的规则。
 * - 远端发现只读，绝不根据远端缺失或空数组删除本地模型。
 * - 导入只新增，删除必须显式调用，二者不能合并成“同步”。
 * - 选中的新模型同时写入 models、fallback_config 和当前使用的 profile，
 *   并追加到各自链尾；原有顺序和状态不被触碰。
 *
 * 阅读顺序：先看文件底部 providerModelCatalog 的五个公开方法，再按需进入 helper。
 */
import type { Db } from '../db/types.js';
import { decrypt } from '../lib/crypto.js';
import { calibrateModelMeta, niceDisplayName, repairLegacyDisplayName } from '../lib/model-intel.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import { endpointScopeForBaseUrl } from '../lib/endpoint-scope.js';
import type {
  Platform,
  ProviderCatalogDiscoveryResult,
  ProviderCatalogImportResult,
  ProviderCatalogLocalResult,
  ProviderCatalogManagedModel,
  ProviderCatalogRemoveResult,
  ProviderCatalogRemoteModel,
  ProviderCatalogSource,
  ProviderCatalogSyncResult,
} from '@freellmapi/shared/types.js';
import { isUserPlatform, resolveProvider } from '../providers/index.js';
import {
  clearCatalogModelTombstone,
  isCatalogManagedModel,
  recordCatalogModelTombstone,
} from './model-state.js';
import {
  deleteRoutingModelMemberships,
  ensureModelInProfile,
  getActiveRoutingProfileId,
} from './routing-groups.js';

/** 可安全暴露给 HTTP 层的业务错误。 */
export class ProviderModelCatalogError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'provider_model_catalog_error',
  ) {
    super(message);
    this.name = 'ProviderModelCatalogError';
  }
}

/** 本功能从 api_keys 表读取的最小字段集合。 */
interface KeyRow {
  id: number;
  platform: string;
  label: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
  created_at: string;
}

/** 一个来源及其内部密钥集合；不会直接返回给前端。 */
interface SourceBundle {
  source: ProviderCatalogSource;
  keys: KeyRow[];
  requestBaseUrl: string | null;
}

/** 已解析的来源上下文，额外包含本次网络请求要使用的首选密钥。 */
interface ResolvedSource extends SourceBundle {
  selectedKey: KeyRow;
}

/** 去掉末尾斜杠，保证 endpoint 分组和 /models 拼接结果稳定。 */
function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '') ?? '';
  return trimmed || null;
}

/** 内置供应商按 platform 标识；自定义 endpoint 按具体 key 标识。 */
function sourceIdFor(platform: string, baseUrl: string | null, keyId: number): string {
  if (platform === 'custom' || baseUrl) return `key:${keyId}`;
  return `platform:${platform}`;
}

/** 优先使用“已启用且健康”的密钥，其次选择最近创建的密钥。 */
function preferredKey(rows: KeyRow[]): KeyRow {
  const sorted = [...rows].sort((a, b) => {
    const aScore = (a.enabled ? 0 : 10) + (a.status === 'healthy' ? 0 : 1);
    const bScore = (b.enabled ? 0 : 10) + (b.status === 'healthy' ? 0 : 1);
    if (aScore !== bScore) return aScore - bScore;
    return b.created_at.localeCompare(a.created_at);
  });
  const row = sorted[0];
  if (!row) throw new ProviderModelCatalogError('No credential is configured for this provider', 409, 'missing_provider_key');
  return row;
}

/**
 * 生成当前来源对应的本地模型过滤条件。
 * custom 来源可能有多把相同 endpoint 的密钥，因此使用整个 key 集合，而不是只看首选 key。
 */
function localModelWhere(platform: string, keyIds: number[], endpointScope?: string | null): {
  sql: string;
  values: Array<string | number>;
} {
  const scope = endpointScopeForBaseUrl(endpointScope);
  if (scope) {
    const placeholders = keyIds.map(() => '?').join(', ');
    const legacy = keyIds.length > 0
      ? ` OR (COALESCE(m.endpoint_scope, '') = '' AND m.key_id IN (${placeholders}))`
      : '';
    return {
      sql: `m.platform = ? AND (COALESCE(m.endpoint_scope, '') = ?${legacy})`,
      values: keyIds.length > 0
        ? [platform, scope, ...keyIds]
        : [platform, scope],
    };
  }
  if (platform === 'custom') {
    const placeholders = keyIds.map(() => '?').join(', ');
    return {
      sql: `m.platform = ? AND m.key_id IN (${placeholders})`,
      values: ['custom', ...keyIds],
    };
  }
  return { sql: 'm.platform = ?', values: [platform] };
}

/** 统计来源当前拥有的本地模型数量。 */
function countLocalModels(db: Db, platform: string, keyIds: number[], endpointScope?: string | null): number {
  const where = localModelWhere(platform, keyIds, endpointScope);
  const row = db.prepare(`SELECT COUNT(*) AS count FROM models m WHERE ${where.sql}`).get(...where.values) as { count: number };
  return row.count;
}

const SENSITIVE_QUERY_KEYS = new Set([
  'key',
  'api_key',
  'apikey',
  'token',
  'access_token',
  'auth',
  'authorization',
]);

/**
 * 生成可安全返回给浏览器的 URL。真实请求可能把密钥放在查询参数中，
 * 但展示地址、错误信息和日志都不得包含这些凭据。
 */
function publicCatalogUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    const sensitiveKeys: string[] = [];
    url.searchParams.forEach((_value, key) => {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) sensitiveKeys.push(key);
    });
    for (const key of sensitiveKeys) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch {
    return '[invalid provider model-list URL]';
  }
}

/**
 * 构造真实远端请求和脱敏展示地址。
 * 供应商特有认证由 provider adapter 声明，自定义 OpenAI endpoint 统一使用 /models。
 */
function sourceListUrl(source: Pick<ProviderCatalogSource, 'platform' | 'baseUrl'>, apiKey: string): {
  url: string | null;
  publicUrl: string | null;
  headers: Record<string, string>;
} {
  if (source.baseUrl) {
    const url = `${source.baseUrl}/models`;
    return {
      url,
      publicUrl: publicCatalogUrl(url),
      headers: apiKey && apiKey !== 'no-key' ? { Authorization: `Bearer ${apiKey}` } : {},
    };
  }

  const provider = resolveProvider(source.platform as Platform);
  const request = provider?.getModelCatalogRequest(apiKey) ?? null;
  return request
    ? { url: request.url, publicUrl: publicCatalogUrl(request.url), headers: request.headers ?? {} }
    : { url: null, publicUrl: null, headers: {} };
}

/**
 * 从 api_keys 构建来源列表。该步骤不解密密钥，因此可安全用于页面初始化。
 * 同一内置 platform 合并；自定义或带 base_url 的渠道按 endpoint 分组。
 */
function buildSources(db: Db): SourceBundle[] {
  const rows = db.prepare(`
    SELECT id, platform, label, encrypted_key, iv, auth_tag, status, enabled,
           base_url, created_at
      FROM api_keys
     ORDER BY platform ASC, created_at DESC, id DESC
  `).all() as KeyRow[];

  const groups = new Map<string, KeyRow[]>();
  for (const row of rows) {
    const baseUrl = normalizeBaseUrl(row.base_url);
    const groupingKey = row.platform === 'custom' || baseUrl
      ? `${row.platform}\u0000${baseUrl ?? ''}`
      : row.platform;
    const group = groups.get(groupingKey) ?? [];
    group.push({ ...row, base_url: baseUrl });
    groups.set(groupingKey, group);
  }

  const result: SourceBundle[] = [];
  for (const keys of groups.values()) {
    const selected = preferredKey(keys);
    const baseUrl = normalizeBaseUrl(selected.base_url);
    // Source discovery must not decrypt credentials. Adapters can expose the
    // endpoint shape with an empty placeholder; real credentials are resolved
    // only for an explicit discover request.
    const catalogRequest = sourceListUrl({ platform: selected.platform, baseUrl }, '');
    // sourceId 不跟随健康密钥切换；使用组内最小 key id 作为稳定代表。
    const sourceId = sourceIdFor(selected.platform, baseUrl, Math.min(...keys.map(key => key.id)));
    const source: ProviderCatalogSource = {
      sourceId,
      platform: selected.platform,
      label: selected.label || selected.platform,
      keyCount: keys.length,
      enabledKeyCount: keys.filter((key) => key.enabled === 1).length,
      healthyKeyCount: keys.filter((key) => key.status === 'healthy').length,
      modelCount: 0,
      canDiscover: Boolean(catalogRequest.url),
      baseUrl: baseUrl ? publicCatalogUrl(baseUrl) : null,
      listUrl: catalogRequest.publicUrl,
      kind: baseUrl || selected.platform === 'custom' || isUserPlatform(selected.platform) ? 'channel' : 'builtin',
    };
    source.modelCount = countLocalModels(db, source.platform, keys.map(key => key.id), baseUrl);
    result.push({ source, keys, requestBaseUrl: baseUrl });
  }

  return result.sort((a, b) => a.source.platform.localeCompare(b.source.platform) || a.source.label.localeCompare(b.source.label));
}

/** 列出来源，不发网络请求、不解密密钥。 */
function listSources(db: Db): ProviderCatalogSource[] {
  return buildSources(db).map((entry) => entry.source);
}

/** 把前端 sourceId（或旧 platform）解析为内部来源上下文。 */
function resolveSource(db: Db, sourceIdOrPlatform: string): ResolvedSource {
  const wanted = sourceIdOrPlatform.trim();
  const all = buildSources(db);
  const match = all.find(({ source }) => source.sourceId === wanted)
    ?? all.find(({ source }) => source.platform === wanted.toLowerCase());
  if (!match) {
    throw new ProviderModelCatalogError(`Provider source "${wanted}" was not found`, 404, 'provider_source_not_found');
  }
  return { ...match, selectedKey: preferredKey(match.keys) };
}

/** 兼容常见供应商返回结构，提取原始模型数组。 */
function extractRawModelList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of ['data', 'models', 'items', 'result']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  const nested = record.result;
  if (nested && typeof nested === 'object') {
    const nestedRecord = nested as Record<string, unknown>;
    for (const key of ['data', 'models', 'items']) {
      if (Array.isArray(nestedRecord[key])) return nestedRecord[key] as unknown[];
    }
  }
  return null;
}

/** 统一供应商模型 ID；Google 的 models/ 前缀不进入本地数据库。 */
function normalizedModelId(platform: string, item: Record<string, unknown>): string {
  const raw = item.id ?? item.model ?? item.model_id ?? item.name;
  let id = typeof raw === 'string' ? raw.trim() : '';
  if (platform === 'google' && id.startsWith('models/')) id = id.slice('models/'.length);
  return id;
}

/** 优先使用供应商展示名，否则由 modelId 生成可读名称。 */
function displayNameFor(item: Record<string, unknown>, id: string): string {
  const value = item.displayName ?? item.display_name ?? item.title ?? item.name;
  if (typeof value !== 'string' || !value.trim() || value === `models/${id}`) return niceDisplayName(id);
  return value.trim();
}

/** 最后一道错误文本脱敏，避免上游把 key 原样回显。 */
function redactCredential(value: string, credential: string): string {
  if (!credential || credential === 'no-key') return value;
  return value.split(credential).join('[redacted]');
}


/**
 * 统一清洗批量模型 ID。导入和删除共享同一边界，避免两个接口逐渐出现不同规则。
 */
function normalizeModelIds(rawModelIds: string[], action: 'imported' | 'removed'): string[] {
  const ids = [...new Set(rawModelIds.map(id => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new ProviderModelCatalogError('At least one model id is required', 400, 'model_ids_required');
  }
  if (ids.length > 500) {
    throw new ProviderModelCatalogError(
      `At most 500 model ids can be ${action} at once`,
      400,
      'too_many_model_ids',
    );
  }
  return ids;
}

/**
 * 只读发现远端模型。失败和空列表都不会修改任何本地数据。
 */
async function discoverRemote(
  db: Db,
  sourceIdOrPlatform: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderCatalogDiscoveryResult> {
  const { source, keys, selectedKey, requestBaseUrl } = resolveSource(db, sourceIdOrPlatform);
  let apiKey = '';
  try {
    apiKey = decrypt(selectedKey.encrypted_key, selectedKey.iv, selectedKey.auth_tag);
  } catch {
    throw new ProviderModelCatalogError(
      `The stored credential for ${source.label} could not be decrypted`,
      409,
      'provider_key_decrypt_failed',
    );
  }

  const request = sourceListUrl({ platform: source.platform, baseUrl: requestBaseUrl }, apiKey);
  if (!request.url) {
    throw new ProviderModelCatalogError(
      `Provider "${source.platform}" does not expose a model-list endpoint`,
      400,
      'provider_discovery_unsupported',
    );
  }

  if (source.baseUrl) {
    const verdict = await assessProviderUrl(request.url);
    if (!verdict.allowed) {
      throw new ProviderModelCatalogError(
        `Provider model-list URL blocked: ${verdict.reason}`,
        400,
        'provider_discovery_url_blocked',
      );
    }
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(request.url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'FreeLLMAPI-catalog-discover/2.0',
        ...request.headers,
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderModelCatalogError(
      `Failed to reach ${request.publicUrl ?? 'provider model-list endpoint'}: ${message}`,
      502,
      'provider_discovery_unreachable',
    );
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    throw new ProviderModelCatalogError(
      'Provider model-list redirects are not followed; configure the final API root directly',
      400,
      'provider_discovery_redirect',
    );
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    const authHint = upstream.status === 401 || upstream.status === 403
      ? ' Check the selected provider credential and its permissions.'
      : '';
    throw new ProviderModelCatalogError(
      `Upstream model list returned ${upstream.status}: ${redactCredential(text.slice(0, 300), apiKey)}${authHint}`,
      502,
      'provider_discovery_upstream_error',
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProviderModelCatalogError(
      'Upstream model list did not return JSON',
      502,
      'provider_discovery_invalid_json',
    );
  }

  const rawList = extractRawModelList(body);
  if (rawList == null) {
    throw new ProviderModelCatalogError(
      'Upstream JSON did not contain a supported model array (data/models/items/result)',
      502,
      'provider_discovery_unknown_shape',
    );
  }

  const where = localModelWhere(source.platform, keys.map(key => key.id), requestBaseUrl);
  const localRows = db.prepare(`
    SELECT m.id, m.model_id, m.enabled
      FROM models m
     WHERE ${where.sql}
  `).all(...where.values) as Array<{ id: number; model_id: string; enabled: number }>;
  const localIds = new Set(localRows.map((row) => row.model_id));
  // A model id can exist on another provider or endpoint and still be a valid
  // new candidate here. Only the current source controls the checkbox state;
  // the other-source flag is informational for the fusion view.
  const platformIds = new Set(
    (db.prepare('SELECT model_id FROM models WHERE platform = ?').all(source.platform) as Array<{ model_id: string }>)
      .map((row) => row.model_id),
  );

  const models: ProviderCatalogRemoteModel[] = [];
  const seen = new Set<string>();
  for (const value of rawList) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const id = normalizedModelId(source.platform, item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const registeredInThisSource = localIds.has(id);
    const existsOtherSource = platformIds.has(id) && !registeredInThisSource;
    const ownedByRaw = item.owned_by ?? item.ownedBy ?? item.publisher ?? item.organization;
    models.push({
      id,
      name: displayNameFor(item, id),
      ownedBy: typeof ownedByRaw === 'string' ? ownedByRaw : undefined,
      alreadyRegistered: registeredInThisSource,
      existsOtherSource,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));

  const empty = models.length === 0;
  return {
    sourceId: source.sourceId,
    platform: source.platform,
    listUrl: request.publicUrl ?? 'provider model-list endpoint',
    total: models.length,
    registered: localIds.size,
    newCount: models.filter((model) => !model.alreadyRegistered).length,
    remoteState: empty ? 'empty' : 'ok',
    warning: empty
      ? '供应商返回了空模型列表；本地模型没有被标记、禁用或删除。'
      : undefined,
    models,
  };
}

/** 只读列出本地模型；不会访问供应商网络。 */
function listLocal(db: Db, sourceIdOrPlatform: string): ProviderCatalogLocalResult {
  const { source, keys, requestBaseUrl } = resolveSource(db, sourceIdOrPlatform);
  const where = localModelWhere(source.platform, keys.map(key => key.id), requestBaseUrl);
  const activeProfileId = getActiveRoutingProfileId(db);
  const rows = db.prepare(`
    SELECT m.id, m.model_id, m.display_name, m.enabled, m.key_id,
           COALESCE(pm.enabled, 0) AS routing_enabled
      FROM models m
      LEFT JOIN profile_models pm
        ON pm.model_db_id = m.id AND pm.profile_id = ?
     WHERE ${where.sql}
     ORDER BY m.display_name COLLATE NOCASE, m.model_id COLLATE NOCASE
  `).all(activeProfileId, ...where.values) as Array<{
    id: number;
    model_id: string;
    display_name: string;
    enabled: number;
    key_id: number | null;
    routing_enabled: number;
  }>;

  return {
    sourceId: source.sourceId,
    platform: source.platform,
    total: rows.length,
    models: rows.map((row) => ({
      id: row.model_id,
      name: repairLegacyDisplayName(row.model_id, row.display_name),
      modelDbId: row.id,
      localEnabled: row.enabled === 1,
      routingEnabled: row.routing_enabled === 1,
      catalogManaged: isCatalogManagedModel({ platform: source.platform, key_id: row.key_id }),
    })),
  };
}

/**
 * 返回一个供前端勾选的统一模型清单。
 *
 * 刷新只读取远端和本地状态；远端缺失、空列表或异常都不会触碰数据库。
 * 本地已有但远端这次没有返回的模型仍保留在清单中，用户可以明确取消勾选后删除。
 */
async function sync(
  db: Db,
  sourceIdOrPlatform: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderCatalogSyncResult> {
  const local = listLocal(db, sourceIdOrPlatform);

  let discovery: ProviderCatalogDiscoveryResult;
  try {
    discovery = await discoverRemote(db, sourceIdOrPlatform, fetchImpl);
  } catch (error) {
    if (!(error instanceof ProviderModelCatalogError)) throw error;

    const localModels: ProviderCatalogManagedModel[] = local.models.map(model => ({
      id: model.id,
      name: model.name,
      alreadyRegistered: true,
      existsOtherSource: false,
      remotePresent: false,
      localEnabled: model.localEnabled,
      routingEnabled: model.routingEnabled,
      catalogManaged: model.catalogManaged,
    }));
    return {
      sourceId: local.sourceId,
      platform: local.platform,
      listUrl: null,
      remoteTotal: 0,
      localTotal: local.total,
      remoteState: 'error',
      warning: `远端模型拉取失败：${error.message}；本地记录已保留。`,
      models: localModels,
    };
  }

  const localById = new Map(local.models.map(model => [model.id, model]));
  const remoteIds = new Set(discovery.models.map(model => model.id));
  const models: ProviderCatalogManagedModel[] = discovery.models.map(model => {
    const localModel = localById.get(model.id);
    return {
      ...model,
      remotePresent: true,
      ...(localModel
        ? {
            localEnabled: localModel.localEnabled,
            routingEnabled: localModel.routingEnabled,
            catalogManaged: localModel.catalogManaged,
          }
        : {}),
    };
  });

  for (const localModel of local.models) {
    if (remoteIds.has(localModel.id)) continue;
    models.push({
      id: localModel.id,
      name: localModel.name,
      alreadyRegistered: true,
      existsOtherSource: false,
      remotePresent: false,
      localEnabled: localModel.localEnabled,
      routingEnabled: localModel.routingEnabled,
      catalogManaged: localModel.catalogManaged,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));

  return {
    sourceId: discovery.sourceId,
    platform: discovery.platform,
    listUrl: discovery.listUrl,
    remoteTotal: discovery.models.length,
    localTotal: local.total,
    remoteState: discovery.remoteState,
    warning: discovery.warning,
    models,
  };
}

/**
 * 只新增不存在的模型。现有记录、元数据和优先级全部保持不变。
 */
function importMissing(
  db: Db,
  sourceIdOrPlatform: string,
  rawModelIds: string[],
): ProviderCatalogImportResult {
  const { source, keys, selectedKey, requestBaseUrl } = resolveSource(db, sourceIdOrPlatform);
  const ids = normalizeModelIds(rawModelIds, 'imported');

  const activeProfileId = getActiveRoutingProfileId(db);
  const endpointScope = endpointScopeForBaseUrl(requestBaseUrl);
  const bindKeyId = source.platform === 'custom' ? selectedKey.id : null;
  let added = 0;
  let skipped = 0;
  const inserted: Array<{ modelId: string; modelDbId: number }> = [];

  const apply = db.transaction(() => {
    const maxFallback = db.prepare('SELECT COALESCE(MAX(priority), 0) AS priority FROM fallback_config').get() as { priority: number };
    let fallbackPriority = maxFallback.priority;

    for (const modelId of ids) {
      // Built-in rows are matched by platform/model. Custom rows additionally
      // belong to their endpoint, so the same model id at two user endpoints
      // remains two independent candidates.
      const sourceKeyIds = keys.map(key => key.id);
      const legacyEndpointClause = endpointScope && sourceKeyIds.length > 0
        ? ` OR (endpoint_scope = '' AND key_id IN (${sourceKeyIds.map(() => '?').join(', ')}))`
        : '';
      const existingArgs: Array<string | number> = sourceKeyIds.length > 0 && legacyEndpointClause
        ? [source.platform, modelId, endpointScope, ...sourceKeyIds]
        : [source.platform, modelId, endpointScope];
      const existing = db.prepare(`
        SELECT id FROM models
         WHERE platform = ? AND model_id = ?
           AND (endpoint_scope = ?${legacyEndpointClause})
      `).get(...existingArgs);
      if (existing) {
        skipped++;
        continue;
      }

      // A deliberate re-import reverses an earlier local deletion.
      clearCatalogModelTombstone(db, 'chat', source.platform, modelId);

      const meta = calibrateModelMeta(modelId);
      const info = db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           enabled, key_id, supports_tools, supports_vision, endpoint_scope)
        VALUES (?, ?, ?, ?, 35, ?, 1, ?, 1, 0, ?)
      `).run(
        source.platform,
        modelId,
        niceDisplayName(modelId),
        meta.intelligenceRank,
        meta.sizeLabel,
        bindKeyId,
        endpointScope,
      );
      const modelDbId = Number(info.lastInsertRowid);
      fallbackPriority++;
      db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)')
        .run(modelDbId, fallbackPriority);
      ensureModelInProfile(db, activeProfileId, modelDbId, 1);
      inserted.push({ modelId, modelDbId });
      added++;
    }
  });
  apply();

  return { sourceId: source.sourceId, platform: source.platform, added, skipped, models: inserted };
}

/**
 * 显式删除本地模型。目录管理模型先写 tombstone，再按外键顺序删除。
 */
function removeLocal(
  db: Db,
  sourceIdOrPlatform: string,
  rawModelIds: string[],
): ProviderCatalogRemoveResult {
  const { source, keys, requestBaseUrl } = resolveSource(db, sourceIdOrPlatform);
  const ids = normalizeModelIds(rawModelIds, 'removed');

  const removed: Array<{ modelId: string; tombstoned: boolean }> = [];
  const where = localModelWhere(source.platform, keys.map(key => key.id), requestBaseUrl);
  const apply = db.transaction(() => {
    for (const modelId of ids) {
      const row = db.prepare(`
        SELECT m.id, m.platform, m.model_id, m.key_id
          FROM models m
         WHERE ${where.sql} AND m.model_id = ?
         LIMIT 1
      `).get(...where.values, modelId) as {
        id: number;
        platform: string;
        model_id: string;
        key_id: number | null;
      } | undefined;
      if (!row) continue;

      const tombstoned = isCatalogManagedModel(row);
      if (tombstoned) recordCatalogModelTombstone(db, 'chat', row.platform, row.model_id);
      deleteRoutingModelMemberships(db, row.id);
      db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(row.id);
      db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
      removed.push({ modelId: row.model_id, tombstoned });
    }
  });
  apply();

  return { sourceId: source.sourceId, platform: source.platform, removed: removed.length, models: removed };
}

/**
 * 供应商模型目录唯一公共入口。
 *
 * 路由、测试和未来调用者统一通过这个对象访问功能，避免从一个大文件中
 * 任意引用内部 helper。需要修改行为时，先从下面五个方法进入：
 *
 * - listSources: 列出来源，不解密密钥；
 * - discoverRemote: 只读远端；
 * - listLocal: 只读本地；
 * - sync: 合并远端和本地清单，仍然只读；
 * - importMissing: 只新增；
 * - removeLocal: 显式删除本地。
 */
export const providerModelCatalog = {
  listSources,
  discoverRemote,
  listLocal,
  sync,
  importMissing,
  removeLocal,
} as const;
