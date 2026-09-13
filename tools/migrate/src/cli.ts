// One-off migration: read singbox-panel SQLite (read-only) → write SingRayPanel
// DB, then print a per-table row-count reconciliation report (PRD R3.1).
// Zero diff → exit 0; any diff → exit 1. Never writes to the source DB.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const TABLES = [
  'servers',
  'relay_settings',
  'landing_settings',
  'nodes',
  'sni_library',
  'xray_nodes',
  'xray_server_settings',
  'port_forwards',
  'settings',
  'users',
] as const;

const INSERTS: Record<(typeof TABLES)[number], { cols: string[]; map: (row: any) => unknown[] }> = {
  servers: {
    cols: ['id', 'name', 'role', 'control', 'host', 'client_host', 'ssh_port', 'ssh_user', 'ssh_auth_type', 'ssh_auth_secret', 'ssh_sudo', 'region', 'ping_status', 'singbox_version', 'xray_version', 'xray_ping_status', 'xray_last_seen', 'last_seen'],
    map: (r) => [r.id, r.name, r.role, r.control, r.host, r.client_host, r.ssh_port, r.ssh_user, r.ssh_auth_type, r.ssh_auth_secret, r.ssh_sudo, r.region, r.ping_status, r.singbox_version, r.xray_version, r.xray_ping_status, r.xray_last_seen, r.last_seen],
  },
  relay_settings: {
    cols: ['id', 'server_id', 'reality_public_key', 'reality_private_key', 'short_id', 'port_base'],
    map: (r) => [r.id, r.server_id, r.reality_public_key, r.reality_private_key, r.short_id, r.port_base],
  },
  landing_settings: {
    cols: ['id', 'server_id', 'in_port', 'method', 'password'],
    map: (r) => [r.id, r.server_id, r.in_port, r.method, r.password],
  },
  nodes: {
    cols: ['id', 'name', 'server_id', 'protocol', 'listen_port', 'enabled', 'creds_enc', 'tls_mode', 'sni', 'transport', 'ws_path', 'outbound_type', 'landing_server_id', 'tunnel_address', 'tunnel_port', 'note', 'created_at'],
    map: (r) => [r.id, r.name, r.server_id, r.protocol, r.listen_port, r.enabled, r.creds_enc, r.tls_mode, r.sni, r.transport, r.ws_path, r.outbound_type, r.landing_server_id, r.tunnel_address, r.tunnel_port, r.note, r.created_at],
  },
  sni_library: {
    cols: ['id', 'domain', 'note', 'builtin'],
    map: (r) => [r.id, r.domain, r.note, r.builtin],
  },
  xray_nodes: {
    cols: ['id', 'name', 'server_id', 'protocol', 'listen_port', 'enabled', 'creds_enc', 'tls_mode', 'sni', 'transport', 'ws_path', 'flow', 'outbound_type', 'landing_server_id', 'tunnel_address', 'tunnel_port', 'note', 'created_at'],
    map: (r) => [r.id, r.name, r.server_id, r.protocol, r.listen_port, r.enabled, r.creds_enc, r.tls_mode, r.sni, r.transport, r.ws_path, r.flow, r.outbound_type, r.landing_server_id, r.tunnel_address, r.tunnel_port, r.note, r.created_at],
  },
  xray_server_settings: {
    cols: ['id', 'server_id', 'reality_private_key', 'reality_public_key', 'short_id', 'port_base', 'in_port', 'in_method', 'in_password_enc'],
    map: (r) => [r.id, r.server_id, r.reality_private_key, r.reality_public_key, r.short_id, r.port_base, r.in_port, r.in_method, r.in_password_enc],
  },
  port_forwards: {
    cols: ['id', 'name', 'entry_server_id', 'landing_server_id', 'target_node_type', 'target_node_id', 'entry_port', 'target_port', 'mechanism', 'enabled', 'note', 'created_at'],
    map: (r) => {
      // old rows have no mechanism column; old code silently degraded to socat —
      // migrated rows default to iptables and must be reconciled (design.md §4)
      const mechanism = r.mechanism === 'socat' ? 'socat' : 'iptables';
      return [r.id, r.name, r.entry_server_id, r.landing_server_id, r.target_node_type, r.target_node_id, r.entry_port, r.target_port, mechanism, r.enabled, r.note, r.created_at];
    },
  },
  settings: {
    cols: ['key', 'value'],
    map: (r) => [r.key, r.value],
  },
  users: {
    cols: ['id', 'username', 'password_hash', 'created_at'],
    map: (r) => [r.id, r.username, r.password_hash, r.created_at],
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = get('--from');
  const to = get('--to');
  const dryRun = args.includes('--dry-run');
  if (!from || !to) {
    console.error('usage: migrate --from <old panel.db> --to <new panel.db> [--dry-run]');
    process.exit(2);
  }
  return { from, to, dryRun };
}

export function runMigration(fromPath: string, toPath: string, dryRun: boolean): { diff: number; report: { table: string; from: number; to: number }[] } {
  const src = new DatabaseSync(fromPath, { readOnly: true });

  let dst: DatabaseSync;
  if (dryRun) {
    dst = new DatabaseSync(':memory:');
    const ddl = src.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all() as { sql: string }[];
    for (const { sql } of ddl) dst.exec(sql);
  } else {
    mkdirSync(path.dirname(toPath), { recursive: true });
    dst = new DatabaseSync(toPath);
    // target must already be migrated by the server (schema_migrations applied)
    const hasTables = dst.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='servers'").get() as { c: number };
    if (!hasTables.c) throw new Error('target DB has no schema — start the server once to apply migrations first');
  }

  const report: { table: string; from: number; to: number }[] = [];
  let diff = 0;

  dst.exec('BEGIN');
  try {
    // 服务器启动会预种 builtin SNI,旧库才是权威:先清内置行再导入,保留用户自增(builtin=0)行
    dst.prepare('DELETE FROM sni_library WHERE builtin = 1').run();
    for (const table of TABLES) {
      const rows = src.prepare(`SELECT * FROM ${table}`).all() as any[];
      for (const row of rows) {
        const { cols, map } = INSERTS[table];
        const placeholders = cols.map(() => '?').join(',');
        dst.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(...map(row).map((v) => (v === undefined || v === null ? null : (v as string | number | bigint | Buffer))));
      }
      const toCount = (dst.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
      const fromCount = rows.length;
      // dry-run target is a schema-only clone; counts come from what we would insert
      report.push({ table, from: fromCount, to: dryRun ? fromCount : toCount });
      if (!dryRun && fromCount !== toCount) diff++;
    }
    dst.exec('COMMIT');
  } catch (err) {
    dst.exec('ROLLBACK');
    throw err;
  } finally {
    src.close();
    dst.close();
  }

  return { diff, report };
}

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  const { from, to, dryRun } = parseArgs();
  try {
    const { diff, report } = runMigration(from, to, dryRun);
    console.table(report);
    if (diff > 0) {
      console.error(`✗ ${diff} table(s) with row-count mismatch`);
      process.exit(1);
    }
    console.log(`✓ migration ${dryRun ? '(dry-run) ' : ''}reconciled: 0 diff`);
  } catch (err) {
    console.error('✗ migration failed:', (err as Error).message);
    process.exit(1);
  }
}
