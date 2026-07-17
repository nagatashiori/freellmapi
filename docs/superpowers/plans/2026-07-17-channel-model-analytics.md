# 渠道 × 模型 Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Analytics 的调度可观测性、错误分类和延迟基线统一为真实调用的渠道 × 实际模型口径。

**Architecture:** 保持 `requests` 为历史尝试源、`routing_events` 为一次外部请求的调度轨迹。后端在 Analytics 路由中提供纯读的聚合端点与分类器；前端显式渲染请求模型、最终实际渠道/模型及基线表，不触碰 runtime 路由优先级。

**Tech Stack:** Express、SQLite/better-sqlite3、TypeScript、Vitest、React、Recharts。

## Global Constraints

- `request_type='probe'` 不进入真实流量的渠道 × 模型质量基线。
- 成功质量指标只统计 `status='success'`；成功率统计全部真实尝试。
- 不创建数据库迁移，不自动调整 `profile_models` 或生产路由优先级。
- 保留进入本轮前已有的 `server/src/providers/index.ts` 未提交改动，不纳入本次提交。

---

### Task 1: 后端聚合与错误分类

**Files:**
- Modify: `server/src/routes/analytics.ts`
- Test: `server/src/__tests__/routes/analytics.test.ts`

**Interfaces:**
- Produces `GET /api/analytics/channel-model-baselines?range=<24h|7d|30d|90d>` rows with `{ platform, modelId, attempts, successRate, successCount, errorCount, avgLatencyMs, p50LatencyMs, p95LatencyMs, avgTtfbMs, avgTokensPerSecond, lastCalledAt }`.
- Produces error categories `Rate limited or quota`, `Authentication`, `Permission denied`, `Model not found`, `Request or capability mismatch`, `Timeout`, `Connection or DNS`, `Upstream server error`, `Upstream unavailable`, `Stream interrupted`, `Gateway routing`, `Unknown upstream error`, and `No error recorded`.

- [ ] **Step 1: Write failing API tests**

```ts
it('returns channel-model baselines from real traffic only', async () => {
  insertRaw({ platform: 'alpha', modelId: 'glm', status: 'success', latencyMs: 100, ttfbMs: 20, outputTokens: 100, createdAt: '2026-05-29 11:00:00' });
  insertRaw({ platform: 'alpha', modelId: 'glm', status: 'error', latencyMs: 900, error: '429 quota exceeded', createdAt: '2026-05-29 11:01:00' });
  insertRaw({ platform: 'alpha', modelId: 'glm', requestType: 'probe', status: 'success', latencyMs: 1, createdAt: '2026-05-29 11:02:00' });
  const { body } = await request(app, '/api/analytics/channel-model-baselines?range=24h');
  expect(body).toEqual([expect.objectContaining({ platform: 'alpha', modelId: 'glm', attempts: 2, successRate: 50, avgLatencyMs: 100, errorCount: 1 })]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the endpoint is absent**

Run: `cmd /c npm.cmd run test -w server -- src/__tests__/routes/analytics.test.ts`

Expected: FAIL with a 404 or an assertion that the baseline response does not exist.

- [ ] **Step 3: Implement the minimal read-only query and error classifier**

```ts
analyticsRouter.get('/channel-model-baselines', (req, res) => {
  // Aggregate requests WHERE request_type != 'probe' by platform/model_id.
  // Compute successful-only latency metrics and all-attempt success rate.
  // Return one row per real routing target, newest active target first.
});

function classifyError(error: string | null): string {
  // Normalize lower-case text; map explicit HTTP/network/stream/routing patterns.
  // Never return the legacy category 'Other'.
}
```

- [ ] **Step 4: Run focused server tests and verify green**

Run: `cmd /c npm.cmd run test -w server -- src/__tests__/routes/analytics.test.ts src/__tests__/routes/routing-traces.test.ts`

Expected: PASS with no failing tests.

### Task 2: 调度链和基线页面

**Files:**
- Modify: `client/src/pages/AnalyticsPage.tsx`
- Modify: `client/src/i18n/locales/zh-CN.json`
- Test: `server/src/__tests__/routes/routing-traces.test.ts`

**Interfaces:**
- Consumes the Task 1 baseline response.
- Renders trace request model plus final actual channel/model, and each dispatch attempt as named fields.

- [ ] **Step 1: Extend the routing-trace test before UI code**

```ts
expect(body.traces[0]).toMatchObject({
  requestedModel: 'glm-5.2',
  finalPlatform: 'locedge',
  finalModelId: 'z-ai/glm-5.2',
});
```

- [ ] **Step 2: Run the focused trace test and verify it fails for missing final fields**

Run: `cmd /c npm.cmd run test -w server -- src/__tests__/routes/routing-traces.test.ts`

Expected: FAIL because `finalPlatform` and `finalModelId` are absent.

- [ ] **Step 3: Add final route fields, baseline query, and explicit Chinese labels**

```tsx
<span>请求模型：{trace.requestedModel ?? 'auto'}</span>
<span>最终渠道：{trace.finalPlatform}</span>
<span>实际模型：{trace.finalModelId}</span>
```

- [ ] **Step 4: Render a channel × model quality-baseline table**

```tsx
<TableHead>渠道</TableHead>
<TableHead>实际模型</TableHead>
<TableHead>样本</TableHead>
<TableHead>成功率</TableHead>
<TableHead>P50 / P95</TableHead>
<TableHead>TTFB</TableHead>
<TableHead>吞吐</TableHead>
```

- [ ] **Step 5: Run focused tests and type builds**

Run: `cmd /c npm.cmd run test -w server -- src/__tests__/routes/analytics.test.ts src/__tests__/routes/routing-traces.test.ts`

Run: `cmd /c npm.cmd run build -w server`

Run: `cmd /c npm.cmd run build -w client`

Expected: all commands exit 0; client may retain its existing bundle-size warning only.

### Task 3: 完整回归、交接与发布

**Files:**
- Modify: `HANDOVER.md`

- [ ] **Step 1: Run full test suite**

Run: `cmd /c npm.cmd test`

Expected: all server and client tests pass.

- [ ] **Step 2: Record source and deployment boundaries**

Append the code files, tests, production deployment files, database impact (`none`), verification output and any remaining known lint debt to `HANDOVER.md`.

- [ ] **Step 3: Commit and push the isolated source change**

Run: `git add server/src/routes/analytics.ts server/src/__tests__/routes/analytics.test.ts server/src/__tests__/routes/routing-traces.test.ts client/src/pages/AnalyticsPage.tsx client/src/i18n/locales/zh-CN.json docs/superpowers && git commit -m "feat: add channel-model analytics baselines" && git push origin local/freellmapi-ops`

Expected: source commit is pushed without including `server/src/providers/index.ts`.
