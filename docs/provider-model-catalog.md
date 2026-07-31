# 供应商模型管理：结构与修改指南

这套功能已经按“一个功能、一个入口”重新收口。它不是全项目重构，而是专门整理以下链路：

- 列出已配置的供应商来源；
- 从远端发现模型；
- 只新增本地缺少的模型；
- 查看和显式删除本地模型。

## 先看这张结构图

```text
shared/types.ts
  └─ 前后端共用接口类型（唯一类型定义）

server/src/providers/*
  └─ 供应商只声明“如何请求模型列表”

server/src/services/provider-model-catalog.ts
  └─ 唯一业务入口：来源、发现、只增、本地列表、删除

server/src/routes/provider-model-catalog.ts
  └─ 只做参数校验和 HTTP 错误转换

client/src/features/provider-model-catalog/ProviderModelCatalogPanel.tsx
  └─ 该功能全部前端状态和界面

client/src/pages/StatusPage.tsx
  └─ 只挂载健康检查和模型管理面板，不放业务逻辑
```

维护者不需要在 `keys.ts` 或 `StatusPage.tsx` 中寻找模型同步规则。

## 唯一公共入口

后端统一通过以下对象调用：

```ts
providerModelCatalog.listSources(db)
providerModelCatalog.discoverRemote(db, sourceId)
providerModelCatalog.listLocal(db, sourceId)
providerModelCatalog.importMissing(db, sourceId, modelIds)
providerModelCatalog.removeLocal(db, sourceId, modelIds)
```

内部 helper 不导出。这样未来修改不会出现“路由调用一套、测试调用另一套”的情况。

## 五个操作的边界

### 1. `listSources`

- 只读取 `api_keys`；
- 不解密密钥；
- 不访问网络；
- 自定义 endpoint 分开显示。

### 2. `discoverRemote`

- 解密选中的密钥；
- 只读供应商模型列表；
- 解析常见的 `data/models/items/result`；
- 远端失败或返回空数组都不写数据库；
- 返回浏览器的 URL 已脱敏。

### 3. `listLocal`

- 完全读取本地数据库；
- 不访问远端；
- 即使供应商停机、401 或返回空列表，仍然可以管理本地模型。

### 4. `importMissing`

- 只插入 `(platform, model_id)` 不存在的模型；
- 不覆盖已有记录；
- 不调整现有优先级；
- 新模型的三个启用位全部为关闭：
  - `models.enabled = 0`
  - `fallback_config.enabled = 0`
  - Default `profile_models.enabled = 0`
- 明确重新导入时清除该模型旧 tombstone。

### 5. `removeLocal`

- 只删除本机数据库记录；
- 不调用供应商接口；
- 目录管理模型先写 tombstone，避免后台重新加入；
- 删除顺序固定：路由成员 → fallback → model。

## 后台签名目录的边界

`server/src/services/catalog-sync.ts` 是另一套后台目录机制。它可以更新目录元数据，但当前为 additive/update-only：远端快照缺少模型时不会自动删除本地记录。

供应商 `/models` 的结果不能驱动 `catalog-sync` 删除，也不能把本地模型标成“已下架”。

## 常见修改应该改哪里

### 新增一个 OpenAI 兼容供应商

通常只需要在供应商注册处配置 `baseUrl`。`OpenAICompatProvider` 会自动使用：

```text
<baseUrl>/models
```

如果模型列表不是这个地址，使用供应商现有的 `validateUrl` 或在 adapter 中覆写 `getModelCatalogRequest`。

### 供应商返回了新的 JSON 结构

只修改：

```text
server/src/services/provider-model-catalog.ts
  extractRawModelList()
  normalizedModelId()
  displayNameFor()
```

同时在 `provider-model-catalog.test.ts` 添加一个解析用例。

### 修改前端文案或布局

只修改：

```text
client/src/features/provider-model-catalog/ProviderModelCatalogPanel.tsx
```

不要把状态和 mutation 放回 `StatusPage.tsx`。

### 修改接口字段

先修改：

```text
shared/types.ts
```

然后修改 service 返回值、route 校验和面板调用。不要在前后端各复制一套 interface。

## 绝对不要做的事

- 不要把远端发现与本地删除合并成一个“同步”按钮；
- 不要根据远端空列表删除或禁用本地模型；
- 不要在 React 页面中拼供应商 URL 或处理密钥；
- 不要在路由文件中直接写模型数据库事务；
- 不要在该功能中运行 ranking、recalibrate、sort；
- 不要自动开启新模型。

## 测试重点

`server/src/__tests__/services/provider-model-catalog.test.ts` 至少覆盖：

1. 多个 custom endpoint 不会折叠；
2. 同一 custom endpoint 的多把密钥统一管理；
3. custom 重复模型不会改绑；
4. Google `models/` 前缀正确解析；
5. 空远端列表零写入；
6. 新模型三个启用位均为 0；
7. 删除写 tombstone，再导入清 tombstone；
8. 本地列表不访问网络。

每次修改后执行：

```bash
npm test
npm run build
```
