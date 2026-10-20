// 凭据存取:creds_enc 存 JSON(加密),ssh_auth_secret 存明文串(加密)。
// secret 用 config.appSecret(迁移时须等于旧面板 APP_SECRET,密文才兼容)。
import { encrypt, decrypt } from '../core/crypto.js';
import { config } from '../config.js';

export type NodeCreds = Record<string, string>;

export function encryptJson(value: unknown): string {
  return encrypt(config.appSecret, JSON.stringify(value));
}

export function decryptJson(token: string): NodeCreds {
  return JSON.parse(decrypt(config.appSecret, token)) as NodeCreds;
}

export function encryptSecret(plain: string, purpose = ''): string {
  return encrypt(config.appSecret, plain, purpose);
}

export function decryptSecret(token: string, purpose = ''): string {
  return decrypt(config.appSecret, token, purpose);
}
