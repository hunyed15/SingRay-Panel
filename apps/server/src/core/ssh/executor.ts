// SSH execution layer. Ported from singbox-panel ssh.js with design.md §3
// upgrades: timeout classes (settings-overridable), structured SshExecError
// carrying exit code + stderr, sftp staging for sudo machines, and
// ProxyJump support (conn.jump = 跳板机连接参数,解决本地无 IPv6/直连不稳)。

import { Client, type ConnectConfig } from 'ssh2';
import type { Duplex } from 'node:stream';

export type TimeoutClass = 'quick' | 'config' | 'install';

/** default per-class budgets; overridable via settings table (M4) */
export const TIMEOUT_DEFAULTS_MS: Record<TimeoutClass, number> = {
  quick: 10_000,
  config: 30_000,
  install: 300_000,
};

export interface SshConn extends ConnectConfig {
  /** server row id */
  serverId: number;
  sudo: boolean;
  /** 跳板机连接参数:先连 jump,再 forwardOut 到目标(ProxyJump) */
  jump?: SshConn;
}

/** 建立到目标的 SSH 客户端(支持经跳板机);resolve 于 ready */
async function connectClient(conn: SshConn): Promise<Client> {
  if (!conn.jump) {
    const c = new Client();
    await new Promise<void>((resolve, reject) => {
      c.on('ready', () => resolve());
      c.on('error', reject);
      c.connect({ ...conn, readyTimeout: 60_000 });
    });
    return c;
  }
  // 两跳:先连跳板机,再 forwardOut 打隧道到目标 SSH 端口
  const jump = new Client();
  await new Promise<void>((resolve, reject) => {
    jump.on('ready', () => resolve());
    jump.on('error', reject);
    jump.connect(conn.jump as ConnectConfig);
  });
  const sock: Duplex = await new Promise((resolve, reject) => {
    jump.forwardOut('127.0.0.1', 0, conn.host!, conn.port ?? 22, (err, stream) => {
      if (err) {
        jump.end();
        reject(err);
        return;
      }
      resolve(stream);
    });
  });
  const c = new Client();
  await new Promise<void>((resolve, reject) => {
    c.on('ready', () => resolve());
    c.on('error', (err) => {
      jump.end();
      reject(err);
    });
    c.connect({ ...conn, readyTimeout: 60_000, sock });
  });
  // 目标连接断开时同步释放跳板机
  c.on('close', () => jump.end());
  return c;
}

/** 按服务器行组装 ssh2 连接参数(凭据解密后使用) */
export function buildConn(
  serverRow: {
    id: number;
    host: string;
    ssh_port: number;
    ssh_user: string;
    ssh_auth_type: 'key' | 'password';
    ssh_auth_secret: string;
    ssh_sudo: number;
  },
  decrypt: (secret: string) => string,
): SshConn {
  const base: SshConn = {
    serverId: serverRow.id,
    host: serverRow.host,
    port: serverRow.ssh_port || 22,
    username: serverRow.ssh_user || 'root',
    sudo: serverRow.ssh_sudo === 1,
  };
  const secret = decrypt(serverRow.ssh_auth_secret);
  if (serverRow.ssh_auth_type === 'password') return { ...base, password: secret };
  return { ...base, privateKey: secret };
}

/** conn.sudo 时整条包进 root shell(sudo -n sh -c):变量赋值/&& 链/单引号都能正确提权 */
export function buildExecCmd(conn: Pick<SshConn, 'sudo'>, cmd: string): string {
  if (!conn.sudo) return cmd;
  return `sudo -n -- sh -c '${cmd.replace(/'/g, `'\\''`)}'`;
}

export class SshExecError extends Error {
  constructor(
    message: string,
    public readonly cmd: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'SshExecError';
  }
}

export interface ExecOptions {
  timeoutClass?: TimeoutClass;
  /** explicit override, wins over class defaults */
  timeoutMs?: number;
}

export type ExecFn = (conn: SshConn, cmd: string, opts?: ExecOptions) => Promise<{ stdout: string; stderr: string }>;

/** 远程执行命令;非 0 退出或超时 → SshExecError(结构化:cmd/exitCode/stderr) */
export const exec: ExecFn = (conn, cmd, opts = {}) => {
  const base = opts.timeoutMs ?? TIMEOUT_DEFAULTS_MS[opts.timeoutClass ?? 'config'];
  // 跳板隧道连接慢(两跳握手 + 慢机器),给一个 45s 下限
  const timeoutMs = conn.jump ? Math.max(base, 120_000) : base;
  const finalCmd = buildExecCmd(conn, cmd);
  return new Promise((resolve, reject) => {
    let settled = false;
    let client: Client | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.end();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new SshExecError(`ssh exec timeout after ${timeoutMs}ms`, finalCmd, null, ''))), timeoutMs);

    connectClient(conn)
      .then((c) => {
        if (settled) {
          c.end();
          return;
        }
        client = c;
        c.exec(finalCmd, (err, stream) => {
          if (err) return finish(() => reject(err));
          let stdout = '';
          let stderr = '';
          stream.on('data', (d: Buffer) => (stdout += d.toString()));
          stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
          stream.on('close', (code: number | undefined) => {
            if (code !== 0) {
              const detail = stderr.trim() || `exit code ${code}`;
              finish(() => reject(new SshExecError(detail, finalCmd, code ?? null, stderr)));
              return;
            }
            finish(() => resolve({ stdout, stderr }));
          });
        });
      })
      .catch((err) => finish(() => reject(err)));
  });
};

/** 经 sftp 写文件(覆盖)。sudo 机器:暂存 /tmp 后 sudo install 到目标(普通用户写不了 /etc) */
export async function writeFile(conn: SshConn, remotePath: string, content: string, execFn: ExecFn = exec): Promise<void> {
  if (conn.sudo) {
    const name = remotePath.split('/').pop() || `f${Date.now()}`;
    const stage = `/tmp/singray-stage-${process.pid}-${Date.now()}-${name}`;
    await sftpWrite(conn, stage, content);
    await execFn(conn, `install -m 600 '${stage}' '${remotePath}' && rm -f '${stage}'`, { timeoutClass: 'config' });
    return;
  }
  await sftpWrite(conn, remotePath, content);
}

async function sftpWrite(conn: SshConn, remotePath: string, content: string): Promise<void> {
  const c = await connectClient(conn);
  return new Promise<void>((resolve, reject) => {
    c.sftp((err, sftp) => {
      if (err) {
        c.end();
        return reject(err);
      }
      const ws = sftp.createWriteStream(remotePath);
      ws.on('error', (e: Error) => {
        c.end();
        reject(e);
      });
      ws.on('close', () => {
        c.end();
        resolve();
      });
      ws.end(content);
    });
  });
}

/** SSH 连通性测试(echo ok);execFn 可注入以便测试 */
export async function testConnection(conn: SshConn, execFn: ExecFn = exec): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await execFn(conn, 'echo ok', { timeoutClass: 'quick' });
    return { ok: r.stdout.trim() === 'ok', message: r.stdout.trim() };
  } catch (err) {
    const e = err as SshExecError;
    return { ok: false, message: `${e.name === 'SshExecError' ? `[exit ${e.exitCode}] ` : ''}${e.message}` };
  }
}
