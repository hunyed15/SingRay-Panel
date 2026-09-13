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
  migrate(db);
  return db;
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
