import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { markDirty, clearDirtyCore, listPendingDeploys } from './deployState.js';

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
    clearDirtyCore(db, 1, 'singbox');
    expect(listPendingDeploys(db)[0]).toEqual({ serverId: 1, name: 'a', singbox: false, xray: true });
    clearDirtyCore(db, 1, 'xray');
    expect(listPendingDeploys(db)).toEqual([]);
  });

  it('dirty on deleted server disappears (cascade)', () => {
    const db = seed();
    markDirty(db, 2, 'xray');
    db.prepare('DELETE FROM servers WHERE id = 2').run();
    expect(listPendingDeploys(db)).toEqual([]);
  });
});
