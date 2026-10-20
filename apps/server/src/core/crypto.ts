// AES-256-GCM 字段加密。
//
// v2(当前写入格式):`v2:base64(iv).base64(tag|data)`
//   - key = sha256('singray/v2|purpose' || secret):按用途域分离,同一 secret
//     不会在不同字段间复用同一把密钥
//   - AAD = 'singray/v2|purpose':密文被搬到别的字段(如把 cf_token 挪进
//     tg_bot_token)会直接认证失败,而不是"解出一段看似正常的垃圾"
//   - purpose 缺省为空串,便于逐字段渐进接入
//
// 旧格式(只读,兼容 singbox-panel 迁移来的密文):`base64(iv).base64(tag|data)`,
//   key = sha256(secret),无 AAD。读到旧格式后由调用方决定是否重写为 v2。

import crypto from 'node:crypto';

const TAG_LEN = 16;
const V2_PREFIX = 'v2:';

const aadFor = (purpose: string): Buffer => Buffer.from(`singray/v2|${purpose}`, 'utf8');

function deriveLegacyKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function deriveKeyV2(secret: string, purpose: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(`singray/v2|${purpose}`, 'utf8')
    .update(secret, 'utf8')
    .digest();
}

/** 是否是当前(v2)格式;调用方可用它决定要不要重写 */
export function isV2Token(token: string): boolean {
  return token.startsWith(V2_PREFIX);
}

export function encrypt(secret: string, plaintext: string, purpose = ''): string {
  const key = deriveKeyV2(secret, purpose);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(purpose));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${V2_PREFIX}${iv.toString('base64')}.${Buffer.concat([body, tag]).toString('base64')}`;
}

export function decrypt(secret: string, token: string, purpose = ''): string {
  const v2 = isV2Token(token);
  const raw = v2 ? token.slice(V2_PREFIX.length) : token;
  const [ivB64, dataB64] = raw.split('.');
  if (!ivB64 || !dataB64) throw new Error('malformed secret token');
  const iv = Buffer.from(ivB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const tag = data.subarray(data.length - TAG_LEN);
  const body = data.subarray(0, data.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', v2 ? deriveKeyV2(secret, purpose) : deriveLegacyKey(secret), iv);
  decipher.setAuthTag(tag);
  if (v2) decipher.setAAD(aadFor(purpose));
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

/** URL/链接友好的可读密码(纯字母数字,无 base64 的 +/= 特殊字符) */
export function genPassword(length = 24): string {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  // randomInt 无取模偏差(旧实现 256 % 56,前 32 个字符概率略高)
  for (let i = 0; i < length; i++) out += charset[crypto.randomInt(0, charset.length)];
  return out;
}
