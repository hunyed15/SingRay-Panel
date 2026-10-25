# SingRay Panel

一台中心服务器上的 **sing-box + Xray 双核心节点管理面板**。通过 SSH 集中管理多台 Linux 机器，在 Web 界面完成「加机器 → 建节点 → 下发配置 → 编排中转 → 导出订阅」。

单管理员、自用向：没有多用户、计费、流量统计。节点凭据、SSH 私钥全部 AES-256-GCM 加密落库。

## 功能

**机器管理**
- SSH 密钥或密码登录，可选 sudo 提权（仅给普通用户的机器如甲骨文也能用）
- 跳板机（ProxyJump）：本地没 IPv6 或直连不稳时经指定机器中转
- 批量探活、连通性测试

**节点（双核心）**
- sing-box 10 个模板：VLESS+Reality、VMess+WS+TLS、AnyTLS、Hysteria2、TUIC、ShadowTLS、Naive、SOCKS、HTTP、Tunnel
- Xray 5 个模板：VLESS+Reality、VMess+WS+TLS、VLESS+XHTTP、SOCKS、HTTP
- 端口、UUID、Reality 密钥对、自签证书全部自动生成
- 一键批量添加：勾选机器 × 模板批量建节点，同名自动跳过
- Reality SNI 域名库（标注实测可用性）、节点 TCP/TLS 延迟测速
- 定时可用性探测：自动探「实际入口」（走中转的探中转入口端口），节点列表直接显示通/不通

**配置下发**
- 事务化部署：渲染 → 上传 → 核心校验 → 备份 → 原子替换 → 重启 → 健康检查；失败自动回滚，并**重新校验回滚结果**，没有旧配置时如实报告「未回滚」，不再谎报成功
- 部署过程逐步可见（含核心日志），单机部署或全部并发部署（并发 ≤3）
- 核心生命周期：安装 / 重启 / 卸载 / **回退版本**（安装前自动保留上一份二进制）

**中转（端口转发）**
- 入口机端口 → 落地机节点端口，socat（默认，容器可用）或 iptables DNAT（自动识别 v4/v6）
- 创建前预检（ip_forward、防火墙、端口占用），规则带标签，一键对账机器与数据库的差异并可一键修复
- 自动中转拓扑：节点/机器变更后自动在中转机生成转发（IPv6-only 落地经双栈机两跳），全链路复用同一端口
- **NAT 机器端口白名单**：填 `32679-32699,30000` 后，该机节点端口和它作为中转入口的端口都只从这里分配；越界的存量端口只告警，不会悄悄改号
- 一键添加中转规则：入口机 × 落地节点 → 预览端口 → 批量创建，逐条汇报跳过原因

**证书**
- ACME（Let's Encrypt）签发 / 续期 / 删除，acme.sh 自动续期并重载核心
- 支持 Cloudflare Token 走 DNS-01；部署优先用真证书

**订阅**
- 自适应订阅：按 UA 自动分派（sing-box → JSON，Clash/mihomo → YAML，其他 → base64）
- 专用端点恒为单一格式；中转线路可加入订阅；Reality 地址支持 IP/域名切换

## 安装

需要 **Node.js 22+**（用 `node:sqlite`，无原生依赖；推荐 24）。

### 本地开发

```bash
git clone https://github.com/hunyed15/SingRay-Panel.git
cd SingRay-Panel
npm install
cp .env.example .env     # 把两个密钥换成随机值,否则拒绝启动
npm run dev              # 后端 3000,前端 5173;自动加载仓库根的 .env
```

首次启动自动建管理员。`PANEL_ADMIN_PASSWORD` 留空则**随机生成 16 位口令并只打印一次**（日志里找）。

常用命令：

```bash
npm test            # server + web + migrate
npm run lint
npm run typecheck
npm run build
npm run restore -- <备份文件>   # 从备份恢复数据库(先停面板)
```

### 生产部署

```bash
git clone https://github.com/hunyed15/SingRay-Panel.git /opt/singray
cd /opt/singray && npm ci && npm run build
```

**必填环境变量**（`/etc/singray/panel.env`，或用仓库根的 `.env`）：

| 变量 | 说明 |
|---|---|
| `PANEL_JWT_SECRET` | 登录令牌密钥，`openssl rand -hex 32`。**仍是默认值/占位符时进程拒绝启动** |
| `PANEL_APP_SECRET` | 字段加密密钥，`openssl rand -hex 32`。**换掉它，已存的凭据与 Token 就解不开了** |
| `PANEL_ADMIN_USER` / `PANEL_ADMIN_PASSWORD` | 初始管理员，仅首次创建时生效；口令留空 = 随机生成 |

**可选**：`PANEL_DB`（默认 `./data/panel.db`）、`PANEL_HOST`（默认 `127.0.0.1`）、`PANEL_PORT`（默认 3000）、`PANEL_BACKUP_DIR` / `PANEL_BACKUP_RETENTION` / `PANEL_BACKUP_HOUR`（备份目录 / 保留 14 份 / 每日 4 点）、`PANEL_HEALTH_INTERVAL`（分钟，默认 5）、`PANEL_PROBE_INTERVAL`（分钟，默认 30，0 = 关）、`PANEL_TRUST_PROXY`（反代后设 1，否则留空）、`PANEL_CF_TOKEN`（云flare DNS-01）、`TG_BOT_TOKEN` / `TG_CHAT_ID`（告警）、`SINGBOX_VERSION` / `XRAY_VERSION`（默认固定 `1.13.18` / `24.11.30`，写 `latest` 才跟上游最新）。

**systemd**（`/etc/systemd/system/singray.service`）：

```ini
[Service]
EnvironmentFile=/etc/singray/panel.env
WorkingDirectory=/opt/singray
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
```

**nginx**（推荐）：托管 `apps/web/dist`，`/api` 与 `/sub` 反代到 `127.0.0.1:3000`，配 443 证书。

```bash
sudo systemctl enable --now singray
curl -s http://127.0.0.1:3000/health    # 200 即启动成功
```

### 升级与回滚

见 [docs/upgrade.md](docs/upgrade.md)：升级前备份、只读预检、升级步骤、回滚（代码 / 数据 / 核心四象限）、本版破坏性变更。

### 从旧面板迁移数据

```bash
npm run migrate -- --from <旧库路径> --to ./data/panel.db --dry-run   # 先对账
npm run migrate -- --from <旧库路径> --to ./data/panel.db
```

旧库凭据用旧面板的 `APP_SECRET` 加密，迁移后 `PANEL_APP_SECRET` 必须设为同一个值。

## 订阅端点

| 地址 | 格式 |
|---|---|
| `/sub/<slug>` | 按 UA 分派：sing-box → JSON，Clash/mihomo → YAML，其他 → base64 |
| `/sub/singbox/<slug>` | sing-box JSON |
| `/sub/xray/<slug>` | base64 分享链接 |

除 `/health`、`/api/auth/login`、`/sub/*` 外都需要 `Authorization: Bearer <token>`。

## 文档

- [docs/upgrade.md](docs/upgrade.md) — 升级与回滚
- [docs/design.md](docs/design.md) — 架构与设计取舍
- [docs/review/01-report-2026-10-19.md](docs/review/01-report-2026-10-19.md) — 代码审查发现与处理记录
