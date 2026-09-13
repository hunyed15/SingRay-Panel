import { describe, it, expect } from 'vitest';
import { buildInbound, buildMachineConfig } from './singbox/index.js';
import { buildXrayConfig, buildXrayInbound } from './xray/index.js';
import type { MachineCtx, SingboxNodeRow } from './types.js';
import type { XrayNodeRow } from './xray/index.js';

// Fixture machine mirrors the production relay (CoreNet) context shape.
const machine: MachineCtx = {
  id: 1,
  name: 'corenet',
  role: 'relay',
  host: 'corenet.example.com',
  certPath: '/etc/singray/cert.pem',
  keyPath: '/etc/singray/key.pem',
  realityPrivateKey: 'RPK_PRIVATE_SAMPLE',
  shortId: '0123abcd',
};

const landingEndpoint = {
  host: 'landing.example.com',
  in_port: 20408,
  method: '2022-blake3-aes-128-gcm',
  password: 'ss2022-sample-password',
};

function singboxNode(overrides: Partial<SingboxNodeRow> & { protocol: string; creds: SingboxNodeRow['creds'] }): SingboxNodeRow {
  return {
    id: 10,
    name: 'node',
    server_id: 1,
    listen_port: 31001,
    enabled: 1,
    tls_mode: 'none',
    sni: '',
    transport: 'raw',
    ws_path: '',
    outbound_type: 'direct',
    landing_server_id: null,
    tunnel_address: '',
    tunnel_port: null,
    note: '',
    ...overrides,
  } as SingboxNodeRow;
}

const singboxCases: { name: string; node: SingboxNodeRow }[] = [
  { name: 'vless-reality', node: singboxNode({ protocol: 'vless', creds: { uuid: 'u-uuid-0001' }, tls_mode: 'reality', sni: 'dl.google.com' }) },
  { name: 'vmess-ws-tls', node: singboxNode({ protocol: 'vmess', creds: { uuid: 'v-uuid-0002' }, tls_mode: 'tls', transport: 'ws', ws_path: '/ws-a1b2' }) },
  { name: 'trojan-tls', node: singboxNode({ protocol: 'trojan', creds: { password: 'trojan-pass' }, tls_mode: 'tls' }) },
  { name: 'ss2022', node: singboxNode({ protocol: 'shadowsocks', creds: { method: '2022-blake3-aes-128-gcm', password: 'ss-pass' } }) },
  { name: 'hysteria', node: singboxNode({ protocol: 'hysteria', creds: { password: 'hy-pass' }, tls_mode: 'tls' }) },
  { name: 'socks-auth', node: singboxNode({ protocol: 'socks', creds: { username: 'u1', password: 'p1' } }) },
  { name: 'socks-anon', node: singboxNode({ protocol: 'socks', creds: {} as SingboxNodeRow['creds'] }) },
  { name: 'http-auth', node: singboxNode({ protocol: 'http', creds: { username: 'u1', password: 'p1' } }) },
  { name: 'tunnel', node: singboxNode({ protocol: 'tunnel', creds: {} as SingboxNodeRow['creds'], tunnel_address: '10.0.0.5', tunnel_port: 443 }) },
  { name: 'tuic', node: singboxNode({ protocol: 'tuic', creds: { uuid: 't-uuid-0003', password: 'tuic-pass' }, tls_mode: 'tls' }) },
  { name: 'shadowtls', node: singboxNode({ protocol: 'shadowtls', creds: { password: 'stls-pass' }, tls_mode: 'shadowtls', sni: 'www.google.com' }) },
  { name: 'naive', node: singboxNode({ protocol: 'naive', creds: { username: 'nusr', password: 'naive-pass' }, tls_mode: 'tls' }) },
];

