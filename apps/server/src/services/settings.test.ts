import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { getSetting, setSetting, resolveCfToken, resolveTgConfig, getSettings } from './settings.js';

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
});
