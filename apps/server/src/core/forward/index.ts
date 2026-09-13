// Port-forward engine (design.md §4). iptables is the primary mechanism;
// socat (systemd unit) is an explicit user choice — never a silent fallback.
// All rules are tagged `singray:<id>` so reconcile can tell ours apart.

import type { SshConn, ExecFn } from '../ssh/executor.js';
import { exec, writeFile as defaultWriteFile } from '../ssh/executor.js';

export interface ForwardSpec {
  /** db row id, used in rule comments/unit names */
  id: number;
  entryPort: number;
  landingHost: string;
  targetPort: number;
  mechanism: 'iptables' | 'socat';
}

export interface PreflightResult {
  iptablesAvailable: boolean;
  socatAvailable: boolean;
  ipForward: '1' | '0' | 'unknown';
  entryPortBusy: boolean;
  issues: string[];
}

const TAG = (id: number) => `singray:${id}`;

export async function preflight(conn: SshConn, entryPort: number, execFn: ExecFn = exec): Promise<PreflightResult> {
  const issues: string[] = [];
  let iptablesAvailable = false;
  try {
    const r = await execFn(conn, 'command -v iptables >/dev/null 2>&1 && echo YES || echo NO', { timeoutClass: 'quick' });
    iptablesAvailable = r.stdout.trim() === 'YES';
    if (!iptablesAvailable) issues.push('入口机缺少 iptables 命令');
  } catch (err) {
    issues.push(`iptables 可用性检测失败: ${(err as Error).message}`);
  }

  let ipForward: PreflightResult['ipForward'] = 'unknown';
  try {
    const r = await execFn(conn, 'cat /proc/sys/net/ipv4/ip_forward', { timeoutClass: 'quick' });
    ipForward = r.stdout.trim() === '1' ? '1' : '0';
    if (ipForward === '0') issues.push('入口机未开启 net.ipv4.ip_forward(创建 iptables 规则时将自动开启)');
  } catch {
    issues.push('无法读取 ip_forward 状态');
  }

  let socatAvailable = false;
  try {
    const r = await execFn(conn, 'command -v socat >/dev/null 2>&1 && echo YES || echo NO', { timeoutClass: 'quick' });
    socatAvailable = r.stdout.trim() === 'YES';
  } catch {
    // 探测失败按缺失处理,创建 socat 规则时会得到明确报错
  }

  let entryPortBusy = false;
  try {
    const r = await execFn(conn, `ss -tln 2>/dev/null | grep -q ':${entryPort} ' && echo BUSY || echo FREE`, { timeoutClass: 'quick' });
    entryPortBusy = r.stdout.trim() === 'BUSY';
    if (entryPortBusy) issues.push(`入口端口 ${entryPort} 已被占用`);
  } catch {
    // ss 不可用时跳过占用检查,不视为硬错误
  }

  return { iptablesAvailable, socatAvailable, ipForward, entryPortBusy, issues };
}

/** 确保入口机开启 v4/v6 转发并持久化(sudo 机器由 sudo -n 包装) */
async function ensureIpForward(conn: SshConn, execFn: ExecFn): Promise<void> {
  await execFn(conn, `sysctl -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1`, { timeoutClass: 'quick' });
  await execFn(
    conn,
    `printf 'net.ipv4.ip_forward=1\nnet.ipv6.conf.all.forwarding=1\n' > /etc/sysctl.d/99-singray-forward.conf && sysctl --system >/dev/null`,
    { timeoutClass: 'config' },
  );
}

/** 在入口机上解析落地主机 → IP(nf_tables 不接受域名;v4 优先,纯 v6 目标用 v6) */
export async function resolveTargetIP(conn: SshConn, host: string, execFn: ExecFn): Promise<{ ip: string; family: 'v4' | 'v6' }> {
  if (host.includes(':')) return { ip: host, family: 'v6' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ip: host, family: 'v4' };
  const r = await execFn(conn, `getent ahosts ${host} 2>/dev/null | awk '{print $1}' | sort -u`, { timeoutClass: 'quick' });
  const addrs = r.stdout.trim().split('\n').filter(Boolean);
  const v4 = addrs.find((a) => !a.includes(':'));
  const v6 = addrs.find((a) => a.includes(':'));
  if (v4) return { ip: v4, family: 'v4' };
  if (v6) return { ip: v6, family: 'v6' };
  throw new Error(`入口机无法解析落地主机 ${host}(检查 DNS / hosts)`);
}

