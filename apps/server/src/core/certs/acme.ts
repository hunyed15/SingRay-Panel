// ACME 证书管理(via acme.sh):给机器的 client_host 域名签发 Let's Encrypt 真证书。
// 背景:新版 Xray-core 移除了 allowInsecure,自签证书路线失效,vmess/trojan 的 TLS
// 模板必须使用真证书。
// 两种验证方式:
//   - HTTP-01(standalone,需 80 端口可达)
//   - DNS-01(Cloudflare API,无需任何入站端口 → NAT VPS / 80 被拦的场景)
// 配置 PANEL_CF_TOKEN 后优先用 DNS-01,否则回退 HTTP-01。续期由 acme.sh cron 自动完成。

import type { SshConn, ExecFn } from '../ssh/executor.js';
import { exec, writeFile } from '../ssh/executor.js';
import { config } from '../../config.js';
import { resolveCfToken } from '../../services/settings.js';

export const CERT_BASE = '/etc/singray/certs';

export interface CertStatus {
  acmeInstalled: boolean;
  certExists: boolean;
  expiresAt: string | null;
  domain: string;
}

export function certPaths(domain: string) {
  return {
    fullchain: `${CERT_BASE}/${domain}/fullchain.pem`,
    key: `${CERT_BASE}/${domain}/key.pem`,
  };
}

const ACME_BIN = '~/.acme.sh/acme.sh';

export async function certStatus(conn: SshConn, domain: string, execFn: ExecFn = exec): Promise<CertStatus> {
  let acmeInstalled = false;
  try {
    const r = await execFn(conn, `test -f ${ACME_BIN} && echo YES || echo NO`, { timeoutClass: 'quick' });
    acmeInstalled = r.stdout.trim() === 'YES';
  } catch {
    /* 探测失败按未安装 */
  }
  const { fullchain } = certPaths(domain);
  let certExists = false;
  let expiresAt: string | null = null;
  try {
    const r = await execFn(conn, `test -f ${fullchain} && echo YES || echo NO`, { timeoutClass: 'quick' });
    certExists = r.stdout.trim() === 'YES';
    if (certExists) {
      const end = await execFn(conn, `openssl x509 -enddate -noout -in ${fullchain} | cut -d= -f2`, { timeoutClass: 'quick' });
      expiresAt = new Date(end.stdout.trim()).toISOString() || null;
    }
  } catch {
    /* 证书不存在/openssl 失败 */
  }
  return { acmeInstalled, certExists, expiresAt, domain };
}

/**
 * 签发并安装证书(幂等:已有同域名证书时跳过签发,仅确保安装+reloadcmd)。
 * 验证方式:配置 PANEL_CF_TOKEN 时用 DNS-01(无需入站端口),否则 HTTP-01(需 80 端口)。
 */
