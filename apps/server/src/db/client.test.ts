import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate, migrationSnapshot } from '../db/client.js';
import { MIGRATIONS } from '../db/migrations.js';

describe('baseline migration', () => {
  it('loads at least one migration file', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('applies cleanly on a fresh database and is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['servers', 'nodes', 'xray_nodes', 'port_forwards', 'settings', 'users', 'sni_library', 'relay_settings', 'landing_settings', 'xray_server_settings', 'schema_migrations']) {
      expect(tables).toContain(t);
    }
    // port_forwards must have the explicit mechanism column
    const cols = db.prepare('PRAGMA table_info(port_forwards)').all().map((c) => (c as { name: string }).name);
    expect(cols).toContain('mechanism');
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it('迁移前留一份一致性快照(迁移失败才有回退点)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'singray-migrate-'));
    const dbPath = path.join(dir, 'panel.db');
    const db = new DatabaseSync(dbPath);
    migrate(db);

    // 无待执行迁移 → 不做快照
    expect(migrationSnapshot(db, dbPath)).toBeNull();

    // 让一个迁移重新变成"待执行"(迁移名不含 .sql 后缀)
    db.prepare("DELETE FROM schema_migrations WHERE name = '0001_init'").run();
    const snap = migrationSnapshot(db, dbPath);
    expect(snap).toBeTruthy();
    expect(readdirSync(dir).some((f) => f.includes('.pre-migrate-'))).toBe(true);

    // 快照可打开(一致的库,不是半截拷贝)
    const copy = new DatabaseSync(snap!, { readOnly: true });
    expect((copy.prepare('SELECT COUNT(*) c FROM servers').get() as { c: number }).c).toBe(0);
    copy.close();
    db.close();
  });
});