describe('singbox configgen golden snapshots (11 templates)', () => {
  for (const { name, node } of singboxCases) {
    it(`inbound: ${name}`, () => {
      expect(buildInbound(node, machine)).toMatchSnapshot();
    });
  }

  it('machine config with relay node + landing shared inbound', () => {
    const vless = singboxNode({ id: 11, name: 'vless-relay', protocol: 'vless', creds: { uuid: 'relay-uuid' }, tls_mode: 'reality', sni: 'dl.google.com', outbound_type: 'relay', landing_server_id: 2 });
    const ss = singboxNode({ id: 12, name: 'ss-direct', protocol: 'shadowsocks', creds: { method: '2022-blake3-aes-128-gcm', password: 'x' }, enabled: 0 });
    expect(
      buildMachineConfig({
        machine,
        relaySettings: { reality_public_key: 'pub', reality_private_key: 'RPK_PRIVATE_SAMPLE', short_id: '0123abcd', port_base: 31000 },
        landingSettings: { in_port: 20408, method: '2022-blake3-aes-128-gcm', password: 'landing-pass' },
        nodes: [vless, ss],
        landings: { 2: landingEndpoint },
      }),
    ).toMatchSnapshot();
  });

  it('relay node referencing missing landing fails loudly', () => {
    const vless = singboxNode({ protocol: 'vless', creds: { uuid: 'u' }, tls_mode: 'reality', sni: 'x.com', outbound_type: 'relay', landing_server_id: 99 });
    expect(() => buildMachineConfig({ machine, nodes: [vless], landings: {} })).toThrow(/不存在或缺少共享入站配置/);
  });
});

function xrayNode(overrides: Partial<XrayNodeRow> & { protocol: string; creds: XrayNodeRow['creds'] }): XrayNodeRow {
  return {
    id: 70,
    name: 'xnode',
    server_id: 1,
    listen_port: 41001,
    enabled: 1,
    tls_mode: 'reality',
    sni: 'dl.google.com',
    transport: 'raw',
    ws_path: '',
    flow: '',
    outbound_type: 'direct',
    landing_server_id: null,
    note: '',
    ...overrides,
  } as XrayNodeRow;
}

const xrayCases: { name: string; node: XrayNodeRow }[] = [
  { name: 'vless-reality', node: xrayNode({ protocol: 'vless', creds: { uuid: 'x-uuid-0001' } }) },
  { name: 'vmess-ws-tls', node: xrayNode({ protocol: 'vmess', creds: { uuid: 'x-uuid-0002' }, tls_mode: 'tls', transport: 'ws', ws_path: '/ws-x' }) },
  { name: 'trojan-tls', node: xrayNode({ protocol: 'trojan', creds: { password: 'xt-pass' }, tls_mode: 'tls' }) },
  { name: 'shadowsocks', node: xrayNode({ protocol: 'shadowsocks', creds: { method: 'aes-128-gcm', password: 'xss-pass' }, tls_mode: 'none' }) },
  { name: 'socks-auth', node: xrayNode({ protocol: 'socks', creds: { username: 'u', password: 'p' }, tls_mode: 'none' }) },
  { name: 'http-auth', node: xrayNode({ protocol: 'http', creds: { username: 'u', password: 'p' }, tls_mode: 'none' }) },
];

describe('xray configgen golden snapshots (6 templates)', () => {
  for (const { name, node } of xrayCases) {
    it(`inbound: ${name}`, () => {
      expect(buildXrayInbound(node, machine)).toMatchSnapshot();
    });
  }

  it('machine config: vless relay chain + landing shared ss inbound', () => {
    const vless = xrayNode({ id: 71, name: 'vless-relay', protocol: 'vless', creds: { uuid: 'xr-uuid' }, outbound_type: 'relay', landing_server_id: 2 });
    expect(
      buildXrayConfig({
        machine: { ...machine, role: 'landing' },
        nodes: [vless],
        landings: { 2: landingEndpoint },
        xrayLandingSettings: { in_port: 20409, in_method: 'aes-128-gcm', in_password: 'xlanding-pass' },
      }),
    ).toMatchSnapshot();
  });

  it('xray inbound never emits unsupported inbound keys (regression: network field crash)', () => {
    const inbound = buildXrayInbound(xrayNode({ protocol: 'shadowsocks', creds: { method: 'aes-128-gcm', password: 'p' }, tls_mode: 'none' }), machine);
    expect(JSON.stringify(inbound)).not.toContain('"network"');
  });
});
