# HANDOVER — 2026-08-08

## 当前任务卡：v13.21 官方账号池冷却治理与 Analytics token 记录

### 目标与用户可见结果

- 保留 v13.20 的官方账号池核心行为：无历史时轮询，有历史时按官方 v0.6.9 的 Beta/Thompson 抽样在可靠性与速度之间选择；模型范围、健康状态、并发、RPM/RPD、TPM/TPD、供应商级限制和失败切换继续生效。
- 成功恢复的 token 不继续继承旧的冷却升级阶梯；超时、5xx、网络错误不再被误计为“未知额度耗尽”，只有真正的限流信号才进入未知额度的升级计数。
- Analytics 最近调度链继续显示每次实际使用的 API/token 标签和 API ID；只显示标签/编号，不显示真实密钥。

### 当前状态

- source `local/freellmapi-ops`：提交 `e950b39` 已 push；标签 `v13.21` 已 push。
- VPS `/home/debian/freellmapi`：源码为 `e950b39`；容器 `freellmapi-freellmapi-1` 为 `running healthy`；服务端编译产物包含本轮冷却修复。
- 前端重新构建并成套上传：公网使用 `assets/index-D3DUdwgK.js` 与 `assets/index-D9saEn7T.css`，左上角版本为 `v13.21`。
- 部署备份：`/home/debian/freellmapi/deploy-backups/20260808_v13.21_e950b39/`；本轮没有写入生产模型、路由或 API key 数据。

### 修改与验证

- `server/src/services/ratelimit.ts`：成功请求清除 token 的冷却升级记录；增加 `quotaSignal` 判断。
- `server/src/lib/fallback-loop.ts`：只有真正的限流错误才给未知日额度启用重复命中升级。
- `server/src/__tests__/services/ratelimit.test.ts`：新增成功恢复重置冷却阶梯、超时/5xx 不计额度信号的测试。
- 先红后绿：新增 2 项测试在旧实现下失败，修复后通过。
- 定向账号池/限制/fallback/Analytics 测试：6 个文件、92 项通过；冷却测试 33/33 通过。
- source 全量测试在排除仓库其他 worktree、外网 offline-fetch 和 Windows/undici bad-port 的 custom-modalities 测试后退出码 0；迁移测试退出码 0。
- `npx tsc --noEmit -p server/tsconfig.json`、server build、client build、`git diff --check` 均通过。
- 公网 `/api/ping` 200、首页 200、`Cache-Control: public, max-age=0`、HSTS 存在；公网 JS 含 `v13.21`、不含 `v13.20`，并含 Analytics 的 `API ID` 和 routing-traces 代码。

### 保护边界与未完成验证

- 未运行 ranking、recalibrate、sort；未修改模型数量、模型 ID、enabled、排名、profile/fallback 顺序或生产数据库资料。
- 未用真实生产 token 发起上游请求，因此“线上真实请求连续使用两把 token”的最后一步仍需用户自行发一次请求后在 Analytics 查看；代码链路和模拟失败切换已验证。
- VPS 上原有的 `docker-compose.yml` 修改及历史 `dist-*`/备份目录保持不动，没有执行清理。

### 唯一下一步

- 用同一端点的两把有效 token 发起请求，打开 Analytics 的“最近调度链”，确认每次尝试出现不同的 API 标签/ID；不要把真实 token 本身贴到页面或日志。

---

## 历史任务卡：v13.20 多 API 官方账号选择修复

### 目标与用户可见结果

- 同一供应商、同一自定义端点下的多个 token/API key 进入同一个可用账号池。
- 无历史数据时按 key ID 稳定轮询；有历史数据时使用官方 v0.6.9 的 Beta 后验抽样策略，可靠 key 更容易被选中，但其他 key 仍会被探索。
- 同一端点的两个 token 文件可以互相轮换；不同端点不会混用；冷却、限流、并发占满或本次请求已经失败的 key 会跳过。
- 前端已同步重新构建并部署，版本显示为 `v13.20`。

### 当前状态

- source `local/freellmapi-ops`：提交 `b88c037` 已 push；标签 `v13.20` 已 push。
- VPS `/home/debian/freellmapi`：源码为 `b88c037`，镜像已重新构建；`freellmapi-freellmapi-1` 为 `running healthy`。
- 公网入口使用 `assets/index-C5qINsoU.js` 和 `assets/index-D9saEn7T.css`；公网 JS 含 `v13.20` 且不含 `v13.19`。
- 生产数据库未写入；只读取确认 `mapleleaf` 当前有同一端点的 2 个启用 key。

