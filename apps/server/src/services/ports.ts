// 端口分配与唯一性校验(移植自旧 ports.js,同时覆盖 nodes/xray_nodes 两张表)
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';
import { parsePortAllow, containsPort, describePortRanges, type PortRange } from './portAllow.js';

/** 常见代理/Web 端口黑名单(避免明显指纹),其余全随机 */
const AVOID = new Set([
  21, 22, 23, 25, 53, 80, 81, 110, 143, 443, 465, 587, 853, 1080, 1194, 1433, 1521, 3306, 3389,
  5432, 6379, 8080, 8081, 8443, 8888, 9090, 10808, 10809,
]);

/** 完全随机分配端口(默认 20000-65000,避开已用与常见端口,防 GFW 按顺序规律封) */
export function randomFreePort(usedPorts: number[], min = 20000, max = 65000): number {
  const used = new Set(usedPorts);
  for (let i = 0; i < 500; i++) {
    const p = min + Math.floor(Math.random() * (max - min + 1));
    if (!used.has(p) && !AVOID.has(p)) return p;
  }
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !AVOID.has(p)) return p;
  }
  return min;
}

export interface PortCheckOpts {
  /** 编辑时排除自身(只对 selfTable 生效,避免误排除另一张表同 id 行) */
  selfTable?: 'nodes' | 'xray_nodes';
  excludeNodeId?: number;
}

/** 同机端口唯一校验:nodes 与 xray_nodes 都查(旧版 xray 只查 nodes,同表冲突会落到 sqlite UNIQUE 报 500,这里统一返回 409) */
export function assertPortFree(
  db: DatabaseSync,
  serverId: number,
  port: number,
  opts: PortCheckOpts = {},
): void {
  for (const table of ['nodes', 'xray_nodes'] as const) {
    const exclude =
      opts.selfTable === table && opts.excludeNodeId !== undefined ? opts.excludeNodeId : -1;
    const row = db
      .prepare(`SELECT id FROM ${table} WHERE server_id = ? AND listen_port = ? AND id != ?`)
      .get(serverId, port, exclude);
    if (row) throw new HttpError(409, `端口 ${port} 已被该机器上其他节点占用`);
  }
}

/**
 * 全局已用端口:所有机器的节点端口 + 所有转发规则的入口/目标端口。
 * 拓扑引擎要求节点端口跨机唯一(整条中转链路复用同一端口号),故分配时必须全局去重。
 */
export function globallyUsedPorts(db: DatabaseSync): number[] {
  const rows = db
    .prepare(
      `SELECT listen_port AS p FROM nodes
       UNION SELECT listen_port AS p FROM xray_nodes
       UNION SELECT entry_port AS p FROM port_forwards
       UNION SELECT target_port AS p FROM port_forwards`,
    )
    .all() as { p: number }[];
  return rows.map((r) => r.p);
}

// ---------- 机器可用端口白名单(NAT 场景) ----------
// NAT 机器的公网端口段由服务商映射,只有其中端口可用。白名单同时约束:
//   1) 该机上节点的监听端口;2) 该机作为中转入口时的入口端口。

/** 机器可用端口区间;空数组 = 不限制(写入时已校验格式,读到的脏数据按不限制处理) */
export function serverPortRanges(db: DatabaseSync, serverId: number): PortRange[] {
  const row = db.prepare('SELECT port_allow FROM servers WHERE id = ?').get(serverId) as
    | { port_allow: string }
    | undefined;
  return parsePortAllow(row?.port_allow ?? '').ranges;
}

export function isPortAllowedOnServer(db: DatabaseSync, serverId: number, port: number): boolean {
  const ranges = serverPortRanges(db, serverId);
  return ranges.length === 0 || containsPort(ranges, port);
}

/** 手填端口越界 → 400,并列出该机可用端口(比「端口冲突」更早暴露配置错误) */
export function assertPortAllowedOnServer(db: DatabaseSync, serverId: number, port: number, who = '该机器'): void {
  const ranges = serverPortRanges(db, serverId);
  if (ranges.length === 0 || containsPort(ranges, port)) return;
  throw new HttpError(400, `${who}的可用端口白名单不含 ${port}(可用端口:${describePortRanges(ranges)})`);
}

/** 白名单内最小可用端口;无可用返回 null */
export function pickPortFromRanges(usedPorts: number[], ranges: PortRange[]): number | null {
  const used = new Set(usedPorts);
  for (const r of ranges) {
    for (let p = r.start; p <= r.end; p++) {
      if (!used.has(p)) return p;
    }
  }
  return null;
}

/**
 * 为某台机器分配端口。
 * 无白名单 → 保持原有「全局随机」策略(避免按序分配被按规律封端口);
 * 有白名单 → 取白名单内最小可用端口:端口段通常很小,确定性分配让「一键添加」的
 * 预览端口与实际创建端口一致。
 */
export function allocatePortForServer(db: DatabaseSync, serverId: number): number {
  const ranges = serverPortRanges(db, serverId);
  const used = globallyUsedPorts(db);
  if (ranges.length === 0) return randomFreePort(used);
  const port = pickPortFromRanges(used, ranges);
  if (port === null) {
    throw new HttpError(
      400,
      `该机器的可用端口已用尽(白名单 ${describePortRanges(ranges)},这些端口已被其他节点/规则占用)`,
    );
  }
  return port;
}
