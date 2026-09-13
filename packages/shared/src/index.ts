// SingRayPanel shared domain types.
// Single source of truth for protocol definitions: illegal fields for a core
// must be unrepresentable here (design.md §2).

// ---------- Protocol option unions ----------

export type SingboxTransport = 'tcp' | 'ws' | 'grpc' | 'httpupgrade' | 'h2';
export type SecurityKind = 'none' | 'tls' | 'reality';

export interface TlsOptions {
  sni: string;
  insecure: boolean;
  alpn?: string[];
  fingerprint?: string;
}

export interface RealityOptions {
  sni: string;
  publicKey: string;
  shortId: string;
  fingerprint: string;
}

// ---------- SingBox node definitions (11 templates) ----------

export type SingboxProtocol =
  | 'shadowsocks'
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'hysteria2'
  | 'tuic'
  | 'shadowtls'
  | 'naive'
  | 'socks'
  | 'http'
  | 'anytls';

export interface SingboxNodeDef {
  id: number;
  name: string;
  serverId: number;
  protocol: SingboxProtocol;
  port: number;
  enabled: boolean;
  /** protocol-specific options, validated by protocol variant */
  options: SingboxProtocolOptions;
  note: string;
}

export type SingboxProtocolOptions =
  | { kind: 'shadowsocks'; method: string; password: string }
  | { kind: 'vmess'; uuid: string; alterId: number; security: SecurityKind; tls?: TlsOptions; transport: SingboxTransport }
  | { kind: 'vless'; uuid: string; flow: '' | 'xtls-rprx-vision'; security: SecurityKind; tls?: TlsOptions; reality?: RealityOptions; transport: SingboxTransport }
  | { kind: 'trojan'; password: string; tls: TlsOptions; transport: SingboxTransport }
  | { kind: 'hysteria2'; password: string; tls: TlsOptions; upMbps?: number; downMbps?: number }
  | { kind: 'tuic'; uuid: string; password: string; tls: TlsOptions; congestionControl: 'cubic' | 'new_reno' | 'bbr' }
  | { kind: 'shadowtls'; password: string; tls: TlsOptions; version: 1 | 2 | 3 }
  | { kind: 'naive'; username: string; password: string; tls: TlsOptions }
  | { kind: 'socks'; username?: string; password?: string }
  | { kind: 'http'; username?: string; password?: string; tls?: TlsOptions }
  | { kind: 'anytls'; password: string; tls: TlsOptions };

// ---------- Xray node definitions (6 templates) ----------

export type XrayProtocol = 'vless' | 'vmess' | 'trojan' | 'shadowsocks' | 'socks' | 'http';

export interface XrayNodeDef {
  id: number;
  name: string;
  serverId: number;
  protocol: XrayProtocol;
  port: number;
  enabled: boolean;
  options: XrayProtocolOptions;
  note: string;
}

export type XrayProtocolOptions =
  | { kind: 'vless'; uuid: string; flow: '' | 'xtls-rprx-vision'; security: SecurityKind; tls?: TlsOptions; reality?: RealityOptions; transport: SingboxTransport }
  | { kind: 'vmess'; uuid: string; alterId: number; security: SecurityKind; tls?: TlsOptions; transport: SingboxTransport }
  | { kind: 'trojan'; password: string; tls: TlsOptions; transport: SingboxTransport }
  | { kind: 'shadowsocks'; method: string; password: string }
  | { kind: 'socks'; username?: string; password?: string }
  | { kind: 'http'; username?: string; password?: string; tls?: TlsOptions };

// ---------- Port forwarding ----------

export type ForwardMechanism = 'iptables' | 'socat';

export interface PortForwardDef {
  id: number;
  name: string;
  entryServerId: number;
  landingServerId: number;
  targetNodeType: 'singbox' | 'xray';
  targetNodeId: number;
  targetPort: number;
  entryPort: number;
  mechanism: ForwardMechanism;
  enabled: boolean;
  note: string;
}

// ---------- Share links ----------

export interface ShareLinkParts {
  protocol: XrayProtocol | 'hysteria2' | 'tuic' | 'anytls';
  host: string;
  port: number;
  params: Record<string, string>;
  fragment?: string;
  /** raw userinfo for protocols that carry credentials there */
  userinfo?: string;
}

export function buildShareLink(parts: ShareLinkParts): string {
  const qs = new URLSearchParams(parts.params).toString();
  const userinfo = parts.userinfo ? `${parts.userinfo}@` : '';
  const query = qs ? `?${qs}` : '';
  const frag = parts.fragment ? `#${encodeURIComponent(parts.fragment)}` : '';
  return `${parts.protocol}://${userinfo}${parts.host}:${parts.port}${query}${frag}`;
}

// ---------- Machine context for config rendering ----------

export interface MachineCtx {
  host: string;
  /** inbound listen address, e.g. 0.0.0.0 */
  listen: string;
  logLevel: string;
}
