// 端口分配与唯一性校验(移植自旧 ports.js,同时覆盖 nodes/xray_nodes 两张表)
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomInt } from 'node:crypto';
import { HttpError } from './errors.js';
import { parsePortAllow, containsPort, describePortRanges, expandRanges, portAllowCount, type PortRange } from './portAllow.js';

/** 随机/派生分配的范围 */
const PORT_MIN = 20000;
const PORT_MAX = 65000;

/** 常见代理/Web 端口黑名单(避免明显指纹),其余全随机 */
const AVOID = new Set([
  21, 22, 23, 25, 53, 80, 81, 110, 143, 443, 465, 587, 853, 1080, 1194, 1433, 1521, 3306, 3389,
  5432, 6379, 8080, 8081, 8443, 8888, 9090, 10808, 10809,
]);

/** 完全随机分配端口(默认 20000-65000,避开已用与常见端口,防 GFW 按顺序规律封) */
export function randomFreePort(usedPorts: number[], min = PORT_MIN, max = PORT_MAX): number {
  const used = new Set(usedPorts);
  for (let i = 0; i < 500; i++) {
    const p = randomInt(min, max + 1); // CSPRNG:端口就是对外指纹,不该可预测
    if (!used.has(p) && !AVOID.has(p)) return p;
  }
  for (let p = min; p <= max; p++) {
    if (!used.has(p) && !AVOID.has(p)) return p;
  }
  return min;
}

/**
 * 确定性端口分配:用 seed 派生起点,再顺序找空位。
 * 「一键添加」的预览与创建是两次独立请求,共用同一个 seed 与同一份 DB 快照
 * 才能得到同一批端口(旧实现两次都调 Math.random,预览报的端口和实际创建的必然不同)。
 * 仍然避开 AVOID 黑名单,并且不取全局最小端口 —— 保留"不按顺序分配"的性质。
 */
export function pickPortDerived(usedPorts: number[], seed: string, min = PORT_MIN, max = PORT_MAX): number {
  const used = new Set(usedPorts);
  const span = max - min + 1;
  const hash = createHash('sha256').update(seed).digest();
  const start = min + (hash.readUInt32BE(0) % span);
  for (let i = 0; i < span; i++) {
    const p = min + ((start - min + i) % span);
    if (!used.has(p) && !AVOID.has(p)) return p;
  }
  return randomFreePort([...used], min, max);
}

/**
 * 端口被谁占用。端口号在全链路是**共享标识**(中转机要复用同一个端口号),
 * 所以"白名单被占满"往往不是这台机器的问题 —— 报错必须指出占用方。
 */
export function describePortHolders(db: DatabaseSync, ports: number[], limit = 3): string {
  const out: string[] = [];
  for (const p of ports.slice(0, limit)) {
    const node = db
      .prepare(
        `SELECT s.name AS name FROM servers s WHERE s.id IN (
           SELECT server_id FROM nodes WHERE listen_port = ?
           UNION SELECT server_id FROM xray_nodes WHERE listen_port = ?) LIMIT 1`,
      )
      .get(p, p) as { name: string } | undefined;
    if (node) {
      out.push(`${p}(${node.name} 的节点)`);
      continue;
    }
    const rule = db
      .prepare('SELECT s.name AS name FROM port_forwards f JOIN servers s ON s.id = f.entry_server_id WHERE f.entry_port = ? LIMIT 1')
      .get(p) as { name: string } | undefined;
    if (rule) out.push(`${p}(${rule.name} 的中转规则)`);
  }
  return out.join('、');
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
  // 该机的转发规则入口端口:iptables DNAT 会把这个端口上的流量整段截走,
  // 节点与入口端口同号 = 节点流量被静默改道
  const rule = db
    .prepare('SELECT id FROM port_forwards WHERE entry_server_id = ? AND entry_port = ?')
    .get(serverId, port) as { id: number } | undefined;
  if (rule) throw new HttpError(409, `端口 ${port} 已被该机器上的中转规则占用(入口端口)`);
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
  const ranges = parsePortAllow(row?.port_allow ?? '').ranges;
  // 填 `1-65535` 的本意是"不限制":按白名单走会从端口 1 开始分配,还把 AVOID 黑名单整体旁路
  return portAllowCount(ranges) >= 60000 ? [] : ranges;
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
 * 有白名单 → 取白名单内最小可用端口(端口段很小,确定性分配让预览=创建);
 * 无白名单 → 用 seed 派生的确定性随机(同 seed 同结果,仍不按顺序分配)。
 */
export function allocatePortForServer(db: DatabaseSync, serverId: number, seed?: string): number {
  const ranges = serverPortRanges(db, serverId);
  const used = globallyUsedPorts(db);
  if (ranges.length === 0) return pickPortDerived(used, seed ?? `server:${serverId}`);
  const port = pickPortFromRanges(used, ranges);
  if (port === null) {
    const expanded = expandRanges(ranges);
    const holders = expanded ? describePortHolders(db, expanded) : '';
    throw new HttpError(
      400,
      `该机器的可用端口已用尽(白名单 ${describePortRanges(ranges)})` +
        (holders ? `:${holders} 已占用 —— 端口号在全链路共享,别的机器占了同一端口号也用不了` : ''),
    );
  }
  return port;
}
