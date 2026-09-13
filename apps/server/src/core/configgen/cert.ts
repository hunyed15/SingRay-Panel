// Self-signed certificate generator (ECDSA P-256, SAN with hostname + IPs, 10y),
// hand-built DER via node:crypto. Ported verbatim from singbox-panel
// server/src/sbconfig/cert.js. Pure function: returns PEMs.

import crypto from 'node:crypto';

const TEN_YEARS = 10 * 365 * 24 * 3600_000;

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: number[]): number[] {
  return [tag, ...derLen(content.length), ...content];
}

function derSeq(...parts: number[][]): number[] {
  return der(0x30, parts.flat());
}

function derInt(bytes: number[]): number[] {
  let b = [...bytes];
  if (b[0] & 0x80) b = [0x00, ...b];
  return der(0x02, b);
}

function derOid(oid: number[]): number[] {
  const first = oid[0] * 40 + oid[1];
  const body: number[] = [];
  for (const comp of oid.slice(2)) {
    let v = comp;
    const part = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      part.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    body.push(...part);
  }
  return der(0x06, [first, ...body]);
}

function derBitString(content: number[]): number[] {
  return der(0x03, [0x00, ...content]);
}

function derOctetString(bytes: number[]): number[] {
  return der(0x04, bytes);
}

function derUtf8(str: string): number[] {
  return der(0x0c, [...Buffer.from(str, 'utf8')]);
}

function derUtcTime(date: Date): number[] {
  const s = date.toISOString();
  const y = s.slice(2, 4);
  const rest = s.slice(5, 19).replace(/[:T-]/g, '');
  return der(0x17, [...Buffer.from(`${y}${rest}Z`, 'ascii')]);
}

function derName(cn: string): number[] {
  const attr = derSeq(derOid([2, 5, 4, 3]), derUtf8(cn));
  return derSeq(der(0x31, attr));
}

const OID_EC_PUBLIC_KEY = derOid([1, 2, 840, 10045, 2, 1]);
const OID_PRIME256V1 = derOid([1, 2, 840, 10045, 3, 1, 7]);
const OID_ECDSA_SHA256 = derOid([1, 2, 840, 10045, 4, 3, 2]);

/** 将 IPv6 地址解析为 16 字节(含 :: 展开);非法返回 null */
function ipv6ToBytes(addr: string): Buffer | null {
  const hasDouble = addr.includes('::');
  const [head, tail] = addr.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' || tail === undefined ? [] : tail.split(':');
  const missing = 8 - h.length - t.length;
  if (hasDouble ? missing < 1 : missing !== 0) return null;
  const parts = [...h, ...Array(Math.max(missing, 0)).fill('0'), ...t];
  if (parts.length !== 8) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    const v = parseInt(p, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return Buffer.from(bytes);
}

export function genSelfSignedCert({ commonName, altNames = [] }: { commonName: string; altNames?: string[] }): {
  certPem: string;
  keyPem: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // EC 公钥点(未压缩 0x04 || x || y)
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x as string, 'base64url');
  const y = Buffer.from(jwk.y as string, 'base64url');
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);

  const algId = derSeq(OID_EC_PUBLIC_KEY, OID_PRIME256V1);
  const spki = derSeq(algId, derBitString([...point]));

  const notBefore = new Date(Date.now() - 3600_000);
  const notAfter = new Date(Date.now() + TEN_YEARS);
  const serial = crypto.randomBytes(16);

  // subjectAltName: DNS / IP(IPv6 正确展开;非法地址跳过,不 crash)
  const sanParts: number[][] = [];
  for (const name of altNames) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) {
      sanParts.push(der(0x87, [...Buffer.from(name.split('.').map(Number))])); // [7] iPAddress v4
    } else if (name.includes(':')) {
      const ip = ipv6ToBytes(name);
      if (ip) sanParts.push(der(0x87, [...ip])); // [7] iPAddress v6
    } else {
      sanParts.push(der(0x82, [...Buffer.from(name, 'utf8')])); // [2] dNSName
    }
  }
  const sanExtValue = derSeq(...sanParts);
  const basicExtValue = der(0x30, der(0x01, [0x00])); // basicConstraints cA=false
  const extensions = der(
    0xa3,
    derSeq(
      // basicConstraints critical=TRUE;DER BOOLEAN TRUE 必须为 0xFF(Go 严格)
      derSeq(derOid([2, 5, 29, 19]), der(0x01, [0xff]), derOctetString(basicExtValue)),
      // SAN critical=FALSE
      derSeq(derOid([2, 5, 29, 17]), der(0x01, [0x00]), derOctetString(sanExtValue)),
    ),
  );

  const tbs = derSeq(
    der(0xa0, derInt([0x02])), // version v3
    derInt([...serial]),
    derSeq(OID_ECDSA_SHA256),
    derName(commonName),
    derSeq(derUtcTime(notBefore), derUtcTime(notAfter)),
    derName(commonName),
    spki,
    extensions,
  );

  const signer = crypto.createSign('sha256');
  signer.update(Buffer.from(tbs));
  const signature = signer.sign(privateKey);

  const certDer = derSeq(tbs, derSeq(OID_ECDSA_SHA256), derBitString([...signature]));

  const certPem = [
    '-----BEGIN CERTIFICATE-----',
    Buffer.from(certDer).toString('base64').match(/.{1,64}/g)!.join('\n'),
    '-----END CERTIFICATE-----',
    '',
  ].join('\n');
  const keyPem = privateKey.export({ type: 'sec1', format: 'pem' }) as string;

  return { certPem, keyPem };
}