### 修改文件

- `server/src/services/router.ts`：key 有历史时采用 `sampleBeta` + `speedScore` 的官方账号选择方式；无历史时用 `ORDER BY id ASC` 保证轮询顺序稳定。
- `server/src/__tests__/services/router-key-pool.test.ts`：增加历史后的双 key 探索测试、同端点双 token 轮换测试和不同端点隔离测试。

### fresh 验证

- 先红后绿：旧实现下新增历史测试的 24 次选择全部落在第一把 key；改为官方抽样后两把 key 都被选中。
- key pool 定向测试：5/5 通过。
- source 测试（排除其他 worktree 和公网 offline-fetch 保护测试）：退出码 0。
- server TypeScript 检查、server build、client build、`git diff --check` 均通过。
- VPS 容器 healthy，内部和公网 `/api/ping` 均 200；生产页面资源已更新到 `v13.20`。

### 保护边界

- 未修改模型、路由顺序、排名、enabled 或数据库资料；未运行 ranking、recalibrate、sort。
- 未使用真实生产 token 发起上游请求；没有真实额度消耗。
- 官方策略不是有历史后的强制 A/B/A/B，而是可靠性优先并保留探索；强制等比例轮换属于另一个策略，本次未擅自替换。

### 阻塞

- 默认全量扫描会额外发现 `.worktrees/` 中其他窗口的测试；公网 offline-fetch 测试在当前环境收到 HTTP 403，因此默认扫描有 5 个与本次改动无关的失败。源目录排除这些干扰后的测试通过。

### 唯一下一步

- 用户用同一端点的两把有效 token 发一次生产请求，在 Analytics 查看是否出现两个不同 API ID；没有真实请求证据前，不把上游轮换称为线上最终确认。

---

## 当前任务卡：回滚 v13.18 Playground 供应商显示修改

### 目标与用户可见结果

- 撤回 v13.18 中“融合模型显示全部有可用密钥供应商”的前端修改。
- Playground 恢复 v13.17 的行为：只保留 active profile 中启用且模型级可用的成员来生成下拉选项。
- 不恢复生产数据库旧副本，不回退用户在 v13.18 之后产生的任何数据。

### 当前状态

- source `local/freellmapi-ops`：回滚提交 `d5891ff` 已 push；`v13.18` 标签保留为历史记录，不移动、不删除。
- VPS 前端已从 v13.18 上线备份原地恢复为 `assets/index-CU9IL6DR.js`（v13.17）；服务端容器未重启，保持 `running healthy`。
- VPS 回滚前的 v13.18 前端另存于 `/home/debian/freellmapi/deploy-backups/rollback-before-v13.18-restore-20260805_0945/frontend-dist-v13.18/`，便于再次恢复。

### 回滚范围

- 已撤回 `client/src/lib/playground-models.ts`、`client/src/lib/model-groups.ts` 和对应新增测试。
- 只恢复前端静态资源；数据库、`profile_models.priority`、`enabled`、`intelligence_rank`、人工路由顺序和现有模型记录均保持不变。
- 未运行 ranking、recalibrate、sort；未恢复旧数据库备份，避免覆盖后续业务数据。

### fresh 验证

- 回滚后前端测试 `2 files / 4 tests` 全通过；`npm run build -w client` 退出码 0；`git diff --check` 通过。
- 生产回滚使用备份 `/home/debian/freellmapi/deploy-backups/playground-provider-groups-v13.18-20260805_0935/frontend-dist/`，备份资源哈希为 `a4670653170a18313baa4a7e5b635c86f7cc0e42d9060024a26373e0ef03883c`。
- 公网：`/`、`/playground`、`/api/ping` 均 200；公网 bundle 为 `index-CU9IL6DR.js`，包含 `v13.17` 且不包含 `v13.18`；`Cache-Control: public, max-age=0` 和 HSTS 保持；容器 healthy。

### 阻塞

- 无代码、测试或部署阻塞。已打开的旧页面需要 Ctrl+F5 一次才能看到回滚后的静态资源。

### 唯一下一步

- 用户在生产 `/playground` 执行一次 Ctrl+F5，确认页面恢复到 v13.17 的供应商显示行为。

---

## 历史任务卡：Playground 融合模型显示全部可用供应商（v13.18）

### 目标与用户可见结果

