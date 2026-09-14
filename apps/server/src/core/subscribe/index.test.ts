import { describe, it, expect } from 'vitest';
import { buildShareLink, toBase64, toSingboxConfig, pickFormat, type NodeView } from './index.js';

const vless: NodeView = {
  id: 1,
  name: 'HK-VLESS',
  protocol: 'vless',
  host: 'hk.example.com',
  port: 31001,
  sni: 'dl.google.com',
  ws_path: '',
  realityPublicKey: 'PBK123',
  shortId: 'abcd1234',
  creds: { uuid: 'u-1', flow: 'xtls-rprx-vision' },
};

const ss: NodeView = {
  id: 2,
  name: 'HK-SS',
  protocol: 'shadowsocks',
  host: 'hk.example.com',
  port: 31002,
  sni: 'hk.example.com',
  ws_path: '',
  realityPublicKey: null,
  shortId: null,
  creds: { method: '2022-blake3-aes-128-gcm', password: 'p' },
};

describe('subscribe', () => {
  it('vless share link includes flow (regression 3adac49)', () => {
    const link = buildShareLink(vless)!;
    expect(link).toContain('flow=xtls-rprx-vision');
    expect(link).toContain('pbk=PBK123');
    expect(link).toContain('sid=abcd1234');
    expect(link).toContain('#HK-VLESS');
  });

  it('vless without flow omits the param (singbox reality+vision incompatible)', () => {
    const link = buildShareLink({ ...vless, creds: { uuid: 'u-1' } })!;
    expect(link).not.toContain('flow=');
  });

  it('ss link is SIP002 with base64 userinfo; tunnel/socks return null', () => {
    expect(buildShareLink(ss)).toContain('ss://');
    expect(buildShareLink({ ...ss, protocol: 'tunnel' })).toBeNull();
  });

  it('toBase64 joins lines and encodes', () => {
    const out = Buffer.from(toBase64([vless, ss]), 'base64').toString('utf8');
    expect(out.split('\n')).toHaveLength(2);
  });

  it('toSingboxConfig builds mobile-ready config (tun inbound + selector + urltest + direct)', () => {
    const cfg = toSingboxConfig([vless, ss]) as {
      inbounds: { type: string; auto_route?: boolean }[];
      outbounds: { tag: string }[];
      route: { final: string; rule_set?: unknown[] };
    };
    // 手机端必需:tun 入口
    expect(cfg.inbounds.some((i) => i.type === 'tun' && i.auto_route === true)).toBe(true);
    // 出站:节点 + PROXY 选择器 + auto 自动测速 + direct/block
    expect(cfg.outbounds.map((o) => o.tag)).toEqual(['HK-VLESS', 'HK-SS', 'PROXY', 'auto', 'direct', 'block']);
    expect(cfg.route.final).toBe('PROXY');
    expect(cfg.route.rule_set?.length).toBeGreaterThan(0);
    expect(pickFormat({}, 'sing-box/1.13 CLI')).toBe('singbox');
    expect(pickFormat({}, 'v2rayN/6')).toBe('base64');
    expect(pickFormat({ format: 'singbox' }, '')).toBe('singbox');
  });
});
