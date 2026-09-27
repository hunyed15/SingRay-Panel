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
  // 运维:数据库备份(空 = db 同目录 backups/;保留份数;每日备份小时)
  backupDir: process.env.PANEL_BACKUP_DIR ?? '',
  backupRetention: Number(process.env.PANEL_BACKUP_RETENTION ?? 14),
  backupHour: Number(process.env.PANEL_BACKUP_HOUR ?? 4),
  // 运维:健康检查间隔(分钟)
  healthIntervalMin: Number(process.env.PANEL_HEALTH_INTERVAL ?? 5),
  // 告警:Telegram Bot(未配置 = 仅落库不推送)
  tgBotToken: process.env.TG_BOT_TOKEN ?? '',
  tgChatId: process.env.TG_CHAT_ID ?? '',
};

// 生产防护:对外监听时禁止使用仓库默认密钥(否则任何知道仓库的人可伪造 admin JWT)
const DEFAULT_SECRETS = new Set(['dev-only-change-me']);
const weakSecrets = [config.jwtSecret, config.appSecret].filter((s) => DEFAULT_SECRETS.has(s));
if (!['127.0.0.1', 'localhost'].includes(process.env.PANEL_HOST ?? '127.0.0.1') && weakSecrets.length > 0) {
  throw new Error(`拒绝启动:对外监听(PANEL_HOST 非 127.0.0.1)禁止使用默认密钥,请配置 ${weakSecrets.join(' 与 ')}(openssl rand -hex 32)`);
}
