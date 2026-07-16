# HANDOVER — 2026-07-16

## 当前目标

整理 FreeLLMAPI 项目当前状态，给下一次会话继续接手。

本轮核心任务已从“延迟展示/排序”推进到“修路由数据源混乱”：

- `model: "auto"` 不应被 `/models/chat` 的 fallback_config 和 active profile 分裂影响。
- 用户手动排序/启用禁用必须有意义，不能出现“关了模型还被 auto 调用”。
- 路由运行时应使用唯一数据源，当前改造方向是：运行时以 `profile_models` 为准，尤其 Default profile。
- `fallback_config` 逐步变成兼容/展示层，不再作为 runtime auto 的另一套真相。

## 用户硬性要求

- 始终中文回复。
- 服务不能停。线上 API 正在跑，不能随便 stop/restart。
- DB 修改前必须备份。
- 不要再自动改乱 `/models/chat` 手动顺序。
- 不要让 catalog sync / 自动脚本重排用户顺序。
- 所有路由/延迟/排序核心计算尽量后端做，前端只展示。
- 不要把大日志、大列表 dump 到聊天里，先聚合。

## 已确认线上事实

VPS：`116.80.59.138`

容器：`freellmapi-freellmapi-1`

DB：容器内 `/app/server/data/freeapi.db`

正确 SSH key：`E:\codex-dfm\tmp_ssh_key.pem`，Git Bash 路径：`/e/codex-dfm/tmp_ssh_key.pem`

当前线上曾确认：

- `active_profile_id = 1`
- `routing_strategy = priority`
- `model: "auto"` 走 active profile 的 `profile_models`，不是 `fallback_config`
- profile 1 里 GLM-5.2 优先级在 gemma4 前：
  - P3 `mapleleaf/z-ai/glm-5.2`
  - P4 `locedge/z-ai/glm-5.2`
  - P5 `modelscope/ZhipuAI/GLM-5.2`
  - P15/P16 才是 `gemma4:31b`
- `fallback_config` 里 gemma4 可为 disabled，但 auto 仍可调用 profile 里的 gemma4。
- 这解释用户说的“关了/暂停了模型还会被调用”：很可能 UI 改的是 `fallback_config.enabled`，runtime auto 看的是 `profile_models.enabled`。

## GLM-5.2 问题结论

用户怀疑 GLM-5.2 因 token 太高/不会自动压缩失败。

已查日志，主要不是 token 压缩问题：

- modelscope `ZhipuAI/GLM-5.2` 返回 429 daily quota exceeded。
- mapleleaf/locedge `z-ai/glm-5.2` 返回上游 internal server error。
- `req=auto` 选择 gemma4，是前面高优先模型当时被跳过/失败后，fallback loop 掉到 gemma4。

仍缺少成功路由时的完整 skip diagnostics。当前日志只在 routing exhausted 时打印详细 diagnostics。

## 已完成改动概要

### 延迟显示/排序相关

涉及文件：

- `client/src/lib/routing.ts`
- `client/src/pages/ModelDetailPage.tsx`
- `client/src/pages/FallbackPage.tsx`
- `client/src/pages/DashboardPage.tsx`
- `client/src/components/model-table.tsx`
- `server/src/routes/fallback.ts`

要点：

- 后端 `/api/fallback` 返回 `latencyStats`。
- 新增 `/api/fallback/probe-stats?canonical=...`，后端按 24h probe 成功延迟排序 provider members。
- `/models/chat` group row 显示 24h 平均延迟。
- `/models/chat/:id` provider row 显示延迟。
- `/dashboard` 显示 24h 平均延迟。
- 删除前端单独计算延迟 hook，避免违背“后端做计算”。
- ModelDetail probe-all 后用后端返回顺序更新页面显示。
- 修复 provider health card 使用 `displayMembers`，否则排序看不到。
- 修复 rapid drag mutation race，用 `dragGeneration` 防止旧 mutation 清掉新 local state。

### 路由唯一数据源改造相关

新增/修改文件：

- `server/src/services/routing-groups.ts`（新）
- `server/src/db/migrations/20260716_000001_routing_profile_source.ts`（新）
- `server/src/routes/fallback.ts`
- `server/src/services/router.ts`
- `server/src/routes/models.ts`
- `server/src/routes/keys.ts`
- `server/src/services/catalog-sync.ts`
- `server/src/services/declarative-config.ts`
- `server/src/services/model-state.ts`
- `server/src/db/migrate/defaults.ts`
- 相关 tests

当前改造意图：

- `profile_models` 成为 runtime auto 真实来源。
- Default profile 作为 `/models/chat` 兼容显示/编辑来源。
- 禁用/启用、排序都应写 Default profile membership，而不是只写 `fallback_config`。
- `fallback_config` 不再作为 runtime 另一套 truth，避免双写漂移。
- catalog sync 新模型只追加 Default profile，默认 off。
- 删除 catalog model 时清掉 profile membership。
- 自定义 key 注册模型只加入 Default profile，避免再写 fallback_config。

