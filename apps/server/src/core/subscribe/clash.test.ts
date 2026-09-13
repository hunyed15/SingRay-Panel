import { describe, it, expect } from 'vitest';
import { toClashYaml, clashProxy } from './clash.js';
import type { NodeView } from './index.js';

const vlessReality: NodeView = {
  id: 1, name: 'Dedirock-vless-reality-xray', protocol: 'vless', host: 'dedirocks.1o1.top', port: 49464,
  sni: 'dl.google.com', ws_path: '', realityPublicKey: 'PBK123', shortId: 'abcd1234',
  creds: { uuid: 'u-1', flow: 'xtls-rprx-vision' },
};
const vmess: NodeView = { ...vlessReality, id: 2, name: 'Dedirock-vmess-ws-tls-xray', protocol: 'vmess', ws_path: '/ws-x', realityPublicKey: null, creds: { uuid: 'u-2' } };
const ss: NodeView = { ...vlessReality, id: 3, name: 'Dedirock-shadowsocks-xray', protocol: 'shadowsocks', realityPublicKey: null, creds: { method: 'aes-128-gcm', password: 'p+/=' } };

describe('clash/mihomo subscription', () => {
  it('vless reality proxy maps reality-opts + flow + fingerprint', () => {
    const p = clashProxy(vlessReality)!;
    expect(p.type).toBe('vless');
    expect(p['reality-opts']).toEqual({ 'public-key': 'PBK123', 'short-id': 'abcd1234' });
    expect(p.flow).toBe('xtls-rprx-vision');
    expect(p['client-fingerprint']).toBe('chrome');
  });

  it('yaml output is structurally valid (key lines + quoting survives special chars)', () => {
    const yaml = toClashYaml([vlessReality, vmess, ss]);
    expect(yaml).toContain('- name: "Dedirock-vless-reality-xray"');
    expect(yaml).toContain('type: "vless"');
    expect(yaml).toContain('public-key: "PBK123"');
    expect(yaml).toContain('proxy-groups:');
    expect(yaml).toContain('MATCH,PROXY');
    // ss 密码含 +/= 特殊字符 → 双引号包裹
    expect(yaml).toContain('password: "p+/="');
  });

  it('skips unsupported protocols (naive/tunnel/shadowtls)', () => {
    const yaml = toClashYaml([{ ...ss, name: 'n1', protocol: 'naive' }, { ...ss, name: 'n2', protocol: 'tunnel' }]);
    expect(yaml).not.toContain('n1');
    expect(yaml).not.toContain('n2');
    expect(toClashYaml([{ ...ss, name: 'ok', protocol: 'shadowsocks' }])).toContain('type: "ss"');
  });
});
