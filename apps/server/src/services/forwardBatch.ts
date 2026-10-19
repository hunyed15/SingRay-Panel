// 中转规则「一键添加」:入口机(可多台)× 落地节点(可多选)→ 预览端口分配 → 批量创建。
//
// 与单条创建走完全相同的落库/下发语义(socat 或 iptables,由机制显式决定),
// 区别只在:端口从入口机的可用端口白名单里取、逐条给出跳过原因、机器侧失败回滚该条。
//
// 端口分配规则:
//   - 有白名单 → 白名单内最小可用端口(确定性:预览端口 = 实际创建端口)
//   - 无白名单 → 以(入口机,节点)为种子的确定性分配(同样是预览 = 实际)

import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';
import { serverConn } from './conn.js';
import { applyForward, type ForwardSpec } from '../core/forward/index.js';
import { withServerLock } from './locks.js';
import {
  describePortHolders,
  globallyUsedPorts,
  pickPortDerived,
  pickPortFromRanges,
  serverPortRanges,
} from './ports.js';
import { expandRanges, describePortRanges } from './portAllow.js';
import type { Row } from './row.js';

export type BatchCore = 'singbox' | 'xray';
export type ForwardMechanism = 'iptables' | 'socat';

/** 单次「一键添加」的上限(逐条串行 SSH,按 50 条一批比较安全) */
const MAX_BATCH_CREATE = 50;

export interface BatchTarget {
  type: BatchCore;
  id: number;
}

export interface BatchInput {
  entryServerIds: number[];
  targets: BatchTarget[];
  /** 不传 = 跟随每台入口机自己的转发机制设置 */
  mechanism?: ForwardMechanism;
  includeInSub?: boolean;
}

export interface BatchItem {
  key: string;
  entryServerId: number;
  entryServerName: string;
  entryPort: number | null;
  landingServerId: number;
  landingServerName: string;
  targetNodeType: BatchCore;
  targetNodeId: number;
  targetNodeName: string;
  targetPort: number;
  core: BatchCore;
  mechanism: ForwardMechanism;
  includeInSub: boolean;
  action: 'create' | 'skip';
  reason?: string;
}

export interface BatchPlan {
  items: BatchItem[];
  createCount: number;
  skipCount: number;
}

export interface BatchError {
  key: string;
  name: string;
  message: string;
}

export interface BatchResult {
  created: BatchItem[];
  skipped: BatchItem[];
  errors: BatchError[];
}

/** 不进订阅、中转无意义的协议(与拓扑引擎的排除口径一致) */
const NOT_RELAYABLE = new Set(['socks', 'http', 'tunnel']);

interface NodeRow {
  id: number;
  name: string;
  protocol: string;
  listen_port: number;
  enabled: number;
  server_id: number;
  server_name: string;
  landing_host: string;
  landing_client_host: string;
}

function loadNode(db: DatabaseSync, target: BatchTarget): NodeRow | undefined {
  const table = target.type === 'singbox' ? 'nodes' : 'xray_nodes';
  return db
    .prepare(
      `SELECT n.id, n.name, n.protocol, n.listen_port, n.enabled, n.server_id,
              s.name AS server_name, s.host AS landing_host, s.client_host AS landing_client_host
       FROM ${table} n JOIN servers s ON s.id = n.server_id
       WHERE n.id = ?`,
    )
    .get(target.id) as NodeRow | undefined;
}

function hasRuleForNode(db: DatabaseSync, entryServerId: number, target: BatchTarget): boolean {
  return Boolean(
    db
      .prepare('SELECT id FROM port_forwards WHERE entry_server_id = ? AND target_node_type = ? AND target_node_id = ?')
      .get(entryServerId, target.type, target.id),
  );
}

/**
 * 计算批量创建计划(不碰机器)。预览与执行共用,保证两次结果一致。
 * 端口分配在本批次内递增占位:后面的条目不会再拿到前面的端口。
 */
