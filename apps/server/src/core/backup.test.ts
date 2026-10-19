import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBackupNow, listBackups, backedUpToday } from './backup.js';
import { config } from '../config.js';

let dir: string;
let dbPath: string;
let live: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'singray-backup-'));
  dbPath = path.join(dir, 'panel.db');
  live = new DatabaseSync(dbPath);
  live.exec('PRAGMA journal_mode = WAL');
  live.exec('CREATE TABLE servers (id INTEGER PRIMARY KEY, name TEXT)');
  live.prepare("INSERT INTO servers (name) VALUES ('m1')").run();
  (config as any).backupDir = path.join(dir, 'backups');
  (config as any).backupRetention = 3;
});

describe('backup module', () => {
  it('creates a verifiable backup copy', () => {
    const r = runBackupNow(live, dbPath);
    expect(r.file).toMatch(/^panel-\d{8}-\d{6}\.db$/);
    expect(existsSync(path.join(dir, 'backups', r.file))).toBe(true);
    // 校验:备份可打开且数据在
    const check = new DatabaseSync(path.join(dir, 'backups', r.file), { readOnly: true });
    expect((check.prepare('SELECT COUNT(*) c FROM servers').get() as { c: number }).c).toBe(1);
    check.close();
    expect(backedUpToday(path.join(dir, 'backups'))).toBe(true);
    // 不残留 .tmp
    expect(readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('includes rows committed to WAL even when another connection holds a read snapshot', () => {
    // 旧实现(checkpoint + 拷 .db)在此场景会静默丢数据
    const reader = new DatabaseSync(dbPath);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) c FROM servers').get(); // 持有读快照

    live.prepare("INSERT INTO servers (name) VALUES ('m2')").run();
    live.prepare("INSERT INTO servers (name) VALUES ('m3')").run();

    const r = runBackupNow(live, dbPath);
    const check = new DatabaseSync(path.join(dir, 'backups', r.file), { readOnly: true });
    const c = (check.prepare('SELECT COUNT(*) c FROM servers').get() as { c: number }).c;
    check.close();
    expect(c).toBe(3); // 备份里必须有刚写入的 3 行
    reader.exec('COMMIT');
    reader.close();
  });

  it('leaves no file behind when the copy cannot be verified', () => {
    const brokenPath = path.join(dir, 'broken.db');
    const broken = new DatabaseSync(brokenPath);
    broken.exec('CREATE TABLE other (id INTEGER)'); // 没有 servers 表 → 校验必失败
    expect(() => runBackupNow(broken, brokenPath)).toThrow(/校验失败/);
    expect(listBackups(path.join(dir, 'backups')).length).toBe(0);
    expect(backedUpToday(path.join(dir, 'backups'))).toBe(false); // 当天不该被"已备份"挡住
    broken.close();
  });

  it('an unreadable file named like today does not count as a backup', () => {
    const d = path.join(dir, 'backups');
    mkdirSync(d, { recursive: true });
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    writeFileSync(path.join(d, `panel-${today}-120000.db`), 'not a database');
    expect(backedUpToday(d)).toBe(false);
  });

  it('prunes old backups beyond retention', () => {
    mkdirSync(path.join(dir, 'backups'), { recursive: true });
    for (let i = 1; i <= 5; i++) {
      writeFileSync(path.join(dir, 'backups', `panel-2026010${i}-120000.db`), 'x');
    }
    runBackupNow(live, dbPath);
    const left = readdirSync(path.join(dir, 'backups'));
    expect(left.length).toBe(3); // 5 旧 + 1 新 = 6 → 修剪到 3(保留文件名最新的 3 个)
    expect(left.some((f) => f.includes('20260101'))).toBe(false); // 最旧的被删
    expect(left.some((f) => f.includes('20260104'))).toBe(true); // 较新的旧备份保留
    expect(listBackups(path.join(dir, 'backups')).length).toBe(3);
  });
});
