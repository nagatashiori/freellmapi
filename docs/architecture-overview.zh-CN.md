# FreeLLMAPI 中文架构总览

这份文档面向第一次接手项目的人。目标不是罗列所有文件，而是解释：一条请求从哪里进入、依据什么选模型、如何调用供应商、数据写到哪里，以及修改某个功能应该从哪个入口开始。

> 先记住一条原则：**HTTP 路由只接参数，Service 决定业务，Provider 只处理供应商差异，数据库保存唯一状态，React Page 只组合功能组件。**

## 一张总图

```text
管理后台（React）
  ├─ 密钥、模型、路由组、健康、统计页面
  └─ /api/* 管理接口（需要后台登录）
          │
          ▼
Express app
  ├─ routes/*                 参数校验、鉴权、HTTP 返回
  ├─ services/*               业务规则和数据库事务
  ├─ providers/*              每家供应商的请求/响应差异
  └─ SQLite                   密钥、模型、路由、请求记录、设置

OpenAI / Anthropic / Codex 客户端
  └─ /v1/* 或 /mcp
          │
          ▼
proxy / responses / anthropic route
          │
          ▼
services/router.ts
  ├─ 读取 active profile 的 profile_models
  ├─ 过滤禁用模型、能力不符、无可用密钥、限流和冷却项
  ├─ 按人工优先级和运行时健康信号生成候选链
  └─ 失败时继续下一候选
          │
          ▼
providers/* adapter
  ├─ 转换为上游格式
  ├─ 发起供应商请求
  └─ 归一化成 OpenAI/Anthropic 兼容响应
```

## 1. 程序入口

### 服务端

- `server/src/index.ts`：初始化数据库、后台任务并启动 HTTP 服务。
- `server/src/app.ts`：挂载中间件和所有路由。
- `server/src/routes/*`：管理 API 与代理 API 的 HTTP 入口。

管理接口位于 `/api/*`；给外部 AI 客户端使用的兼容接口位于 `/v1/*` 和 `/mcp`。

### 前端

- `client/src/pages/*`：页面级组合，不应保存复杂业务规则。
- `client/src/features/*`：一项完整功能的状态、请求和界面。
- `client/src/components/*`：可复用的小组件。
- `shared/types.ts`：前后端共同使用的接口类型；不要在两端复制同名 interface。

## 2. 数据库里每张核心表负责什么

| 表 | 作用 | 是否为运行时真相 |
|---|---|---|
| `api_keys` | 加密保存供应商密钥、endpoint、健康状态 | 是 |
| `models` | 模型身份、能力、全局启用位和元数据 | 是 |
| `profiles` | 路由组，例如 Default | 是 |
| `profile_models` | 每个路由组的模型顺序和启用位 | **AUTO 路由的主要真相** |
| `fallback_config` | 旧界面/兼容链数据 | 兼容层，不应再形成第二套路由真相 |
| `requests` | 真实请求和探测结果，用于统计、健康与诊断 | 是 |
| `settings` | 当前 profile、路由策略及其他运行设置 | 是 |
| `catalog_model_tombstones` | 记住用户明确删除的目录模型，防止后台重新加入 | 是 |

修改路由行为时，先确认写的是 `profile_models`，不要只改 `fallback_config`。

## 3. 模型是怎样进入系统的

系统有三种模型来源，它们不能混成一个“全量同步”：

1. **随版本迁移附带的基础模型**
   - 位于 `server/src/db/migrations/*`。
   - 用于新安装和版本升级的稳定基线。

2. **后台签名目录**
   - 入口：`server/src/services/catalog-sync.ts`。
   - 更新目录元数据并补充新模型。
   - 当前规则为 additive/update-only：远端快照缺少某模型时，不自动删除本地模型。

3. **用户主动从供应商 `/models` 发现并导入**
   - 唯一业务入口：`server/src/services/provider-model-catalog.ts`。
   - 远端发现只读；导入只新增；本地删除必须显式确认。
   - 详细结构见 `docs/provider-model-catalog.md`。

新导入模型会在以下三处保持关闭：

```text
models.enabled = 0
fallback_config.enabled = 0
Default profile_models.enabled = 0
```

之后健康探测成功时，`model-probe.ts` 会开启模型和当前 active profile 中的成员资格。它不会自动重排人工优先级。

