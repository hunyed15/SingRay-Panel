// Xray 节点 CRUD(移植自旧 routes/xray_nodes.js 的写路径;deploy 下发属 M4)
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';
import { encryptJson, decryptJson } from './creds.js';
import { genRandomHex, genPassword } from '../core/crypto.js';
import { XRAY_TEMPLATE_META, XRAY_PROTOCOL_DEFAULTS, genXrayNodeCreds, xrayNodeDefaults } from './xray_templates.js';
import { randomFreePort, assertPortFree } from './ports.js';
import { buildShareLink, type NodeView } from '../core/subscribe/index.js';
import type { NodeRow } from './nodes.js';

export interface XrayNodeInput {
  template: string;
  name: string;
  serverId: number;
  outboundType?: 'direct' | 'relay';
  landingServerId?: number;
  port?: number;
  sni?: string;
  flow?: string;
}

export interface XrayNodeUpdateInput {
  name?: string;
  protocol?: string;
  port?: number;
  enabled?: boolean;
  sni?: string;
  flow?: string;
  outboundType?: 'direct' | 'relay';
  landingServerId?: number;
  note?: string;
  /** socks/http 认证(用户未填且为空时由生成值兜底) */
  authUser?: string;
  authPassword?: string;
}

const SELECT_JOIN = `SELECT n.*, s.name AS server_name, g.name AS landing_name
  FROM xray_nodes n
  JOIN servers s ON s.id = n.server_id
  LEFT JOIN servers g ON g.id = n.landing_server_id`;

function loadRow(db: DatabaseSync, id: number): NodeRow {
  const row = db.prepare(`${SELECT_JOIN} WHERE n.id = ?`).get(id) as unknown as NodeRow | undefined;
  if (!row) throw new HttpError(404, 'Xray 节点不存在');
  return row;
}

/** 构建分享链接所需的 view(xray reality 公钥来自 xray_server_settings) */
function toView(db: DatabaseSync, row: NodeRow): NodeView | null {
  const server = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(row.server_id) as
    | { host: string; client_host: string }
    | undefined;
  if (!server) return null;
  const xrs = db.prepare('SELECT reality_public_key, short_id FROM xray_server_settings WHERE server_id = ?').get(row.server_id) as
    | { reality_public_key: string; short_id: string }
    | undefined;
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: server.client_host || server.host,
    port: row.listen_port,
    sni: row.sni || server.host,
    ws_path: row.ws_path,
    realityPublicKey: xrs?.reality_public_key ?? null,
    shortId: xrs?.short_id ?? null,
    creds: decryptJson(row.creds_enc),
  };
}

function nodeItem(db: DatabaseSync, row: NodeRow) {
  return {
    id: row.id,
    name: row.name,
    server_id: row.server_id,
    server_name: row.server_name ?? '',
    protocol: row.protocol,
    listen_port: row.listen_port,
    enabled: row.enabled,
    tls_mode: row.tls_mode,
    transport: row.transport,
    sni: row.sni || undefined,
    ws_path: row.ws_path || undefined,
    flow: row.flow || undefined,
    outbound_type: row.outbound_type,
    landing_server_id: row.landing_server_id ?? undefined,
    landing_name: row.landing_name || undefined,
    tunnel_address: row.tunnel_address || undefined,
    tunnel_port: row.tunnel_port ?? undefined,
    auth_user: row.protocol === 'socks' || row.protocol === 'http' ? (decryptJson(row.creds_enc) as any).username : undefined,
    auth_password: row.protocol === 'socks' || row.protocol === 'http' ? (decryptJson(row.creds_enc) as any).password : undefined,
    share_link: (() => {
      const view = toView(db, row);
      return view ? buildShareLink(view) : null;
    })(),
    note: row.note,
    created_at: row.created_at,
  };
}

export function listXrayNodes(db: DatabaseSync) {
  const rows = db.prepare(`${SELECT_JOIN} ORDER BY n.id`).all() as unknown as NodeRow[];
  return rows.map((r) => nodeItem(db, r));
}

export function getXrayNode(db: DatabaseSync, id: number) {
  return nodeItem(db, loadRow(db, id));
}

