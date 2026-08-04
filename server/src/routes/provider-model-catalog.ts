import { Router } from 'express';
import type { Request, Response } from 'express';
import { z, type ZodError } from 'zod';
import { getDb } from '../db/index.js';
import {
  ProviderModelCatalogError,
  providerModelCatalog,
} from '../services/provider-model-catalog.js';

/**
 * 供应商模型目录 HTTP 层。
 *
 * 这里刻意只做三件事：
 * 1. 校验请求参数；
 * 2. 调用 providerModelCatalog 服务；
 * 3. 把服务错误转换成统一 JSON。
 *
 * 供应商 URL、密钥选择、数据库写入和 tombstone 规则全部在 service 中，
 * 禁止在路由里复制业务判断。这样维护者只需要先看本文件和对应 service。
 */
export const providerModelCatalogRouter = Router();

// 兼容旧客户端传 platform；新客户端统一传 sourceId，因为同一 platform
// 可以配置多个自定义 endpoint，只有 sourceId 能准确定位来源。
type SourceInput = { sourceId?: string; platform?: string };

/** 新旧来源参数统一判定。 */
function hasSource(value: SourceInput): boolean {
  return Boolean(value.sourceId || value.platform);
}

const sourceFields = {
  sourceId: z.string().trim().min(1).optional(),
  platform: z.string().trim().min(1).optional(),
};

const sourceSchema = z.object(sourceFields).refine(
  hasSource,
  { message: 'sourceId or platform is required' },
);

const modelIdsSchema = z.object({
  ...sourceFields,
  modelIds: z.array(z.string().trim().min(1)).min(1).max(500),
}).refine(
  hasSource,
  { message: 'sourceId or platform is required' },
);

const removeSchema = z.object({
  ...sourceFields,
  modelIds: z.array(z.string().trim().min(1)).min(1).max(500),
  confirm: z.literal(true),
}).refine(
  hasSource,
  { message: 'sourceId or platform is required' },
);

/** 从新旧请求格式中取出统一来源标识。 */
function sourceRef(value: { sourceId?: string; platform?: string }): string {
  return value.sourceId ?? value.platform ?? '';
}


/** 将 Zod 的多条错误压成 API 使用的一条消息。 */
function validationMessage(error: ZodError): string {
  return error.errors.map(issue => issue.message).join(', ');
}

/** 所有端点共用同一错误格式，前端无需猜测不同接口的响应结构。 */
function sendError(res: Response, error: unknown): void {
  if (error instanceof ProviderModelCatalogError) {
    res.status(error.status).json({ error: { message: error.message, type: error.code } });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({
    error: {
      message,
      type: 'provider_model_catalog_internal_error',
    },
  });
}

/** 返回已配置的供应商来源；该操作不会解密 API key。 */
providerModelCatalogRouter.get('/platforms', (_req: Request, res: Response) => {
  try {
    const sources = providerModelCatalog.listSources(getDb());
    res.json({ sources, platforms: sources });
  } catch (error) {
    sendError(res, error);
  }
});

/** 只读远端 /models，并标记哪些模型尚未存在于本地。 */
providerModelCatalogRouter.post('/discover', async (req: Request, res: Response) => {
  const parsed = sourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: validationMessage(parsed.error) } });
    return;
  }

  try {
    res.json(await providerModelCatalog.discoverRemote(getDb(), sourceRef(parsed.data)));
  } catch (error) {
    sendError(res, error);
  }
});

/** 只读本地数据库；远端故障时仍可正常查看和管理本地模型。 */
providerModelCatalogRouter.post('/local', (req: Request, res: Response) => {
  const parsed = sourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: validationMessage(parsed.error) } });
    return;
  }

  try {
    res.json(providerModelCatalog.listLocal(getDb(), sourceRef(parsed.data)));
  } catch (error) {
    sendError(res, error);
  }
});

/** 刷新统一清单；远端异常时仍返回本地记录，不自动增删任何模型。 */
providerModelCatalogRouter.post('/sync', async (req: Request, res: Response) => {
  const parsed = sourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: validationMessage(parsed.error) } });
    return;
  }

  try {
    res.json(await providerModelCatalog.sync(getDb(), sourceRef(parsed.data)));
  } catch (error) {
    sendError(res, error);
  }
});

/** 只新增不存在的模型；不覆盖、删除或重排任何现有模型。 */
providerModelCatalogRouter.post('/import', (req: Request, res: Response) => {
  const parsed = modelIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: validationMessage(parsed.error) } });
    return;
  }

  try {
    res.json(providerModelCatalog.importMissing(getDb(), sourceRef(parsed.data), parsed.data.modelIds));
  } catch (error) {
    sendError(res, error);
  }
});

/** 显式删除本地记录；confirm:true 防止误调用。 */
providerModelCatalogRouter.post('/remove', (req: Request, res: Response) => {
  const parsed = removeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: 'Explicit confirm:true and 1-500 modelIds are required',
        type: 'provider_model_delete_confirmation_required',
      },
    });
    return;
  }

  try {
    res.json(providerModelCatalog.removeLocal(getDb(), sourceRef(parsed.data), parsed.data.modelIds));
  } catch (error) {
    sendError(res, error);
  }
});
