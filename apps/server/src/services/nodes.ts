// sing-box 节点 CRUD(移植自旧 routes/nodes.js 的写路径;deploy 下发属 M4)
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';
import { encryptJson, decryptJson, type NodeCreds } from './creds.js';
import { genRandomHex, genPassword } from '../core/crypto.js';
import { TEMPLATE_META, PROTOCOL_DEFAULTS, genNodeCreds, nodeDefaults } from './templates.js';
import { randomFreePort, assertPortFree } from './ports.js';
import { buildShareLink, type NodeView } from '../core/subscribe/index.js';

export interface NodeRow {
  id: number;
  name: string;
  server_id: number;
  protocol: string;
  listen_port: number;
  enabled: number;
  creds_enc: string;
  tls_mode: string;
  sni: string;
  transport: string;
  ws_path: string;
  /** 仅 xray_nodes 表有此列(nodes 行恒为 undefined) */
  flow?: string;
  outbound_type: string;
  landing_server_id: number | null;
  tunnel_address: string;
  tunnel_port: number | null;
  note: string;
  created_at: string;
  server_name?: string;
  landing_name?: string | null;
}

export interface NodeInput {
  template: string;
  name: string;
  serverId: number;
  outboundType?: 'direct' | 'relay';
  landingServerId?: number;
  port?: number;
  sni?: string;
  authUser?: string;
  authPassword?: string;
  tunnelAddress?: string;
  tunnelPort?: number;
}

export interface NodeUpdateInput {
  name?: string;
  protocol?: string;
  port?: number;
  enabled?: boolean;
  sni?: string;
  outboundType?: 'direct' | 'relay';
  landingServerId?: number;
  authUser?: string;
  authPassword?: string;
  tunnelAddress?: string;
  tunnelPort?: number;
  note?: string;
}

const SELECT_JOIN = `SELECT n.*, s.name AS server_name, g.name AS landing_name
  FROM nodes n
  JOIN servers s ON s.id = n.server_id
  LEFT JOIN servers g ON g.id = n.landing_server_id`;

function loadRow(db: DatabaseSync, id: number): NodeRow {
  const row = db.prepare(`${SELECT_JOIN} WHERE n.id = ?`).get(id) as unknown as NodeRow | undefined;
  if (!row) throw new HttpError(404, '节点不存在');
  return row;
}

/** 构建分享链接所需的 view(含 Reality 公钥;与 core/subscribe NodeView 对齐) */
function toView(db: DatabaseSync, row: NodeRow): NodeView | null {
  const server = db.prepare('SELECT host, client_host FROM servers WHERE id = ?').get(row.server_id) as
    | { host: string; client_host: string }
    | undefined;
  if (!server) return null;
  const rs = db.prepare('SELECT reality_public_key, short_id FROM relay_settings WHERE server_id = ?').get(row.server_id) as
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
    realityPublicKey: rs?.reality_public_key ?? null,
    shortId: rs?.short_id ?? null,
    creds: decryptJson(row.creds_enc),
  };
}

/**
 * 构造 NodeItem(凭据不回显,socks/http 的认证字段除外——单管理员面板且订阅本就含该凭据,编辑需回显)。
 * share_link 由 core/subscribe 构建;隧道节点返回 null(订阅内容不含 tunnel)。
 */
function nodeItem(db: DatabaseSync, row: NodeRow) {
  const creds = decryptJson(row.creds_enc);
  const isAuth = row.protocol === 'socks' || row.protocol === 'http';
  const view = toView(db, row);
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
    outbound_type: row.outbound_type,
    landing_server_id: row.landing_server_id ?? undefined,
    landing_name: row.landing_name || undefined,
    tunnel_address: row.tunnel_address || undefined,
    tunnel_port: row.tunnel_port ?? undefined,
    auth_user: isAuth ? creds.username : undefined,
    auth_password: isAuth ? creds.password : undefined,
    share_link: view ? buildShareLink(view) : null,
    note: row.note,
    created_at: row.created_at,
  };
}

export function listNodes(db: DatabaseSync) {
  const rows = db.prepare(`${SELECT_JOIN} ORDER BY n.id`).all() as unknown as NodeRow[];
  return rows.map((r) => nodeItem(db, r));
}

export function getNode(db: DatabaseSync, id: number) {
  return nodeItem(db, loadRow(db, id));
}

/** socks/http 认证:用户填写优先;两项皆空时自动生成(无认证的开放代理会被扫描滥用) */
function applyAuthCreds(creds: NodeCreds, authUser?: string, authPassword?: string): void {
  if (authUser || authPassword) {
    if (!authUser || !authPassword) throw new HttpError(400, '认证需要同时填写用户名与密码');
    creds.username = String(authUser).trim();
    creds.password = String(authPassword);
  } else if (!creds.username && !creds.password) {
    creds.username = genRandomHex(8);
    creds.password = genPassword();
  }
}