## 4. 一次普通聊天请求怎么走

以 `POST /v1/chat/completions` 为例：

1. 路由层解析请求、鉴权和客户端上下文。
2. `services/router.ts` 根据 `model` 参数解析目标：
   - `auto`：读取当前 active profile；
   - 明确模型：走固定模型或同核心模型组；
   - `fusion`：进入多模型并行与汇总流程。
3. 候选链过滤：
   - 模型及 profile 成员是否启用；
   - 是否支持 vision、tools、structured output；
   - 是否存在可用密钥；
   - 免费额度、速率限制、冷却和近期失败状态。
4. Provider adapter 把统一请求转换为上游供应商格式。
5. 上游成功后归一化响应并记录统计；失败、超时或限流时继续下一候选。
6. 所有候选耗尽后，返回聚合后的可诊断错误。

人工顺序来自 `profile_models.priority`。运行时健康信号可以暂时把故障路线后移或排除，但不应写回并打乱人工顺序。

## 5. Provider adapter 的职责

目录：`server/src/providers/*`

每个 adapter 只处理供应商差异，例如：

- API base URL 和认证 header；
- 聊天、流式、工具调用等请求格式；
- 上游错误和响应归一化；
- 模型列表请求地址 `getModelCatalogRequest()`。

不要在 React 页面或 HTTP route 中判断 “Google 用什么 URL、Cohere 用什么字段”。这类差异必须留在 provider/service 层。

## 6. 健康检测如何影响路由

入口：`server/src/services/model-probe.ts`

- 手动和定时探测最终都写入统一的 probe 结果。
- 成功：开启 `models.enabled`，并开启当前 active profile 的该模型成员；缺少成员时只追加，不改已有优先级。
- 连续失败达到阈值：关闭模型和 active profile 成员。
- 限流：保留启用状态，用冷却机制临时排除。
- Probe 记录写入 `requests`，但分析真实业务成功率时应排除 `request_type='probe'`。

## 7. 供应商模型管理现在的维护入口

```text
shared/types.ts
  ↓ 共享契约
server/src/providers/*
  ↓ 供应商模型列表请求
server/src/services/provider-model-catalog.ts
  ↓ 唯一业务规则和事务
server/src/routes/provider-model-catalog.ts
  ↓ 参数校验和 HTTP 转换
client/src/features/provider-model-catalog/ProviderModelCatalogPanel.tsx
  ↓ 完整前端功能
client/src/pages/StatusPage.tsx
  ↓ 只负责挂载
```

以后修改该功能，禁止把业务逻辑重新塞回 `keys.ts` 或 `StatusPage.tsx`。

## 8. 修改需求时先找哪个文件

| 需求 | 首选入口 |
|---|---|
| 新增供应商或修改供应商协议 | `server/src/providers/*` |
| 修改模型选择、fallback、能力过滤 | `server/src/services/router.ts` |
| 修改路由组顺序/启停 | `server/src/services/routing-groups.ts` 和相关 route |
| 修改健康探测状态机 | `server/src/services/model-probe.ts` |
| 修改供应商模型发现/导入/删除 | `server/src/services/provider-model-catalog.ts` |
| 修改管理接口参数 | `server/src/routes/*`，并同步 `shared/types.ts` |
| 修改某项完整前端功能 | `client/src/features/*` |
| 只改页面排版 | `client/src/pages/*` |
| 修改表结构 | 新增 migration，不直接改生产数据库 |

## 9. 代码注释标准

后续修改至少遵守以下规则：

- 每个业务模块顶部说明职责、边界和禁止事项。
- 每个公开函数说明输入、状态变化和副作用。
- 数据库事务前说明会写哪些表以及写入顺序。
- 任何“不自动删除、不自动启用、不自动排序”的保护逻辑必须写原因。
- Provider 特例说明上游差异，不能只写“特殊处理”。
- 不给显而易见的赋值逐行写废话注释；注释应解释**为什么**，而不只是复述代码。

## 10. 修改后的最低验证

```bash
npm ci
npm test
npm run build
```

涉及数据库时还要运行对应 migration 测试；涉及路由时至少覆盖成功、限流、超时、fallback 和禁用模型。部署前先备份数据库，禁止运行会批量重排优先级或启用模型的脚本。
