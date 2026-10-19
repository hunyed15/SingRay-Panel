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
- **事务化部署**：渲染 → 上传 → 核心校验 → 备份 → 原子替换 → 重启 → **健康检查**；失败会回滚并**重新校验回滚结果**，没有旧配置可回滚时如实报告「未回滚」，失败详情（逐步状态 + 核心日志）在界面可见——部署不会"谎报成功"
- **备份**：`VACUUM INTO` 一致性快照（含 WAL 已提交数据）→ 校验可打开 → 原子改名落盘，失败不留残留文件、也不会让当天跳过重试；按份数自动清理
- 单机部署 / 一键部署全部（并发 ≤3，逐机结果展示）
- **核心生命周期**：安装（GitHub 下载 + gh-proxy 镜像兜底）/ 重启 / 卸载
- SSH 命令超时按 quick / config / install 分级，跳板链路自动放宽

### 中转（端口转发）
- 入口机端口 → 落地机节点端口，**socat（默认，容器环境通用）与 iptables DNAT（v4/v6 自动识别）双机制显式选择**
- 创建前预检（ip_forward、防火墙、端口占用），规则带标签，**reconcile 一键对账**机器实际规则与数据库
- 中转线路可一键加入订阅
- **自动中转拓扑**：节点/机器变更后自动在中转机上生成转发规则（IPv6-only 落地机经双栈机两跳），全链路复用同一端口，防抖自动同步
- **NAT 机器可用端口白名单**：服务器上填 `32679-32699,30000`（端口段与单端口混写），该机的节点监听端口、以及它作为中转入口的端口都只从这里分配；拓扑引擎对「白名单不含该端口」的中转直接跳过并给出原因，存量越界端口只告警、**绝不悄悄改号**
- **一键添加中转规则**：入口机（可多选）× 落地节点（可多选/全选）→ 预览端口分配（白名单内、全局唯一）→ 批量创建，逐条汇报跳过原因与失败项

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
cp .env.example .env    # 必须把两个密钥改成真实随机值,否则拒绝启动
npm run dev             # server(3000) + web(5173);会自动加载仓库根的 .env
npm test                # vitest 全量(含 golden 快照)
```

`.env` 会被服务端自动加载（已存在的环境变量优先，等价于 systemd `EnvironmentFile` 的行为）。
`PANEL_JWT_SECRET` / `PANEL_APP_SECRET` 仍是默认值或 `.env.example` 的占位符时，**进程直接拒绝启动**——这条守卫与监听地址无关（nginx 反代到 `127.0.0.1` 同样要求），因为用默认串可以离线伪造管理员令牌。

首次启动自动创建管理员。`PANEL_ADMIN_PASSWORD` **留空则随机生成 16 位口令并只打印一次**（不再有 `admin888` 这类默认口令，登录后请立即修改）。

### 生产部署

```bash
npm ci && npm run build
```

1. **环境变量**（systemd EnvironmentFile 或 .env）：

| 变量 | 说明 |
|------|------|
| `PANEL_DB` | SQLite 路径（默认 `./data/panel.db`）|
| `PANEL_HOST` | 监听地址（默认 `127.0.0.1`；反代部署保持默认即可）|
| `PANEL_PORT` | 监听端口（默认 3000）|
| `PANEL_JWT_SECRET` | 登录令牌密钥，`openssl rand -hex 32`；**默认值/示例占位符一律拒绝启动** |
| `PANEL_APP_SECRET` | 字段加密密钥，`openssl rand -hex 32`（可与 JWT 不同；一旦变更，已加密的凭据需要重新录入）|
| `PANEL_ADMIN_USER` / `PANEL_ADMIN_PASSWORD` | 初始管理员（仅首次创建时使用）；口令留空 = 随机生成并打印一次 |

可选变量：`PANEL_BACKUP_DIR`（备份目录，空 = 数据库同目录 `backups/`）、`PANEL_BACKUP_RETENTION`（保留份数，默认 14）、`PANEL_BACKUP_HOUR`（每日备份小时，默认 4）、`PANEL_HEALTH_INTERVAL`（健康检查间隔分钟，默认 5）、`PANEL_CF_TOKEN`（Cloudflare Token → 证书走 DNS-01）、`TG_BOT_TOKEN` / `TG_CHAT_ID`（告警）、`PANEL_ENV_FILE`（自定义 .env 路径）、`SINGBOX_VERSION` / `XRAY_VERSION`（缺省 `latest`）。

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
中转 `GET|POST /api/port-forwards` · `PUT|DELETE /api/port-forwards/:id` · `POST /api/port-forwards/preflight` · `POST /api/port-forwards/reconcile` · `POST /api/port-forwards/batch/preview|batch`；
部署 `POST /api/deploy/all` · `POST /api/deploy/:id`；
测速 `POST /api/test/nodes/:id` · `POST /api/test/xray-nodes/:id`；
设置 `GET|PUT /api/settings`、SNI 库 `/api/snis`。