export function createNode(db: DatabaseSync, b: NodeInput) {
  if (!b.name || !b.serverId) throw new HttpError(400, 'name/serverId 必填');
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(b.serverId) as
    | { id: number; host: string; client_host: string }
    | undefined;
  if (!server) throw new HttpError(400, '入口机不存在');
  const meta = TEMPLATE_META[b.template];
  if (!meta) throw new HttpError(400, '未知模板');

  let landingId: number | null = null;
  if (b.outboundType === 'relay') {
    const landing = db.prepare('SELECT id, role FROM servers WHERE id = ?').get(b.landingServerId ?? -1) as
      | { id: number; role: string }
      | undefined;
    if (!landing || landing.role !== 'landing') throw new HttpError(400, '中转出口需要选择落地机');
    landingId = landing.id;
  }

  // 端口:手动指定,或完全随机;落地机共享 ss 入站端口也计入占用(避免随机撞车)
  const used = (db.prepare('SELECT listen_port FROM nodes WHERE server_id = ?').all(b.serverId) as unknown as { listen_port: number }[]).map((r) => r.listen_port);
  const xrayUsed = (db.prepare('SELECT listen_port FROM xray_nodes WHERE server_id = ?').all(b.serverId) as unknown as { listen_port: number }[]).map((r) => r.listen_port);
  used.push(...xrayUsed);
  const ls = db.prepare('SELECT in_port FROM landing_settings WHERE server_id = ?').get(b.serverId) as { in_port: number } | undefined;
  if (ls) used.push(ls.in_port);
  const port = b.port ? Number(b.port) : randomFreePort(used);
  if (b.port) assertPortFree(db, b.serverId, port, { selfTable: 'nodes' });

  const creds = genNodeCreds(meta.protocol);
  if (meta.protocol === 'socks' || meta.protocol === 'http') {
    applyAuthCreds(creds, b.authUser, b.authPassword);
  }
  // sni 用对外域名,与自签证书 SAN 一致(v2rayN 友好)
  const { sni, wsPath } = nodeDefaults(meta.protocol, server.client_host || server.host, b.sni);

  let tunnelAddress = '';
  let tunnelPort: number | null = null;
  if (meta.protocol === 'tunnel') {
    if (!b.tunnelAddress || !b.tunnelPort) throw new HttpError(400, '隧道节点需要填写转发目标地址与端口');
    tunnelAddress = String(b.tunnelAddress).trim();
    tunnelPort = Number(b.tunnelPort);
  }

  const info = db
    .prepare(
      `INSERT INTO nodes (name, server_id, protocol, listen_port, enabled, creds_enc, tls_mode, sni, transport, ws_path, outbound_type, landing_server_id, tunnel_address, tunnel_port, note, created_at)
       VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)`,
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
      b.outboundType ?? 'direct',
      landingId,
      tunnelAddress,
      tunnelPort,
      '',
      new Date().toISOString(),
    );
  return getNode(db, Number(info.lastInsertRowid));
}

export function updateNode(db: DatabaseSync, id: number, b: NodeUpdateInput) {
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

  // 改协议 = 重新生成凭据与默认 TLS/传输/SNI
  if (b.protocol && b.protocol !== row.protocol) {
    protocol = b.protocol;
    creds = genNodeCreds(protocol);
    const defs = PROTOCOL_DEFAULTS[protocol];
    if (!defs) throw new HttpError(400, '未知协议');
    tlsMode = defs.tlsMode;
    transport = defs.transport;
    const defaults = nodeDefaults(protocol, server?.client_host || server?.host || '', b.sni);
    sni = defaults.sni;
    wsPath = defaults.wsPath;
  } else if (b.sni !== undefined && (protocol === 'vless' || protocol === 'shadowtls')) {
    sni = b.sni.trim() || sni;
  }

  // socks/http 认证:authUser 显式提供(含空串=清除认证)时生效
  if ((protocol === 'socks' || protocol === 'http') && b.authUser !== undefined) {
    if (b.authUser && !b.authPassword) throw new HttpError(400, '认证需要同时填写用户名与密码');
    creds.username = b.authUser ? String(b.authUser).trim() : undefined as unknown as string;
    creds.password = b.authUser ? String(b.authPassword) : undefined as unknown as string;
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
  if (b.port !== undefined) assertPortFree(db, row.server_id, port, { selfTable: 'nodes', excludeNodeId: id });

  const tunnelAddress = b.tunnelAddress !== undefined ? String(b.tunnelAddress).trim() : row.tunnel_address;
  const tunnelPort = b.tunnelPort !== undefined ? Number(b.tunnelPort) : row.tunnel_port;

  db.prepare(
    `UPDATE nodes SET name=?, protocol=?, listen_port=?, enabled=?, creds_enc=?, tls_mode=?, sni=?, transport=?, ws_path=?, outbound_type=?, landing_server_id=?, tunnel_address=?, tunnel_port=?, note=?
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
    outboundType,
    landingId,
    tunnelAddress,
    tunnelPort,
    b.note ?? row.note,
    id,
  );
  return getNode(db, id);
}

/** 启停开关:翻转 enabled(旧版经 PUT enabled 字段实现,这里提供独立端点) */
export function toggleNode(db: DatabaseSync, id: number) {
  const row = loadRow(db, id);
  db.prepare('UPDATE nodes SET enabled = ? WHERE id = ?').run(row.enabled ? 0 : 1, id);
  return getNode(db, id);
}

export function deleteNode(db: DatabaseSync, id: number): void {
  loadRow(db, id);
  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
}
