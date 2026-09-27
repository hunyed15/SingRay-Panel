// 定时健康检查:每轮对全部 SSH 机器做 TCP 22 探活 + SSH 核心存活检查 + 证书临期扫描,
// 与上一轮状态对比,**只在状态变化时告警**(首轮只建基线,防启动告警风暴),
// 并把最新状态写回 servers.ping_status / xray_ping_status(顺带解决状态陈旧)。

import type { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { serverConn } from '../services/conn.js';
import { exec } from './ssh/executor.js';
import { sendAlert } from './alerts.js';
import type { Row } from '../services/row.js';

export interface MachineHealth {
  serverId: number;
  name: string;
  ssh: 'up' | 'down';
  singbox: 'up' | 'down' | 'unknown';
  xray: 'up' | 'down' | 'unknown';
  /** ACME 证书剩余天数(未签发/无证书为 null) */
  certDays: number | null;
}

/** 状态对比 → 告警文案列表(纯函数,可测;证书临期由周期层按天去重) */
export function diffHealth(prev: MachineHealth | undefined, curr: MachineHealth): string[] {
  const alerts: string[] = [];
  if (!prev) return alerts; // 首轮建基线
  if (prev.ssh !== curr.ssh) {
    alerts.push(curr.ssh === 'up' ? `机器 ${curr.name} SSH 已恢复` : `机器 ${curr.name} SSH 不可达`);
  }
  for (const core of ['singbox', 'xray'] as const) {
    if (prev[core] !== 'unknown' && curr[core] !== 'unknown' && prev[core] !== curr[core]) {
      alerts.push(
        curr[core] === 'up'
          ? `机器 ${curr.name} 的 ${core} 服务已恢复`
          : `机器 ${curr.name} 的 ${core} 服务已停止`,
      );
    }
  }
  return alerts;
}

export function tcpProbe(host: string, port: number, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

/** 单机检查:TCP 22 → SSH(核心状态 + 证书剩余天数,一次 SSH 会话全做) */
export async function checkServer(db: DatabaseSync, serverId: number): Promise<MachineHealth> {
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!s) throw new Error(`server ${serverId} not found`);
  const name = s.name as string;
  const host = (s.client_host || s.host) as string;
  const sshUp = await tcpProbe(host, Number(s.ssh_port) || 22);
  const health: MachineHealth = { serverId, name, ssh: sshUp ? 'up' : 'down', singbox: 'unknown', xray: 'unknown', certDays: null };
  if (!sshUp) return health;
  try {
    const conn = serverConn(db, serverId);
    const domain = (s.client_host || s.host) as string;
    const r = await exec(
      conn,
      `systemctl is-active sing-box || echo inactive; systemctl is-active xray || echo inactive; F=/etc/singray/certs/${domain}/fullchain.pem; test -f $F && openssl x509 -enddate -noout -in $F | cut -d= -f2 || echo no-cert`,
      { timeoutClass: 'quick' },
    );
    const [sb, xr, certEnd] = r.stdout.trim().split('\n');
    health.singbox = sb === 'active' ? 'up' : 'down';
    health.xray = xr === 'active' ? 'up' : 'down';
    if (certEnd && certEnd !== 'no-cert') {
      const days = Math.floor((new Date(certEnd).getTime() - Date.now()) / 86400000);
      health.certDays = Number.isFinite(days) ? days : null;
    }
  } catch {
    // SSH 探活成功但执行失败(超时等) → 核心状态 unknown
  }
  return health;
}

const lastStates = new Map<number, MachineHealth>();

/** 一轮完整健康检查;返回摘要文本(供调度器落库) */
export async function runHealthCheckCycle(
  db: DatabaseSync,
  opts?: { probe?: (serverId: number) => Promise<MachineHealth> },
): Promise<string> {
  const servers = db.prepare("SELECT id FROM servers WHERE control = 'ssh' ORDER BY id").all() as { id: number }[];
  const alerts: string[] = [];
  const certExpiring: string[] = [];

  for (const { id } of servers) {
    let curr: MachineHealth;
    try {
      curr = opts?.probe ? await opts.probe(id) : await checkServer(db, id);
    } catch {
      continue;
    }
    alerts.push(...diffHealth(lastStates.get(id), curr));
    lastStates.set(id, curr);

    // 证书临期(≤30 天):每天最多告警一次
    if (curr.certDays !== null && curr.certDays <= 30) {
      certExpiring.push(`${curr.name}(${curr.certDays} 天)`);
    }

    // 写回 servers 状态列(自动刷新,替代人肉巡检)
    db.prepare('UPDATE servers SET ping_status = ?, xray_ping_status = ?, last_seen = ? WHERE id = ?').run(
      curr.ssh === 'up' ? 'online' : 'offline',
      curr.xray === 'unknown' ? 'unknown' : curr.xray === 'up' ? 'online' : curr.xray === 'down' ? 'offline' : 'unknown',
      new Date().toISOString(),
      id,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const lastCertAlert = db.prepare("SELECT value FROM settings WHERE key = 'last_cert_alert_date'").get() as { value: string } | undefined;
  if (certExpiring.length > 0 && lastCertAlert?.value !== today) {
    alerts.push(`证书即将到期(≤30 天): ${certExpiring.join('、')}`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('last_cert_alert_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
  }

  if (alerts.length > 0) {
    await sendAlert(db, 'SingRayPanel 健康检查', alerts.join('\n'));
  }
  return alerts.length > 0 ? `${alerts.length} 条状态变化告警` : `${servers.length} 台机器检查完成,无状态变化`;
}

/** 测试用:清空基线 */
export function resetHealthBaseline(): void {
  lastStates.clear();
}
