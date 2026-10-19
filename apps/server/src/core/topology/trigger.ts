// 拓扑同步触发:变更后异步执行(不阻塞请求)。
// 多次触发合并为一次(防抖 3s),避免批量操作时反复 SSH。

import type { DatabaseSync } from 'node:sqlite';
import { syncTopology, type SyncResult } from './sync.js';
import { recordRun } from '../alerts.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let pendingDb: DatabaseSync | null = null;
const listeners: ((r: SyncResult) => void)[] = [];

/** 请求一次拓扑同步(防抖合并) */
export function requestTopologySync(db: DatabaseSync): void {
  pendingDb = db;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void runSync();
  }, 3000);
  timer.unref?.();
}

async function runSync(): Promise<void> {
  if (running || !pendingDb) return;
  running = true;
  const db = pendingDb;
  pendingDb = null;
  try {
    const r = await syncTopology(db);
    for (const l of listeners) l(r);
  } catch (err) {
    // syncTopology 内部已按条记账;这里兜住"计划/落库阶段"抛出的异常 ——
    // 否则一次失败后每次重试都静默失败,运维卡片永远不亮。
    recordRun(db, 'topology', false, (err as Error).message.slice(0, 200));
  } finally {
    running = false;
    if (pendingDb) requestTopologySync(pendingDb); // 期间又有变更 → 再跑一轮
  }
}

/** 注册同步结果监听(SSE/日志用) */
export function onTopologySync(fn: (r: SyncResult) => void): void {
  listeners.push(fn);
}

/** 测试用:清空状态 */
export function resetTopologyTrigger(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  running = false;
  pendingDb = null;
  listeners.length = 0;
}
