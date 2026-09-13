// AES-256-GCM secret storage, format-compatible with singbox-panel crypto.js
// (`base64(iv).base64(tag|data)`, key = sha256(secret)) so migrated rows
// decrypt without re-encryption. Plus credential generators.

import crypto from 'node:crypto';

const TAG_LEN = 16;

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function encrypt(secret: string, plaintext: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${Buffer.concat([body, tag]).toString('base64')}`;
}

export function decrypt(secret: string, token: string): string {
  const key = deriveKey(secret);
  const [ivB64, dataB64] = token.split('.');
  if (!ivB64 || !dataB64) throw new Error('malformed secret token');
  const iv = Buffer.from(ivB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const tag = data.subarray(data.length - TAG_LEN);
  const body = data.subarray(0, data.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function genUuid(): string {
  return crypto.randomUUID();
}

/** ss-2022 密码:16 字节 base64 */
export function genSsPassword(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** Reality short_id:16 位 hex */
export function genShortId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** x25519 密钥对,返回 JWK 的 x/d(base64url),与 sing-box/xray reality 格式一致 */
export function genRealityKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return { publicKey: pub.x as string, privateKey: priv.d as string };
}

export function genRandomHex(bytes = 12): string {
  return crypto.randomBytes(bytes).toString('hex');
}
