import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigration } from './cli.js';

const OLD_DDL = `
CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL, control TEXT NOT NULL DEFAULT 'ssh', host TEXT NOT NULL DEFAULT '', client_host TEXT NOT NULL DEFAULT '', ssh_port INTEGER NOT NULL DEFAULT 22, ssh_user TEXT NOT NULL DEFAULT 'root', ssh_auth_type TEXT NOT NULL DEFAULT 'key', ssh_auth_secret TEXT NOT NULL DEFAULT '', ssh_sudo INTEGER NOT NULL DEFAULT 0, region TEXT NOT NULL DEFAULT '', ping_status TEXT NOT NULL DEFAULT 'unknown', singbox_version TEXT NOT NULL DEFAULT '', xray_version TEXT NOT NULL DEFAULT '', xray_ping_status TEXT NOT NULL DEFAULT 'unknown', xray_last_seen TEXT, last_seen TEXT);
CREATE TABLE relay_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE, reality_public_key TEXT NOT NULL, reality_private_key TEXT NOT NULL, short_id TEXT NOT NULL, port_base INTEGER NOT NULL DEFAULT 31000);
CREATE TABLE landing_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE, in_port INTEGER NOT NULL, method TEXT NOT NULL DEFAULT '2022-blake3-aes-128-gcm', password TEXT NOT NULL);
CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, protocol TEXT NOT NULL, listen_port INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, creds_enc TEXT NOT NULL DEFAULT '', tls_mode TEXT NOT NULL DEFAULT 'none', sni TEXT NOT NULL DEFAULT '', transport TEXT NOT NULL DEFAULT 'raw', ws_path TEXT NOT NULL DEFAULT '', outbound_type TEXT NOT NULL DEFAULT 'direct', landing_server_id INTEGER REFERENCES servers(id), tunnel_address TEXT NOT NULL DEFAULT '', tunnel_port INTEGER, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(server_id, listen_port));
CREATE TABLE sni_library (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL UNIQUE, note TEXT NOT NULL DEFAULT '', builtin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE xray_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, protocol TEXT NOT NULL, listen_port INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, creds_enc TEXT NOT NULL DEFAULT '', tls_mode TEXT NOT NULL DEFAULT 'reality', sni TEXT NOT NULL DEFAULT '', transport TEXT NOT NULL DEFAULT 'raw', ws_path TEXT NOT NULL DEFAULT '', flow TEXT NOT NULL DEFAULT '', outbound_type TEXT NOT NULL DEFAULT 'direct', landing_server_id INTEGER REFERENCES servers(id), tunnel_address TEXT NOT NULL DEFAULT '', tunnel_port INTEGER, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(server_id, listen_port));
CREATE TABLE xray_server_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE, reality_private_key TEXT NOT NULL, reality_public_key TEXT NOT NULL, short_id TEXT NOT NULL, port_base INTEGER NOT NULL DEFAULT 41000, in_port INTEGER, in_method TEXT NOT NULL DEFAULT 'aes-128-gcm', in_password_enc TEXT NOT NULL DEFAULT '');
CREATE TABLE port_forwards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, entry_server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, landing_server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, target_node_type TEXT NOT NULL, target_node_id INTEGER NOT NULL, entry_port INTEGER NOT NULL, target_port INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(entry_server_id, entry_port));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
`;

let dir: string;
let fromPath: string;
let toPath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'singray-migrate-'));
  fromPath = path.join(dir, 'old.db');
  toPath = path.join(dir, 'new.db');

  const src = new DatabaseSync(fromPath);
  src.exec(OLD_DDL);
  src.prepare("INSERT INTO servers (id, name, role, host, ssh_sudo) VALUES (1, 'corenet', 'relay', '1.2.3.4', 1)").run();
  src.prepare("INSERT INTO servers (id, name, role, host) VALUES (2, 'landing', 'landing', '5.6.7.8')").run();
  src.prepare("INSERT INTO nodes (id, name, server_id, protocol, listen_port, creds_enc) VALUES (10, 'vless1', 1, 'vless', 31001, 'enc-token')").run();
  src.prepare("INSERT INTO xray_nodes (id, name, server_id, protocol, listen_port, creds_enc, flow) VALUES (70, 'xvless', 1, 'vless', 41001, 'enc-token2', 'xtls-rprx-vision')").run();
  src.prepare("INSERT INTO port_forwards (id, name, entry_server_id, landing_server_id, target_node_type, target_node_id, entry_port, target_port) VALUES (7, 'fwd', 1, 2, 'xray', 70, 31001, 41001)").run();
  src.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'admin', 'bcrypt-hash', '2026-01-01')").run();
  src.close();

  // target gets the NEW schema (0001 baseline incl. port_forwards.mechanism)
  const baseline = path.resolve(__dirname, '../../../apps/server/src/db/migrations/0001_init.sql');
  const dst = new DatabaseSync(toPath);
  dst.exec(readFileSync(baseline, 'utf8'));
  dst.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migrate tool', () => {
  it('migrates all rows and reconciles with zero diff', () => {
    const { diff, report } = runMigration(fromPath, toPath, false);
    expect(diff).toBe(0);
    const servers = report.find((r) => r.table === 'servers')!;
    expect(servers.from).toBe(2);
    const nodes = report.find((r) => r.table === 'nodes')!;
    expect(nodes.from).toBe(1);

    const dst = new DatabaseSync(toPath);
    // mechanism defaults to iptables for legacy rows (design.md §4)
    const fw = dst.prepare('SELECT mechanism FROM port_forwards WHERE id = 7').get() as { mechanism: string };
    expect(fw.mechanism).toBe('iptables');
    // legacy rows without in_password_enc come through as null, not crash
    const xs = dst.prepare('SELECT in_method FROM xray_server_settings').all();
    expect(xs).toEqual([]);
    const user = dst.prepare('SELECT username FROM users').get() as { username: string };
    expect(user.username).toBe('admin');
    dst.close();
  });

  it('is idempotent (INSERT OR REPLACE keeps counts stable)', () => {
    const { diff } = runMigration(fromPath, toPath, false);
    expect(diff).toBe(0);
  });
});
