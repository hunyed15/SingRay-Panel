# SingRayPanel

个人自用的双核心(SingBox + Xray)节点管理面板。在一台中心机部署,通过 SSH 集中管理多台 Linux 服务器上的 sing-box 与 Xray-core,完成「服务器管理 → 节点创建 → 配置下发 → 订阅导出」全流程。

SingRayPanel 是 [singbox-panel](https://github.com/hunyed115/singbox-panel)(Siray-Panel)的全新重写:功能全覆盖,针对三个反复出故障的域做了架构级重设计。

## 架构

```
apps/server    Fastify + TypeScript,node:sqlite,ssh2 直连
apps/web       React 19 + antd 6 + Vite
packages/shared 领域类型与 share-link 编解码(前后端共用)
tools/migrate  一次性迁移脚本(读旧库 → 对账)
```

## 三个故障域的重设计

| 故障域 | 旧面板问题 | SingRayPanel 方案 |
|--------|-----------|------------------|
| 配置生成 | JS 对象拼接,非法字段上线才炸(xray `network` 事故) | 17+6 模板纯函数 + golden 快照测试锁死输出格式 |
| 部署 | restart 成功 ≠ 核心活着,部署谎报 OK;SSH 超时硬编码 | 事务状态机:render→upload→verify→backup→swap→restart→**health**;失败自动回滚;超时按 quick/config/install 分级 |
| 端口转发 | iptables 失败静默降级 socat,机器状态与面板认知脱节 | 机制显式选择(iptables/socat systemd unit)+ 创建前预检 + reconcile 对账 |

## 快速开始

```bash
npm install
npm run dev          # server(3000) + web(5173, /api 代理)
npm test             # vitest 全量(含 golden 快照)
npm run typecheck
```

首次启动自动创建管理员(环境变量或默认 admin/admin888,请立即修改):

```bash
PANEL_ADMIN_USER=admin
PANEL_ADMIN_PASSWORD=admin888
# 全新安装示例;迁移场景 PANEL_APP_SECRET 必须等于旧面板 APP_SECRET(见下文迁移说明)
# PANEL_APP_SECRET=<openssl rand -hex 32>
PANEL_DB=./data/panel.db        # SQLite 路径
PANEL_JWT_SECRET=<openssl rand -hex 32>
PANEL_PORT=3000
```

## 从旧面板迁移

```bash
# 对账预演(只读旧库,不写目标)
npm run migrate -- --from /path/to/old/panel.db --to ./data/panel.db --dry-run
# 正式迁移(先启动一次 server 让它建好 schema)
npm run migrate -- --from /path/to/old/panel.db --to ./data/panel.db
```

- **密钥要求**:字段加密密钥由 `PANEL_APP_SECRET` 控制,**必须设为旧面板的 `APP_SECRET`**(旧库凭据用它加密;不匹配会解密失败)。`PANEL_JWT_SECRET` 是登录 token 密钥,可自由生成
- 密文格式兼容(AES-256-GCM,`base64(iv).base64(tag|data)`),密钥对上即可解,无需重新加密
- 旧端口转发规则无机制字段,迁移后默认 `iptables`,建议在各入口机执行一次「对账」核对

## 部署到生产

服务器上需要 Node.js >= 22(开发机 24 验证)。建议 systemd 托管 server,前端 `npm run build` 后由 nginx 静态托管并反代 `/api`。

订阅端点(公开,slug 混淆,首次启动自动生成于 settings 表):
- SingBox 客户端: `GET /sub/<slug>`(UA 自动分派 base64/singbox JSON,或 `?format=` 指定)
- Xray/通用客户端: `GET /sub/xray/<slug>`

## API 一览

认证 `POST /api/auth/login`、`GET /api/auth/me`、`PUT /api/auth/account`;
服务器 `GET|POST /api/servers`、`PUT|DELETE /api/servers/:id`、`POST /api/servers/:id/test`;
节点 `GET|POST /api/nodes`、`PUT|DELETE /api/nodes/:id`、`POST /api/nodes/:id/toggle`(+ `/api/xray/nodes` 同构,含 `purge`);
中转 `GET|POST /api/port-forwards`、`DELETE /api/port-forwards/:id`、`POST /api/port-forwards/preflight`、`POST /api/port-forwards/reconcile`;
部署 `POST /api/deploy/all`、`POST /api/deploy/:id`;
测速 `POST /api/test/nodes/:id`、`POST /api/test/xray-nodes/:id`;
设置 `GET|PUT /api/settings`、SNI 库 `/api/snis`。

除 `/health`、`/api/auth/login`、`/sub/*` 外均需 `Authorization: Bearer <token>`。

## 设计文档

- 前序 PRD 与经验: singbox-panel 仓库 `.trellis/tasks/archive/2026-09/09-11-siray-replan/`
- 本仓库任务规划: singbox-panel 仓库 `.trellis/tasks/09-12-singray-rewrite/`(prd/design/implement)
