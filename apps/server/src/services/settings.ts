// 面板设置(KV):订阅 slug、Reality 地址策略、Cloudflare/Telegram 令牌
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';
import { genRandomHex } from '../core/crypto.js';
import { encryptSecret, decryptSecret } from './creds.js';
import { config } from '../config.js';

const CF_TOKEN_KEY = 'cf_token';
const TG_BOT_TOKEN_KEY = 'tg_bot_token';
const TG_CHAT_ID_KEY = 'tg_chat_id';

/**
 * 落库时加密的键:令牌会被备份带走,明文等于备份里有明文凭据。
 * 用 appSecret 加密(与节点凭据同一把钥匙);更换 APP_SECRET 后需要重新录入。
 */
const SECRET_KEYS = new Set([CF_TOKEN_KEY, TG_BOT_TOKEN_KEY]);
const ENC_PREFIX = 'enc:';

function decode(key: string, value: string): string {
  if (!SECRET_KEYS.has(key) || !value.startsWith(ENC_PREFIX)) return value;
  try {
    return decryptSecret(value.slice(ENC_PREFIX.length));
  } catch {
    // APP_SECRET 换过 → 解不开;当作未配置,但保留密文不覆盖(换回旧密钥还能救)
    return '';
  }
}

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  const value = row?.value ?? null;
  if (value === null) return null;
  const plain = decode(key, value);
  // 旧数据是明文:读到时顺手加密回写(不需要迁移脚本)
  if (SECRET_KEYS.has(key) && value && !value.startsWith(ENC_PREFIX)) {
    setSetting(db, key, plain);
  }
  return plain;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  const stored = SECRET_KEYS.has(key) && value ? `${ENC_PREFIX}${encryptSecret(value)}` : value;
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, stored);
}

export interface PanelSettings {
  subSlug: string;
  subUrl: string;
  /** 订阅里 Reality 节点地址: true=IP(绕开慢 DNS,默认) / false=域名(换 IP 免改订阅) */
  singboxRealityIp: boolean;
  xrayRealityIp: boolean;
  /** Cloudflare API Token(DNS-01 证书签发);DB 优先,env 兜底。返回时脱敏 */
  cfTokenSet: boolean;
  cfTokenSource: 'db' | 'env' | 'none';
  /** Telegram 告警 */
  tgBotTokenSet: boolean;
  tgChatId: string;
}

/** DNS-01 Token:DB 优先,env(PANEL_CF_TOKEN)兜底 */
export function resolveCfToken(db: DatabaseSync): string {
  return getSetting(db, CF_TOKEN_KEY) || config.cfToken || '';
}

/** TG 配置:DB 优先,env 兜底 */
export function resolveTgConfig(db: DatabaseSync): { botToken: string; chatId: string } {
  return {
    botToken: getSetting(db, TG_BOT_TOKEN_KEY) || config.tgBotToken || '',
    chatId: getSetting(db, TG_CHAT_ID_KEY) || config.tgChatId || '',
  };
}

const REALITY_IP_KEYS = { singbox: 'sub_singbox_reality_ip', xray: 'sub_xray_reality_ip' } as const;

function realityIp(db: DatabaseSync, core: 'singbox' | 'xray'): boolean {
  return getSetting(db, REALITY_IP_KEYS[core]) !== '0'; // 默认 IP
}

export function getSettings(db: DatabaseSync): PanelSettings {
  let slug = getSetting(db, 'sub_slug');
  if (!slug) {
    slug = genRandomHex(6);
    setSetting(db, 'sub_slug', slug);
  }
  const dbCf = getSetting(db, CF_TOKEN_KEY);
  const dbTg = getSetting(db, TG_BOT_TOKEN_KEY);
  return {
    subSlug: slug,
    subUrl: `/sub/singbox/${slug}`,
    singboxRealityIp: realityIp(db, 'singbox'),
    xrayRealityIp: realityIp(db, 'xray'),
    cfTokenSet: Boolean(dbCf || config.cfToken),
    cfTokenSource: dbCf ? 'db' : config.cfToken ? 'env' : 'none',
    tgBotTokenSet: Boolean(dbTg || config.tgBotToken),
    tgChatId: getSetting(db, TG_CHAT_ID_KEY) || config.tgChatId || '',
  };
}

export function putSettings(
  db: DatabaseSync,
  b: {
    subSlug?: string;
    singboxRealityIp?: boolean;
    xrayRealityIp?: boolean;
    /** Cloudflare Token(空字符串 = 清除 DB 值回退 env) */
    cfToken?: string;
    tgBotToken?: string;
    tgChatId?: string;
  },
): PanelSettings {
  if (b.subSlug !== undefined) {
    const raw = String(b.subSlug || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(raw)) throw new HttpError(400, 'slug 仅允许字母/数字/下划线/连字符');
    // 订阅是免鉴权端点:slug 就是唯一凭据,太短等于可枚举
    if (raw.length < 8) throw new HttpError(400, 'slug 至少 8 位(订阅地址免鉴权,slug 即凭据)');
    setSetting(db, 'sub_slug', raw);
  }
  if (b.singboxRealityIp !== undefined) setSetting(db, REALITY_IP_KEYS.singbox, b.singboxRealityIp ? '1' : '0');
  if (b.xrayRealityIp !== undefined) setSetting(db, REALITY_IP_KEYS.xray, b.xrayRealityIp ? '1' : '0');
  // 敏感值:非空则写入 DB;空字符串 = 清除(回退 env 兜底)
  if (b.cfToken !== undefined) setSetting(db, CF_TOKEN_KEY, b.cfToken.trim());
  if (b.tgBotToken !== undefined) setSetting(db, TG_BOT_TOKEN_KEY, b.tgBotToken.trim());
  if (b.tgChatId !== undefined) setSetting(db, TG_CHAT_ID_KEY, b.tgChatId.trim());
  return getSettings(db);
}
