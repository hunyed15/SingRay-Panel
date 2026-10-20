// 字段加密:v2 信封(AAD + 用途分离)与旧格式兼容
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encrypt, decrypt, isV2Token } from './crypto.js';
import { config } from '../config.js';

/** 手工构造旧格式密文(key = sha256(secret),无 AAD),模拟迁移来的数据 */
function legacyEncrypt(secret: string, plaintext: string): string {
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return `${iv.toString('base64')}.${Buffer.concat([body, cipher.getAuthTag()]).toString('base64')}`;
}

describe('crypto: v2 信封 + 旧格式兼容', () => {
  it('v2 roundtrip 且带版本前缀', () => {
    const plain = JSON.stringify({ uuid: 'u1', password: 'p1' });
    const token = encrypt(config.jwtSecret, plain);
    expect(isV2Token(token)).toBe(true);
    expect(token).toMatch(/^v2:[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(decrypt(config.jwtSecret, token)).toBe(plain);
  });

  it('purpose 绑定:换个用途解不开(密文不能在字段间搬运)', () => {
    const token = encrypt(config.jwtSecret, 'cf-token-value', 'settings.cf_token');
    expect(decrypt(config.jwtSecret, token, 'settings.cf_token')).toBe('cf-token-value');
    expect(() => decrypt(config.jwtSecret, token, 'settings.tg_bot_token')).toThrow();
    expect(() => decrypt(config.jwtSecret, token)).toThrow();
  });

  it('旧格式密文仍能解密,且被识别为旧格式', () => {
    const legacy = legacyEncrypt(config.jwtSecret, 'old-value');
    expect(isV2Token(legacy)).toBe(false);
    expect(decrypt(config.jwtSecret, legacy)).toBe('old-value');
  });

  it('错 secret / 畸形 token 抛错', () => {
    const token = encrypt(config.jwtSecret, 'secret');
    expect(() => decrypt('other-secret', token)).toThrow();
    expect(() => decrypt(config.jwtSecret, 'not-a-token')).toThrow();
    expect(() => decrypt(config.jwtSecret, 'v2:not-a-token')).toThrow();
  });
});