export async function issueCert(
  conn: SshConn,
  domain: string,
  execFn: ExecFn = exec,
  /** Cloudflare Token(DB 解析后的值);缺省用 env */
  cfToken?: string,
): Promise<{ steps: string[]; method: 'dns-01' | 'http-01' }> {
  const steps: string[] = [];
  const { fullchain, key } = certPaths(domain);
  const reloadCmd = `systemctl reload sing-box 2>/dev/null; systemctl restart xray 2>/dev/null; true`;
  const token = cfToken ?? config.cfToken;
  const useDns = Boolean(token);

  // 1. 安装 acme.sh(缺省 CA 指向 Let's Encrypt);get.acme.sh 在部分网络被拒 → GitHub tarball 兜底
  const st = await certStatus(conn, domain, execFn);
  if (!st.acmeInstalled) {
    await execFn(
      conn,
      `(curl -s https://get.acme.sh | sh -s email=admin@${domain} >/dev/null 2>&1 && test -f ${ACME_BIN}) || (rm -rf /tmp/acme-src && curl -sL https://github.com/acmesh-official/acme.sh/archive/refs/heads/master.tar.gz -o /tmp/acme.tgz && mkdir -p /tmp/acme-src && tar xzf /tmp/acme.tgz -C /tmp/acme-src --strip-components=1 && cd /tmp/acme-src && ./acme.sh --install -m admin@${domain} --force >/dev/null 2>&1)`,
      { timeoutClass: 'install' },
    );
    await execFn(conn, `${ACME_BIN} --set-default-ca --server letsencrypt`, { timeoutClass: 'config' });
    steps.push('acme.sh 安装');
  } else {
    steps.push('acme.sh 已存在');
  }

  // 2. 签发:已有则跳过;DNS-01 优先,HTTP-01 兜底
  if (await hasAcmeCert(conn, domain, execFn)) {
    steps.push('证书已存在,跳过签发');
  } else if (useDns) {
    await issueCertDns01(conn, domain, token, execFn, steps);
  } else {
    await execFn(
      conn,
      // POSIX 兼容:捕获签发退出码(dash 不支持 pipefail),失败(80 被占/域名未解析)不被 tail 掩盖
      `out=$(${ACME_BIN} --issue -d ${domain} --standalone --server letsencrypt 2>&1); rc=$?; printf '%s\n' "$out" | tail -5; exit $rc`,
      { timeoutClass: 'install' },
    );
    steps.push(`HTTP-01 签发 ${domain}`);
  }

  // 3. 安装到固定路径 + 续期后自动重载核心
  await execFn(conn, `mkdir -p $(dirname ${fullchain})`, { timeoutClass: 'quick' });
  await execFn(
    conn,
    `${ACME_BIN} --install-cert -d ${domain} --fullchain-file ${fullchain} --key-file ${key} --reloadcmd "${reloadCmd}"`,
    { timeoutClass: 'config' },
  );
  steps.push('安装证书 + 续期自动重载');
  return { steps, method: useDns ? 'dns-01' : 'http-01' };
}

/** 部署时检测机器上是否有真证书可用(有则模板优先使用,无则退回自签) */
export async function hasRealCert(conn: SshConn, domain: string, execFn: ExecFn = exec): Promise<boolean> {
  if (!domain || /^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain.includes(':')) return false; // IP/IPv6 无法签发
  const { fullchain } = certPaths(domain);
  try {
    const r = await execFn(conn, `test -f ${fullchain} && echo YES || echo NO`, { timeoutClass: 'quick' });
    return r.stdout.trim() === 'YES';
  } catch {
    return false;
  }
}

// ---------- DNS-01 (Cloudflare) ----------

/** 是否配置了 Cloudflare Token(DNS-01 模式可用);DB 值优先,env 兜底 */
export function dns01Available(db?: import('node:sqlite').DatabaseSync): boolean {
  if (db) return Boolean(resolveCfToken(db));
  return Boolean(config.cfToken);
}

/**
 * DNS-01 签发(经 Cloudflare API,不依赖任何入站端口)。
 * acme.sh 的 dns_cf 插件经 CF_Token 环境变量认证。
 */
async function issueCertDns01(conn: SshConn, domain: string, token: string, execFn: ExecFn, steps: string[]): Promise<void> {
  const r = await execFn(
    conn,
    // 环境变量只在本条命令内可见,不落盘;acme.sh dns_cf 插件读 CF_Token
    `export CF_Token='${token}'; out=$(${ACME_BIN} --issue -d ${domain} --dns dns_cf --server letsencrypt 2>&1); rc=$?; printf '%s\\n' "$out" | tail -6; exit $rc`,
    { timeoutClass: 'install' },
  );
  if (r.stdout.trim()) {
    const last = r.stdout.trim().split('\n').pop() ?? '';
    steps.push(`DNS-01 签发(${last.slice(0, 60)})`);
  } else {
    steps.push('DNS-01 签发');
  }
}

/** 查询 acme.sh 中该域名是否已有证书(避免重复签发) */
async function hasAcmeCert(conn: SshConn, domain: string, execFn: ExecFn): Promise<boolean> {
  try {
    const r = await execFn(conn, `${ACME_BIN} --list 2>/dev/null | grep -c '${domain}' || echo 0`, { timeoutClass: 'quick' });
    return Number(r.stdout.trim()) > 0;
  } catch {
    return false;
  }
}

export { hasAcmeCert };
