// sing-box 节点模板 + 凭据生成(移植自旧 templates.js)
import { genUuid, genSsPassword, genRandomHex } from '../core/crypto.js';

/** 模板 → 协议/TLS/传输(与前端契约一致) */
export const TEMPLATE_META: Record<string, { protocol: string; tlsMode: string; transport: string }> = {
  'vless-reality': { protocol: 'vless', tlsMode: 'reality', transport: 'raw' },
  'vmess-ws-tls': { protocol: 'vmess', tlsMode: 'tls', transport: 'ws' },
  'trojan-tls': { protocol: 'trojan', tlsMode: 'tls', transport: 'raw' },
  ss2022: { protocol: 'shadowsocks', tlsMode: 'none', transport: 'raw' },
  hysteria: { protocol: 'hysteria', tlsMode: 'tls', transport: 'raw' },
  socks: { protocol: 'socks', tlsMode: 'none', transport: 'raw' },
  http: { protocol: 'http', tlsMode: 'none', transport: 'raw' },
  tunnel: { protocol: 'tunnel', tlsMode: 'none', transport: 'raw' },
  tuic: { protocol: 'tuic', tlsMode: 'tls', transport: 'raw' },
  shadowtls: { protocol: 'shadowtls', tlsMode: 'shadowtls', transport: 'raw' },
  naive: { protocol: 'naive', tlsMode: 'tls', transport: 'raw' },
};

/** 协议 → 默认 TLS/传输(编辑改协议时用) */
export const PROTOCOL_DEFAULTS: Record<string, { tlsMode: string; transport: string }> = {
  vless: { tlsMode: 'reality', transport: 'raw' },
  vmess: { tlsMode: 'tls', transport: 'ws' },
  trojan: { tlsMode: 'tls', transport: 'raw' },
  shadowsocks: { tlsMode: 'none', transport: 'raw' },
  hysteria: { tlsMode: 'tls', transport: 'raw' },
  socks: { tlsMode: 'none', transport: 'raw' },
  http: { tlsMode: 'none', transport: 'raw' },
  tunnel: { tlsMode: 'none', transport: 'raw' },
  tuic: { tlsMode: 'tls', transport: 'raw' },
  shadowtls: { tlsMode: 'shadowtls', transport: 'raw' },
  naive: { tlsMode: 'tls', transport: 'raw' },
};

/** 按协议生成节点凭据 */
export function genNodeCreds(protocol: string): Record<string, string> {
  switch (protocol) {
    case 'vless':
      return { uuid: genUuid() }; // 不带 flow:reality+vision 不兼容
    case 'vmess':
      return { uuid: genUuid() };
    case 'trojan':
      return { password: genSsPassword() };
    case 'shadowsocks':
      return { method: '2022-blake3-aes-128-gcm', password: genSsPassword() };
    case 'hysteria':
      return { password: genSsPassword() };
    case 'tuic':
      return { uuid: genUuid(), password: genSsPassword() };
    case 'shadowtls':
      return { password: genSsPassword() };
    case 'naive':
      return { username: genRandomHex(4), password: genSsPassword() };
    default:
      return {};
  }
}

/** 按协议决定默认 SNI;返回 { sni, wsPath } */
export function nodeDefaults(
  protocol: string,
  host: string,
  sniInput?: string,
): { sni: string; wsPath: string } {
  if (protocol === 'vless') return { sni: sniInput || 'www.microsoft.com', wsPath: '' };
  if (protocol === 'shadowtls') return { sni: sniInput || 'www.google.com', wsPath: '' };
  if (protocol === 'vmess') return { sni: host, wsPath: `/ws-${genRandomHex(4)}` };
  if (protocol === 'tunnel') return { sni: '', wsPath: '' };
  return { sni: host, wsPath: '' };
}
