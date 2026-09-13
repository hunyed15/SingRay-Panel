// Core lifecycle management (install / restart / uninstall), ported from
// singbox-panel routes/servers.js controlAction + xrayControlAction.
// Install downloads release binaries (GitHub, gh-proxy mirror fallback),
// writes systemd units + minimal config, enables the service.

import type { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { exec, writeFile } from '../core/ssh/executor.js';
import { rowConn } from './conn.js';
import type { ExecFn, SshConn } from '../core/ssh/executor.js';
import { decrypt } from '../core/crypto.js';
import type { Row } from './row.js';

export type CoreKind = 'singbox' | 'xray';
export type LifecycleAction = 'install' | 'restart' | 'uninstall';

const SINGBOX_FALLBACK_VERSION = '1.13.18';
const XRAY_FALLBACK_VERSION = '24.11.30';

const SINGBOX_UNIT = (bin: string, cfg: string) => `[Unit]
Description=sing-box
After=network.target

[Service]
Type=simple
ExecStart=${bin} run -c ${cfg}
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

const XRAY_UNIT = (bin: string, cfg: string) => `[Unit]
Description=Xray
After=network.target

[Service]
Type=simple
ExecStart=${bin} run -c ${cfg}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

/** 'latest' → GitHub 最新 release;失败回退固定版本 */
async function resolveVersion(repo: string, pinned: string, fallback: string): Promise<string> {
  if (pinned !== 'latest') return pinned;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const tag = (await res.json())?.tag_name || '';
      if (/^v?\d+\.\d+\.\d+/.test(tag)) return tag.replace(/^v/, '');
    }
  } catch {
    /* 网络失败走回退 */
  }
  return fallback;
}

function singboxArch(unameOut: string): string {
  const m = unameOut.trim();
  const map: Record<string, string> = { x86_64: 'amd64', aarch64: 'arm64', armv7l: 'armv7', riscv64: 'riscv64' };
  return map[m] || m;
}

function xrayArch(unameOut: string): string {
  const m = unameOut.trim();
  // xray 与 sing-box 发布包命名不同
  const map: Record<string, string> = { x86_64: '64', aarch64: 'arm64-v8a', armv7l: 'arm32-v7a', riscv64: 'riscv64' };
  return map[m] || m;
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw new Error(`[${label}] ${(err as Error).message}`);
  }
}

const dlCmd = (file: string, url: string) =>
  `rm -f ${file}; (command -v curl >/dev/null && curl -fsSL -o ${file} '${url}') || (command -v wget >/dev/null && wget -q -O ${file} '${url}')`;

async function downloadWithMirror(conn: SshConn, file: string, url: string, execFn: ExecFn): Promise<void> {
  try {
    await execFn(conn, dlCmd(file, url), { timeoutClass: 'install' });
  } catch {
    // GitHub 直连失败 → gh-proxy 镜像兜底
    await execFn(conn, dlCmd(file, `https://gh-proxy.org/${url}`), { timeoutClass: 'install' });
  }
}

function getConn(db: DatabaseSync, serverId: number): { conn: SshConn; row: Row } {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as Row | undefined;
  if (!row) throw new Error('服务器不存在');
  return { row, conn: rowConn(db, row) };
}

