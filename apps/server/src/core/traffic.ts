// 流量采集:经 SSH 用机器上的 xray api 客户端查询两个核心的 v2ray 统计 API
// (xray: 127.0.0.1:18482;sing-box: 127.0.0.1:18481,sing-box 的 v2ray_api 与
// v2ray StatsService 协议兼容,xray api 客户端可直接查询),把每入站累计计数器
// 存为采样行;今日用量 = 当日相邻采样差分之和(计数器归零自动处理)。

import type { DatabaseSync } from 'node:sqlite';
import { serverConn } from '../services/conn.js';
import { exec } from './ssh/executor.js';
import type { Row } from '../services/row.js';

export interface TagStat {
  core: 'singbox' | 'xray';
  tag: string;
  uplink: number;
  downlink: number;
}

const PORT_RE = /^(relay|landing)-in-(\d+)$/;

/** 解析 xray api statsquery 输出 → 每入站上下行(纯函数,可测) */
export function parseStatsQueryOutput(core: 'singbox' | 'xray', stdout: string): TagStat[] {
  let parsed: { stats?: { name: string; value: string }[] };
  try {
    parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    return [];
  }
  const out = new Map<string, TagStat>();
  for (const s of parsed.stats ?? []) {
    // name 形如 inbound>>>relay-in-31001>>>traffic>>>uplink
    const m = s.name.match(/^inbound>>>([^>]+)>>>traffic>>>(uplink|downlink)$/);
    if (!m) continue;
    const [, tag, dir] = m;
    if (tag === 'api-in') continue;
    const key = tag;
    const stat = out.get(key) ?? { core, tag, uplink: 0, downlink: 0 };
    if (dir === 'uplink') stat.uplink = Number(s.value) || 0;
    else stat.downlink = Number(s.value) || 0;
    out.set(key, stat);
  }
  return [...out.values()];
}

/** 相邻采样差分求和(计数器归零/回绕时该段记 0) */
export function cumulativeDelta(values: number[]): number {
  let sum = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) sum += d;
  }
  return sum;
}

/** 采集单机双核心流量并落采样行;返回采集到的入站数 */
export async function collectMachineTraffic(db: DatabaseSync, serverId: number): Promise<number> {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!s) throw new Error(`server ${serverId} not found`);
  if ((s.control as string) !== 'ssh') return 0;
  const conn = serverConn(db, serverId);

  let collected = 0;
  // v1 仅 xray:sing-box 官方发布版不含 v2ray api(需自编译),其 vless/vmess 线路流量暂不统计
  const targets: { core: 'singbox' | 'xray'; port: number }[] = [{ core: 'xray', port: 18482 }];
  for (const { core, port } of targets) {
    try {
      const r = await exec(
        conn,
        `xray api statsquery --server=127.0.0.1:${port} -pattern "inbound>>>" 2>&1`,
        { timeoutClass: 'quick' },
      );
      const stats = parseStatsQueryOutput(core, r.stdout);
      const ins = db.prepare(
        'INSERT INTO traffic_samples (server_id, core, tag, uplink, downlink) VALUES (?,?,?,?,?)',
      );
      for (const st of stats) {
        ins.run(serverId, core, st.tag, st.uplink, st.downlink);
        collected++;
      }
    } catch {
      // 核心未运行/无 stats(旧配置未重部署)→ 跳过该核心
    }
  }
  return collected;
}

/** 采集全部 SSH 机器 */
export async function collectAllTraffic(db: DatabaseSync): Promise<string> {
  const servers = db.prepare("SELECT id, name FROM servers WHERE control = 'ssh' ORDER BY id").all() as { id: number; name: string }[];
  let tags = 0;
  for (const s of servers) {
    try {
      tags += await collectMachineTraffic(db, s.id);
    } catch {
      // 单机失败不阻断其它机器
    }
  }
  pruneSamples(db);
  return `${servers.length} 台机器采样完成,${tags} 个入站计数`;
}

function pruneSamples(db: DatabaseSync): void {
  db.prepare(
    "DELETE FROM traffic_samples WHERE sampled_at < datetime('now', '-7 days')",
  ).run();
}

export interface TrafficNodeRow {
  serverName: string;
  core: 'singbox' | 'xray';
  tag: string;
  nodeName: string;
  up: number;
  down: number;
}

/** 今日用量(按节点):当日采样差分,tag 映射节点名 */
export function todaySummary(db: DatabaseSync): { date: string; nodes: TrafficNodeRow[]; totalUp: number; totalDown: number } {
  const date = new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT server_id, core, tag, uplink, downlink, sampled_at
       FROM traffic_samples WHERE sampled_at >= ? ORDER BY server_id, core, tag, sampled_at`,
    )
    .all(`${date}T00:00:00`) as Row[];

  // 分组 → 差分
  const groups = new Map<string, { serverId: number; core: 'singbox' | 'xray'; tag: string; ups: number[]; downs: number[] }>();
  for (const r of rows) {
    const key = `${r.server_id}|${r.core}|${r.tag}`;
    const g = groups.get(key) ?? { serverId: r.server_id, core: r.core as 'singbox' | 'xray', tag: r.tag, ups: [] as number[], downs: [] as number[] };
    g.ups.push(Number(r.uplink));
    g.downs.push(Number(r.downlink));
    groups.set(key, g);
  }

  // tag → 节点名
  const nodes: TrafficNodeRow[] = [];
  let totalUp = 0;
  let totalDown = 0;
  for (const g of groups.values()) {
    const up = cumulativeDelta(g.ups);
    const down = cumulativeDelta(g.downs);
    if (up === 0 && down === 0) continue;
    const portMatch = g.tag.match(PORT_RE);
    let nodeName = g.tag;
    if (portMatch) {
      const port = Number(portMatch[2]);
      const table = g.core === 'singbox' ? 'nodes' : 'xray_nodes';
      const n = db.prepare(`SELECT name FROM ${table} WHERE server_id = ? AND listen_port = ?`).get(g.serverId, port) as { name: string } | undefined;
      if (n) nodeName = n.name;
      else nodeName = `${portMatch[1] === 'landing' ? '落地共享入站' : '未知入站'} :${port}`;
    }
    const srv = db.prepare('SELECT name FROM servers WHERE id = ?').get(g.serverId) as { name: string } | undefined;
    nodes.push({ serverName: srv?.name ?? String(g.serverId), core: g.core, tag: g.tag, nodeName, up, down });
    totalUp += up;
    totalDown += down;
  }
  nodes.sort((a, b) => b.down + b.up - (a.down + a.up));
  return { date, nodes, totalUp, totalDown };
}
