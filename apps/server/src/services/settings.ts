// 面板设置(KV):目前只有订阅 slug(移植自旧 routes/settings.js + db.js get/setSetting)
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './errors.js';
import { genRandomHex } from '../core/crypto.js';

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export interface PanelSettings {
  subSlug: string;
  subUrl: string;
  /** 订阅里 Reality 节点地址: true=IP(绕开慢 DNS,默认) / false=域名(换 IP 免改订阅) */
  singboxRealityIp: boolean;
  xrayRealityIp: boolean;
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
  return {
    subSlug: slug,
    subUrl: `/sub/singbox/${slug}`,
    singboxRealityIp: realityIp(db, 'singbox'),
    xrayRealityIp: realityIp(db, 'xray'),
  };
}

export function putSettings(db: DatabaseSync, b: { subSlug?: string; singboxRealityIp?: boolean; xrayRealityIp?: boolean }): PanelSettings {
  if (b.subSlug !== undefined) {
    const raw = String(b.subSlug || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(raw)) throw new HttpError(400, 'slug 仅允许字母/数字/下划线/连字符');
    setSetting(db, 'sub_slug', raw);
  }
  if (b.singboxRealityIp !== undefined) setSetting(db, REALITY_IP_KEYS.singbox, b.singboxRealityIp ? '1' : '0');
  if (b.xrayRealityIp !== undefined) setSetting(db, REALITY_IP_KEYS.xray, b.xrayRealityIp ? '1' : '0');
  return getSettings(db);
}
