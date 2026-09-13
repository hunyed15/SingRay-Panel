import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import nodeCrypto from 'node:crypto';
import { migrate } from '../db/client.js';
import { createServer, updateServer, deleteServer, testServer } from './servers.js';
import { createNode, updateNode, toggleNode, deleteNode, getNode, listNodes } from './nodes.js';
import { createXrayNode, updateXrayNode, purgeXrayNodes, listXrayNodes } from './xray_nodes.js';
import { assertPortFree } from './ports.js';
import { HttpError } from './errors.js';
import { decrypt, encrypt } from '../core/crypto.js';
import { decryptJson } from './creds.js';
import { config } from '../config.js';
import type { ExecFn } from '../core/ssh/executor.js';
import type { ServerRow } from './servers.js';
import type { NodeRow } from './nodes.js';

let db: DatabaseSync;
let relay: Omit<ServerRow, 'ssh_auth_secret'>;
let landing: Omit<ServerRow, 'ssh_auth_secret'>;

function rawNode(id: number): NodeRow {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as unknown as NodeRow;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  migrate(db);
  relay = createServer(db, {
    name: 'relay-1',
    role: 'relay',
    host: '10.0.0.1',
    sshAuthSecret: 'ssh-key-abc',
  });
  landing = createServer(db, {
    name: 'landing-1',
    role: 'landing',
    host: '10.0.0.2',
    sshAuthSecret: 'ssh-key-def',
  });
});

afterEach(() => {
  db.close();
});