- Playground 搜索 `Free` 时仍只显示一个融合模型，但供应商提示显示它的全部可用供应商，不再只显示当前第一行的 `mapleleaf`。
- 同一供应商有多个模型行时只计一次；当前有可用密钥的供应商才计入数量。
- 一个融合组只要至少有一个启用且可用的成员就继续显示；其他有可用密钥但暂未启用的成员用于展示供应商组成，不会单独变成可选路由。

### 当前状态

- source `local/freellmapi-ops`：`f999c80`，已 push，标签 `v13.18` 已 push。
- VPS `/home/debian/freellmapi`：已快进到 `f999c80`，已拉取标签 `v13.18`；未重建或重启服务端镜像，容器保持 `running healthy`。
- 前端已重新构建并原地替换绑定目录；公网入口使用 `assets/index-rYkAP6jK.js`，包含 `v13.18`。

### 根因与修复

- **根因**：旧代码先把“未启用”的供应商行过滤掉，再做融合分组，所以 `Free` 只剩当前启用的 `mapleleaf`。
- **修复**：先按逻辑模型分组，再保留同组中所有有可用密钥的供应商；供应商数量按不同平台去重，避免一个平台的两行模型被重复计算。
- **生产 Free 现状**：按当前数据库的可用密钥数据，`cmapi`、`kilo`、`mapleleaf` 三个平台会计入；没有可用密钥的平台不计入。

### 修改文件

- `client/src/lib/playground-models.ts`：先判断可见融合组，再收集同组可用供应商。
- `client/src/lib/model-groups.ts`：供应商数量和平台列表去重。
- `client/src/lib/playground-models.test.ts`：新增“一个启用成员 + 多个未启用但有可用密钥成员”回归测试。

### 保护边界

- 未修改生产数据库、`profile_models.priority`、`enabled`、`intelligence_rank`、人工路由顺序或供应商实际启用状态。
- 未运行 ranking、recalibrate、sort；本轮只修 Playground 显示，不擅自把三个供应商全部打开参与实际调度。
- 现有 active profile 数据源和失效模型自动回退逻辑保持不变。

### fresh 验证

- TDD 回归：先验证旧逻辑得到 1 个供应商，再实现修复；前端测试 `2 files / 5 tests` 全通过。
- `npm run build -w client`：退出码 0；构建产物包含 `v13.18`、`providerCount`、`usableKeyCount`；`git diff --check` 通过。
- VPS 备份：`/home/debian/freellmapi/deploy-backups/playground-provider-groups-v13.18-20260805_0935/`，含旧前端、数据库 WAL/SHM（如存在）、compose 和新前端压缩包。
- VPS：代码 `f999c80`、标签 `v13.18`、容器 `running healthy`、内部 `/api/ping` 200；新前端文件哈希与本地构建一致。
- 公网：`/`、`/playground`、`/api/ping` 均 200；`Cache-Control: public, max-age=0`、HSTS 存在；公网 bundle 为 `index-rYkAP6jK.js` 且包含 `v13.18`。

### 阻塞

- 无代码、测试或部署阻塞。旧页面仍可能保留浏览器缓存，需要 Ctrl+F5 一次。

### 唯一下一步

- 用户在生产 `/playground` 执行一次 Ctrl+F5，搜索 `Free`，确认提示变为当前可用的 `3 个供应商`；如果希望这三个供应商实际都参加 Auto/Fusion 调度，再单独确认路由表里的启用状态和顺序。

---

## 历史任务卡：Playground 可选模型与实际可用模型同步（v13.17）

### 目标与用户可见结果

- Playground 的模型下拉列表只从当前 Auto 实际使用的 active profile 读取，不再误读 Default profile。
- 只显示启用且存在模型级可用密钥的模型；同一逻辑模型的多个供应商仍合并为一个选项。
- 模型被删除、关闭、移出当前路由组或失去可用密钥后，刷新数据会自动从下拉列表移除；旧的本地选择自动回到 Auto，不再发送已经失效的模型 ID。

### 当前状态

- source `local/freellmapi-ops`：`e98dacf`，已 push，标签 `v13.17` 已 push。
- VPS `/home/debian/freellmapi`：`e98dacf`，已显式拉取标签 `v13.17`；镜像已重新构建并重启，容器保持 `running healthy`。
- 前端已重新构建并原地替换绑定目录；公网入口使用 `assets/index-CU9IL6DR.js`，包含 `v13.17`。

### 修改文件

