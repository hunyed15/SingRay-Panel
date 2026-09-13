import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { deployAll, deployServerBothCores } from './deployAll.js';
import { encrypt } from '../core/crypto.js';
import { config } from '../config.js';

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const enc = (s: string) => encrypt(config.jwtSecret, s);
  db.prepare("INSERT INTO servers (id, name, role, host, ssh_sudo, control, ssh_auth_secret) VALUES (1, 'corenet', 'relay', '10.0.0.1', 0, 'ssh', ?)").run(enc('fake-key-1'));
  db.prepare("INSERT INTO servers (id, name, role, host, control, ssh_auth_secret) VALUES (2, 'landing', 'landing', '10.0.0.2', 'ssh', ?)").run(enc('fake-key-2'));
  db.prepare("INSERT INTO servers (id, name, role, host, control) VALUES (3, 'agentbox', 'relay', '10.0.0.3', 'agent')").run();
  db.prepare("INSERT INTO relay_settings (server_id, reality_public_key, reality_private_key, short_id, port_base) VALUES (1, 'pbk', ?, 'sid1', 31000)").run(enc('rpvk1'));
  db.prepare("INSERT INTO landing_settings (server_id, in_port, method, password) VALUES (2, 20408, '2022-blake3-aes-128-gcm', ?)").run(enc('landing-pass'));
  db.prepare("INSERT INTO nodes (server_id, name, protocol, listen_port, creds_enc, tls_mode, sni, outbound_type, landing_server_id) VALUES (1, 'vless-relay', 'vless', 31001, ?, 'reality', 'dl.google.com', 'relay', 2)").run(enc(JSON.stringify({ uuid: 'u-1' })));
  db.prepare("INSERT INTO nodes (server_id, name, protocol, listen_port, creds_enc, tls_mode) VALUES (2, 'ss-landing', 'shadowsocks', 31002, ?, 'tls')").run(enc(JSON.stringify({ method: '2022-blake3-aes-128-gcm', password: 'p1' })));
  db.prepare("INSERT INTO xray_nodes (server_id, name, protocol, listen_port, creds_enc, tls_mode, sni, flow) VALUES (1, 'xvless', 'vless', 41001, ?, 'reality', 'dl.google.com', 'xtls-rprx-vision')").run(enc(JSON.stringify({ uuid: 'x-1' })));
  return db;
}

/** fake exec: everything succeeds, is-active → active */
const okExec = async (_c: any, cmd: string) => ({ stdout: cmd.includes('is-active') ? 'active\n' : '', stderr: '' });
const okWrite = async () => {};

describe('deployAll orchestration', () => {
  it('deploys both cores per machine (agent machines excluded from deployAll)', async () => {
    const db = seedDb();
    const results = await deployAll(db, { execFn: okExec as any, writeFileFn: okWrite });
    expect(results).toHaveLength(2); // only control='ssh' machines

    const corenet = results.find((r) => r.serverName === 'corenet')!;
    expect(corenet.singbox.ok).toBe(true);
    expect(corenet.singbox.steps).toContain('render');
    expect(corenet.singbox.steps).toContain('health');
    // xray vless present → deployed, not skipped
    expect(corenet.xray.ok).toBe(true);
    expect(corenet.xray.steps).toContain('health');

    const landing = results.find((r) => r.serverName === 'landing')!;
    // landing machine: ss-landing node with tls → cert step must appear
    expect(landing.singbox.steps).toContain('cert(self-signed)');
    expect(landing.singbox.ok).toBe(true);

    // agent machine not part of deployAll (V1 SSH only)
    expect(results.some((r) => r.serverName === 'agentbox')).toBe(false);
  }, 60000);

  it('propagates deploy failure per machine without aborting others', async () => {
    const db = seedDb();
    const failingExec = async (_c: any, cmd: string) => {
      if (cmd.includes('sing-box check')) throw new Error('invalid config');
      return { stdout: cmd.includes('is-active') ? 'active\n' : '', stderr: '' };
    };
    const results = await deployAll(db, { execFn: failingExec as any, writeFileFn: okWrite });
    const corenet = results.find((r) => r.serverName === 'corenet')!;
    expect(corenet.singbox.ok).toBe(false);
    expect(corenet.singbox.error).toContain('invalid config');
    expect(corenet.singbox.steps.join(',')).toContain('verify');
    // xray core unaffected by sing-box check failure (per-core isolation)
    expect(corenet.xray.ok).toBe(true);
    // other machines still processed (no abort)
    const landing = results.find((r) => r.serverName === 'landing')!;
    expect(landing.singbox.ok).toBe(false); // also fails check, but result recorded
    expect(landing.xray.skipped).toBe(true); // nothing to deploy → clean skip
  }, 60000);

  it('direct call: deployServerBothCores returns per-core result shape', async () => {
    const db = seedDb();
    const r = await deployServerBothCores(db, 2, { execFn: okExec as any, writeFileFn: okWrite });
    expect(r.serverName).toBe('landing');
    expect(r.xray.skipped).toBe(true); // no xray nodes, no relay refs
    expect(r.singbox.ok).toBe(true);
  }, 60000);

  it('auto-installs missing core binary before deploy', async () => {
    const db = seedDb();
    const execFn = async (_c: unknown, cmd: string) => {
      if (cmd.startsWith('test -x ')) throw new Error('exit code 1'); // 二进制不存在
      return { stdout: cmd.includes('is-active') ? 'active\n' : '', stderr: '' };
    };
    const r = await deployServerBothCores(db, 1, { execFn: execFn as any, writeFileFn: okWrite });
    expect(r.singbox.ok).toBe(true);
    expect(r.singbox.steps).toContain('auto-install');
    expect(r.xray.steps).toContain('auto-install');
  }, 60000);
});
