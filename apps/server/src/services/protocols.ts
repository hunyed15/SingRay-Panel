// "哪些协议能进订阅 / 能中转"的单一事实源。
// 之前这条口径在 4 段 SQL(subs.ts)、拓扑引擎(plan.ts)、一键添加(forwardBatch.ts)
// 里各写一遍,改一处漏一处就会让订阅里混进必然连不通的线路。
//
// 口径:
//  - tunnel:sing-box 的转发构造,不是真实服务
//  - socks / http:没有分享链接,客户端订阅里用不了,中转也没有意义

/** sing-box 侧不进订阅的协议 */
export const NOT_SUBSCRIBABLE_SINGBOX = ['tunnel', 'socks', 'http'] as const;

/** xray 侧不进订阅的协议(没有 tunnel 模板) */
export const NOT_SUBSCRIBABLE_XRAY = ['socks', 'http'] as const;

/** SQL 的 IN 列表只能用字面量拼,统一从这里生成 */
export const sqlList = (items: readonly string[]): string => `(${items.map((i) => `'${i}'`).join(', ')})`;

export const NOT_SUBSCRIBABLE_SINGBOX_SQL = sqlList(NOT_SUBSCRIBABLE_SINGBOX);
export const NOT_SUBSCRIBABLE_XRAY_SQL = sqlList(NOT_SUBSCRIBABLE_XRAY);

/** 中转规则的落地节点不能用这些协议(与订阅口径一致) */
export const NOT_RELAYABLE: ReadonlySet<string> = new Set(NOT_SUBSCRIBABLE_SINGBOX);
