// 流量采集:经 SSH 用机器上的 xray api 客户端查询 xray 核心的 v2ray 统计 API
// (xray: 127.0.0.1:18482),把每入站累计计数器存为采样行;
// 今日用量 = 当日相邻采样差分之和(计数器归零自动处理)。
// v1 仅 xray:sing-box 官方发布版不含 v2ray api(需自编译)。

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
  let parsed: { stat?: { name: string; value: string }[]; stats?: { name: string; value: string }[] };
  try {
    // xray api 输出可能带前后缀文本(日志/提示)——取第一个 { 到最后一个 } 之间的纯 JSON
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return [];
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
  // Xray 26.x 返回 "stat"(单数),老版返回 "stats"(复数)——兼容两种
  const statList = parsed.stat ?? parsed.stats ?? [];
  const out = new Map<string, TagStat>();
  for (const s of statList) {
    // name 形如 inbound>>>relay-in-31001>>>traffic>>>uplink
    const m = s.name.match(/^inbound>>>([^>]+)>>>traffic>>>(uplink|downlink)$/);
    if (!m) continue;
    const [, tag, dir] = m;
    if (tag === 'api-in') continue;
    const stat = out.get(tag) ?? { core, tag, uplink: 0, downlink: 0 };
    if (dir === 'uplink') stat.uplink = Number(s.value) || 0;
    else stat.downlink = Number(s.value) || 0;
    out.set(tag, stat);
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

/** 采集单机 xray 流量并落采样行;返回采集到的入站数 */
export async function collectMachineTraffic(db: DatabaseSync, serverId: number): Promise<number> {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!s) throw new Error(`server ${serverId} not found`);
  if ((s.control as string) !== 'ssh') return 0;
  const conn = serverConn(db, serverId);

  let collected = 0;
  // v1 仅 xray:sing-box 官方发布版不含 v2ray api(需自编译),其 vless/vmess 线路流量暂不统计
  const r = await exec(
    conn,
    `xray api statsquery --server=127.0.0.1:18482 -pattern "inbound>>>" 2>&1`,
    { timeoutClass: 'quick' },
  );
  const stats = parseStatsQueryOutput('xray', r.stdout);
  const ins = db.prepare(
    'INSERT INTO traffic_samples (server_id, core, tag, uplink, downlink) VALUES (?,?,?,?,?)',
  );
  for (const st of stats) {
    ins.run(serverId, 'xray', st.tag, st.uplink, st.downlink);
    collected++;
  }
  return collected;
}

/** 采集全部 SSH 机器;每机结果(含失败原因)回显到摘要,便于诊断 */
export async function collectAllTraffic(db: DatabaseSync): Promise<string> {
  const servers = db.prepare("SELECT id, name FROM servers WHERE control = 'ssh' ORDER BY id").all() as { id: number; name: string }[];
  const parts: string[] = [];
  for (const s of servers) {
    try {
      const n = await collectMachineTraffic(db, s.id);
      parts.push(`${s.name}:${n}`);
    } catch (err) {
      parts.push(`${s.name}:ERR(${(err as Error).message.slice(0, 80)})`);
    }
  }
  pruneSamples(db);
  return parts.join(' ');
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
