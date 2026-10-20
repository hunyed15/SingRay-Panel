import { existsSync } from 'node:fs';
import path from 'node:path';
import { isVersionSpec, PINNED_SINGBOX_VERSION, PINNED_XRAY_VERSION } from './core/versions.js';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// .env 自动加载。README 让用户 `cp .env.example .env`,但此前全仓没有 dotenv、
// dev 脚本也没有 --env-file,那份文件从未生效 —— 用户以为配了密钥,实际仍在用默认值。
// 已存在的环境变量优先(systemd EnvironmentFile / 容器 env 不会被覆盖)。
const envFile = process.env.PANEL_ENV_FILE
  ? path.resolve(process.env.PANEL_ENV_FILE)
  : path.resolve(DIR, '../../../.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile);
  } catch {
    console.warn(`[config] .env 解析失败,已忽略:${envFile}`);
  }
}

const RAW_DB = process.env.PANEL_DB ?? './data/panel.db';

/** 核心版本:默认取固定版本;`latest` 允许但要显式写;写错直接拒绝启动(比 404 下载好排查) */
function readCoreVersion(envName: string, pinned: string): string {
  const raw = (process.env[envName] ?? pinned).trim();
  if (!isVersionSpec(raw)) {
    throw new Error(`拒绝启动:${envName}=${raw} 不是合法版本号(形如 1.13.18,或 latest)`);
  }
  return raw.replace(/^v/, '');
}

export const config = {
  host: process.env.PANEL_HOST ?? '127.0.0.1',
  port: Number(process.env.PANEL_PORT ?? 3000),
  // 反向代理后(nginx/caddy):开了才会按 X-Forwarded-For 取真实客户端 IP,
  // 否则限流会把所有请求算成 127.0.0.1 —— 攻击者 10 次/分就能锁死管理员登录。
  // 直连部署保持关闭(否则客户端可以伪造 XFF 绕过限流)。
  trustProxy: process.env.PANEL_TRUST_PROXY === '1',
  // ':memory:' 哨兵直传(测试用),其余路径基于 server 包目录解析
  dbPath: RAW_DB === ':memory:' ? RAW_DB : path.resolve(DIR, '../..', RAW_DB),
  jwtSecret: process.env.PANEL_JWT_SECRET ?? 'dev-only-change-me',
  // 字段加密密钥:旧面板用独立 APP_SECRET,迁移场景必须设为旧值,否则旧密文解不开
  appSecret: process.env.PANEL_APP_SECRET ?? process.env.PANEL_JWT_SECRET ?? 'dev-only-change-me',
  // 核心安装(生命周期)配置
  singboxDownloadBase: process.env.SINGBOX_DOWNLOAD_BASE ?? 'https://github.com/SagerNet/sing-box/releases/download',
  singboxVersion: readCoreVersion('SINGBOX_VERSION', PINNED_SINGBOX_VERSION),
  xrayDownloadBase: process.env.XRAY_DOWNLOAD_BASE ?? 'https://github.com/XTLS/Xray-core/releases/download',
  xrayVersion: readCoreVersion('XRAY_VERSION', PINNED_XRAY_VERSION),
  // 运维:数据库备份(空 = db 同目录 backups/;保留份数;每日备份小时)
  backupDir: process.env.PANEL_BACKUP_DIR ?? '',
  backupRetention: Number(process.env.PANEL_BACKUP_RETENTION ?? 14),
  backupHour: Number(process.env.PANEL_BACKUP_HOUR ?? 4),
  // 运维:健康检查间隔(分钟)
  healthIntervalMin: Number(process.env.PANEL_HEALTH_INTERVAL ?? 5),
  // 自动可用性探测间隔(分钟);0 = 关闭。探测从面板本机发起,面板到节点不通时结论无意义
  probeIntervalMin: Number(process.env.PANEL_PROBE_INTERVAL ?? 30),
  // ACME DNS-01:Cloudflare API Token(配置后证书签发走 DNS-01,无需 80 端口)
  cfToken: process.env.PANEL_CF_TOKEN ?? '',
  // 告警:Telegram Bot(未配置 = 仅落库不推送)
  tgBotToken: process.env.TG_BOT_TOKEN ?? '',
  tgChatId: process.env.TG_CHAT_ID ?? '',
};

// 弱密钥守卫:与监听地址**无关**。
// 旧实现只在 PANEL_HOST 非 127.0.0.1 时报错,而 README 推荐的 nginx 反代部署
// 恰好让进程监听 127.0.0.1 —— 守卫永不触发,公网实例可以用仓库里的默认串
// 离线伪造 admin JWT。示例占位符(change-me-*)同样属于"用户以为已配置"的陷阱。
const DEFAULT_SECRETS = new Set(['dev-only-change-me']);
const isWeakSecret = (value: string): boolean =>
  !value || DEFAULT_SECRETS.has(value) || /^(change-me|dev-only)/i.test(value);

const weakSecrets = [
  ['PANEL_JWT_SECRET', config.jwtSecret],
  ['PANEL_APP_SECRET', config.appSecret],
] as const;
const weak = weakSecrets.filter(([, value]) => isWeakSecret(value)).map(([name]) => name);
// 离线运维脚本(如 `npm run restore`)在 import 本模块前设这个变量跳过守卫:
// 恢复数据库不需要密钥,而最需要恢复的时候往往正是 .env 坏掉的时候。
// HTTP 服务进程永远不设它,所以线上守卫不受影响。
const skipGuardForOfflineTool = process.env.PANEL_ALLOW_WEAK_SECRETS === '1';
if (weak.length > 0 && !skipGuardForOfflineTool) {
  throw new Error(
    `拒绝启动:${weak.join(' 与 ')} 仍是默认值或 .env.example 的示例值。` +
      `请用 openssl rand -hex 32 生成后写入 .env(与 PANEL_HOST 无关,公网/反代部署同样要求)`,
  );
}
