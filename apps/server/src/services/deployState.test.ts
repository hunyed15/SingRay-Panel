import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { markDirty, clearDirtyCore, dirtyStamp, listPendingDeploys } from './deployState.js';

function seed() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("INSERT INTO servers (id, name, role, host) VALUES (1, 'a', 'landing', '1.1.1.1')").run();
  db.prepare("INSERT INTO servers (id, name, role, host) VALUES (2, 'b', 'landing', '2.2.2.2')").run();
  return db;
}

describe('deployState (pending deploys)', () => {
  it('mark → list → per-core clear', () => {
    const db = seed();
    markDirty(db, 1, 'singbox');
    expect(listPendingDeploys(db)).toEqual([{ serverId: 1, name: 'a', singbox: true, xray: false }]);
    // 二次标记不重复,合并核心
    markDirty(db, 1, 'xray');
    expect(listPendingDeploys(db)[0]).toEqual({ serverId: 1, name: 'a', singbox: true, xray: true });

    const sbStamp = dirtyStamp(db, 1, 'singbox');
    expect(clearDirtyCore(db, 1, 'singbox', sbStamp)).toBe(true);
    expect(listPendingDeploys(db)[0]).toEqual({ serverId: 1, name: 'a', singbox: false, xray: true });
    expect(clearDirtyCore(db, 1, 'xray', dirtyStamp(db, 1, 'xray'))).toBe(true);
    expect(listPendingDeploys(db)).toEqual([]);
  });

  it('部署期间又发生变更 → 标记不清除(横幅继续提示,避免"看起来已部署")', () => {
    const db = seed();
    markDirty(db, 1, 'singbox');
    const stamp = dirtyStamp(db, 1, 'singbox'); // 部署开始时取的时间
    // 部署进行中又改了节点 → 标记时间被刷新
    db.prepare("UPDATE pending_deploys SET singbox_marked_at = '2099-01-01T00:00:00.000Z' WHERE server_id = 1").run();

    expect(clearDirtyCore(db, 1, 'singbox', stamp)).toBe(false);
    expect(listPendingDeploys(db)[0]).toEqual({ serverId: 1, name: 'a', singbox: true, xray: false });
  });

  it('dirty on deleted server disappears (cascade)', () => {
    const db = seed();
    markDirty(db, 2, 'xray');
    db.prepare('DELETE FROM servers WHERE id = 2').run();
    expect(listPendingDeploys(db)).toEqual([]);
  });
});