- `server/src/routes/fallback.ts`：`GET /api/fallback?profile=active` 读取 active profile，保留默认 `/api/fallback` 给模型管理页使用。
- `client/src/lib/playground-models.ts`：统一判断模型级可用性、构建可选模型和清理过期选择。
- `client/src/pages/PlaygroundPage.tsx`：改用 active profile 查询、模型级健康数量和过期选择回退逻辑。
- `server/src/__tests__/routes/fallback-playground.test.ts`：锁定 Playground 必须读取 active profile。
- `client/src/lib/playground-models.test.ts`：锁定模型级可用密钥筛选和删除模型后回退 Auto。

### 保护边界

- 未修改生产数据库、`profile_models.priority`、`enabled`、`intelligence_rank` 或人工路由顺序；测试写入的只有内存数据库。
- 未运行 ranking、recalibrate、sort；未改变 Default 模型管理页的默认数据源。
- 保留前端统一 `['fallback']` 前缀失效规则，因此模型、密钥、健康探测或路由组变更后，Playground 的 active 查询也会一起重新获取。

### fresh 验证

- 新服务端回归测试：1/1 通过；新前端测试：2/2 通过；相关 fallback 测试：78/78 通过。
- server 全量测试 `npm run test -w server`：退出码 0。
- server TypeScript、server build、client build：退出码 0；构建产物包含 `profile=active`、`playground.model` 和 `v13.17`。
- `git diff --check`：通过。
- VPS 备份：`/home/debian/freellmapi/deploy-backups/playground-model-sync-v13.17-20260805_011542/`，含数据库（WAL/SHM 如存在）、旧前端和 compose。
- VPS：`e98dacf`、标签 `v13.17`、容器 `running healthy`、服务端编译文件包含 active profile 查询；内部 `/api/ping` 200。
- 公网：`/playground` 200、首页 200、`/api/ping` 200、`Cache-Control: public, max-age=0`、HSTS 存在；公网 bundle 使用 `index-CU9IL6DR.js` 且包含 `v13.17`。

### 阻塞

- 无代码、测试或部署阻塞。用户已经打开的旧页面需要 Ctrl+F5 一次，之后刷新模型会自动同步。

### 唯一下一步

- 用户在生产 `/playground` 执行一次 Ctrl+F5，打开下拉框确认它只显示 active 路由中当前可用的模型；以后从模型管理、密钥或健康探测入口更新后会自动重新读取。

### 最新 Session（2026-08-05）

- **根因**：Playground 原来读取 Default profile，而 Auto 运行时读取 active profile；同时前端只看供应商级 keyCount，并保留 localStorage 里的旧模型选择。
- **修复**：增加 active profile 查询参数；使用模型级 usableKeyCount；把可用模型筛选和旧选择清理抽成共享纯逻辑；后端、前端和测试一起提交为 `e98dacf`，标签 `v13.17`。
- **上线**：先备份生产数据库和旧前端，再构建 Docker 镜像并重启，最后在绑定的 `dist` 目录内原地替换前端资源；容器和公网检查均通过。

---

## 历史交接（v13.16 及更早）

## 当前任务卡：所有模型变更统一刷新全页面（v13.16）

### 目标与用户可见结果

- 供应商模型管理只保留一条流程：选择供应商 → 点击“拉取模型”。
- 数据库已有模型自动打勾；勾选立即添加，取消勾选立即删除本地记录。
- 更新后同时刷新模型页、默认路由表、其他路由组、模型状态和探测历史视图，避免页面继续显示旧缓存。
- 从供应商模型、模型详情、路由表、仪表盘、密钥管理等入口修改后，其他相关页面都走同一个刷新入口。
- 远端没有返回的本地模型仍显示为已勾选，用户可明确取消后删除；远端异常不自动删除本地模型。

### 当前状态

- source `local/freellmapi-ops`：`0bc9a6f`，已 push，标签 `v13.16` 已 push。
- VPS `/home/debian/freellmapi` 已更新到 `0bc9a6f`；本轮只更新前端，运行容器保持 healthy，未重启服务。
- `freellmapi-freellmapi-1` healthy；内部 `/api/ping` 200。
- 前端已重新构建并原地成套替换；公网入口使用 `assets/index-wBNFCCWK.js`，包含 `v13.16`，旧入口不再使用。

### 修改文件