export async function applyForward(
  conn: SshConn,
  spec: ForwardSpec,
  remove: boolean,
  execFn: ExecFn = exec,
  /** injectable for tests; real impl stages via sftp + sudo install */
  writeFileFn: (conn: SshConn, path: string, content: string, execFn: ExecFn) => Promise<void> = defaultWriteFile,
): Promise<void> {
  if (spec.mechanism === 'iptables') {
    await ensureIpForward(conn, execFn).catch((err) => {
      throw new Error(`开启 ip_forward 失败: ${(err as Error).message}`);
    });
    const action = remove ? '-D' : '-A';
    const tag = TAG(spec.id);
    const { ip, family } = await resolveTargetIP(conn, spec.landingHost, execFn);
    const ipt = family === 'v6' ? 'ip6tables' : 'iptables';
    // ip6tables 的 v6 地址必须带方括号: [2607:...]:port
    const dest = family === 'v6' ? `[${ip}]:${spec.targetPort}` : `${ip}:${spec.targetPort}`;
    const cmds = [
      `${ipt} -t nat ${action} PREROUTING -p tcp --dport ${spec.entryPort} -m comment --comment ${tag} -j DNAT --to-destination ${dest}`,
      `${ipt} ${action} FORWARD -p tcp -d ${ip} --dport ${spec.targetPort} -j ACCEPT`,
    ];
    for (const cmd of cmds) {
      try {
        await execFn(conn, cmd, { timeoutClass: 'config' });
      } catch (err) {
        // iptables -D 对不存在的规则报错;删除场景视为已达成
        if (remove && /No such file or directory| Bad rule /i.test((err as Error).message)) continue;
        throw new Error(`iptables ${remove ? '删除' : '写入'}规则失败: ${(err as Error).message}`);
      }
    }
    // v4+v6 规则都落盘(v6 不落盘则重启后 v6 中转静默消失)
    await execFn(
      conn,
      `(command -v iptables-save >/dev/null && iptables-save > /etc/iptables/rules.v4 2>/dev/null) || true; (command -v ip6tables-save >/dev/null && mkdir -p /etc/iptables && ip6tables-save > /etc/iptables/rules.v6 2>/dev/null) || true`,
      { timeoutClass: 'config' },
    );
    return;
  }

  // socat via systemd unit — explicit mechanism, created/removed idempotently
  const unit = `singray-fwd-${spec.entryPort}.service`;
  if (remove) {
    await execFn(conn, `systemctl stop ${unit} --quiet 2>/dev/null; systemctl disable ${unit} --quiet 2>/dev/null; rm -f /etc/systemd/system/${unit}; systemctl daemon-reload --quiet`, { timeoutClass: 'config' });
    return;
  }
  // 确保 socat 二进制存在(显式安装,不是降级)
  await execFn(conn, `(command -v socat >/dev/null || (apt-get update -qq && apt-get install -y -qq socat) || (yum install -y -q socat))`, { timeoutClass: 'install' });
  const unitContent = [
    '[Unit]',
    `Description=SingRayPanel port forward ${spec.entryPort} -> ${spec.landingHost}:${spec.targetPort}`,
    'After=network.target',
    '',
    '[Service]',
    'ExecStart=/usr/bin/socat TCP-LISTEN:' + spec.entryPort + ',fork,reuseaddr TCP:' + spec.landingHost + ':' + spec.targetPort,
    'Restart=always',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  const { writeFile } = await import('../ssh/executor.js');
  await writeFileFn(conn, `/etc/systemd/system/${unit}`, unitContent, execFn);
  await execFn(conn, `systemctl daemon-reload && systemctl enable --now ${unit}`, { timeoutClass: 'config' });
  await execFn(conn, `systemctl daemon-reload && systemctl enable --now ${unit}`, { timeoutClass: 'config' });
}

export interface ReconcileReport {
  /** iptables DNAT rules with our tag actually present on the machine */
  actualIptables: string[];
  /** singray-fwd-* units actually present */
  actualSocatUnits: string[];
  /** db says iptables but machine lacks it */
  missingIptables: number[];
  /** db says socat but unit missing/inactive */
  missingSocat: number[];
  /** machine has our rules that db doesn't know */
  orphanIptables: string[];
  orphanSocat: string[];
}

/** 对账:机器实际规则 vs DB 期望。dbRules: [{id, mechanism, entryPort}] */
export async function reconcile(
  conn: SshConn,
  dbRules: { id: number; mechanism: 'iptables' | 'socat'; entryPort: number }[],
  execFn: ExecFn = exec,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    actualIptables: [],
    actualSocatUnits: [],
    missingIptables: [],
    missingSocat: [],
    orphanIptables: [],
    orphanSocat: [],
  };

  const ipt = await execFn(
    conn,
    `iptables -t nat -S PREROUTING 2>/dev/null | grep 'singray:' || true`,
    { timeoutClass: 'quick' },
  );
  report.actualIptables = ipt.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  const units = await execFn(
    conn,
    `systemctl list-units --quiet 'singray-fwd-*' --no-legend 2>/dev/null | awk '{print $1}' || true`,
    { timeoutClass: 'quick' },
  );
  report.actualSocatUnits = units.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  const dbIptables = new Set(dbRules.filter((r) => r.mechanism === 'iptables').map((r) => r.id));
  const dbSocat = new Set(dbRules.filter((r) => r.mechanism === 'socat').map((r) => r.entryPort));

  for (const line of report.actualIptables) {
    const m = line.match(/singray:(\d+)/);
    const id = m ? Number(m[1]) : null;
    if (id === null || !dbIptables.has(id)) report.orphanIptables.push(line);
    else dbIptables.delete(id);
  }
  report.missingIptables = [...dbIptables];

  for (const unit of report.actualSocatUnits) {
    const m = unit.match(/singray-fwd-(\d+)\.service/);
    const port = m ? Number(m[1]) : null;
    if (port === null || !dbSocat.has(port)) report.orphanSocat.push(unit);
    else dbSocat.delete(port);
  }
  report.missingSocat = [...dbSocat];

  return report;
}