describe('servers service', () => {
  it('create builds role settings and hides secret', () => {
    expect(relay.ping_status).toBe('unknown');
    expect((relay as Record<string, unknown>).ssh_auth_secret).toBeUndefined();
    const rs = db.prepare('SELECT * FROM relay_settings WHERE server_id = ?').get(relay.id) as unknown as {
      reality_public_key: string;
      reality_private_key: string;
      short_id: string;
    };
    expect(rs.reality_public_key).toBeTruthy();
    // 私钥加密存储,可解回
    expect(decrypt(config.jwtSecret, rs.reality_private_key)).toBeTruthy();
    expect(rs.short_id).toMatch(/^[0-9a-f]{16}$/);
    const ls = db.prepare('SELECT * FROM landing_settings WHERE server_id = ?').get(landing.id) as unknown as { in_port: number; password: string };
    expect(ls.in_port).toBe(32000 + landing.id);
    expect(decrypt(config.jwtSecret, ls.password)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('ssh_auth_secret is encrypted at rest', () => {
    const raw = db.prepare('SELECT ssh_auth_secret FROM servers WHERE id = ?').get(relay.id) as unknown as { ssh_auth_secret: string };
    expect(raw.ssh_auth_secret).not.toContain('ssh-key-abc');
    expect(decrypt(config.jwtSecret, raw.ssh_auth_secret)).toBe('ssh-key-abc');
  });

  it('role change rebuilds role settings', () => {
    const updated = updateServer(db, landing.id, { role: 'relay' });
    expect(updated.role).toBe('relay');
    expect(db.prepare('SELECT id FROM landing_settings WHERE server_id = ?').get(landing.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM relay_settings WHERE server_id = ?').get(landing.id)).toBeTruthy();
  });

  it('delete blocked when referenced by nodes (409)', () => {
    createNode(db, { template: 'trojan-tls', name: 'n1', serverId: relay.id, port: 30001 });
    expect(() => deleteServer(db, relay.id)).toThrow(HttpError);
    try {
      deleteServer(db, relay.id);
    } catch (e) {
      expect((e as HttpError).status).toBe(409);
    }
  });

  it('testServer injects fake exec', async () => {
    const okExec: ExecFn = () => Promise.resolve({ stdout: 'ok\n', stderr: '' });
    expect(await testServer(db, relay.id, okExec)).toEqual({ ok: true, message: 'ok' });
    const failExec: ExecFn = () => Promise.reject(new Error('conn refused'));
    expect((await testServer(db, relay.id, failExec)).ok).toBe(false);
  });
});

describe('nodes service (db roundtrip)', () => {
  it('create generates creds, encrypts them, defaults sni/wsPath', () => {
    const node = createNode(db, { template: 'vmess-ws-tls', name: 'vmess节点', serverId: relay.id });
    expect(node.protocol).toBe('vmess');
    expect(node.tls_mode).toBe('tls');
    expect(node.transport).toBe('ws');
    expect(node.ws_path).toMatch(/^\/ws-[0-9a-f]+$/);
    expect(node.sni).toBe('10.0.0.1');
    expect(node.enabled).toBe(1);
    expect(node.share_link).toMatch(/^vmess:\/\//);

    const raw = rawNode(node.id);
    expect(raw.creds_enc).not.toContain('uuid'); // 密文不含明文字段名
    const creds = decryptJson(raw.creds_enc);
    expect(creds.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('create with explicit port; duplicate port → 409', () => {
    const n1 = createNode(db, { template: 'trojan-tls', name: 'n1', serverId: relay.id, port: 30005 });
    expect(n1.listen_port).toBe(30005);
    expect(n1.share_link).toMatch(/^trojan:\/\//);
    expect(() => createNode(db, { template: 'trojan-tls', name: 'n2', serverId: relay.id, port: 30005 })).toThrow(HttpError);
    try {
      createNode(db, { template: 'trojan-tls', name: 'n2', serverId: relay.id, port: 30005 });
    } catch (e) {
      expect((e as HttpError).status).toBe(409);
    }
  });

  it('socks node with auth echoes auth fields; others do not', () => {
    const n = createNode(db, {
      template: 'socks',
      name: 's1',
      serverId: relay.id,
      port: 30010,
      authUser: 'alice',
      authPassword: 'pw123',
    });
    expect(n.auth_user).toBe('alice');
    expect(n.auth_password).toBe('pw123');
    expect(n.share_link).toBe('socks5://alice:pw123@10.0.0.1:30010#s1'); // socks 带认证的分享链接
    const trojan = createNode(db, { template: 'trojan-tls', name: 't1', serverId: relay.id, port: 30011 });
    expect(trojan.auth_user).toBeUndefined();
    expect(trojan.auth_password).toBeUndefined();
  });

  it('tunnel node requires tunnelAddress/tunnelPort and persists relay fields', () => {
    expect(() => createNode(db, { template: 'tunnel', name: 't', serverId: relay.id, port: 30012 })).toThrow(HttpError);
    const n = createNode(db, {
      template: 'tunnel',
      name: 't',
      serverId: relay.id,
      port: 30012,
      outboundType: 'relay',
      landingServerId: landing.id,
      tunnelAddress: '10.0.0.9',
      tunnelPort: 5201,
    });
    expect(n.protocol).toBe('tunnel');
    expect(n.share_link).toBeNull(); // tunnel 不进订阅
    expect(n.outbound_type).toBe('relay');
    expect(n.landing_server_id).toBe(landing.id);
    expect(n.tunnel_address).toBe('10.0.0.9');
    expect(n.tunnel_port).toBe(5201);
  });

  it('relay outbound requires a landing server', () => {
    try {
      createNode(db, { template: 'ss2022', name: 'r', serverId: relay.id, port: 30013, outboundType: 'relay', landingServerId: relay.id });
      expect.unreachable();
    } catch (e) {
      expect((e as HttpError).status).toBe(400);
    }
  });

  it('protocol change regenerates creds and defaults', () => {
    const n = createNode(db, { template: 'trojan-tls', name: 'n', serverId: relay.id, port: 30014 });
    const oldCreds = decryptJson(rawNode(n.id).creds_enc);
    const updated = updateNode(db, n.id, { protocol: 'vless' });
    expect(updated.protocol).toBe('vless');
    expect(updated.tls_mode).toBe('reality');
    expect(updated.sni).toBe('www.microsoft.com');
    const newCreds = decryptJson(rawNode(n.id).creds_enc);
    expect(newCreds.uuid).toBeTruthy();
    expect(newCreds.password).toBeUndefined();
    expect(newCreds.uuid).not.toBe(oldCreds.password); // 凭据确已重新生成
  });

  it('toggle flips enabled; delete removes row', () => {
    const n = createNode(db, { template: 'ss2022', name: 'n', serverId: relay.id, port: 30015 });
    const off = toggleNode(db, n.id);
    expect(off.enabled).toBe(0);
    const on = toggleNode(db, n.id);
    expect(on.enabled).toBe(1);
    deleteNode(db, n.id);
    expect(listNodes(db)).toHaveLength(0);
    expect(() => getNode(db, n.id)).toThrow(/节点不存在/);
  });
});

describe('xray nodes service', () => {
  it('create xray vless reality node with flow', () => {
    const n = createXrayNode(db, { template: 'xray-vless-reality', name: 'x1', serverId: relay.id, port: 31001 });
    expect(n.protocol).toBe('vless');
    expect(n.tls_mode).toBe('reality');
    expect(n.flow).toBe('xtls-rprx-vision');
    expect(n.share_link).toMatch(/^vless:\/\//);
    const creds = decryptJson((db.prepare('SELECT creds_enc FROM xray_nodes WHERE id = ?').get(n.id) as unknown as { creds_enc: string }).creds_enc);
    expect(creds.uuid).toBeTruthy();
    expect(creds.flow).toBe('xtls-rprx-vision');
  });

  it('port uniqueness is checked against both node tables (409)', () => {
    createNode(db, { template: 'trojan-tls', name: 'sb', serverId: relay.id, port: 31002 });
    // sing-box 已占 31002 → xray 节点同端口 409(旧版此处会落 sqlite UNIQUE 报 500)
    expect(() => createXrayNode(db, { template: 'xray-trojan-tls', name: 'x', serverId: relay.id, port: 31002 })).toThrow(HttpError);
    const x = createXrayNode(db, { template: 'xray-trojan-tls', name: 'x', serverId: relay.id, port: 31003 });
    expect(() => assertPortFree(db, relay.id, 31003, { selfTable: 'xray_nodes' })).toThrow(HttpError);
    // 编辑排除自身
    updateXrayNode(db, x.id, { port: 31003 });
    expect(() => assertPortFree(db, relay.id, 31003, { selfTable: 'xray_nodes', excludeNodeId: x.id })).not.toThrow();
  });

  it('purge keeps one node', () => {
    const a = createXrayNode(db, { template: 'xray-ss', name: 'a', serverId: relay.id, port: 31004 });
    createXrayNode(db, { template: 'xray-http', name: 'b', serverId: relay.id, port: 31005 });
    const deleted = purgeXrayNodes(db, a.id);
    expect(deleted).toBe(1);
    expect(listXrayNodes(db)).toHaveLength(1);
    expect(listXrayNodes(db)[0].id).toBe(a.id);
  });
});

describe('legacy ciphertext compatibility', () => {
  it('decrypts old-format token (iv.body+tag layout)', () => {
    // 旧库 crypto.js 的同构格式:base64(iv).base64(body|tag),此处手动构造验证可解
    const key = nodeCrypto.createHash('sha256').update(config.jwtSecret, 'utf8').digest();
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update('legacy-secret', 'utf8'), cipher.final()]);
    const legacy = `${iv.toString('base64')}.${Buffer.concat([body, cipher.getAuthTag()]).toString('base64')}`;
    expect(decrypt(config.jwtSecret, legacy)).toBe('legacy-secret');
    expect(encrypt(config.jwtSecret, 'legacy-secret')).not.toBe(legacy); // 新写仍加密,格式不变
  });
});
