import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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
  });

  it('prunes old backups beyond retention', () => {
    // 手工放 5 个旧备份(保留数设 3)
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
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