- `shared/types.ts`：增加统一模型清单类型。
- `server/src/services/provider-model-catalog.ts`：新增只读统一清单，合并远端模型和本地孤儿记录；远端失败时返回本地记录。
- `server/src/routes/provider-model-catalog.ts`：增加 `/sync` 清单接口；保留旧接口兼容其他调用者。
- `client/src/features/provider-model-catalog/ProviderModelCatalogPanel.tsx`：删除两个模式、批量选择和分开的添加/删除按钮，改为一个拉取按钮和逐行勾选。
- `server/src/__tests__/services/provider-model-catalog.test.ts`：新增合并清单、远端失败保留本地记录测试。
- `client/src/lib/invalidate-model-views.ts`：集中声明并执行所有模型、路由、路由组、状态、探测历史和供应商目录缓存刷新。
- `client/src/lib/invalidate-model-views.test.ts`：锁定共享刷新入口覆盖所有相关页面，并验证每个缓存前缀都会被刷新。
- `client/src/pages/FallbackPage.tsx`、`DashboardPage.tsx`、`ModelDetailPage.tsx`：路由、启用、删除、策略和成员变更统一调用共享刷新入口。
- `client/src/components/keys/*.tsx`、`StatusPage.tsx`、`use-probe.ts`、`PremiumPage.tsx`：密钥、健康探测和目录同步后也刷新对应模型视图；批量探测使用较窄的健康刷新范围，避免重复请求过多。
- `client/src/pages/StatusPage.tsx`：更新页面说明，明确拉取后会同步相关视图。

### 保护边界

- 没有修改 `profile_models.priority`、`enabled`、`intelligence_rank` 或生产业务数据。
- 没有运行 ranking、recalibrate、sort。
- 取消勾选仍通过后端显式删除接口执行，并写入既有 tombstone 规则。
- 不自动重排 `profile_models.priority`；模型目录更新不会替用户改变人工路由顺序。

### fresh 验证

- 供应商目录服务测试：10/10 通过。
- 前端缓存刷新测试：2/2 通过（先失败后通过）。
- client TypeScript 检查与 build：通过；构建后标签为 `v13.16`。
- 共享刷新入口和测试文件定向 ESLint：通过；全量 client lint 仍有仓库原有 66 个问题，未在本轮扩展修复。
- `git diff --check`：通过。
- 生产只读核对：`models=278`、Default `profile_models=278`、活动 profile 为 Default、策略为 `priority`；默认路由数据与模型数据库一致。
- 公网核对：入口 200、`Cache-Control: public, max-age=0`、HSTS 存在；新 bundle 含 `profile-models` 和 `probe-history` 刷新逻辑。
- server 全量测试已运行；本地环境有 3 个与本次改动无关的既有/环境失败：公网离线保护测试收到真实 403、keys 测试超时、completions 测试遇到 undici bad port。不能将其记为全量通过。

### 部署备份

- `/home/debian/freellmapi/deploy-backups/provider-model-catalog-v13.14-20260804_202554/`：数据库和旧前端目录。
- `/home/debian/freellmapi/deploy-backups/frontend-v13.14-20260804_203435/`：替换前的前端目录。
- `/home/debian/freellmapi/deploy-backups/model-view-refresh-v13.15-20260804_211227/`：上一轮数据库和前端目录备份。
- `/home/debian/freellmapi/deploy-backups/model-view-refresh-v13.16-20260805_052655/`：本轮数据库（含 WAL/SHM）和前端目录备份。
- 未删除 VPS 原有未跟踪备份目录或 compose 本地改动。

### 唯一下一步

- 用户在生产页面 Ctrl+F5，任选一个入口更新模型后打开模型页、路由表、路由策略和模型状态页，确认它们都会自动显示同一份最新结果。

### 最新 Session（2026-08-05）

- **根因**：之前只有供应商模型面板会刷新部分缓存；从模型页、路由表、仪表盘或密钥页修改时，其他页面仍保留旧数据。
- **修复**：把所有模型变更入口接到 `invalidate-model-views.ts`；模型新增、删除、启用、路由组成员、策略和密钥/健康变化后，相关页面统一重新读取同一份数据库结果。
- **保护**：只刷新前端缓存，不自动重排人工路由顺序；未改 `profile_models.priority`、`enabled`、`intelligence_rank`，未运行 ranking、recalibrate、sort。
- **上线**：代码 `0bc9a6f`、标签 `v13.16` 已 push；VPS 前端已原地替换并通过本机/公网检查。

---

## 历史交接（2026-07-16）

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
