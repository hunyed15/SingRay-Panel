// 端口分配与唯一性校验(移植自旧 ports.js,同时覆盖 nodes/xray_nodes 两张表)
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';

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
