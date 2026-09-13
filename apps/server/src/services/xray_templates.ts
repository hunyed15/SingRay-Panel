// Xray 节点模板 + 凭据生成(移植自旧 xrayconfig/templates.js)
import { genUuid, genSsPassword, genRandomHex, genPassword } from '../core/crypto.js';

/** Xray 模板 → 协议/TLS/传输 */
export const XRAY_TEMPLATE_META: Record<string, { protocol: string; tlsMode: string; transport: string }> = {
  'xray-vless-reality': { protocol: 'vless', tlsMode: 'reality', transport: 'raw' },
  'xray-vmess-ws-tls': { protocol: 'vmess', tlsMode: 'tls', transport: 'ws' },
  'xray-trojan-tls': { protocol: 'trojan', tlsMode: 'tls', transport: 'raw' },
  'xray-ss': { protocol: 'shadowsocks', tlsMode: 'none', transport: 'raw' },
  'xray-socks': { protocol: 'socks', tlsMode: 'none', transport: 'raw' },
  'xray-http': { protocol: 'http', tlsMode: 'none', transport: 'raw' },
};

/** Xray 协议 → 默认 TLS/传输 */
export const XRAY_PROTOCOL_DEFAULTS: Record<string, { tlsMode: string; transport: string }> = {
  vless: { tlsMode: 'reality', transport: 'raw' },
  vmess: { tlsMode: 'tls', transport: 'ws' },
  trojan: { tlsMode: 'tls', transport: 'raw' },
  shadowsocks: { tlsMode: 'none', transport: 'raw' },
  socks: { tlsMode: 'none', transport: 'raw' },
  http: { tlsMode: 'none', transport: 'raw' },
};

/** 按协议生成 xray 节点凭据 */
export function genXrayNodeCreds(protocol: string, flow: string): Record<string, string> {
  switch (protocol) {
    case 'vless':
      return { uuid: genUuid(), flow: flow || 'xtls-rprx-vision' };
    case 'vmess':
      return { uuid: genUuid() };
    case 'trojan':
      return { password: genSsPassword() };
    case 'shadowsocks':
      return { method: 'aes-128-gcm', password: genSsPassword() };
    case 'socks':
    case 'http':
      // 无认证的 socks/http 会被扫描滥用,默认生成凭据(URL 安全可读字符集)
      return { username: genRandomHex(8), password: genPassword() };
    default:
      return {};
  }
}

/** 按协议决定默认 SNI */
export function xrayNodeDefaults(
  protocol: string,
  host: string,
  sniInput?: string,
): { sni: string; wsPath: string } {
  if (protocol === 'vless') return { sni: sniInput || 'www.microsoft.com', wsPath: '' };
  if (protocol === 'vmess') return { sni: host, wsPath: `/xray-ws-${genRandomHex(4)}` };
  return { sni: host, wsPath: '' };
}
