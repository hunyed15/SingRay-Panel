// sing-box machine config assembly (pure functions), ported from singbox-panel
// server/src/sbconfig/. Semantic lock: golden snapshots must match the
// production configs this code has been emitting.

import type {
  LandingEndpoint,
  LandingSettings,
  MachineCtx,
  RelaySettings,
  SingboxCreds,
  SingboxNodeRow,
} from '../types.js';

function listenBase(node: SingboxNodeRow) {
  return { tag: `relay-in-${node.listen_port}`, listen: '::', listen_port: node.listen_port };
}

function tlsSelfSigned(machine: MachineCtx) {
  if (!machine.certPath || !machine.keyPath) {
    throw new Error(`machine ${machine.name}: self-signed TLS templates require cert paths`);
  }
  return {
    enabled: true,
    server_name: machine.host,
    certificate_path: machine.certPath,
    key_path: machine.keyPath,
  };
}

function requireReality(machine: MachineCtx) {
  if (!machine.realityPrivateKey || !machine.shortId) {
    throw new Error(`machine ${machine.name}: reality templates require relay settings`);
  }
  return { privateKey: machine.realityPrivateKey, shortId: machine.shortId };
}

type CredsOf<N> = N extends { creds: infer C } ? C : never;

export function buildInbound(node: SingboxNodeRow, machine: MachineCtx): Record<string, unknown> {
  const listen = listenBase(node);
  const creds = node.creds as SingboxCreds & Record<string, unknown>;
  switch (node.protocol) {
    case 'vless': {
      // 实测:sing-box 1.12/1.13 的 flow=xtls-rprx-vision 与 reality 不兼容,故不带 flow
      const { privateKey, shortId } = requireReality(machine);
      return {
        type: 'vless',
        ...listen,
        users: [{ uuid: creds.uuid }],
        tls: {
          enabled: true,
          server_name: node.sni,
          reality: {
            enabled: true,
            handshake: { server: node.sni, server_port: 443 }, // Dial Fields:server_port 而非 port
            private_key: privateKey,
            short_id: [shortId],
          },
        },
      };
    }
    case 'vmess':
      return {
        type: 'vmess',
        ...listen,
        users: [{ uuid: creds.uuid, alterId: 0 }],
        transport: { type: 'ws', path: node.ws_path },
        tls: tlsSelfSigned(machine),
      };
    case 'trojan':
      return {
        type: 'trojan',
        ...listen,
        users: [{ password: creds.password }],
        tls: tlsSelfSigned(machine),
      };
    case 'shadowsocks':
      return {
        type: 'shadowsocks',
        ...listen,
        method: creds.method,
        password: creds.password,
      };
    case 'hysteria':
      return {
        type: 'hysteria2',
        ...listen,
        users: [{ password: creds.password }],
        tls: tlsSelfSigned(machine),
      };
    case 'socks':
      return creds.username
        ? { type: 'socks', ...listen, users: [{ username: creds.username, password: creds.password }] }
        : { type: 'socks', ...listen };
    case 'http':
      return creds.username
        ? { type: 'http', ...listen, users: [{ username: creds.username, password: creds.password }] }
        : { type: 'http', ...listen };
    case 'tunnel':
      return {
        type: 'direct',
        ...listen,
        network: 'tcp',
        override_address: node.tunnel_address,
        override_port: node.tunnel_port,
      };
    case 'tuic':
      return {
        type: 'tuic',
        ...listen,
        users: [{ uuid: creds.uuid, password: creds.password }],
        congestion_control: 'bbr',
        tls: tlsSelfSigned(machine),
      };
    case 'shadowtls':
      return {
        type: 'shadowtls',
        ...listen,
        version: 3,
        users: [{ password: creds.password }],
        handshake: { server: node.sni, server_port: 443 },
      };
    case 'naive':
      return {
        type: 'naive',
        ...listen,
        users: [{ username: creds.username, password: creds.password }],
        tls: tlsSelfSigned(machine),
      };
    default:
      throw new Error(`unknown protocol: ${node.protocol}`);
  }
}

export type Creds = CredsOf<SingboxNodeRow>;

function buildRelayOutbound(nodeId: number, landing: LandingEndpoint) {
  return {
    type: 'shadowsocks',
    tag: `landing-${nodeId}`,
    server: landing.host,
    server_port: landing.in_port,
    method: landing.method,
    password: landing.password,
  };
}

function buildRelayRule(port: number, nodeId: number) {
  // sing-box route 规则的 inbound 字段匹配【入站 tag】而非端口(官方文档: Tags of Inbound)
  return { inbound: [`relay-in-${port}`], outbound: `landing-${nodeId}` };
}

function buildLandingInbound(landing: LandingSettings) {
  return {
    type: 'shadowsocks',
    tag: `landing-in-${landing.in_port}`,
    listen: '::',
    listen_port: landing.in_port,
    method: landing.method,
    password: landing.password,
  };
}

export interface SingboxMachineInput {
  machine: MachineCtx;
  relaySettings?: RelaySettings;
  landingSettings?: LandingSettings;
  nodes: SingboxNodeRow[];
  /** landing server id → endpoint (host + shared ss inbound creds) */
  landings: Record<number, LandingEndpoint>;
}

export function buildMachineConfig(input: SingboxMachineInput): Record<string, unknown> {
  const { machine, landingSettings, landings } = input;
  const active = input.nodes.filter((n) => n.enabled === 1);

  const inbounds = active.map((n) => buildInbound(n, machine));
  const outbounds: Record<string, unknown>[] = [{ type: 'direct', tag: 'direct' }];
  const rules: Record<string, unknown>[] = [];

  for (const n of active) {
    if (n.outbound_type !== 'relay' || !n.landing_server_id) continue;
    const landing = landings[n.landing_server_id];
    if (!landing) {
      // 缺失落地机会导致流量静默走 direct——必须失败大声
      throw new Error(
        `node #${n.id} (${n.name}) 引用的落地机 #${n.landing_server_id} 不存在或缺少共享入站配置`,
      );
    }
    outbounds.push(buildRelayOutbound(n.id, landing));
    rules.push(buildRelayRule(n.listen_port, n.id));
  }

  if (machine.role === 'landing' && landingSettings) {
    inbounds.push(buildLandingInbound(landingSettings));
  }

  return {
    log: { level: 'info', timestamp: true },
    inbounds,
    outbounds,
    route: { rules, final: 'direct' },
  };
}
