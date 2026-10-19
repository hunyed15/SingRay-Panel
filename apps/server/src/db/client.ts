import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { MIGRATIONS, ensureMigrationsTable } from './migrations.js';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  if (config.dbPath !== ':memory:') {
    mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrationSnapshot(db);
  migrate(db);
  return db;
}

/**
 * 迁移前快照:迁移失败 = 面板起不来,而旧库没有回退点就只能人工救。
 * 只在"确有未执行的迁移"且库里已经有表时做(VACUUM INTO 保证 WAL 下也一致)。
 */
export function migrationSnapshot(db: DatabaseSync, dbPath = config.dbPath): string | null {
  if (dbPath === ':memory:') return null;
  ensureMigrationsTable(db);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name as string));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return null;
  const tables = (
    db
      .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'")
      .get() as { c: number }
  ).c;
  if (tables === 0) return null; // 全新库,没有东西需要备份

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const target = `${dbPath}.pre-migrate-${stamp}.db`;
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    console.log(`[db] 迁移前快照:${target}(待执行 ${pending.length} 个迁移)`);
    return target;
  } catch (err) {
    // 快照失败不阻断启动,但必须吼一声(否则用户以为有回退点而其实没有)
    console.warn(`[db] 迁移前快照失败:${(err as Error).message}`);
    return null;
  }
}

export function migrate(db: DatabaseSync): void {
  ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name as string),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(m.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}

