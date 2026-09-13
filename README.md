# SingRayPanel

个人自用的**双核心（SingBox + Xray）节点管理面板**：在一台中心服务器上部署，通过 SSH 集中管理多台 Linux 机器上运行的 sing-box 与 Xray-core，在 Web 界面完成「服务器管理 → 节点创建 → 配置下发 → 中转编排 → 订阅导出」全流程。

单管理员、纯自用设计：没有多用户、计费、流量统计这些包袱；所有敏感数据（节点凭据、SSH 私钥）AES-256-GCM 加密落库。

## 功能

### 服务器与连接
- SSH 机器增删改查，密钥/密码双认证，sudo 提权（甲骨文等仅给普通用户的机器）
- **SSH 跳板机（ProxyJump）**：本地无 IPv6 或直连不稳时，经指定机器隧道连接目标
- 批量探活与连通性测试

### 节点管理（双核心）
- **SingBox**：VLESS+Reality、VMess+WS+TLS、Trojan、SS2022、Hysteria2、TUIC、ShadowTLS、Naive、SOCKS、HTTP、Tunnel
- **Xray**：VLESS+Reality、VMess+WS+TLS、Trojan、Shadowsocks、SOCKS、HTTP
- 模板制创建：端口分配、凭据、Reality 密钥对、自签证书全部自动生成
- **一键批量添加**：按机器勾选模板批量建节点，同名自动跳过
- Reality SNI 域名库（带实测可用性标注）
- 节点测速（TCP / TLS 握手延迟）

### 配置下发
- **事务化部署**：渲染 → 上传 → 核心校验 → 备份 → 原子替换 → 重启 → **健康检查**；任一步失败自动回滚并采集核心日志——部署永远不会"谎报成功"
- 单机部署 / 一键部署全部（并发 ≤3，逐机结果展示）
- **核心生命周期**：安装（GitHub 下载 + gh-proxy 镜像兜底）/ 重启 / 卸载
- SSH 命令超时按 quick / config / install 分级，跳板链路自动放宽

### 中转（端口转发）
- 入口机端口 → 落地机节点端口，**socat（默认，容器环境通用）与 iptables DNAT（v4/v6 自动识别）双机制显式选择**
- 创建前预检（ip_forward、防火墙、端口占用），规则带标签，**reconcile 一键对账**机器实际规则与数据库
- 中转线路可一键加入订阅

### 证书管理
- ACME（Let's Encrypt）证书签发/续期/删除，acme.sh 自动续期并重载核心
- 部署自动优先使用真证书；vmess/trojan 等需要证书的协议在新版 Xray（已移除 allowInsecure）下正常工作

### 订阅导出
- **自适应订阅**（`/sub/<slug>`）：按客户端 UA 自动分发——sing-box 系 → JSON，Clash/mihomo 系 → YAML，其余 → base64 链接
- 专用端点：`/sub/singbox/<slug>`（恒 sing-box JSON）、`/sub/xray/<slug>`（恒 base64）
- 中转线路可加入订阅；Reality 节点地址支持 IP / 域名切换（绕开慢 DNS）
- 密码等特殊字符全量 URL 编码，订阅格式经解析器验证

## 架构

```
apps/server     Fastify + TypeScript + node:sqlite（零原生依赖）
apps/web        React 19 + antd 6 + Vite
packages/shared 领域类型（前后端共用）
tools/migrate   SQLite 迁移工具（行数对账报告）
```

设计原则：配置生成为**纯函数 + golden 快照测试**（17 + 6 模板输出格式锁死）；部署为**事务状态机**；机器状态与面板认知可通过**对账**消除漂移。

## 安装

### 本地开发

```bash
git clone https://github.com/hunyed115/SingRay-Panel.git
cd SingRayPanel
npm install
cp .env.example .env    # 修改密钥
npm run dev             # server(3000) + web(5173)
npm test                # vitest 全量(含 golden 快照)
```

首次启动自动创建管理员（`PANEL_ADMIN_USER` / `PANEL_ADMIN_PASSWORD`，默认 admin/admin888，请立即修改）。

### 生产部署

```bash
npm ci && npm run build
```

1. **环境变量**（systemd EnvironmentFile 或 .env）：

| 变量 | 说明 |
|------|------|
| `PANEL_DB` | SQLite 路径（默认 `./data/panel.db`）|
| `PANEL_HOST` | 监听地址；`0.0.0.0` 时必须配置下方两个密钥（否则拒绝启动）|
| `PANEL_PORT` | 监听端口（默认 3000）|
| `PANEL_JWT_SECRET` | 登录令牌密钥，`openssl rand -hex 32` |
| `PANEL_APP_SECRET` | 字段加密密钥，与 JWT 可不同，`openssl rand -hex 32` |
| `PANEL_ADMIN_USER` / `PANEL_ADMIN_PASSWORD` | 初始管理员（仅首次创建时使用）|

2. **systemd**（`EnvironmentFile` 指向上面的 env 文件）：

```ini
[Service]
EnvironmentFile=/etc/singray/panel.env
WorkingDirectory=/opt/singray
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
```

3. **nginx**（推荐）：托管 `apps/web/dist`，`/api` 与 `/sub` 反代 `127.0.0.1:3000`，配 443 证书。

### 数据迁移（从其他面板）

`tools/migrate` 支持从旧面板 SQLite 导入：只读源库、逐表映射、输出**行数对账报告**（非零差异退出码 1）：

```bash
npm run migrate -- --from <旧库路径> --to ./data/panel.db --dry-run   # 对账预演
npm run migrate -- --from <旧库路径> --to ./data/panel.db             # 正式迁移
```

注意：旧面板凭据以 `APP_SECRET` 加密，迁移后 `PANEL_APP_SECRET` 必须设置为旧值。

## 订阅端点

| 地址 | 格式 |
|------|------|
| `/sub/<slug>` | 自适应（UA 分派：sing-box → JSON，Clash/mihomo → YAML，其余 → base64）|
| `/sub/singbox/<slug>` | sing-box 配置 JSON |
| `/sub/xray/<slug>` | base64 分享链接 |

除 `/health`、`/api/auth/login`、`/sub/*` 外均需 `Authorization: Bearer <token>`。

## API 一览

认证 `POST /api/auth/login` · `GET /api/auth/me` · `PUT /api/auth/account`；
服务器 `GET|POST /api/servers` · `PUT|DELETE /api/servers/:id` · `POST /api/servers/:id/test` · `POST /api/servers/:id/install|restart|uninstall` · `POST /api/servers/:id/xray-<action>` · `POST /api/servers/:id/batch-nodes` · `GET /api/servers/:id/cert-status` · `POST /api/servers/:id/issue-cert` · `GET /api/servers/certs`；
节点 `GET|POST /api/nodes` · `GET|PUT|DELETE /api/nodes/:id` · `POST /api/nodes/:id/toggle` · `POST /api/nodes/:id/test`（`/api/xray/nodes` 同构，含 `purge`）；
中转 `GET|POST /api/port-forwards` · `PUT|DELETE /api/port-forwards/:id` · `POST /api/port-forwards/preflight` · `POST /api/port-forwards/reconcile`；
部署 `POST /api/deploy/all` · `POST /api/deploy/:id`；
测速 `POST /api/test/nodes/:id` · `POST /api/test/xray-nodes/:id`；
设置 `GET|PUT /api/settings`、SNI 库 `/api/snis`。
