# 设计说明(architecture notes)

代码注释里引用的 `design.md §N` 指的就是这份文档。它只讲"为什么这么设计"和
"哪些约束不能破",实现细节看代码与 `docs/review/01-report-2026-10-19.md` 的风险台账。

## §2 领域模型与端口唯一性

- **机器(servers)**:`relay`(中转入口)/ `landing`(落地)。控制方式 `ssh`(V1 唯一可用)
  或 `agent`(预留)。角色决定凭据形态:relay 有 Reality 密钥对,landing 有共享 Shadowsocks 入站。
- **节点(nodes / xray_nodes)**:一套模板(协议 + TLS 模式 + 传输),凭据加密落库
  (`creds_enc`,AES-256-GCM)。
- **转发规则(port_forwards)**:`entry_server:entry_port → target`,target 可以是
  `port`(裸端口,手工规则)、sing-box 节点或 xray 节点。`auto=1` 表示由拓扑引擎维护。
- **端口唯一性**:同一台机器上的 `(entry_server_id, entry_port)` 唯一;节点监听端口与
  转发入口端口在同一台机器上也互斥(iptables DNAT 会截走该端口的节点流量)。
- **NAT 机器**:`port_allow` 声明可用端口白名单(`32679-32699,30000`)。有白名单时端口
  只能从白名单里取,`1-65535` 视为"不限制"。存量越界端口只告警不改号。
- **一键添加(批量)**:入口机 × 落地节点 的笛卡尔积,先预览后创建;复用一条全链路
  唯一端口,单次上限 50 条。

## §3 部署事务

一次部署 = 采集机器数据 → 渲染配置(纯函数 + golden 快照)→ 下发:

1. **备份**:把现有配置原子备份(`BACKED-UP` / `NO-CONFIG` / `BACKUP-FAILED` 三态);
2. **写配置**:写临时文件再 `install -m 600 && mv -f`(原子替换,不会留半截文件);
3. **reload**:`systemctl reload`,失败则回滚;
4. **校验**:`is-active` 轮询(5×1s)。任一步失败 → `rollback()`,并用同样的轮询
   **确认回滚是否真的成功**;没有备份时记 `rollback-skip`,不谎报成功;
5. **结果**:每一步的成败与输出进 `journal`,进 `deploy_audits` 审计,前端的
   `DeployResultModal` 逐台展示成败与失败原因。

约束:

- **按机器互斥**(`services/locks.ts`):同一台机器上的部署/生命周期/健康检查/证书签发
  串行,排队上限 10 分钟,超时 409 且不会迟到执行;嵌套调用可重入。
- **增量感知**(`pending_deploys`):节点/证书变更 → 标记机器脏;部署成功**只有标记时间
  没变过才清零**(部署期间的新变更不能被一起抹掉)。
- **并发上限 3**:批量部署时同时最多三台机器在跑,避免面板侧 SSH 连接打满。
- **版本回退点**:`install` 覆盖前把旧二进制留成 `<bin>.prev`,`rollback` 动作三路 mv 互换。

## §4 转发引擎

- 两种机制:`socat`(用户态 TCP 转发,容器/无 NET_ADMIN 环境通用,默认)与
  `iptables` DNAT(内核态,性能好,需要 NET_ADMIN)。机器级 `relay_mechanism` 决定。
- **幂等**:socat 用 systemd unit `singray-<ruleId>.service`,iptables 规则注释 tag
  `singray:<ruleId>`;重复下发 = 覆盖,删除按 tag 精确匹配。
- **删除顺序**:先删机器侧,成功才删 DB 行;机器侧失败返回 409 并保留记录
  (否则机器上留下永久孤儿转发)。
- **对账**:比较期望规则与机器现状,`fix=true` 时重新下发缺失项、清理孤儿 unit 与
  iptables 规则(`-S` 输出的 `-A` 换成 `-D` 原样重放)。
- 命令拼装只允许 `shQuote()` 过的值通过,host/name 有白名单正则把关。

## §5 连通性探测

- **手动测速**:面板本机用 `net`/`tls` 直连节点端口(TCP 连接延迟;TLS 类协议再加一次
  握手),不依赖机器上的 `nc`/`openssl`。注意:结论代表"面板到节点"的连通性。
- **自动探测**:定时任务对每个启用节点探测**用户实际会连的入口** —— 若该节点被某条
  `include_in_sub` 的中转规则承载,探的是中转机的 `entry_port`;否则探节点自己所在机器的
  `client_host:listen_port`。结果落 `node_probes`(每节点一行),节点列表展示"通/不通"。
- **健康检查**(`core/healthcheck.ts`):按机器跑 `is-active` 三路信号(核心服务、配置
  校验、端口),状态变化时告警;单机异常不影响本轮其它机器。

## §6 安全边界

- 启动即校验 `PANEL_JWT_SECRET` / `PANEL_APP_SECRET`:默认值/示例占位符直接拒绝启动
  (与 `PANEL_HOST` 无关);管理员口令未设置则随机生成并只打印一次。
- 字段加密用 v2 信封:`v2:` 前缀 + 按用途(`purpose`)分离的密钥 + AAD,密文跨字段搬运
  会认证失败;旧格式密文读到即升级。换 `PANEL_APP_SECRET` = 旧凭据需要重新录入。
- 订阅 `/sub/*` 免鉴权但 slug 即凭据:至少 8 位、`Cache-Control: no-store`、每 IP 限流。
- 会话:JWT 带 `token_version`,改密码后旧 token 立即失效;反代部署需开
  `PANEL_TRUST_PROXY=1`,否则限流会把所有人算成 127.0.0.1。
- 错误响应统一 `{ error, code }`;`code` 是机器可读的(not_found / conflict /
  invalid_credentials / unauthorized …),前端不靠中文文本做控制流。
- **API 命名统一 camelCase**:数据库行是 snake_case,由响应序列化层
  (`core/json.ts` 的 camelize,挂 `preSerialization`)统一转换,所以 `/api/*` 的
  JSON 一律 camelCase;`/sub/*` 与静态资源不受影响。前端再用 zod 契约
  (`apps/web/src/services/contracts.ts`)校验每个 DTO,不符合就抛 `bad_response`
  并指出字段路径 —— 也是"后端改名/漏字段"的早期警报。

## §7 运维

- 备份:`VACUUM INTO` 一致性快照 → 校验可用 → 落盘;每日一次,保留 N 份;
  迁移前另存一份 `<db>.pre-migrate-<时间>.db`。
- 审计:部署结果进 `deploy_audits`,调度任务进 `job_runs`(7 天 / 2000 条),
  告警送达失败写 `alert-error` 而不是谎报成功。
