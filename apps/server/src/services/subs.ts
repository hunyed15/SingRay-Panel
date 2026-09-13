// Subscription data collection (decrypt creds, join server host + reality
// settings). Ported from singbox-panel sub.js collectNodes + xray_sub.js.
// Subscriptions = enabled direct nodes + enabled port-forwards flagged
// include_in_sub (rendered as entry-address + landing-node params).

import type { DatabaseSync } from 'node:sqlite';
import { decrypt } from '../core/crypto.js';
import { getSetting } from './settings.js';
import { config } from '../config.js';
import type { NodeView } from '../core/subscribe/index.js';
import type { Row } from './row.js';

const secret = () => config.appSecret; // 字段加密密钥(迁移须等于旧 APP_SECRET)

export type RealityAddrMode = 'ip' | 'domain';

/** Reality 节点地址模式:ip(绕开慢 DNS,默认)/ domain(换 IP 免改订阅) */
export function realityAddrFor(db: DatabaseSync, core: 'singbox' | 'xray'): RealityAddrMode {
  return getSetting(db, core === 'singbox' ? 'sub_singbox_reality_ip' : 'sub_xray_reality_ip') === '0' ? 'domain' : 'ip';
}

function addrFor(row: Row, mode: RealityAddrMode, isReality: boolean): string {
  if (isReality && mode === 'ip') return row.host;
  return row.client_host || row.host;
}

export function collectSingboxNodes(db: DatabaseSync, realityAddr: RealityAddrMode = 'ip'): NodeView[] {
  const rows = db
    .prepare(
      `SELECT n.*, s.host, s.client_host, rs.reality_public_key, rs.short_id
       FROM nodes n
       JOIN servers s ON s.id = n.server_id
       LEFT JOIN relay_settings rs ON rs.server_id = s.id
       WHERE n.enabled = 1 AND n.protocol != 'tunnel'
       ORDER BY n.id`,
    )
    .all() as Row[];
  const direct = rows.map((r) => ({
    id: r.id,
    name: r.name,
    protocol: r.protocol,
    host: addrFor(r, realityAddr, r.protocol === 'vless' && !!r.reality_public_key),
    port: r.listen_port,
    sni: r.sni || r.host,
    ws_path: r.ws_path,
    realityPublicKey: r.reality_public_key,
    shortId: r.short_id,
    creds: JSON.parse(decrypt(secret(), r.creds_enc)),
  }));
  return [...direct, ...collectForwardViews(db, 'singbox', realityAddr)];
}

export function collectXrayNodes(db: DatabaseSync, realityAddr: RealityAddrMode = 'ip'): NodeView[] {
  const rows = db
    .prepare(
      `SELECT n.*, s.host, s.client_host, xs.reality_public_key, xs.short_id
       FROM xray_nodes n
       JOIN servers s ON s.id = n.server_id
       LEFT JOIN xray_server_settings xs ON xs.server_id = s.id
       WHERE n.enabled = 1
       ORDER BY n.id`,
    )
    .all() as Row[];
  const direct = rows.map((r) => {
    const creds = JSON.parse(decrypt(secret(), r.creds_enc));
    // xray vless 的 flow 在列上,注入 creds 供分享链接使用(回归 3adac49)
    if (r.protocol === 'vless' && r.flow) creds.flow = r.flow;
    return {
      id: r.id,
      name: r.name,
      protocol: r.protocol,
      host: addrFor(r, realityAddr, r.protocol === 'vless' && !!r.reality_public_key),
      port: r.listen_port,
      sni: r.sni || r.host,
      ws_path: r.ws_path,
      realityPublicKey: r.reality_public_key,
      shortId: r.short_id,
      creds,
    };
  });
  return [...direct, ...collectForwardViews(db, 'xray', realityAddr)];
}

/**
 * 订阅整合的中转规则:include_in_sub=1 且启用的转发,渲染为
 * 「入口机地址 + 入口端口 + 落地节点参数」的节点视图。
 * 协议参数(uuid/sni/reality 公钥)全部取自落地机——DNAT 透明转发,协议在落地终结。
 */
export function collectForwardViews(db: DatabaseSync, core: 'singbox' | 'xray', realityAddr: RealityAddrMode = 'ip'): NodeView[] {
  const forwards = db
    .prepare(
      `SELECT pf.id, pf.name, pf.entry_port, pf.target_node_type, pf.target_node_id,
              es.host AS entry_host, es.client_host AS entry_client_host
       FROM port_forwards pf
       JOIN servers es ON es.id = pf.entry_server_id
       WHERE pf.enabled = 1 AND pf.include_in_sub = 1 AND pf.target_node_type = ?
       ORDER BY pf.id`,
    )
    .all(core) as Row[];

  const views: NodeView[] = [];
  for (const pf of forwards) {
    const n =
      core === 'singbox'
        ? (db
            .prepare(
              `SELECT n.*, s.host, s.client_host, rs.reality_public_key, rs.short_id
               FROM nodes n
               JOIN servers s ON s.id = n.server_id
               LEFT JOIN relay_settings rs ON rs.server_id = s.id
               WHERE n.id = ? AND n.enabled = 1 AND n.protocol != 'tunnel'`,
            )
            .get(pf.target_node_id) as Row | undefined)
        : (db
            .prepare(
              `SELECT n.*, s.host, s.client_host, xs.reality_public_key, xs.short_id
               FROM xray_nodes n
               JOIN servers s ON s.id = n.server_id
               LEFT JOIN xray_server_settings xs ON xs.server_id = s.id
               WHERE n.id = ? AND n.enabled = 1`,
            )
            .get(pf.target_node_id) as Row | undefined);
    if (!n) continue; // 目标节点被删/停用 → 该中转线路退出订阅

    const creds = JSON.parse(decrypt(secret(), n.creds_enc));
    if (core === 'xray' && n.protocol === 'vless' && n.flow) creds.flow = n.flow;
    views.push({
      id: 100000 + pf.id, // 与直连节点 id 空间隔离,避免 key/selector 冲突
      name: pf.name,
      protocol: n.protocol,
      host: addrFor({ host: pf.entry_host, client_host: pf.entry_client_host }, realityAddr, n.protocol === 'vless' && !!n.reality_public_key),
      port: pf.entry_port,
      sni: n.sni || n.host,
      ws_path: n.ws_path,
      realityPublicKey: n.reality_public_key,
      shortId: n.short_id,
      creds,
    });
  }
  return views;
}
