// 数据库自动备份:checkpoint → 拷贝到备份目录 → 保留 N 份 → 校验可打开。
// 红线能力:panel.db 包含全部凭据/私钥,必须可恢复。

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE_RE = /^panel-\d{8}-\d{6}\.db$/;

export function backupDir(dbPath = config.dbPath): string {
  return config.backupDir || path.join(path.dirname(dbPath), 'backups');
}

export function listBackups(dir = backupDir()): { file: string; size: number; mtime: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((f) => {
      const st = statSync(path.join(dir, f));
      return { file: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.file.localeCompare(a.file)); // 文件名内嵌时间戳,字典序倒序 = 最新优先(比 mtime 稳定)
}

/** 立即执行一次备份;返回备份文件名。失败抛错(由调度器/路由记录) */
export function runBackupNow(db: DatabaseSync, dbPath = config.dbPath): { file: string; size: number } {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });

  // 1) checkpoint:WAL 内容并入主文件,保证拷贝完整
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  // 2) 拷贝
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
  const file = path.join(dir, `panel-${stamp}.db`);
  copyFileSync(dbPath, file);

  // 3) 校验:备份可打开且核心表存在
  const check = new DatabaseSync(file, { readOnly: true });
  check.prepare('SELECT COUNT(*) FROM servers').get();
  check.close();

  // 4) 按保留数量清理旧备份
  const all = listBackups(dir);
  for (const old of all.slice(config.backupRetention)) unlinkSync(path.join(dir, old.file));

  return { file: `panel-${stamp}.db`, size: statSync(file).size };
}

/** 今日是否已备份(调度器用来判断"到了备份小时但今天已备过"则跳过) */
export function backedUpToday(dir = backupDir()): boolean {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return listBackups(dir).some((b) => b.file.includes(today));
}
