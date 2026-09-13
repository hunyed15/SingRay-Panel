// ACME 证书管理(via acme.sh):给机器的 client_host 域名签发 Let's Encrypt 真证书。
// 背景:新版 Xray-core 移除了 allowInsecure,自签证书路线失效,vmess/trojan 的 TLS
// 模板必须使用真证书。签发用 standalone 模式(临时占用 80 端口),续期由 acme.sh cron
// 自动完成,reloadcmd 在续期后重载核心。

import type { SshConn, ExecFn } from '../ssh/executor.js';
import { exec, writeFile } from '../ssh/executor.js';

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
 * 前提:domain 解析到本机,且 80 端口空闲可临时绑定(HTTP-01 standalone)。
 */
export async function issueCert(conn: SshConn, domain: string, execFn: ExecFn = exec): Promise<{ steps: string[] }> {
  const steps: string[] = [];
  const { fullchain, key } = certPaths(domain);
  const reloadCmd = `systemctl reload sing-box 2>/dev/null; systemctl restart xray 2>/dev/null; true`;

  // 1. 安装 acme.sh(缺省 CA 指向 Let's Encrypt)
  const st = await certStatus(conn, domain, execFn);
  if (!st.acmeInstalled) {
    await execFn(conn, `curl -s https://get.acme.sh | sh -s email=admin@${domain}`, { timeoutClass: 'install' });
    await execFn(conn, `${ACME_BIN} --set-default-ca --server letsencrypt`, { timeoutClass: 'config' });
    steps.push('acme.sh 安装');
  } else {
    steps.push('acme.sh 已存在');
  }

  // 2. 签发(standalone 临时占用 80 端口);已有有效证书时 --issue 会报 "Skip" 直接继续
  await execFn(
    conn,
    // POSIX 兼容:捕获签发退出码(dash 不支持 pipefail),失败(80 被占/域名未解析)不被 tail 掩盖
    `out=$(${ACME_BIN} --issue -d ${domain} --standalone --server letsencrypt 2>&1); rc=$?; printf '%s
' "$out" | tail -5; exit $rc`,
    { timeoutClass: 'install' },
  );
  steps.push(`签发 ${domain}`);

  // 3. 安装到固定路径 + 续期后自动重载核心
  await execFn(conn, `mkdir -p $(dirname ${fullchain})`, { timeoutClass: 'quick' });
  await execFn(
    conn,
    `${ACME_BIN} --install-cert -d ${domain} --fullchain-file ${fullchain} --key-file ${key} --reloadcmd "${reloadCmd}"`,
    { timeoutClass: 'config' },
  );
  steps.push('安装证书 + 续期自动重载');
  return { steps };
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

// writeFile 引用保留:未来 DNS-01 模式需要写 CA 配置
void writeFile;
