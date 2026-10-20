// 部署审计:结果落库,进程重启/超过内存保留期后仍可回溯
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../db/client.js';
import { recordDeploy, listDeployAudits, pruneDeployAudits } from './deployAudit.js';

function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

const okResult = { serverId: 1, serverName: 'HK1', singbox: { ok: true, steps: ['写配置'] }, xray: { ok: true, skipped: true, steps: [] } };
const badResult = { serverId: 2, serverName: 'JP1', singbox: { ok: false, error: 'reload failed', steps: [] }, xray: { ok: true, steps: [] } };

describe('deployAudit', () => {
  it('成功/失败都落库,列表按时间倒序', () => {
    const db = seed();
    recordDeploy(db, okResult);
    recordDeploy(db, badResult);
    const rows = listDeployAudits(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].serverId).toBe(2); // 最新的在前
    expect(rows[0].ok).toBe(false);
    expect(rows[0].detail.singbox?.error).toBe('reload failed');
    expect(rows[1].ok).toBe(true);
    db.close();
  });

  it('xray 被跳过不算失败', () => {
    const db = seed();
    recordDeploy(db, okResult); // xray.skipped = true
    expect(listDeployAudits(db)[0].ok).toBe(true);
    db.close();
  });

  it('可按机器过滤,并只保留最近 500 条', () => {
    const db = seed();
    recordDeploy(db, badResult);
    expect(listDeployAudits(db, 2)).toHaveLength(1);
    expect(listDeployAudits(db, 1)).toHaveLength(0);

    for (let i = 0; i < 505; i++) recordDeploy(db, { serverId: 1, serverName: 'bulk', singbox: { ok: true, steps: [] } });
    const total = (db.prepare('SELECT COUNT(*) c FROM deploy_audits').get() as { c: number }).c;
    expect(total).toBe(500);
    pruneDeployAudits(db); // 幂等
    expect((db.prepare('SELECT COUNT(*) c FROM deploy_audits').get() as { c: number }).c).toBe(500);
    db.close();
  });
});
