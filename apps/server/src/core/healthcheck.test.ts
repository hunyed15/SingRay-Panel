import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { diffHealth, runHealthCheckCycle, resetHealthBaseline, type MachineHealth } from './healthcheck.js';
import { migrate } from '../db/client.js';

const H = (over: Partial<MachineHealth>): MachineHealth => ({
  serverId: 1, name: 'm1', ssh: 'up', singbox: 'up', xray: 'up', certDays: null, ...over,
});

describe('diffHealth (transition → alerts)', () => {
  it('first run builds baseline without alerts (no startup storm)', () => {
    expect(diffHealth(undefined, H({}))).toEqual([]);
  });

  it('alerts on ssh down and recovery', () => {
    const prev = H({});
    expect(diffHealth(prev, H({ ssh: 'down' }))).toEqual(['机器 m1 SSH 不可达']);
    expect(diffHealth(H({ ssh: 'down' }), H({ ssh: 'up' }))).toEqual(['机器 m1 SSH 已恢复']);
  });

  it('alerts on core stop/recovery, not on unknown transitions', () => {
    const prev = H({});
    expect(diffHealth(prev, H({ xray: 'down' }))).toEqual(['机器 m1 的 xray 服务已停止']);
    // unknown ↔ 任何状态:不告警(探活不完整的轮次不制造噪音)
    expect(diffHealth(prev, H({ singbox: 'unknown' }))).toEqual([]);
  });
});

describe('runHealthCheckCycle', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare("INSERT INTO servers (id, name, role, host, control) VALUES (1, 'm1', 'landing', '10.0.0.1', 'ssh')").run();
    resetHealthBaseline();
  });

  it('first cycle: baseline written to servers, no alerts', async () => {
    const summary = await runHealthCheckCycle(db, { probe: async () => H({}) });
    expect(summary).toContain('无状态变化');
    const s = db.prepare('SELECT ping_status, xray_ping_status FROM servers WHERE id = 1').get() as any;
    expect(s.ping_status).toBe('online');
    // 首轮无告警 → job_runs 无 alert 行
    const n = (db.prepare("SELECT COUNT(*) c FROM job_runs WHERE job = 'alert'").get() as { c: number }).c;
    expect(n).toBe(0);
  });

  it('second cycle with change: alert recorded via sendAlert (no TG → 落库)', async () => {
    await runHealthCheckCycle(db, { probe: async () => H({}) });
    const summary = await runHealthCheckCycle(db, { probe: async () => H({ ssh: 'down', singbox: 'unknown', xray: 'unknown' }) });
    expect(summary).toContain('1 条状态变化告警');
    const rows = db.prepare("SELECT detail FROM job_runs WHERE job = 'alert'").all() as { detail: string }[];
    expect(rows.some((r) => r.detail.includes('SSH 不可达'))).toBe(true);
    // 状态写回
    const s = db.prepare('SELECT ping_status FROM servers WHERE id = 1').get() as any;
    expect(s.ping_status).toBe('offline');
  });
});