## 当前工作区状态

`git status --short` 显示：

```text
 M client/src/components/model-table.tsx
 M client/src/lib/routing.ts
 M client/src/pages/DashboardPage.tsx
 M client/src/pages/FallbackPage.tsx
 M client/src/pages/ModelDetailPage.tsx
 M server/src/__tests__/routes/fallback.test.ts
 M server/src/__tests__/routes/proxy-model-groups.test.ts
 M server/src/__tests__/services/router.test.ts
 M server/src/db/migrate/defaults.ts
 M server/src/routes/fallback.ts
 M server/src/routes/keys.ts
 M server/src/routes/models.ts
 M server/src/services/catalog-sync.ts
 M server/src/services/declarative-config.ts
 M server/src/services/model-state.ts
 M server/src/services/router.ts
?? server/src/db/migrations/20260716_000001_routing_profile_source.ts
?? server/src/services/routing-groups.ts
```

`git diff --stat` 大致：

```text
16 files changed, 522 insertions(+), 413 deletions(-)
```

## 重要风险

当前工作区不是完整可交付状态。尤其需要继续检查：

1. `server/src/services/catalog-sync.ts`
   - 上次中断时正在改 import 和 catalog sync 行为。
   - 需要确认没有重复 import、缺失 import、未用 import。
   - 需要确认删除 tombstoned catalog model 时清理 `profile_models`。
   - 需要确认新增 catalog model 加入 Default profile 且默认 disabled。

2. `server/src/routes/keys.ts`
   - 上次删除 `classifyAutoPools()` 调用，可能函数还残留未用。
   - 自定义注册模型应该只 `ensureModelInProfile(Default)`，不再写 `fallback_config`。
   - 需要确认 TypeScript lint/build。

3. `server/src/routes/fallback.ts`
   - 需要确认 fallback API 已完全走 routing-groups service。
   - 需要确认 reorder/toggle/delete 都写 Default profile。
   - 需要确认兼容 response shape 未破坏前端。

4. `server/src/services/router.ts`
   - runtime auto 应从 active profile 读。
   - `orderChain()` priority 模式仍会加 `getPenalty(model_db_id)`。需要查 penalty 是否会让低优先级模型越过高优先级模型。
   - 若要解释 gemma4 被选中，最好添加低噪声 successful auto routing diagnostics，但不能刷爆日志。

5. migration
   - `20260716_000001_routing_profile_source.ts` 需要确认幂等。
   - DB 修改前备份。
   - 不能线上直接跑未审 migration。

6. tests
   - 需要跑 server tests / TypeScript build。
   - 之前 server 严格 TS 有历史错误，若 build 失败要区分新旧错误。

## 上次中断位置

上次会话最后正在执行：

- 移除自定义模型注册写 `fallback_config`。
- 改 catalog sync：新 catalog model 只追加 Default profile，默认 off。
- 删除 catalog model 时清理 profile membership。
- 中断前 edit 可能只完成一半。

目标会话文件：

```text
C:\Users\teres\.claude\projects\C--Users-teres-Desktop-freellmapi-handover\5ad50afd-ba23-4928-957b-89d5f66c1bda.jsonl
```

如果需要更多历史，可读该 jsonl，但要限制 Tail/过滤输出，避免上下文爆。

## 推荐下一步

1. 不要部署，不要动线上 DB。
2. 本地先查当前 diff：
   - `git diff -- server/src/services/catalog-sync.ts`
   - `git diff -- server/src/routes/keys.ts`
   - `git diff -- server/src/routes/fallback.ts`
   - `git diff -- server/src/services/router.ts`
3. 修完 TypeScript 明显错误。
4. 跑最小测试：
   - router tests
   - fallback route tests
   - proxy model groups tests
5. 本地构建通过后，再规划无停机部署。
6. 任何 DB migration 或线上数据修复前，先备份 DB。

## 不要做的事

- 不要 `docker compose down`。
- 不要 stop 容器。
- 不要 reset/clean 工作区。
- 不要自动重排 `/models/chat`。
- 不要把 `fallback_config` 和 `profile_models` 双写搞成两个可漂移来源。
- 不要未经备份跑 migration。
- 不要假设 `/models/chat` disabled 就等于 auto disabled，必须看写的是哪个表。

## Session 039 — routing profile source + deployed (2026-07-16)

