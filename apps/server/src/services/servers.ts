// 服务器 CRUD + SSH 连通性测试(部署/生命周期下发属 M4,不在本层)
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';
import { encryptSecret, decryptSecret } from './creds.js';
import { genRealityKeypair, genSsPassword, genShortId } from '../core/crypto.js';
import { testConnection, type ExecFn } from '../core/ssh/executor.js';
import { serverConn } from './conn.js';

export interface ServerRow {
  id: number;
  name: string;
  role: 'relay' | 'landing';
  control: 'ssh' | 'agent';
  host: string;
  client_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_auth_type: 'key' | 'password';
  ssh_auth_secret: string;
  ssh_sudo: number;
  region: string;
  ping_status: string;
  singbox_version: string;
  xray_version: string;
  xray_ping_status: string;
  xray_last_seen: string | null;
  last_seen: string | null;
}

export interface ServerInput {
  name: string;
  role: 'relay' | 'landing';
  control?: 'ssh' | 'agent';
  host?: string;
  clientHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'key' | 'password';
  sshAuthSecret?: string;
  sshSudo?: boolean;
  region?: string;
}

const SELECT_ALL = 'SELECT * FROM servers';

function getRow(db: DatabaseSync, id: number): ServerRow {
  const row = db.prepare(`${SELECT_ALL} WHERE id = ?`).get(id) as unknown as ServerRow | undefined;
  if (!row) throw new HttpError(404, '服务器不存在');
  return row;
}

/** 凭据不进前端 */
function stripSecret(row: ServerRow): Omit<ServerRow, 'ssh_auth_secret'> {
  const { ssh_auth_secret: _ssh, ...rest } = row;
  return rest;
}

export function listServers(db: DatabaseSync): Omit<ServerRow, 'ssh_auth_secret'>[] {
  return (db.prepare(`${SELECT_ALL} ORDER BY id`).all() as unknown as ServerRow[]).map(stripSecret);
}

export function getServer(db: DatabaseSync, id: number): Omit<ServerRow, 'ssh_auth_secret'> {
  return stripSecret(getRow(db, id));
}

/** relay 建 reality 凭据,landing 建 ss 入站(端口按 id 偏移避让) */
function createRoleSettings(db: DatabaseSync, id: number, role: 'relay' | 'landing'): void {
  if (role === 'relay') {
    const { publicKey, privateKey } = genRealityKeypair();
    db.prepare(
      `INSERT INTO relay_settings (server_id, reality_public_key, reality_private_key, short_id, port_base)
       VALUES (?,?,?,?,?)`,
    ).run(id, publicKey, encryptSecret(privateKey), genShortId(), 31000);
  } else {
    db.prepare(`INSERT INTO landing_settings (server_id, in_port, method, password) VALUES (?,?,?,?)`).run(
      id,
      32000 + id,
      '2022-blake3-aes-128-gcm',
      encryptSecret(genSsPassword()),
    );
  }
}

export function createServer(db: DatabaseSync, b: ServerInput): Omit<ServerRow, 'ssh_auth_secret'> {
  const control = b.control ?? 'ssh';
  if (control === 'ssh' && (!b.host || !b.sshAuthSecret)) {
    throw new HttpError(400, 'SSH 模式需要 host 与 sshAuthSecret');
  }
  const sshSecret = control === 'ssh' ? encryptSecret(b.sshAuthSecret ?? '') : '';
  const info = db
    .prepare(
      `INSERT INTO servers (name, role, control, host, client_host, ssh_port, ssh_user, ssh_auth_type, ssh_auth_secret, ssh_sudo, region)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      b.name,
      b.role,
      control,
      b.host ?? '',
      b.clientHost ?? '',
      b.sshPort ?? 22,
      b.sshUser ?? 'root',
      b.sshAuthType ?? 'key',
      sshSecret,
      b.sshSudo ? 1 : 0,
      b.region ?? '',
    );
  const id = Number(info.lastInsertRowid);
  createRoleSettings(db, id, b.role);
  return getServer(db, id);
}

export interface ServerUpdateInput extends Partial<ServerInput> {}

export function updateServer(db: DatabaseSync, id: number, b: ServerUpdateInput) {
  const row = getRow(db, id);
  const nextRole = b.role ?? row.role;
  const control = b.control ?? row.control;
  if (control === 'ssh' && b.sshAuthSecret !== undefined && b.sshAuthSecret !== '') {
    // 密钥/密码只在显式提供时更新,不支持清空(留空 = 保持原凭据)
    db.prepare('UPDATE servers SET ssh_auth_secret = ? WHERE id = ?').run(encryptSecret(b.sshAuthSecret), id);
  }
  db.prepare(
    `UPDATE servers SET name=?, role=?, control=?, host=?, client_host=?, ssh_port=?, ssh_user=?, ssh_auth_type=?, ssh_sudo=?, region=?
     WHERE id=?`,
  ).run(
    b.name ?? row.name,
    nextRole,
    control,
    b.host ?? row.host,
    b.clientHost ?? row.client_host,
    b.sshPort ?? row.ssh_port,
    b.sshUser ?? row.ssh_user,
    b.sshAuthType ?? row.ssh_auth_type,
    b.sshSudo !== undefined ? (b.sshSudo ? 1 : 0) : row.ssh_sudo,
    b.region ?? row.region,
    id,
  );

  // 角色变更:重建机器级凭据(relay ↔ landing)
  if (nextRole !== row.role) {
    db.prepare('DELETE FROM relay_settings WHERE server_id = ?').run(id);
    db.prepare('DELETE FROM landing_settings WHERE server_id = ?').run(id);
    createRoleSettings(db, id, nextRole);
  }
  return getServer(db, id);
}

export function deleteServer(db: DatabaseSync, id: number): void {
  getRow(db, id);
  // 引用检查覆盖两套节点表(旧版只查 nodes,xray 节点会被级联静默删除)
  const used = db
    .prepare('SELECT COUNT(*) AS c FROM nodes WHERE server_id = ? OR landing_server_id = ?')
    .get(id, id) as unknown as { c: number };
  const usedXray = db
    .prepare('SELECT COUNT(*) AS c FROM xray_nodes WHERE server_id = ? OR landing_server_id = ?')
    .get(id, id) as unknown as { c: number };
  if (used.c + usedXray.c > 0) throw new HttpError(409, '该服务器正被节点引用,请先删除相关节点');
  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
}

/** SSH 连通性测试;execFn 可注入以便单测 */
export async function testServer(db: DatabaseSync, id: number, execFn?: ExecFn) {
  const row = getRow(db, id);
  if (row.control === 'agent') {
    return { ok: false, message: 'agent 模式状态来自心跳' };
  }
  const conn = serverConn(db, id);
  return testConnection(conn, execFn);
}
