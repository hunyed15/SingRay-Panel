import { describe, it, expect } from 'vitest';
import { deployCore, type DeployStep } from './index.js';
import type { ExecFn, SshConn } from '../ssh/executor.js';

const conn: SshConn = { serverId: 1, host: '10.0.0.1', sudo: false, readyTimeout: 5000 };

const BACKUP_CMD = 'echo BACKED-UP'; // 备份探测命令(sing-box / xray 两种 paths 都含此串)
const RESTORE_CMD = 'config.json.bak /etc/sing-box/config.json';

/** scripted mock: handlers keyed by substring, first match wins; default ok */
function scripted(
  handlers: { match: string; run?: () => Promise<void>; stdout?: string | (() => string) }[] = [],
) {
  const calls: string[] = [];
  const execFn: ExecFn = async (_c, cmd) => {
    calls.push(cmd);
    const h = handlers.find((x) => cmd.includes(x.match));
    if (h?.run) await h.run();
    const out = typeof h?.stdout === 'function' ? h.stdout() : (h?.stdout ?? '');
    return { stdout: out, stderr: '' };
  };
  const writeFileFn = async (_c: SshConn, path: string, content: string) => {
    calls.push(`writeFile:${path}:${content.length}`);
  };
  return { calls, execFn, writeFileFn };
}

const stepNames = (steps: DeployStep[]) => steps.map((s) => s.step);

describe('deploy engine (transactional)', () => {
  it('singbox happy path: verify via check, reload, health active', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'is-active', stdout: 'active\n' },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: { log: {} }, execFn, writeFileFn });
    expect(r.ok).toBe(true);
    expect(stepNames(r.steps)).toEqual(['render', 'upload', 'verify', 'backup', 'swap', 'restart', 'health']);
    expect(calls.some((c) => c.includes('/usr/local/bin/sing-box check -c'))).toBe(true);
    expect(calls.some((c) => c.includes('systemctl reload sing-box'))).toBe(true);
    expect(calls.some((c) => c.startsWith('writeFile:/tmp/singray-singbox/config.json:'))).toBe(true);
  }, 20000);

  it('xray skips local verify, uses restart, health active', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'is-active', stdout: 'active\n' },
    ]);
    const r = await deployCore(conn, { core: 'xray', config: { log: {} }, execFn, writeFileFn });
    expect(r.ok).toBe(true);
    expect(stepNames(r.steps)).toEqual(['render', 'upload', 'verify-skip', 'backup', 'swap', 'restart', 'health']);
    expect(calls.some((c) => c.includes('systemctl restart xray'))).toBe(true);
  }, 20000);

  it('verify failure (before swap) fails without rollback and production untouched', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'sing-box check', run: async () => { throw new Error('invalid json: unknown field network'); } },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(false);
    expect(r.error).toContain('unknown field network');
    expect(calls.some((c) => c.includes('systemctl reload'))).toBe(false);
    expect(calls.some((c) => c.includes('install -m 600'))).toBe(false);
  }, 20000);

  it('swap is atomic: writes .new then mv (never overwrites in place)', async () => {
    const { calls, execFn, writeFileFn } = scripted([{ match: 'is-active', stdout: 'active\n' }]);
    await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    const swap = calls.find((c) => c.includes('install -m 600'));
    expect(swap).toContain('/etc/sing-box/config.json.new');
    expect(swap).toContain('mv -f /etc/sing-box/config.json.new /etc/sing-box/config.json');
  }, 20000);

  it('reload failure after swap rolls back to .bak and restarts old config', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: BACKUP_CMD, stdout: 'BACKED-UP\n' },
      { match: 'systemctl reload sing-box', run: async () => { throw new Error('job failed'); } },
      { match: 'is-active', stdout: 'active\n' },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    const swapIdx = calls.findIndex((c) => c.includes('install -m 600'));
    expect(swapIdx).toBeGreaterThan(-1);
    const rollbackIdx = calls.findIndex((c) => c.includes(RESTORE_CMD));
    expect(rollbackIdx).toBeGreaterThan(swapIdx);
    expect(r.steps.find((s) => s.step === 'rollback')?.ok).toBe(true);
  }, 20000);

  it('health-fail collects journal, rolls back and verifies the result (AC4 regression)', async () => {
    let probes = 0;
    const { execFn, writeFileFn } = scripted([
      { match: BACKUP_CMD, stdout: 'BACKED-UP\n' },
      // 健康检查 10 次全部 inactive;回滚后的校验(第 11 次起)active
      { match: 'is-active', stdout: () => (++probes <= 10 ? 'inactive\n' : 'active\n') },
      { match: 'journalctl', stdout: 'xray: failed to parse config\nFATAL: run failed' },
    ]);
    const r = await deployCore(conn, { core: 'xray', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.journal).toContain('failed to parse config');
    expect(r.error).toContain('未进入 active');
    expect(r.steps.find((s) => s.step === 'rollback')?.ok).toBe(true);
  }, 40000);

  it('first deploy (no old config): reports rolledBack=false instead of lying', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: BACKUP_CMD, stdout: 'NO-CONFIG\n' }, // 机器上还没有旧配置
      { match: 'is-active', stdout: 'inactive\n' },
    ]);
    const r = await deployCore(conn, { core: 'xray', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(false); // 没有可回滚的东西,就不能说"已回滚"
    expect(stepNames(r.steps)).toContain('rollback-skip');
    expect(calls.some((c) => c.includes(RESTORE_CMD))).toBe(false);
  }, 40000);

  it('backup failure aborts before touching production', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: BACKUP_CMD, stdout: 'BACKUP-FAILED\n' },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('旧配置备份失败');
    expect(calls.some((c) => c.includes('install -m 600'))).toBe(false);
    expect(r.steps.find((s) => s.step === 'backup')?.ok).toBe(false);
  }, 20000);

  it('rollback failure is reported honestly (rolledBack=false + failed step)', async () => {
    const { execFn, writeFileFn } = scripted([
      { match: BACKUP_CMD, stdout: 'BACKED-UP\n' },
      { match: 'is-active', stdout: 'inactive\n' },
      { match: 'cp -f /etc/sing-box/config.json.bak', run: async () => { throw new Error('disk full'); } },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(false);
    expect(r.steps.find((s) => s.step === 'rollback')).toMatchObject({ ok: false, detail: 'disk full' });
  }, 40000);

  it('reload "not applicable" falls back to restart (old units without ExecReload)', async () => {
    const { calls, execFn, writeFileFn } = scripted([
      { match: 'systemctl reload sing-box', run: async () => { throw new Error('Job type reload is not applicable for unit sing-box.service'); } },
      { match: 'is-active', stdout: 'active\n' },
    ]);
    const r = await deployCore(conn, { core: 'singbox', config: {}, execFn, writeFileFn });
    expect(r.ok).toBe(true);
    expect(stepNames(r.steps)).toContain('restart-fallback');
    expect(calls.some((c) => c.includes('systemctl restart sing-box'))).toBe(true);
  }, 20000);
});
