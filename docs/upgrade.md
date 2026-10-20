# 升级运行手册(面板自身 + 机器上的核心)

这份是给**你自己执行**的:依次复制命令、核对每一步的输出。
不建议把 SSH 口令/私钥贴进对话——聊天记录会留在日志里,而且我无法在失败时帮你回滚
（我看不到服务状态,也不知道你那台机器上还有什么在跑）。

要我在旁边看着走,最好的方式是:先跑 §0 和 §1(只读),把输出贴回来,我按你的实际环境
把后面的命令改成可直接粘贴的版本。

---

## §0 先做退路(5 分钟,别跳过)

```bash
# 0.1 面板数据库备份(在面板目录下执行;也可以在界面上点「立即备份」)
curl -s -X POST http://127.0.0.1:3000/api/system/backup -H "Authorization: Bearer $TOKEN"
ls -lh data/backups/                 # 记下最新那个 panel-YYYYMMDD-HHMMSS.db

# 0.2 代码现状(升级前的 commit,回滚要用)
cd /path/to/SingRay && git rev-parse HEAD && git status --short
```

> 数据迁移会在面板启动时自动执行,并且**升级前会自动留一份
> `panel.db.pre-migrate-<时间>.db`**(本轮新增)。真要回滚数据:
> 停面板 → `npm run restore -- <备份文件>` → 启动。

---

## §1 只读预检(不改任何东西)

```bash
node -v ; npm -v                      # 需要 Node 22+(node:sqlite);推荐 24
git -C /path/to/SingRay log --oneline -1
systemctl list-units --type=service | grep -i singray     # 找到面板服务名,记作 $SERVICE
systemctl status "$SERVICE" --no-pager | head -5
curl -s http://127.0.0.1:3000/health                      # 升级前必须 200
grep -E '^(PANEL_|SINGBOX_|XRAY_)' /path/to/SingRay/.env | sed 's/=.*/=***/'   # 只看键名
/usr/local/bin/sing-box version 2>/dev/null | head -2
/usr/local/bin/xray version 2>/dev/null | head -2
```

把 §1 的输出贴回来,我会告诉你:能不能直接升、核心版本要不要跟着动、以及你的
`$SERVICE`/`.env` 路径对应的确切命令。

---

## §2 升级面板

```bash
cd /path/to/SingRay
git pull --ff-only                     # 有本地改动会失败,先把 git status 的改动处理掉
npm ci                                 # 依赖已精确锁定,用 ci 而不是 install
npm run lint && npm run typecheck && npm test && npm run build
sudo systemctl restart "$SERVICE"
sleep 3
curl -s http://127.0.0.1:3000/health   # 仍然 200 才算过
journalctl -u "$SERVICE" -n 40 --no-pager   # 有 "拒绝启动"/"migration ... failed" 就停下
```

⚠️ 前端是 `npm run build` 产物:如果你的静态文件由 nginx 直接托管,确认它指向的
`apps/web/dist` 已经是新的(或按你原来的部署方式同步一次)。

---

## §3 机器上的核心二进制(可选,只有想升级时才做)

面板**不会**因为你自己升级面板而改动机器上的核心。要升级:

1. 界面 → 服务器 → 某台机「管理 → 安装」:
   现在默认装**固定版本** `1.13.18`(sing-box)/ `24.11.30`(xray);
   想装最新版,先在面板 `.env` 里设 `SINGBOX_VERSION=latest` / `XRAY_VERSION=latest` 再重启面板。
2. 装完如果核心起不来:同一菜单「管理 → 回退版本」——会换回安装前留下的
   `<bin>.prev` 并重启(本轮新增)。
3. 每台机器装完,看节点列表新的「探测」列是否变「通」;要立刻重探:
   ```bash
   curl -s -X POST http://127.0.0.1:3000/api/test/probe-all -H "Authorization: Bearer $TOKEN"
   ```

---

## §4 回滚

| 什么坏了 | 怎么做 |
|---|---|
| 面板起不来(代码) | `git checkout <§0 记下的 commit>` → `npm ci && npm run build` → 重启服务 |
| 面板起不来(数据/迁移) | 停服务 → `npm run restore -- data/backups/<备份文件>` → 启动 |
| 机器上的核心跑不起来 | 界面「管理 → 回退版本」 |
| 外部脚本读不到字段 | 见 §5 的破坏性变更,把脚本字段名改成 camelCase |

---

## §5 这次升级的破坏性变更(务必先看)

1. **`/api/*` 的 JSON 字段名从 snake_case 改成 camelCase**
   （`ip_stack → ipStack`、`listen_port → listenPort`、`entry_device` 类的都没有了，
   `entry_server_id → entryServerId` 等）。**任何自己写的脚本/监控/备份脚本读 API 的地方都要改**。
   写接口入参本来就是 camelCase，不受影响；`/sub/*` 订阅地址完全不受影响。
2. **错误响应多了 `code`**：`{ error, code }`。只读 `error` 的代码不会坏。
3. **改服务器角色需要确认**：不带 `confirmRotateCredentials: true` 会返回 400（界面已处理）。
4. **删节点/删服务器会先清理机器侧的转发规则**：删节点时机器侧清不掉 → 409 且节点保留。
5. **订阅 slug 至少 8 位**（已有的短 slug 仍可用，只是不能再改成更短的）。
6. **`/sub` 加了 `Cache-Control: no-store` 与限流**（每 IP 120/分钟）。
7. **核心版本默认固定**（见 §3），不再是 `latest`。