export function createXrayNode(db: DatabaseSync, b: XrayNodeInput) {
  if (!b.name || !b.serverId) throw new HttpError(400, 'name/serverId 必填');
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(b.serverId) as
    | { id: number; host: string; client_host: string }
    | undefined;
  if (!server) throw new HttpError(400, '入口机不存在');
  const meta = XRAY_TEMPLATE_META[b.template];
  if (!meta) throw new HttpError(400, '未知模板');

  let landingId: number | null = null;
  if (b.outboundType === 'relay') {
    const landing = db.prepare('SELECT id, role FROM servers WHERE id = ?').get(b.landingServerId ?? -1) as
      | { id: number; role: string }
      | undefined;
    if (!landing || landing.role !== 'landing') throw new HttpError(400, '中转出口需要选择落地机');
    landingId = landing.id;
  }

  // 端口分配:排除本表与 sing-box 节点端口避免冲突
  const used = (db.prepare('SELECT listen_port FROM xray_nodes WHERE server_id = ?').all(b.serverId) as unknown as { listen_port: number }[]).map((r) => r.listen_port);
  const sbUsed = (db.prepare('SELECT listen_port FROM nodes WHERE server_id = ?').all(b.serverId) as unknown as { listen_port: number }[]).map((r) => r.listen_port);
  const port = b.port ? Number(b.port) : randomFreePort([...used, ...sbUsed]);
  if (b.port) assertPortFree(db, b.serverId, port, { selfTable: 'xray_nodes' });

  const flow = meta.protocol === 'vless' ? (b.flow || 'xtls-rprx-vision') : '';
  const creds = genXrayNodeCreds(meta.protocol, flow);
  const { sni, wsPath } = xrayNodeDefaults(meta.protocol, server.client_host || server.host, b.sni);

  const info = db
    .prepare(
      `INSERT INTO xray_nodes (name, server_id, protocol, listen_port, enabled, creds_enc, tls_mode, sni, transport, ws_path, flow, outbound_type, landing_server_id, note, created_at)
       VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      b.name,
      b.serverId,
      meta.protocol,
      port,
      encryptJson(creds),
      meta.tlsMode,
      sni,
      meta.transport,
      wsPath,
      flow,
      b.outboundType ?? 'direct',
      landingId,
      '',
      new Date().toISOString(),
    );
  return getXrayNode(db, Number(info.lastInsertRowid));
}

export function updateXrayNode(db: DatabaseSync, id: number, b: XrayNodeUpdateInput) {
  const row = loadRow(db, id);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(row.server_id) as
    | { host: string; client_host: string }
    | undefined;

  let protocol = row.protocol;
  let creds = decryptJson(row.creds_enc);
  let tlsMode = row.tls_mode;
  let transport = row.transport;
  let wsPath = row.ws_path;
  let sni = row.sni;
  let flow = row.flow ?? '';

  if (b.protocol && b.protocol !== row.protocol) {
    protocol = b.protocol;
    flow = protocol === 'vless' ? (b.flow || 'xtls-rprx-vision') : '';
    creds = genXrayNodeCreds(protocol, flow);
    const defs = XRAY_PROTOCOL_DEFAULTS[protocol];
    if (!defs) throw new HttpError(400, '未知协议');
    tlsMode = defs.tlsMode;
    transport = defs.transport;
    const defaults = xrayNodeDefaults(protocol, server?.client_host || server?.host || '', b.sni);
    sni = defaults.sni;
    wsPath = defaults.wsPath;
  } else if (b.sni !== undefined && protocol === 'vless') {
    sni = b.sni.trim() || sni;
  }

  // socks/http 认证覆盖:用户填写优先;为空且原凭据为空时生成(防无认证裸奔)
  if ((protocol === 'socks' || protocol === 'http') && (b.authUser !== undefined || b.authPassword !== undefined)) {
    creds = {
      username: b.authUser?.trim() || creds.username || genRandomHex(8),
      password: b.authPassword || creds.password || genPassword(),
    };
  } else if (protocol === 'socks' || protocol === 'http') {
    creds = {
      username: creds.username || genRandomHex(8),
      password: creds.password || genPassword(),
    };
  }

  const outboundType = b.outboundType ?? row.outbound_type;
  let landingId = row.landing_server_id;
  if (b.outboundType === 'direct') landingId = null;
  if (b.landingServerId !== undefined) {
    if (outboundType === 'direct') throw new HttpError(400, '直连节点无需落地机');
    const landing = db.prepare('SELECT id, role FROM servers WHERE id = ?').get(b.landingServerId) as
      | { id: number; role: string }
      | undefined;
    if (!landing || landing.role !== 'landing') throw new HttpError(400, '落地机非法');
    landingId = landing.id;
  }

  const port = b.port !== undefined ? Number(b.port) : row.listen_port;
  if (b.port !== undefined) assertPortFree(db, row.server_id, port, { selfTable: 'xray_nodes', excludeNodeId: id });

  db.prepare(
    `UPDATE xray_nodes SET name=?, protocol=?, listen_port=?, enabled=?, creds_enc=?, tls_mode=?, sni=?, transport=?, ws_path=?, flow=?, outbound_type=?, landing_server_id=?, note=?
     WHERE id=?`,
  ).run(
    b.name ?? row.name,
    protocol,
    port,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : row.enabled,
    encryptJson(creds),
    tlsMode,
    sni,
    transport,
    wsPath,
    flow,
    outboundType,
    landingId,
    b.note ?? row.note,
    id,
  );
  return getXrayNode(db, id);
}

export function toggleXrayNode(db: DatabaseSync, id: number) {
  const row = loadRow(db, id);
  db.prepare('UPDATE xray_nodes SET enabled = ? WHERE id = ?').run(row.enabled ? 0 : 1, id);
  return getXrayNode(db, id);
}

export function deleteXrayNode(db: DatabaseSync, id: number): void {
  loadRow(db, id);
  db.prepare('DELETE FROM xray_nodes WHERE id = ?').run(id);
}

/** 清空所有 xray 节点(不触发部署),可保留一个 */
export function purgeXrayNodes(db: DatabaseSync, keepId = 0): number {
  return Number(db.prepare('DELETE FROM xray_nodes WHERE id != ?').run(keepId).changes);
}
