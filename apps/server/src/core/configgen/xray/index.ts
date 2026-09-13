// Xray machine config assembly (pure functions), ported from singbox-panel
// server/src/xrayconfig/. Semantic lock: golden snapshots must match the
// production configs this code has been emitting.

import type { LandingEndpoint, MachineCtx, SingboxNodeRow } from '../types.js';

export interface XrayNodeRow {
  id: number;
  name: string;
  server_id: number;
  protocol: string;
  listen_port: number;
  enabled: number;
  creds: XrayCreds;
  tls_mode: 'none' | 'reality' | 'tls';
  sni: string;
  transport: 'raw' | 'ws' | 'tcp';
  ws_path: string;
  flow: string;
  outbound_type: 'direct' | 'relay';
  landing_server_id: number | null;
  note: string;
}

export type XrayCreds =
  | { uuid: string }
  | { password: string }
  | { method: string; password: string }
  | { username: string; password: string };

export interface XrayLandingSettings {
  in_port: number;
  in_method: string;
  in_password: string;
}

export interface XrayMachineInput {
  machine: MachineCtx;
  nodes: XrayNodeRow[];
  landings: Record<number, LandingEndpoint>;
  /** xray landing shared ss inbound (server-scoped settings row) */
  xrayLandingSettings?: XrayLandingSettings;
}

function tlsSettings(machine: MachineCtx) {
  if (!machine.certPath || !machine.keyPath) {
    throw new Error(`machine ${machine.name}: self-signed TLS templates require cert paths`);
  }
  return {
    certificates: [{ certificateFile: machine.certPath, keyFile: machine.keyPath }],
  };
}

export function buildXrayInbound(node: XrayNodeRow, machine: MachineCtx): Record<string, unknown> {
  const base = { tag: `relay-in-${node.listen_port}`, port: node.listen_port, listen: '0.0.0.0' };
  const creds = node.creds as XrayCreds & Record<string, unknown>;

  switch (node.protocol) {
    case 'vless': {
      if (!machine.realityPrivateKey || !machine.shortId) {
        throw new Error(`machine ${machine.name}: vless reality requires relay settings`);
      }
      return {
        ...base,
        protocol: 'vless',
        settings: {
          clients: [{ id: creds.uuid, flow: node.flow || 'xtls-rprx-vision' }],
          decryption: 'none',
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            dest: `${node.sni}:443`,
            serverNames: [node.sni],
            privateKey: machine.realityPrivateKey,
            shortIds: [machine.shortId],
            xver: 0,
          },
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      };
    }

    case 'vmess':
      return {
        ...base,
        protocol: 'vmess',
        settings: { clients: [{ id: creds.uuid, alterId: 0 }] },
        streamSettings: {
          network: 'ws',
          wsSettings: { path: node.ws_path || '/' },
          security: 'tls',
          tlsSettings: tlsSettings(machine),
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      };

    case 'trojan':
      return {
        ...base,
        protocol: 'trojan',
        settings: { clients: [{ password: creds.password }] },
        streamSettings: { network: 'tcp', security: 'tls', tlsSettings: tlsSettings(machine) },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      };

    case 'shadowsocks':
      return {
        ...base,
        protocol: 'shadowsocks',
        settings: { method: creds.method, password: creds.password },
      };

    case 'socks':
      return creds.username
        ? {
            ...base,
            protocol: 'socks',
            settings: { auth: 'password', accounts: [{ user: creds.username, pass: creds.password }], udp: true },
          }
        : { ...base, protocol: 'socks', settings: { auth: 'noauth', udp: true } };

    case 'http':
      return creds.username
        ? { ...base, protocol: 'http', settings: { accounts: [{ user: creds.username, pass: creds.password }] } }
        : { ...base, protocol: 'http', settings: {} };

    default:
      throw new Error(`unknown xray protocol: ${node.protocol}`);
  }
}

function buildXrayRelayOutbound(nodeId: number, landing: LandingEndpoint) {
  return {
    protocol: 'shadowsocks',
    tag: `landing-${nodeId}`,
    settings: {
      servers: [{ address: landing.host, port: landing.in_port, method: landing.method, password: landing.password }],
    },
  };
}

function buildXrayRelayRule(port: number, nodeId: number) {
  return { type: 'field', inboundTag: [`relay-in-${port}`], outboundTag: `landing-${nodeId}` };
}

function buildXrayLandingInbound(landing: XrayLandingSettings) {
  return {
    tag: `landing-in-${landing.in_port}`,
    port: landing.in_port,
    listen: '0.0.0.0',
    protocol: 'shadowsocks',
    settings: { method: landing.in_method, password: landing.in_password },
  };
}

export function buildXrayConfig(input: XrayMachineInput): Record<string, unknown> {
  const { machine, landings, xrayLandingSettings } = input;
  const active = input.nodes.filter((n) => n.enabled === 1);

  const inbounds = active.map((n) => buildXrayInbound(n, machine));
  const outbounds: Record<string, unknown>[] = [{ protocol: 'freedom', tag: 'direct' }];
  const rules: Record<string, unknown>[] = [];

  for (const n of active) {
    if (n.outbound_type !== 'relay' || !n.landing_server_id) continue;
    const landing = landings[n.landing_server_id];
    if (!landing) {
      throw new Error(`node #${n.id} (${n.name}) 引用的落地机 #${n.landing_server_id} 不存在或缺少共享入站配置`);
    }
    outbounds.push(buildXrayRelayOutbound(n.id, landing));
    rules.push(buildXrayRelayRule(n.listen_port, n.id));
  }

  if (machine.role === 'landing' && xrayLandingSettings) {
    inbounds.push(buildXrayLandingInbound(xrayLandingSettings));
  }

  return {
    log: { loglevel: 'warning' },
    inbounds,
    outbounds,
    routing: { domainStrategy: 'AsIs', rules },
  };
}
