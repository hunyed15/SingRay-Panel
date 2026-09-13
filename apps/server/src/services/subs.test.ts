import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { collectSingboxNodes, collectXrayNodes } from './subs.js';
import { encrypt } from '../core/crypto.js';
import { config } from '../config.js';

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const enc = (s: string) => encrypt(config.appSecret, s);
  // 入口机(中转) + 落地机(reality 密钥在落地)
  db.prepare("INSERT INTO servers (id, name, role, host, control, ssh_auth_secret) VALUES (1, 'entry', 'relay', 'entry.example.com', 'ssh', ?)").run(enc('k1'));
  db.prepare("INSERT INTO servers (id, name, role, host, control, ssh_auth_secret) VALUES (2, 'landing', 'landing', 'landing.example.com', 'ssh', ?)").run(enc('k2'));
  db.prepare("INSERT INTO relay_settings (server_id, reality_public_key, reality_private_key, short_id, port_base) VALUES (2, 'LANDING_PBK', ?, 'landing_sid', 31000)").run(enc('rpvk'));
  // 落地 sing-box vless 节点 + xray vless 节点(flow)
  db.prepare("INSERT INTO nodes (id, server_id, name, protocol, listen_port, creds_enc, tls_mode, sni) VALUES (10, 2, 'landing-vless', 'vless', 31001, ?, 'reality', 'dl.google.com')").run(enc(JSON.stringify({ uuid: 'u-1' })));
  db.prepare("INSERT INTO xray_nodes (id, server_id, name, protocol, listen_port, creds_enc, tls_mode, sni, flow) VALUES (70, 2, 'xvless', 'vless', 41001, ?, 'reality', 'dl.google.com', 'xtls-rprx-vision')").run(enc(JSON.stringify({ uuid: 'x-1' })));
  // 中转规则:一条进订阅,一条不进
  db.prepare("INSERT INTO port_forwards (id, name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, include_in_sub) VALUES (7, '中转-香港', 1, 2, 'singbox', 10, 31001, 31001, 'iptables', 1)").run();
  db.prepare("INSERT INTO port_forwards (id, name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, include_in_sub) VALUES (8, '中转-不含', 1, 2, 'xray', 70, 32001, 41001, 'iptables', 0)").run();
  db.prepare("INSERT INTO port_forwards (id, name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port, mechanism, include_in_sub) VALUES (9, '中转-禁用', 1, 2, 'xray', 70, 33001, 41001, 'iptables', 1)").run();
  db.prepare('UPDATE port_forwards SET enabled = 0 WHERE id = 9').run();
  return db;
}

describe('subscription includes port-forwards (include_in_sub)', () => {
  it('singbox subscription renders enabled+checked forwards with entry address and landing params', () => {
    const db = seedDb();
    const views = collectSingboxNodes(db);
    // 直连节点 0 个(landing-vless 属于落地机也在列) — landing node enabled → 在列
    const forward = views.find((v) => v.name === '中转-香港');
    expect(forward).toBeDefined();
    expect(forward!.host).toBe('entry.example.com');
    expect(forward!.port).toBe(31001);
    // reality 参数取自落地机
    expect(forward!.realityPublicKey).toBe('LANDING_PBK');
    expect(forward!.shortId).toBe('landing_sid');
    expect(forward!.sni).toBe('dl.google.com');
  });

  it('xray subscription includes checked forward with flow, excludes unchecked and disabled', () => {
    const db = seedDb();
    const views = collectXrayNodes(db);
    const names = views.map((v) => v.name);
    expect(names).toContain('xvless'); // 直连节点仍在
    const excluded = views.filter((v) => v.name === '中转-不含');
    expect(excluded).toHaveLength(0); // include_in_sub=0
    const disabled = views.filter((v) => v.name === '中转-禁用');
    expect(disabled).toHaveLength(0); // enabled=0
    const fwd = views.find((v) => v.name === '中转-香港');
    expect(fwd).toBeUndefined(); // 目标是 singbox 节点,不出现在 xray 订阅
  });

  it('xray forward view: xray-target forward enters xray subscription with flow', () => {
    const db = seedDb();
    db.prepare('UPDATE port_forwards SET include_in_sub = 1 WHERE id = 8').run();
    const views = collectXrayNodes(db);
    const fwd = views.find((v) => v.name === '中转-不含');
    expect(fwd).toBeDefined();
    expect(fwd!.port).toBe(32001);
    expect(fwd!.creds.flow).toBe('xtls-rprx-vision');
  });
});
