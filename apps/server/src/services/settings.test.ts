import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { migrate } from '../db/client.js';
import { getSetting, setSetting, resolveCfToken, resolveTgConfig, getSettings } from './settings.js';
import { config } from '../config.js';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

const raw = (db: DatabaseSync, key: string): string =>
  ((db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '');

describe('settings: 令牌加密落库(备份/拖库时不留明文)', () => {
  it('cf_token / tg_bot_token 存密文,读回明文', () => {
    const db = freshDb();
    setSetting(db, 'cf_token', 'cf-super-secret');
    setSetting(db, 'tg_bot_token', '123:tg-secret');

    expect(raw(db, 'cf_token')).toMatch(/^enc:/);
    expect(raw(db, 'cf_token')).not.toContain('cf-super-secret');
    expect(raw(db, 'tg_bot_token')).not.toContain('tg-secret');

    expect(getSetting(db, 'cf_token')).toBe('cf-super-secret');
    expect(resolveCfToken(db)).toBe('cf-super-secret');
    expect(resolveTgConfig(db).botToken).toBe('123:tg-secret');
    db.close();
  });

  it('非敏感键保持明文(订阅 slug 等)', () => {
    const db = freshDb();
    setSetting(db, 'sub_slug', 'abc123');
    expect(raw(db, 'sub_slug')).toBe('abc123');
    db.close();
  });

  it('旧库里已有的明文令牌:读到即加密回写,不需要迁移脚本', () => {
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('cf_token','legacy-plain')").run();
    expect(getSetting(db, 'cf_token')).toBe('legacy-plain');
    expect(raw(db, 'cf_token')).toMatch(/^enc:/);
    expect(raw(db, 'cf_token')).not.toContain('legacy-plain');
    db.close();
  });

  it('解不开的密文(APP_SECRET 换过)按未配置处理,但保留密文不覆盖', () => {
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('cf_token','enc:not-a-valid-token')").run();
    expect(getSetting(db, 'cf_token')).toBe('');
    expect(raw(db, 'cf_token')).toBe('enc:not-a-valid-token');
    db.close();
  });

  it('设置接口的返回体里没有令牌明文', () => {
    const db = freshDb();
    setSetting(db, 'cf_token', 'secret-xyz');
    const s = getSettings(db);
    expect(s.cfTokenSet).toBe(true);
    expect(s.cfTokenSource).toBe('db');
    expect(JSON.stringify(s)).not.toContain('secret-xyz');
    db.close();
  });

  it('密文绑定了用途:搬到别的键上解不开(不会被当成合法令牌使用)', () => {
    const db = freshDb();
    setSetting(db, 'cf_token', 'cf-value');
    const stolen = raw(db, 'cf_token');
    // 模拟"把 cf_token 的密文塞进 tg_bot_token"
    db.prepare("INSERT INTO settings (key, value) VALUES ('tg_bot_token', ?)").run(stolen);
    expect(getSetting(db, 'tg_bot_token')).toBe('');
    expect(resolveTgConfig(db).botToken).toBe('');
    db.close();
  });

  it('旧格式密文(V1,无 purpose)读到即升级为 v2 信封', () => {
    const db = freshDb();
    // V1:key = sha256(appSecret),无 AAD
    const key = crypto.createHash('sha256').update(config.appSecret, 'utf8').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(Buffer.from('legacy-v1-token', 'utf8')), cipher.final()]);
    const legacy = `${iv.toString('base64')}.${Buffer.concat([body, cipher.getAuthTag()]).toString('base64')}`;
    db.prepare("INSERT INTO settings (key, value) VALUES ('cf_token', ?)").run(`enc:${legacy}`);

    expect(getSetting(db, 'cf_token')).toBe('legacy-v1-token');
    // 读一次就升级:库里变成 v2 信封,且仍然解得开
    expect(raw(db, 'cf_token')).toMatch(/^enc:v2:/);
    expect(getSetting(db, 'cf_token')).toBe('legacy-v1-token');
    db.close();
  });
});
