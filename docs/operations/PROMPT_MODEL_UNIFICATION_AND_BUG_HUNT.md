# FreeLLMAPI 模型命名归一化、逻辑模型组整合与全局 Bug 排查提示词 (Prompt)

使用说明：当需要让 AI Agent（如 Claude Code, Antigravity, OpenCode 等）在 source 目录下进行新一轮深度的模型命名整合与隐患排查时，可直接复制本提示词发给 Agent。

---

```markdown
# 任务：FreeLLMAPI 模型命名归一化整合与全局 Bug 深度排查

你接手的是 FreeLLMAPI 项目（基于 Express + SQLite + TypeScript 的 LLM 统一路由与代理网关）。
用户反映目前项目仍然存在以下痛点：
1. **模型命名混乱且未完全整合**：不同 Provider 的模型 ID 格式不统一（如 `deepseek-ai/DeepSeek-V3`、`deepseek-v3`、`deepseek/deepseek-chat`；`claude-3-7-sonnet-20250219` 与 `claude-3.7-sonnet` 等），部分模型没有正确归一化合并到同一个逻辑模型组 (Logical Model Group)，导致无法跨 Provider 实现同模型自动 Failover。
2. **不同路由接口行为不一致**：`/v1/chat/completions`、`/v1/responses` (Codex/OpenCode 常用)、`/v1/messages` (Anthropic 协议)、`/v1/embeddings` 在处理 `model` 参数、逻辑组解析、粘性会话与 Failover 机制上仍存在差异。
3. **健康检测与数据库并发/查询开销**：在高并发请求和多模型探测场景下，需要确保健康检测不误杀模型、SQLite 锁保护完备且热门路由路径不触发全表扫描。

---

## 检查与修复要求

### 一、模型命名归一化与逻辑组整合 (Model Group Unification)
1. **核对 `model-groups.ts` 与 `resolveRequestedIdToMembers` 映射规则**：
   - 检查 `source/server/src/services/model-groups.ts` 中的规范 Slug (Canonical Slugs) 与成员匹配逻辑。
   - 确保同一种逻辑模型（如 Kimi 2.6、DeepSeek V3/R1、Claude 3.7 Sonnet、Gemini 2.5 Flash、GLM 4.7 等）在各个 Provider 注册的具体 `model_id` 能被准确识别归为同一个逻辑模型组。
   - 当客户端发送别名（如大小写不同、包含/不包含 provider 前缀、或版本后缀变体）时，能够精准解析到对应的逻辑模型组，而不是被当成未知模型返回 400 或误退回到全局 `auto`。
2. **完善模型组内 Fallback 顺序与过滤**：
   - 逻辑模型组内的各 Candidate 应严格保持 Profile 中配置的相对顺序。
   - 组内某些 Provider 不可用（如无有效 Key、不支持工具调用或处于冷却中）时，应自动跳至组内下一个可用 Provider，不得跳出该模型组去调用无关模型。

### 二、各路由 Surfaces 统一审计
1. **`/v1/chat/completions` (proxy.ts)**
2. **`/v1/responses` (responses.ts)**
3. **`/v1/messages` (anthropic.ts)**
4. **`/v1/embeddings` (embeddings.ts)**

请逐一核对上述 4 个接口：
- `req.body.model` 的解析逻辑是否一致（优先逻辑组解析 -> 单模型 Catalog 匹配 -> 不存在/全禁用返回 400 `model_not_found`）。
- 粘性会话 (Sticky Sessions, `x-session-id`) 的处理是否一致（不会将组外模型插入限定组链中）。
- 工具调用能力 (`supports_tools`)、视觉能力 (`supports_vision`) 和 Structured Output (`response_format`) 的前置过滤是否一致。

### 三、健康管理与 SQLite 数据库健壮性
1. **API Key 状态与模型探测联动**：
   - 确保当 API Key 处在 `invalid` 或 `enabled = 0` 时，健康检测与模型探测不会向无效 Key 发送上游 HTTP 请求。
   - 连续 3 次探测失败 (`error`/`timeout`) 才关闭模型开关；429 `rate_limited` 只进入临时 Cooldown，不得关闭模型。
2. **数据库锁与性能保护**：
   - 检查所有 SQLite 连接均配置 `journal_mode = WAL` 和 `busy_timeout = 5000`。
   - 检查热路由路径中涉及 `requests`、`profile_models`、`api_keys` 等表的高频 SQL，确保均有对应索引覆盖，严禁全表扫描。

---

## 强制遵循的规则 (Guiding Rules)

1. **先 TDD 测试驱动**：在修改任何代码之前，先编写或扩展复现问题的失败测试，确认测试转红后再编写最小实现代码，最后验证测试转绿。
2. **严格保护人工优先级与开关**：
   - **禁止** 运行 ranking、recalibrate、sort 或任何批量重排路由顺序的脚本。
   - **禁止** 修改 `intelligence_rank`。
   - **禁止** 自动修改用户手动关闭的 API Key 的 `enabled` 状态。
3. **Git 提交规范**：
   - 代码源码改动位于 `source/` 目录，在分支 `local/freellmapi-ops` 上提交并 Push 到 `origin` (`https://github.com/nagatashiori/freellmapi.git`)。
   - **严禁** 使用 `git add -A` 或 `git add .`！必须使用 `git add -- <file1> <file2>` 显式暂存修改的文件。
   - 本地产生的功能集合验证完毕后打 Tag (如 `v13.5`) 并 Push。
4. **验证与交接**：
   - 修改完成后运行：
     ```powershell
     npx tsc --noEmit (server)
     npm run build (server & client)
     npm test (server 全量测试)
     ```
   - 将验证证据与提交更新追加记录到 `HANDOVER.md` 最新 Session 中。

```
