你是 Claude Code，在项目 `C:\Users\teres\Desktop\freellmapi-handover\source` 继续工作。请始终中文回复，短句，少废话。

先读 `HANDOVER.md`，重点看 Session 040。不要假设外层 git 已跟踪 source；先确认仓库结构和 git 状态。

当前生产状态：

- VPS：`116.80.59.138`
- 容器：`freellmapi-freellmapi-1`
- 远端路径：`/home/debian/freellmapi`
- DB：容器内 `/app/server/data/freeapi.db`
- SSH key：`E:\codex-dfm\tmp_ssh_key.pem`（Git Bash `/e/codex-dfm/tmp_ssh_key.pem`）
- 生产 `fallback_attempt_timeout_ms=15000`
- 生产 `routing_strategy=priority`
- 容器上轮已 healthy，`/api/ping` ok

本轮已完成：

1. 慢渠道 failover：每个 chat attempt 首响应/首包 15s timeout，失败后走下一个渠道。
2. stream 修复：OpenAI-compatible stream 已开始输出后，SSE body inactivity 恢复 90s，避免 MiniMax/NVIDIA `stream interrupted`。
3. 绝对排名 UI 删除：Status 页面不再调用不存在的 recalibrate API，只保留模型组去重说明。
4. 删除本地危险 ranking scripts：`absolute-rank.js`、`recalibrate-absolute-rank.cjs`、`install-absolute-rank.cjs`、`freeze-absolute-rank.cjs` 等。
5. `/models/chat/:id` 测试全部提供方后，会按 probe latency 保存 Default profile `profile_models.priority`，调度在 priority 策略下跟随最快顺序。
6. 429 自动调整：429 现在会把该模型在 Default 路由组持久下沉到末尾，同时保留 cooldown/penalty。
7. SiliconFlow：key 已存在且 healthy，但 catalog 没模型；已请求 `https://api.siliconflow.com/v1/models` 并导入 50 个 chat 模型到生产 `models` + Default profile。

重要结论：

- `fallback_config` 是 legacy/backfill/rollback 兼容层，不是 runtime auto 主路由源。
- runtime auto 主路由源是 `profile_models`。
- 禁用模型不会调度：`models.enabled=0` 不进链；`profile_models.enabled=0` 在模型组候选中会被丢掉。
- 429 会 failover；如果用户看到 `exceeded retry limit, last status: 429 Too Many Requests`，先查生产日志，可能是上游/客户端文案或所有候选失败。
- 不要再把 15s timeout 传给 stream body read；只能用于首响应/首包。

下一步建议：

1. 若用户问 git/提交：先运行 `git status --short`，确认外层 repo 与 `source` 是否嵌套 repo。不要擅自 commit，除非用户明确说提交。
2. 若用户继续报 429：查 `requests` 表、`rate_limit_cooldowns` 表、`docker compose logs --since=...`，看 FreeLLMAPI 是否有 `next`，还是最终池子耗尽。
3. 若用户要清理 `light` 分组污染：先备份 DB，再列出改动计划，确认后改 `profile_models`。
4. 若用户要测试 SiliconFlow：查 `/models/chat` 是否出现 siliconflow 成员；必要时对具体模型点 probe。
5. 继续保持小输出，不 dump 大日志。

禁止：

- 不要 `docker compose down`。
- 不要 stop 容器。
- 不要未经备份改生产 DB。
- 不要 reset/clean 工作区。
- 不要恢复绝对排名脚本或 recalibrate UI。
- 不要把 `fallback_config` 和 `profile_models` 再做成两套可写 truth。
