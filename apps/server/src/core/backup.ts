// 数据库自动备份:VACUUM INTO 一致性快照 → 校验 → 原子重命名 → 保留 N 份。
// 红线能力:panel.db 包含全部凭据/私钥,必须可恢复。
//
// 旧实现的两个坑(已修):
//   1) PRAGMA wal_checkpoint(TRUNCATE) + copyFileSync:第二个连接持读快照时
//      checkpoint 会**静默**不生效,拷贝出的 .db 缺最近提交;
//   2) 先落正式文件名再校验:校验失败时留下一个当日"备份",而 backedUpToday()
//      据此判定今日已备份 → 当天不再重试,也没有任何失败记录。

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
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

/** 备份文件真的能打开且核心表可读(失败留下的空壳不算备份) */
export function isUsableBackup(file: string): boolean {
  let check: DatabaseSync | null = null;
  try {
    check = new DatabaseSync(file, { readOnly: true });
    check.prepare('SELECT COUNT(*) FROM servers').get();
    return true;
  } catch {
    return false;
  } finally {
    check?.close();
  }
}

/** 立即执行一次备份;返回备份文件名。失败抛错,**且不留下任何文件** */
export function runBackupNow(db: DatabaseSync, dbPath = config.dbPath): { file: string; size: number } {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
  const file = path.join(dir, `panel-${stamp}.db`);
  const tmp = `${file}.tmp`;

  try {
    // 1) 一致性快照:VACUUM INTO 在单个读事务里导出整库,自动包含 WAL 中已提交的数据
    if (existsSync(tmp)) unlinkSync(tmp);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);

    // 2) 校验:备份可打开且核心表存在
    if (!isUsableBackup(tmp)) throw new Error('备份文件校验失败(无法打开或缺少核心表)');

    // 3) 校验通过才落成正式文件名(rename 同目录原子)
    renameSync(tmp, file);
  } catch (err) {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
    }
    throw err;
  }

  // 4) 按保留数量清理旧备份
  const all = listBackups(dir);
  for (const old of all.slice(config.backupRetention)) unlinkSync(path.join(dir, old.file));

  return { file: `panel-${stamp}.db`, size: statSync(file).size };
}

/**
 * 今日是否已有**可用**备份(调度器用来判断"到了备份小时但今天已备过"则跳过)。
 * 必须是能打开的备份:校验失败的残留文件不能让当天永久跳过备份。
 */
export function backedUpToday(dir = backupDir()): boolean {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return listBackups(dir)
    .filter((b) => b.file.includes(`panel-${today}-`))
    .some((b) => isUsableBackup(path.join(dir, b.file)));
}

/**
 * 从备份恢复数据库(**必须先停面板**:本函数直接替换文件,运行中的进程会继续用旧句柄)。
 *
 * 步骤:校验备份可用 → 给当前库留一份一致性快照 → 原子替换 → 清掉旧库的 -wal/-shm。
 * 返回快照路径,方便恢复错了再换回来。
 */
export function restoreFromBackup(
  backupFile: string,
  dbPath = config.dbPath,
): { restoredFrom: string; snapshot: string | null; bytes: number } {
  if (dbPath === ':memory:') throw new Error('内存库不支持恢复');
  if (!existsSync(backupFile)) throw new Error(`备份文件不存在:${backupFile}`);
  if (!isUsableBackup(backupFile)) throw new Error(`备份文件不可用(无法打开或缺核心表):${backupFile}`);

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // 恢复前的当前库:优先用 VACUUM INTO(带 WAL 也一致),失败再退回文件拷贝
  let snapshot: string | null = null;
  if (existsSync(dbPath)) {
    snapshot = `${dbPath}.pre-restore-${stamp}.db`;
    try {
      const live = new DatabaseSync(dbPath);
      try {
        live.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      } finally {
        live.close();
      }
    } catch {
      copyFileSync(dbPath, snapshot);
    }
  }

  // 旧库的 -wal/-shm 必须先清掉:它们是旧库的日志,留在原地会盖住刚恢复的数据
  for (const suffix of ['-wal', '-shm']) {
    const f = `${dbPath}${suffix}`;
    if (existsSync(f)) unlinkSync(f);
  }

  const tmp = `${dbPath}.restore-tmp`;
  copyFileSync(backupFile, tmp);
  renameSync(tmp, dbPath); // 同目录原子替换:中途断电也不会留下半截库

  return { restoredFrom: backupFile, snapshot, bytes: statSync(dbPath).size };
}
