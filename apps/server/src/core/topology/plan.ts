// 自动中转拓扑引擎。
// 目标:节点一旦创建,自动在所有中转机上生成到达它的转发规则(含 IPv6-only 落地机的两跳)。
//
// 端口策略:一个节点占一个「全局唯一端口」,整条链路上所有机器都用这个端口号
//   (节点端口 = 中转入口端口 = 中间跳端口),因此不会冲突,且无需人工规划。
//
// NAT 机器只能用服务商映射过的端口(servers.port_allow 白名单):链路要求每一跳的
// 入口机都能监听该端口,否则该链路直接不生成(不给机器塞用不了的端口),并在
// skipped 里给出原因供界面展示。
//
// 链路计算:中转机 R 能直达落地机 L(地址族匹配)→ 一跳 R:P→L:P;
//          否则找双栈机 M(R 可达 M 且 M 可达 L)→ 两跳 R:P→M:P、M:P→L:P。

import type { DatabaseSync } from 'node:sqlite';
import type { Row } from '../../services/row.js';
import { containsPort, parsePortAllow, describePortRanges, type PortRange } from '../../services/portAllow.js';

export type IpStack = 'v4' | 'v6' | 'dual' | 'unknown';

export interface MachineRef {
  id: number;
  name: string;
  host: string;
  /** 对外地址(订阅/展示用) */
  clientHost: string;
  role: 'relay' | 'landing';
  ipStack: IpStack;
  relayMechanism: 'iptables' | 'socat';
  /**
   * 两跳时指定中间跳优先走哪台双栈机(落地机上的设置);null/undefined = 引擎自选。
   * 仅在该机确实是合法候选(双栈且双向可达)时生效,否则回退到默认选取。
   */
  preferViaServerId?: number | null;
  /** 可用端口白名单(NAT 场景);空数组 = 不限制 */
  portAllow: PortRange[];
}

export interface NodeRef {
  id: number;
  name: string;
  /** singbox | xray */
  type: 'singbox' | 'xray';
  serverId: number;
  port: number;
}

/** 期望的一条转发规则(一跳) */
export interface DesiredRule {
  /** 规则名(便于识别链路) */
  name: string;
  entryServerId: number;
  landingServerId: number;
  /** 目标节点(仅末跳绑定节点;中间跳为 port) */
  targetNodeType: 'singbox' | 'xray' | 'port';
  targetNodeId: number;
  entryPort: number;
  targetPort: number;
  mechanism: 'iptables' | 'socat';
  /** 规则归属核心(singbox/xray);中间跳归并到所属链路的核心,便于按核心整体筛选 */
  core: 'singbox' | 'xray';
  /** 链路上游(用于展示:CDT → Hytron → JP) */
  via?: string;
  /** 末跳规则进订阅(只有末跳才代表一个可用线路) */
  includeInSub: boolean;
}

// ---------- 纯函数:地址族与可达性 ----------

export function hostFamily(host: string): 'v4' | 'v6' {
  return host.includes(':') ? 'v6' : 'v4';
}

const hasV4 = (s: IpStack) => s === 'v4' || s === 'dual';
const hasV6 = (s: IpStack) => s === 'v6' || s === 'dual';

/** from 机器能否直接连到 host(按 host 的地址族判断) */
export function canReach(fromStack: IpStack, host: string): boolean {
  return hostFamily(host) === 'v4' ? hasV4(fromStack) : hasV6(fromStack);
}

/**
 * 计算 R → L 的链路。返回机器 id 序列(含首尾);无解返回 null。
 * 优先一跳;否则找双栈中间机。
 * 中间机选取:若落地机指定了 preferViaServerId 且它合法可用,则用它;否则取第一个合法候选。
 */
export function resolvePath(
  relay: MachineRef,
  landing: MachineRef,
  all: MachineRef[],
): number[] | null {
  if (relay.id === landing.id) return null;
  if (canReach(relay.ipStack, landing.host)) return [relay.id, landing.id];
  if (relay.ipStack === 'unknown' || landing.ipStack === 'unknown') return null;
  // 需要中间跳:R 可达 M,且 M 可达 L;M 不能是 R 或 L
  const candidates = all.filter(
    (m) => m.id !== relay.id && m.id !== landing.id && m.ipStack === 'dual' && canReach(relay.ipStack, m.host) && canReach(m.ipStack, landing.host),
  );
  if (candidates.length === 0) return null;
  // 落地机指定的优先中间跳(仅在它本身是合法候选时采用)
  const preferred = landing.preferViaServerId != null ? candidates.find((m) => m.id === landing.preferViaServerId) : undefined;
  return [relay.id, (preferred ?? candidates[0]).id, landing.id];
}