**做了什么**:
1. 自定义注册模型不再写 `fallback_config`。
2. 自定义模型写入 `models` 表后，只加入 Default profile 的 `profile_models`。
3. named third-party 平台仍额外加入 Third-Party profile。
4. `high` / `mid` / `light` 不再按模型名字自动加入，避免污染人工路由组。
5. catalog 新 chat model 只加入 Default profile。
6. catalog 删除/tombstone 删除模型前清理 `profile_models`。
7. 新增 `server/src/services/routing-groups.ts`，集中处理 profile routing helpers。
8. 修复 `FallbackPage.tsx` 未用变量导致 Docker 全量 build 失败。

**验证和部署**:
- 本地 `npm --prefix "source" run build` 通过。
- 远端 `/home/debian/freellmapi` 已上传当前 source 并 `docker compose up -d --build`。
- 容器 `freellmapi-freellmapi-1` 已重建并 healthy。
- 远端 health check `http://127.0.0.1:3001/api/ping` 返回 ok。
- 部署前源码备份：`/home/debian/deploy-backups/freellmapi-pre-routing-20260716-163842.tgz`。
- Docker volume DB 未删除、未重建。

**关键结论**:
- `fallback_config` 现在是 legacy/backfill/rollback 兼容层，不是 runtime auto 主路由源。
- runtime auto 主路由源是 `profile_models`。
- 自定义/第三方注册的当然仍是模型：它们在 `models` 表，并通过 `profile_models` 加入可调用路由组。

## Session 040 — failover timeout, ranking cleanup, provider ordering, SiliconFlow import (2026-07-16)

**做了什么**:
1. 修复慢渠道卡死：新增 `fallback_attempt_timeout_ms`，生产设置为 `15000`。
2. `/v1/chat/completions` 和 legacy `/completions` 每次尝试首响应超过 15s 会 abort，并进入下一渠道 failover。
3. 修复流式副作用：OpenAI-compatible stream 建连/首响应仍 15s，但 stream 已开始输出后 SSE body inactivity 恢复默认 90s，避免 MiniMax/NVIDIA 中途 `stream interrupted`。
4. 删除前端 Status 页面“绝对排名 + 重新校准”入口，改成只说明“运行时模型组去重自动生效”。
5. 删除本地危险绝对排名脚本：`scripts/absolute-rank.js`、`recalibrate-absolute-rank.cjs`、`install-absolute-rank.cjs`、`freeze-absolute-rank.cjs`、`fix-opus-ranks.cjs`、`inspect-rank-issues.cjs`、`patch-absolute-rank-tiers.cjs`。
6. `/models/chat/:id` 的“测试全部提供方”原来只做 UI 临时排序；已改为测试后按后端 probe 延迟排序，并保存到 Default profile `profile_models.priority`。生产 `routing_strategy=priority`，所以调度会跟随第 1 位。
7. 修复 429 后“不自动调整”：429 现在会把该模型在 Default 路由组中持久下沉到末尾，同时保留 cooldown/penalty；刷新和重启后仍避开。
8. SiliconFlow key 已存在且 healthy，但本地 catalog 无模型；已直接请求 SiliconFlow `/v1/models`，导入 50 个 chat 模型到 `models` 并加入 Default profile。

**验证和部署**:
- 多次本地 `npm --prefix "source" run build` 通过。
- 多次远端 `npm run build` + `docker compose up -d --build` 通过。
- 当前生产容器 `freellmapi-freellmapi-1` healthy。
- `http://127.0.0.1:3001/api/ping` 返回 ok。
- 生产设置确认：`fallback_attempt_timeout_ms=15000`、`routing_strategy=priority`。
- 生产 SiliconFlow 确认：`models WHERE platform='siliconflow' AND enabled=1` 为 50，Default profile joined 为 50。

**关键结论**:
- “超时 15 秒切下一个”只应限制请求首响应/首包，不能限制 stream 中途 chunk 间隔；否则 MiniMax/NVIDIA 这类慢流会被误断。
- 429 本身会 failover；用户看到 `exceeded retry limit, last status: 429 Too Many Requests` 时，多半是上游/客户端自身文案或所有候选最终失败。现在 429 还会持久下沉顺序，避免同一坏渠道一直排前。
- 禁用模型不会调度：`models.enabled=0` 不进链，`profile_models.enabled=0` 在模型组候选会被丢掉。
- SiliconFlow 原提示来自 upstream catalog gating，不是 key 错；生产已绕过 catalog gating 直接按 `/v1/models` 导入。

**仍需注意**:
- 外层 git 仓库显示 `source/` 整体未跟踪，外层 `git status` 看不到 source 内部逐文件修改；若要提交，应先进 `source` 或确认仓库结构。
- 当前未提交 git commit。用户问到 git 时要先说明“没 commit”，除非用户明确要求提交。
- `light` profile 仍有历史污染，未清理；清理生产 DB 前必须备份并让用户确认。
- 临时脚本 `_tmp_import_siliconflow.mjs` 是本轮为生产导入 SiliconFlow 写的临时文件，不含明文 key，可按需删除。
