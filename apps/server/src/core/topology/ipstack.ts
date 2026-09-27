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
    // 用「能否真正连上公网」判断地址族可用性。
    // 只看路由表/global 地址都会误判:容器内有 docker0(172.x, global scope)和
    // 指向网关的默认 v4 路由,实测 JP-2.99(纯 IPv6)被误判为 dual。
    // 这里用超时 3s 的 TCP 连接实测(每族只试一个稳定的公共地址)。
    // 显式分开两条命令,避免 sh 分词与 IPv6 方括号歧义
    const r = await exec(
      conn,
      [
        `(timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null && echo V4) || true`,
        `(timeout 3 bash -c 'exec 3<>"/dev/tcp/2606:4700:4700::1111/443"' 2>/dev/null && echo V6) || true`,
      ].join('; '),
      { timeoutClass: 'quick' },
    );
    const out = r.stdout;
    const has4 = /V4/.test(out);
    const has6 = /V6/.test(out);
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