/** 机器能否监听该端口(白名单为空 = 不限) */
export function allowsPort(machine: MachineRef, port: number): boolean {
  return machine.portAllow.length === 0 || containsPort(machine.portAllow, port);
}

/** 被端口白名单挡掉的链路(界面展示「为什么这条中转没生成」) */
export interface PlanSkip {
  nodeId: number;
  nodeName: string;
  port: number;
  relayServerId: number;
  relayName: string;
  /** 白名单里不含该端口的机器 */
  machineId: number;
  machineName: string;
  reason: string;
}

export interface PlanResult {
  rules: DesiredRule[];
  skipped: PlanSkip[];
}

/**
 * 生成期望规则集(纯函数,可测)。
 * 对每个中转机 × 每个落地节点计算链路并展开为规则;中间跳规则按 (entry,port,landing) 去重。
 * 链路上任一中转入口机的端口白名单不含该端口 → 不生成规则,记入 skipped。
 */
export function planTopology(
  machines: MachineRef[],
  nodes: NodeRef[],
  /** 落地机 id → 节点列表(按 server_id 分组的便捷索引可省略) */
): PlanResult {
  const relays = machines.filter((m) => m.role === 'relay');
  const byId = new Map(machines.map((m) => [m.id, m]));
  const rules = new Map<string, DesiredRule>();
  const skipped: PlanSkip[] = [];
  const skipKeys = new Set<string>();

  const add = (r: DesiredRule) => {
    // key 必须与 DB 的 UNIQUE(entry_server_id, entry_port) 同口径:
    // 同一入口机的一个端口只能承载一条规则。用更细的 key(带落地/目标端口)会生成
    // 插不进去的重复行 —— 整轮同步在 INSERT 处抛错并被 trigger 吞掉。
    const key = `${r.entryServerId}|${r.entryPort}`;
    const taken = rules.get(key);
    if (taken) {
      const name = byId.get(r.entryServerId)?.name ?? `#${r.entryServerId}`;
      skipped.push({
        nodeId: r.targetNodeId,
        nodeName: r.name,
        port: r.entryPort,
        relayServerId: r.entryServerId,
        relayName: name,
        machineId: r.entryServerId,
        machineName: name,
        reason: `入口端口 ${r.entryPort} 已被规则「${taken.name}」占用(同一入口机的端口不能复用,手工规则优先)`,
      });
      return;
    }
    rules.set(key, r);
  };

  /** 链路上除落地机外的每一跳都要能监听该端口(落地机上的节点端口是既成事实) */
  const blockedHop = (path: number[], port: number): MachineRef | undefined =>
    path
      .slice(0, -1)
      .map((id) => byId.get(id))
      .find((m): m is MachineRef => m !== undefined && !allowsPort(m, port));

  for (const node of nodes) {
    const landing = byId.get(node.serverId);
    if (!landing) continue;
    for (const relay of relays) {
      const path = resolvePath(relay, landing, machines);
      if (!path) continue;
      const blocked = blockedHop(path, node.port);
      if (blocked) {
        // 同一节点被同一台机器挡住,多条链路只报一次(否则 N 台中转机 = N 条重复说明)
        const key = `${node.id}|${blocked.id}`;
        if (!skipKeys.has(key)) {
          skipKeys.add(key);
          skipped.push({
            nodeId: node.id,
            nodeName: node.name,
            port: node.port,
            relayServerId: relay.id,
            relayName: relay.name,
            machineId: blocked.id,
            machineName: blocked.name,
            reason: `端口 ${node.port} 不在机器 ${blocked.name} 的可用端口白名单内(可用:${describePortRanges(blocked.portAllow)})`,
          });
        }
        continue;
      }
      const viaNames = path.map((id) => byId.get(id)?.name ?? `#${id}`).join('→');
      const mech = relay.relayMechanism;

      if (path.length === 2) {
        // 一跳:中转机直达落地机
        add({
          name: `${relay.name}→${node.name}`,
          entryServerId: relay.id,
          landingServerId: landing.id,
          targetNodeType: node.type,
          targetNodeId: node.id,
          entryPort: node.port,
          targetPort: node.port,
          mechanism: mech,
          core: node.type,
          includeInSub: true,
        });
      } else {
        // 两跳:R → M → L
        const midId = path[1];
        const mid = byId.get(midId)!;
        // 上游规则:R → M(中间跳,不进订阅)
        add({
          name: `${relay.name}→${node.name}`,
          entryServerId: relay.id,
          landingServerId: mid.id,
          targetNodeType: 'port',
          targetNodeId: 0,
          entryPort: node.port,
          targetPort: node.port,
          mechanism: mech,
          core: node.type,
          via: viaNames,
          includeInSub: false,
        });
        // 末跳规则:M → L(绑定节点,进订阅)
        add({
          name: `${mid.name}→${node.name}`,
          entryServerId: mid.id,
          landingServerId: landing.id,
          targetNodeType: node.type,
          targetNodeId: node.id,
          entryPort: node.port,
          targetPort: node.port,
          mechanism: mid.relayMechanism,
          core: node.type,
          via: viaNames,
          includeInSub: true,
        });
      }
    }
  }
  return { rules: [...rules.values()], skipped };
}

