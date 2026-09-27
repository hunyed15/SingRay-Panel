// IP 栈自动探测:经 SSH 检查机器是否有全局 IPv4 / IPv6 地址,写入 servers.ip_stack。
// 供拓扑引擎判断「中转机能到达哪些落地机」。

import type { DatabaseSync } from 'node:sqlite';
import { serverConn } from '../../services/conn.js';
import { exec } from '../ssh/executor.js';
import type { IpStack } from './plan.js';

/**
 * 探测单机 IP 栈。
 * v4: 有全局 IPv4;v6: 有全局 IPv6;dual: 两者都有。
 */
export async function detectIpStack(db: DatabaseSync, serverId: number): Promise<IpStack> {
  try {
    const conn = serverConn(db, serverId);
    const r = await exec(
      conn,
      `V4=$(ip -4 addr show scope global 2>/dev/null | grep -c 'inet ' || echo 0); V6=$(ip -6 addr show scope global 2>/dev/null | grep -c 'inet6 ' || echo 0); echo "$V4 $V6"`,
      { timeoutClass: 'quick' },
    );
    const [v4n, v6n] = r.stdout.trim().split(/\s+/).map(Number);
    const has4 = v4n > 0;
    const has6 = v6n > 0;
    const stack: IpStack = has4 && has6 ? 'dual' : has4 ? 'v4' : has6 ? 'v6' : 'unknown';
    db.prepare('UPDATE servers SET ip_stack = ? WHERE id = ?').run(stack, serverId);
    return stack;
  } catch {
    return 'unknown'; // 探测失败保持原值,由下次重试
  }
}

/** 探测全部 SSH 机器;返回摘要 */
export async function detectAllIpStacks(db: DatabaseSync): Promise<string> {
  const servers = db.prepare("SELECT id, name FROM servers WHERE control = 'ssh' ORDER BY id").all() as { id: number; name: string }[];
  const parts: string[] = [];
  for (const s of servers) {
    const stack = await detectIpStack(db, s.id);
    parts.push(`${s.name}:${stack}`);
  }
  return parts.join(' ');
}
