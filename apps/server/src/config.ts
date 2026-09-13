import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const RAW_DB = process.env.PANEL_DB ?? './data/panel.db';

export const config = {
  host: process.env.PANEL_HOST ?? '127.0.0.1',
  port: Number(process.env.PANEL_PORT ?? 3000),
  // ':memory:' 哨兵直传(测试用),其余路径基于 server 包目录解析
  dbPath: RAW_DB === ':memory:' ? RAW_DB : path.resolve(DIR, '../..', RAW_DB),
  jwtSecret: process.env.PANEL_JWT_SECRET ?? 'dev-only-change-me',
  // 字段加密密钥:旧面板用独立 APP_SECRET,迁移场景必须设为旧值,否则旧密文解不开
  appSecret: process.env.PANEL_APP_SECRET ?? process.env.PANEL_JWT_SECRET ?? 'dev-only-change-me',
  // 核心安装(生命周期)配置
  singboxDownloadBase: process.env.SINGBOX_DOWNLOAD_BASE ?? 'https://github.com/SagerNet/sing-box/releases/download',
  singboxVersion: process.env.SINGBOX_VERSION ?? 'latest',
  xrayDownloadBase: process.env.XRAY_DOWNLOAD_BASE ?? 'https://github.com/XTLS/Xray-core/releases/download',
  xrayVersion: process.env.XRAY_VERSION ?? 'latest',
};

// 生产防护:对外监听时禁止使用仓库默认密钥(否则任何知道仓库的人可伪造 admin JWT)
const DEFAULT_SECRETS = new Set(['dev-only-change-me']);
const weakSecrets = [config.jwtSecret, config.appSecret].filter((s) => DEFAULT_SECRETS.has(s));
if (!['127.0.0.1', 'localhost'].includes(process.env.PANEL_HOST ?? '127.0.0.1') && weakSecrets.length > 0) {
  throw new Error(`拒绝启动:对外监听(PANEL_HOST 非 127.0.0.1)禁止使用默认密钥,请配置 ${weakSecrets.join(' 与 ')}(openssl rand -hex 32)`);
}