// ---------- DB 装配 ----------

export function loadMachines(db: DatabaseSync): MachineRef[] {
  return (db.prepare('SELECT id, name, host, client_host, role, ip_stack, relay_mechanism, prefer_via_server_id, port_allow FROM servers').all() as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    host: r.host,
    clientHost: r.client_host,
    role: r.role,
    ipStack: (r.ip_stack ?? 'unknown') as IpStack,
    relayMechanism: (r.relay_mechanism ?? 'socat') as 'iptables' | 'socat',
    preferViaServerId: r.prefer_via_server_id ?? null,
    portAllow: parsePortAllow(r.port_allow ?? '').ranges,
  }));
}

/**
 * 参与中转的节点。
 * 排除:
 *  - tunnel(sing-box 的转发构造,非真实服务)
 *  - socks/http(不进订阅,客户端不可用 → 中转无意义,纯浪费机器资源)
 */
export function loadRelayableNodes(db: DatabaseSync): NodeRef[] {
  const EXCLUDED = `('tunnel', 'socks', 'http')`;
  const sb = (db.prepare(`SELECT id, name, server_id, listen_port FROM nodes WHERE enabled = 1 AND protocol NOT IN ${EXCLUDED}`).all() as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    type: 'singbox' as const,
    serverId: r.server_id,
    port: r.listen_port,
  }));
  const xr = (db.prepare(`SELECT id, name, server_id, listen_port FROM xray_nodes WHERE enabled = 1 AND protocol NOT IN ${EXCLUDED}`).all() as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    type: 'xray' as const,
    serverId: r.server_id,
    port: r.listen_port,
  }));
  return [...sb, ...xr];
}

/** 存量告警:节点端口不在自己机器(落地机)的可用端口白名单内 —— 不自动改号,只提示 */
export interface PortAllowWarning {
  nodeId: number;
  nodeName: string;
  port: number;
  machineId: number;
  machineName: string;
}

export function nodesOutsidePortAllow(machines: MachineRef[], nodes: NodeRef[]): PortAllowWarning[] {
  const byId = new Map(machines.map((m) => [m.id, m]));
  const out: PortAllowWarning[] = [];
  for (const node of nodes) {
    const machine = byId.get(node.serverId);
    if (!machine || allowsPort(machine, node.port)) continue;
    out.push({ nodeId: node.id, nodeName: node.name, port: node.port, machineId: machine.id, machineName: machine.name });
  }
  return out;
}

export interface RuleDiff {
  toCreate: DesiredRule[];
  toDelete: { id: number; name: string; entryServerId: number; entryPort: number; landingServerId: number; targetPort: number; mechanism: 'iptables' | 'socat' }[];
}

/** 对比期望规则与现有 auto 规则,得出增删集合 */
export function diffRules(db: DatabaseSync, desired: DesiredRule[]): RuleDiff {
  const existing = db
    .prepare('SELECT id, name, entry_server_id, entry_port, landing_server_id, target_port, mechanism FROM port_forwards WHERE auto = 1')
    .all() as Row[];
  const key = (e: number, ep: number, l: number, tp: number) => `${e}|${ep}|${l}|${tp}`;
  const desiredKeys = new Set(desired.map((d) => key(d.entryServerId, d.entryPort, d.landingServerId, d.targetPort)));
  const existingKeys = new Set(existing.map((r) => key(r.entry_server_id, r.entry_port, r.landing_server_id, r.target_port)));

  return {
    toCreate: desired.filter((d) => !existingKeys.has(key(d.entryServerId, d.entryPort, d.landingServerId, d.targetPort))),
    toDelete: existing
      .filter((r) => !desiredKeys.has(key(r.entry_server_id, r.entry_port, r.landing_server_id, r.target_port)))
      .map((r) => ({
        id: r.id,
        name: r.name,
        entryServerId: r.entry_server_id,
        entryPort: r.entry_port,
        landingServerId: r.landing_server_id,
        targetPort: r.target_port,
        // 用规则自身记录的机制删除,而非机器当前配置(机器机制变更后仍能正确清理)
        mechanism: (r.mechanism ?? 'socat') as 'iptables' | 'socat',
      })),
  };
}
