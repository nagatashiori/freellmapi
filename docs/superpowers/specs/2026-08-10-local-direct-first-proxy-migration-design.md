# FreeLLMAPI 局域网迁移与直连优先代理设计

## 目标

将 FreeLLMAPI 主体迁移到局域网主机 `192.168.1.111` 运行，WebUI 仅通过
`http://192.168.1.111:3001` 访问；在本地部署完成并通过真实验证后，仅停止 VPS 上的
FreeLLMAPI 容器，保留 VPS 主机、容器数据、配置和其他服务。

## 不变边界

- 保留现有 Provider、API Key、模型、路由优先级、数据库设置和 WebUI 功能。
- 不执行 ranking、recalibrate、sort，也不修改 `enabled`、`intelligence_rank` 或人工
  `priority`。
- 不把 `.env`、数据库、密钥或 `ENCRYPTION_KEY` 提交到 Git。
- VPS 只执行可回滚的备份和最终 `docker stop`；不删除容器、卷、镜像、目录或配置。

## 网络策略

### 路由决策

所有由应用发起的外部 HTTP 请求统一经过一个请求入口：

1. 目标为本机、局域网、私有网段或明确的本地 Provider 时，强制直连，不使用代理。
2. 其他目标默认先直连。
3. 直连在连接建立、DNS、TLS 或响应读取阶段发生网络异常/超时，且调用方信号仍然有效时，
   再以同一请求参数尝试代理。
4. 直连收到 HTTP 响应后，不因 401、403、404 或其他业务 HTTP 状态重复发送请求；鉴权和
   Provider 业务错误交由原有错误处理。
5. 代理未配置、被禁用、目标被 bypass，或请求已被调用方取消时，不进行代理重试。

这样可以减少跨境请求经过 VPS 的次数，同时避免把错误的 API Key、模型名或权限错误误判为
网络故障。代理重试只记录脱敏后的平台、目标主机、请求类型和最终路线，不记录 URL 中的
密钥、请求体或响应凭据。

### 配置兼容性

继续保留现有 `proxy_url`、`proxy_enabled`、`proxy_bypass` 数据库设置和 `PROXY_URL` 环境
变量优先级。增加一个兼容的路由模式设置，用于显式选择 `direct-first`、`proxy-only` 或
`direct-only`；未设置时默认为 `direct-first`。现有 bypass 平台在任何模式下仍不经过代理。

### 请求覆盖范围

除 BaseProvider、embeddings、media 和 Google 图片下载外，目录同步、Premium 授权、
自定义 Provider 模型发现及其他面向外部服务的裸 `fetch` 也改用同一请求入口。数据库备份
的远端 HTTP 访问保留功能，但默认使用直连优先策略。

## 本地运行

- 使用本地 Node.js 运行已构建的服务，不依赖公网 VPS 反向代理。
- 服务监听 `HOST=192.168.1.111`、`PORT=3001`。
- systemd 用户服务清除通用 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 环境变量，避免
  第三方库绕过应用策略；应用代理仅使用 Mihomo 本机端口 `127.0.0.1:7890`。
- WebUI 与 API 同源访问，使用 HTTP，不配置公网域名或 HTTPS。

## 验证与切换

1. 备份 VPS 数据库、WAL/SHM 和运行配置，并在本地复制后校验文件完整性。
2. 先完成单元测试、构建和本地服务启动。
3. 从 `192.168.1.111` 实测各 Provider/API：记录直连成功、直连失败后代理成功、两者
   均失败、鉴权/业务错误和局域网直连结果。
4. 通过浏览器访问 WebUI，并验证 `/api/ping`、登录/API 鉴权和至少一条真实 Provider
   请求。
5. 本地验收完成后停止 VPS 容器 `freellmapi-freellmapi-1`，再次确认 VPS 主机仍在线、
   容器和数据仍存在。

## 验收标准

- `http://192.168.1.111:3001` 可从同一局域网打开 WebUI。
- `/api/ping` 返回成功，前端资源与服务端构建版本一致。
- 直连成功的 Provider 不产生代理请求；直连传输失败的 Provider 能按条件切换代理。
- 局域网、本地 Provider 和国内可直连 API 不绕代理。
- 现有数据库设置、Provider 列表、模型列表和路由优先级未被意外改写。
- VPS 仅停止 FreeLLMAPI 容器，未删除任何 VPS 资源。