export async function serverLifecycle(
  db: DatabaseSync,
  serverId: number,
  core: CoreKind,
  action: LifecycleAction,
  inject?: { execFn?: ExecFn; writeFileFn?: typeof writeFile },
): Promise<{ ok: true; steps: string[] }> {
  const { conn } = getConn(db, serverId);
  const execFn = inject?.execFn ?? exec;
  const writeFileFn = inject?.writeFileFn ?? writeFile;
  const steps: string[] = [];

  if (core === 'singbox') {
    const bin = '/usr/local/bin/sing-box';
    const cfg = '/etc/sing-box/config.json';
    const unit = 'sing-box';
    if (action === 'install') {
      let arch = '';
      await step('架构探测', async () => {
        arch = singboxArch((await execFn(conn, 'uname -m', { timeoutClass: 'quick' })).stdout);
      });
      const ver = await resolveVersion('SagerNet/sing-box', config.singboxVersion, SINGBOX_FALLBACK_VERSION);
      const url = `${config.singboxDownloadBase}/v${ver}/sing-box-${ver}-linux-${arch}.tar.gz`;
      steps.push(`download ${ver}`);
      await step('下载', () => downloadWithMirror(conn, '/tmp/singbox.tar.gz', url, execFn));
      await step('解压', async () => { await execFn(conn, 'rm -rf /tmp/singbox-extract && mkdir -p /tmp/singbox-extract && tar -xzf /tmp/singbox.tar.gz -C /tmp/singbox-extract', { timeoutClass: 'config' }); });
      await step('安装二进制', async () => {
        // find 定位二进制,不依赖解压目录名
        await execFn(conn, `BIN=$(find /tmp/singbox-extract -type f -name sing-box | head -1) && test -n "$BIN" && install -m 755 "$BIN" ${bin}`, { timeoutClass: 'config' });
      });
      await step('写 systemd 单元', async () => {
        await execFn(conn, 'mkdir -p /etc/systemd/system', { timeoutClass: 'quick' });
        await writeFileFn(conn, `/etc/systemd/system/${unit}.service`, SINGBOX_UNIT(bin, cfg), execFn);
      });
      // 最小合法配置,装完即可启动;之后建节点 deploy 会覆盖为真实配置
      await step('写最小配置', async () => {
        await execFn(conn, 'mkdir -p /etc/sing-box', { timeoutClass: 'quick' });
        await writeFileFn(
          conn,
          cfg,
          JSON.stringify({ log: { level: 'info', timestamp: true }, inbounds: [], outbounds: [{ type: 'direct', tag: 'direct' }], route: { final: 'direct' } }, null, 2),
          execFn,
        );
      });
      await step('启动服务', async () => { await execFn(conn, `systemctl daemon-reload && systemctl enable --now ${unit}`, { timeoutClass: 'config' }); });
    } else if (action === 'restart') {
      await step('重启', async () => { await execFn(conn, `systemctl restart ${unit}`, { timeoutClass: 'config' }); });
    } else {
      await step('卸载', async () => {
        await execFn(conn, `systemctl disable --now ${unit}`, { timeoutClass: 'config' });
        await execFn(conn, `rm -f /etc/systemd/system/${unit}.service ${bin}`, { timeoutClass: 'quick' });
        await execFn(conn, 'systemctl daemon-reload', { timeoutClass: 'quick' });
      });
    }
    steps.push(`${action} sing-box`);
    return { ok: true, steps };
  }

  // xray
  const bin = '/usr/local/bin/xray';
  const cfg = '/etc/xray/config.json';
  const unit = 'xray';
  if (action === 'install') {
    let arch = '';
    await step('架构探测', async () => {
      arch = xrayArch((await execFn(conn, 'uname -m', { timeoutClass: 'quick' })).stdout);
    });
    const ver = await resolveVersion('XTLS/Xray-core', config.xrayVersion, XRAY_FALLBACK_VERSION);
    const url = `${config.xrayDownloadBase}/v${ver}/xray-linux-${arch}.zip`;
    steps.push(`download ${ver}`);
    await step('下载', () => downloadWithMirror(conn, '/tmp/xray.zip', url, execFn));
    await step('安装 unzip', async () => {
      await execFn(conn, `(command -v unzip >/dev/null || (apt-get update -qq && apt-get install -y -qq unzip) || (yum install -y -q unzip) || true)`, { timeoutClass: 'install' });
    });
    await step('解压', async () => { await execFn(conn, 'rm -rf /tmp/xray-extract && mkdir -p /tmp/xray-extract && unzip -o /tmp/xray.zip -d /tmp/xray-extract', { timeoutClass: 'config' }); });
    await step('安装二进制', async () => {
      await execFn(conn, `BIN=$(find /tmp/xray-extract -type f -name xray | head -1) && test -n "$BIN" && install -m 755 "$BIN" ${bin}`, { timeoutClass: 'config' });
    });
    await step('写 systemd 单元', async () => {
      await execFn(conn, 'mkdir -p /etc/systemd/system', { timeoutClass: 'quick' });
      await writeFileFn(conn, `/etc/systemd/system/${unit}.service`, XRAY_UNIT(bin, cfg), execFn);
    });
    await step('写最小配置', async () => {
      await execFn(conn, `mkdir -p $(dirname ${cfg})`, { timeoutClass: 'quick' });
      await writeFileFn(
        conn,
        cfg,
        JSON.stringify({ log: { loglevel: 'warning' }, inbounds: [], outbounds: [{ protocol: 'freedom', tag: 'direct' }], routing: { domainStrategy: 'AsIs', rules: [] } }, null, 2),
        execFn,
      );
    });
    await step('启动服务', async () => { await execFn(conn, `systemctl daemon-reload && systemctl enable --now ${unit}`, { timeoutClass: 'config' }); });
    db.prepare('UPDATE servers SET xray_version = ?, xray_ping_status = ? WHERE id = ?').run(ver, 'online', serverId);
  } else if (action === 'restart') {
    await step('重启', async () => { await execFn(conn, `systemctl restart ${unit}`, { timeoutClass: 'config' }); });
  } else {
    await step('卸载', async () => {
      await execFn(conn, `systemctl disable --now ${unit}`, { timeoutClass: 'config' });
      await execFn(conn, `rm -f /etc/systemd/system/${unit}.service ${bin} ${cfg}`, { timeoutClass: 'quick' });
      await execFn(conn, 'systemctl daemon-reload', { timeoutClass: 'quick' });
      db.prepare('UPDATE servers SET xray_version = ?, xray_ping_status = ? WHERE id = ?').run('', 'unknown', serverId);
    });
  }
  steps.push(`${action} xray`);
  return { ok: true, steps };
}
