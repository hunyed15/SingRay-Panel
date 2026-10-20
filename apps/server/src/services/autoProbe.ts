// 自动可用性探测(D1-01):定时从面板侧 TCP/TLS 连一下"用户实际会连的入口"。
//
// 入口判定:节点若被某条 include_in_sub 的中转规则承载,用户连的是中转机
// (entry_server:entry_port);否则连节点自己所在机器的 client_host:listen_port。
// 探测结论落 node_probes(每节点一行,存最近一次结果)。
import type { DatabaseSync } from 'node:sqlite';
import { probeNode } from '../core/probe/index.js';
import { NOT_SUBSCRIBABLE_SINGBOX, NOT_SUBSCRIBABLE_XRAY } from './protocols.js';
import type { Row } from './row.js';

export type ProbeCore = 'singbox' | 'xray';

export interface ProbeTarget {
  nodeType: ProbeCore;
  nodeId: number;
  nodeName: string;
  host: string;
  port: number;
  mode: 'tcp' | 'tls';
  sni: string;
  /** 经中转时是入口规则名,便于在界面上说清"连的是哪条链路" */
  via?: string;
}

export interface ProbeResult extends ProbeTarget {
  ok: boolean;
  latencyMs: number;
  detail: string;
  checkedAt: string;
}

const TLS_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'anytls', 'shadowtls', 'naive']);

function modeFor(protocol: string, sni: string): 'tcp' | 'tls' {
  return TLS_PROTOCOLS.has(protocol) && !!sni ? 'tls' : 'tcp';
}

/** 收集要探测的目标(不改库,便于单测) */
export function collectProbeTargets(db: DatabaseSync): ProbeTarget[] {
  const out: ProbeTarget[] = [];
  for (const core of ['singbox', 'xray'] as const) {
    const table = core === 'singbox' ? 'nodes' : 'xray_nodes';
    const excluded = core === 'singbox' ? NOT_SUBSCRIBABLE_SINGBOX : NOT_SUBSCRIBABLE_XRAY;
    const rows = db
      .prepare(
        `SELECT n.id, n.name, n.protocol, n.listen_port, n.sni, n.server_id, s.host, s.client_host
         FROM ${table} n JOIN servers s ON s.id = n.server_id
         WHERE n.enabled = 1 AND n.protocol NOT IN (${excluded.map((p) => `'${p}'`).join(', ')})
         ORDER BY n.id`,
      )
      .all() as Row[];
    for (const r of rows) {
      // 有 include_in_sub 的中转规则 → 用户实际连的是中转机
      const rule = db
        .prepare(
          `SELECT pf.name, pf.entry_port, es.host AS entry_host, es.client_host AS entry_client_host
           FROM port_forwards pf JOIN servers es ON es.id = pf.entry_server_id
           WHERE pf.target_node_type = ? AND pf.target_node_id = ? AND pf.include_in_sub = 1
           ORDER BY pf.id LIMIT 1`,
        )
        .get(core, r.id) as Row | undefined;
      const host = rule ? rule.entry_client_host || rule.entry_host : r.client_host || r.host;
      const port = rule ? rule.entry_port : r.listen_port;
      if (!host || !port) continue;
      out.push({
        nodeType: core,
        nodeId: r.id,
        nodeName: r.name,
        host,
        port,
        mode: modeFor(r.protocol, r.sni ?? ''),
        sni: r.sni ?? '',
        via: rule ? rule.name : undefined,
      });
    }
  }
  return out;
}

export function saveProbe(db: DatabaseSync, r: ProbeResult): void {
  db.prepare(
    `INSERT INTO node_probes (node_type, node_id, ok, latency_ms, detail, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_type, node_id) DO UPDATE SET
       ok = excluded.ok, latency_ms = excluded.latency_ms,
       detail = excluded.detail, checked_at = excluded.checked_at`,
  ).run(r.nodeType, r.nodeId, r.ok ? 1 : 0, Math.round(r.latencyMs), r.detail.slice(0, 200), r.checkedAt);
}

export interface ProbeRunSummary {
  checked: number;
  ok: number;
  failed: number;
  results: ProbeResult[];
}

/** 探测全部节点(串行,避免对面板侧网卡/SSH 造成瞬时压力) */
export async function probeAllNodes(
  db: DatabaseSync,
  deps: { probe?: typeof probeNode; now?: () => Date } = {},
): Promise<ProbeRunSummary> {
  const probe = deps.probe ?? probeNode;
  const now = deps.now ?? (() => new Date());
  const targets = collectProbeTargets(db);
  const results: ProbeResult[] = [];
  for (const t of targets) {
    const r = await probe({ host: t.host, port: t.port, mode: t.mode, sni: t.sni });
    const row: ProbeResult = {
      ...t,
      ok: r.ok,
      latencyMs: r.latency_ms ?? 0,
      detail: r.detail || (t.via ? `经 ${t.via}` : ''),
      checkedAt: now().toISOString(),
    };
    saveProbe(db, row);
    results.push(row);
  }
  const ok = results.filter((r) => r.ok).length;
  return { checked: results.length, ok, failed: results.length - ok, results };
}

export function listProbes(db: DatabaseSync): ProbeResult[] {
  const rows = db
    .prepare(
      `SELECT p.*, COALESCE(n.name, x.name) AS node_name
       FROM node_probes p
       LEFT JOIN nodes n ON p.node_type = 'singbox' AND n.id = p.node_id
       LEFT JOIN xray_nodes x ON p.node_type = 'xray' AND x.id = p.node_id
       ORDER BY p.node_type, p.node_id`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    nodeType: r.node_type as ProbeCore,
    nodeId: r.node_id as number,
    nodeName: (r.node_name as string) ?? `#${r.node_id}`,
    host: '',
    port: 0,
    mode: 'tcp' as const,
    sni: '',
    ok: r.ok === 1,
    latencyMs: r.latency_ms as number,
    detail: r.detail as string,
    checkedAt: r.checked_at as string,
  }));
}
