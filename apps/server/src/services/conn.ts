// 组装带跳板机的 SSH 连接:目标机器配置了 jump_server_id 时,SSH 经该机器隧道连接
// (ProxyJump)。用于本地无 IPv6 路由 / 直连不稳的场景(跳板通常选 Dedirock)。

import type { DatabaseSync } from 'node:sqlite';
import { buildConn, type SshConn } from '../core/ssh/executor.js';
import { decryptSecret } from './creds.js';
import type { Row } from './row.js';

export function serverConn(db: DatabaseSync, serverId: number): SshConn {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!row) throw new Error(`server ${serverId} not found`);
  return rowConn(db, row);
}

export function rowConn(db: DatabaseSync, row: Row): SshConn {
  const conn = buildConn(row as any, (s) => decryptSecret(s));
  if (row.jump_server_id) {
    const jump = db.prepare('SELECT * FROM servers WHERE id = ?').get(row.jump_server_id) as Row | undefined;
    if (jump && jump.id !== row.id) conn.jump = buildConn(jump as any, (s) => decryptSecret(s));
  }
  return conn;
}