export function planBatchForward(db: DatabaseSync, input: BatchInput): BatchPlan {
  if (!input.entryServerIds.length) throw new HttpError(400, '请至少选择一台入口机');
  if (!input.targets.length) throw new HttpError(400, '请至少选择一个落地节点');

  const entries = input.entryServerIds.map((id) => {
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(400, `入口机 #${id} 不存在`);
    return row;
  });

  const used = new Set(globallyUsedPorts(db));
  const items: BatchItem[] = [];

  for (const entry of entries) {
    const ranges = serverPortRanges(db, entry.id);
    for (const target of input.targets) {
      const key = `${entry.id}:${target.type}:${target.id}`;
      const node = loadNode(db, target);
      const base: BatchItem = {
        key,
        entryServerId: entry.id,
        entryServerName: entry.name,
        entryPort: null,
        landingServerId: node?.server_id ?? 0,
        landingServerName: node?.server_name ?? '(已删除)',
        targetNodeType: target.type,
        targetNodeId: target.id,
        targetNodeName: node?.name ?? `#${target.id}`,
        targetPort: node?.listen_port ?? 0,
        core: target.type,
        mechanism: input.mechanism ?? (entry.relay_mechanism as ForwardMechanism) ?? 'socat',
        includeInSub: input.includeInSub ?? false,
        action: 'skip',
      };

      const skip = (reason: string): void => {
        items.push({ ...base, action: 'skip', reason });
      };

      if (!node) {
        skip('节点不存在');
        continue;
      }
      if (node.enabled !== 1) {
        skip('节点已禁用');
        continue;
      }
      if (NOT_RELAYABLE.has(node.protocol)) {
        skip(`${node.protocol} 节点不进订阅,中转无意义`);
        continue;
      }
      if (node.server_id === entry.id) {
        skip('节点就在该入口机上,无需中转');
        continue;
      }
      // 可达性:入口机与落地机的 IP 栈不匹配时,直连规则建了也连不通(拓扑引擎会改走两跳)。
      // 只对**字面地址**判定:域名落在哪一族要看 DNS,不能凭字面猜,否则会误拦。
      const landingHost = String(node.landing_client_host || node.landing_host || '');
      const entryStack = String(entry.ip_stack ?? 'unknown');
      const landingIsV6 = landingHost.includes(':');
      const landingIsV4 = /^\d+\.\d+\.\d+\.\d+$/.test(landingHost);
      const mismatch = (entryStack === 'v4' && landingIsV6) || (entryStack === 'v6' && landingIsV4);
      if (mismatch) {
        skip(
          `入口机只有 ${entryStack === 'v4' ? 'IPv4' : 'IPv6'},落地机是 ${landingIsV6 ? 'IPv6' : 'IPv4'} 地址,` +
            '直连规则必然不通 —— 请用「拓扑自动规则」经双栈中间机两跳',
        );
        continue;
      }
      if (hasRuleForNode(db, entry.id, target)) {
        skip('该入口机已有此节点的中转规则');
        continue;
      }

      const port = ranges.length
        ? pickPortFromRanges([...used], ranges)
        : pickPortDerived([...used], `${entry.id}|${target.type}|${target.id}`);
      if (port === null) {
        const expanded = expandRanges(ranges);
        const holders = expanded ? describePortHolders(db, expanded) : '';
        skip(
          `该入口机可用端口已用尽(白名单 ${describePortRanges(ranges)})` +
            (holders ? `:${holders} 已占用 —— 端口号在全链路共享,别的机器占了同一端口号也用不了` : ''),
        );
        continue;
      }
      used.add(port);
      items.push({ ...base, entryPort: port, action: 'create' });
    }
  }

  const createCount = items.filter((i) => i.action === 'create').length;
  // 逐条串行 SSH:不设闸门时 50 台 × 500 节点 = 上万条,单个请求能跑几个小时,
  // 前端超时后服务端还在继续下发,现场完全不可解释。
  if (createCount > MAX_BATCH_CREATE) {
    throw new HttpError(
      400,
      `一次最多创建 ${MAX_BATCH_CREATE} 条,当前计划 ${createCount} 条 —— 请减少入口机或落地节点后分批执行`,
    );
  }

  return {
    items,
    createCount,
    skipCount: items.filter((i) => i.action === 'skip').length,
  };
}

/**
 * 执行批量创建:先落库拿行 id(规则标签 singray:<id> 用),再下发机器侧;
 * 某条下发失败 → 删除该行并记入 errors,不影响其余条目。
 */
export async function executeBatchForward(
  db: DatabaseSync,
  input: BatchInput,
  /** 注入点:测试传桩函数,生产用真实 applyForward */
  apply: (
    conn: ReturnType<typeof serverConn>,
    spec: ForwardSpec,
    remove: boolean,
  ) => Promise<void> = (conn, spec, remove) => applyForward(conn, spec, remove),
): Promise<BatchResult> {
  const plan = planBatchForward(db, input);
  const created: BatchItem[] = [];
  const errors: BatchError[] = [];

  for (const item of plan.items) {
    if (item.action !== 'create' || item.entryPort === null) continue;
    let rowId = 0;
    try {
      // INSERT 也必须在 try 里:撞 (entry_server_id, entry_port) 的 UNIQUE 若抛穿,
      // 已下发的机器侧规则与已插入的行都会留场,而用户只看到 500
      const info = db
        .prepare(
          `INSERT INTO port_forwards (name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, include_in_sub, auto, core, note)
           VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,
        )
        .run(
          `${item.entryServerName}→${item.targetNodeName}`,
          item.entryServerId,
          item.landingServerId,
          item.targetNodeType,
          item.targetNodeId,
          item.entryPort,
          item.targetPort,
          item.mechanism,
          item.includeInSub ? 1 : 0,
          item.core,
          '一键添加',
        );
      rowId = Number(info.lastInsertRowid);
      const landing = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(item.landingServerId) as Row;
      const entryPort = item.entryPort; // 闭包里保持 number 收窄
      const entryServerId = item.entryServerId;
      // 与部署/其他下发按机器互斥:同一台入口机上并发写 iptables/unit 会互相踩
      await withServerLock(entryServerId, () =>
        apply(serverConn(db, entryServerId), {
          id: rowId,
          entryPort,
          landingHost: landing.client_host || landing.host,
          targetPort: item.targetPort,
          mechanism: item.mechanism,
        }, false),
      );
      created.push(item);
    } catch (err) {
      if (rowId) db.prepare('DELETE FROM port_forwards WHERE id = ?').run(rowId);
      errors.push({ key: item.key, name: `${item.entryServerName}→${item.targetNodeName}`, message: (err as Error).message });
    }
  }

  return { created, skipped: plan.items.filter((i) => i.action === 'skip'), errors };
}
