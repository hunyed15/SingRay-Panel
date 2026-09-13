import { describe, it, expect } from 'vitest';
import { TEMPLATE_META, PROTOCOL_DEFAULTS, genNodeCreds, nodeDefaults } from './templates.js';
import { XRAY_TEMPLATE_META, genXrayNodeCreds, xrayNodeDefaults } from './xray_templates.js';
import { randomFreePort } from './ports.js';
import { encrypt, decrypt } from '../core/crypto.js';
import { config } from '../config.js';

describe('singbox templates (ported from old templates.js)', () => {
  it('template meta maps template key to protocol/tls/transport', () => {
    expect(TEMPLATE_META['vless-reality']).toEqual({ protocol: 'vless', tlsMode: 'reality', transport: 'raw' });
    expect(TEMPLATE_META['vmess-ws-tls']).toMatchObject({ protocol: 'vmess', transport: 'ws' });
    expect(TEMPLATE_META.tunnel).toMatchObject({ protocol: 'tunnel', tlsMode: 'none' });
  });

  it('genNodeCreds generates per-protocol shapes', () => {
    expect(genNodeCreds('vless').uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(genNodeCreds('vmess').uuid).toBeTruthy();
    expect(genNodeCreds('trojan').password).toBeTruthy();
    expect(genNodeCreds('shadowsocks')).toMatchObject({ method: '2022-blake3-aes-128-gcm' });
    expect(genNodeCreds('tuic')).toHaveProperty('uuid');
    expect(genNodeCreds('tuic')).toHaveProperty('password');
    // tunnel/socks/http 无凭据字段
    expect(genNodeCreds('tunnel')).toEqual({});
    expect(genNodeCreds('socks')).toEqual({});
  });

  it('nodeDefaults picks default sni per protocol', () => {
    expect(nodeDefaults('vless', 'h1.example.com').sni).toBe('www.microsoft.com');
    expect(nodeDefaults('vless', 'h1', 'my.sni.com').sni).toBe('my.sni.com');
    expect(nodeDefaults('shadowtls', 'h1').sni).toBe('www.google.com');
    expect(nodeDefaults('tunnel', 'h1')).toEqual({ sni: '', wsPath: '' });
    const vmess = nodeDefaults('vmess', 'h1.example.com');
    expect(vmess.sni).toBe('h1.example.com');
    expect(vmess.wsPath).toMatch(/^\/ws-[0-9a-f]+$/);
    expect(nodeDefaults('trojan', 'h1.example.com').sni).toBe('h1.example.com');
  });

  it('protocol defaults cover every template protocol', () => {
    for (const meta of Object.values(TEMPLATE_META)) {
      expect(PROTOCOL_DEFAULTS[meta.protocol]).toBeDefined();
    }
  });
});

describe('xray templates (ported from old xrayconfig/templates.js)', () => {
  it('genXrayNodeCreds: vless carries flow, ss uses aes-128-gcm', () => {
    const vless = genXrayNodeCreds('vless', '');
    expect(vless.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(vless.flow).toBe('xtls-rprx-vision');
    expect(genXrayNodeCreds('shadowsocks', '')).toMatchObject({ method: 'aes-128-gcm' });
    expect(genXrayNodeCreds('socks', '')).toEqual({});
  });

  it('xrayNodeDefaults: vmess ws path prefixed /xray-ws-', () => {
    expect(xrayNodeDefaults('vless', 'h1').sni).toBe('www.microsoft.com');
    expect(xrayNodeDefaults('vmess', 'h1.example.com').wsPath).toMatch(/^\/xray-ws-[0-9a-f]+$/);
    expect(xrayNodeDefaults('trojan', 'h1.example.com').sni).toBe('h1.example.com');
  });
});

describe('port allocation', () => {
  it('randomFreePort avoids used and well-known ports', () => {
    const used = [20000, 20001];
    for (let i = 0; i < 50; i++) {
      const p = randomFreePort(used);
      expect(used).not.toContain(p);
      expect([80, 443, 8080, 1080]).not.toContain(p);
      expect(p).toBeGreaterThanOrEqual(20000);
      expect(p).toBeLessThanOrEqual(65000);
    }
  });
});

describe('crypto roundtrip (old-db compatible format)', () => {
  it('encrypt then decrypt returns original plaintext', () => {
    const token = encrypt(config.jwtSecret, JSON.stringify({ uuid: 'u1', password: 'p1' }));
    // 格式:base64(iv).base64(body+tag),与旧库一致
    expect(token).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(decrypt(config.jwtSecret, token)).toBe(JSON.stringify({ uuid: 'u1', password: 'p1' }));
  });

  it('decrypt with wrong secret or malformed token throws', () => {
    const token = encrypt(config.jwtSecret, 'secret');
    expect(() => decrypt('other-secret', token)).toThrow();
    expect(() => decrypt(config.jwtSecret, 'not-a-token')).toThrow();
  });
});
